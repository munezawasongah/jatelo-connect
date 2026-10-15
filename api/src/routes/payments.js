// Operator payments, wallet merchant numbers, SMS gateways, connection requests,
// and the public webhook the SMS gateway phone posts received SMS to.
import { Router, json } from 'express';
import { z } from 'zod';
import { withTenant, asOwner } from '../db.js';
import { config } from '../config.js';
import { h, parse, notFound, badRequest, conflict, audit, zUuid, zPage, zPhone, HttpError } from '../lib/http.js';
import { encrypt, randomToken, sha256 } from '../lib/crypto.js';
import { requireRole, ROLES } from '../middleware/auth.js';
import { completePayment, claimWithTxnId, recordInboundSms } from '../services/payments.js';
import { disconnectEverywhere } from '../services/sessions.js';
import { queueSms } from '../services/sms.js';

export const payments = Router();
export const paymentChannels = Router();
export const smsGateways = Router();
export const serviceRequests = Router();
export const smsWebhook = Router();

// ───────────── Payments ─────────────
payments.get('/', h(async (req, res) => {
  const q = parse(zPage.extend({
    status: z.enum(['pending', 'success', 'failed', 'expired', 'refunded']).optional(),
    channel: z.string().max(20).optional(), purpose: z.string().max(20).optional(),
    from: z.coerce.date().optional(), to: z.coerce.date().optional(),
  }), req.query);
  const out = await withTenant(req.tenantId, async (c) => {
    const where = [], vals = [];
    const add = (sql, v) => { vals.push(v); where.push(sql.replaceAll('?', `$${vals.length}`)); };
    if (q.status) add('p.status = ?', q.status);
    if (q.channel) add('p.channel = ?', q.channel);
    if (q.purpose) add('p.purpose = ?', q.purpose);
    if (q.from) add('p.created_at >= ?', q.from);
    if (q.to) add('p.created_at < ?', q.to);
    if (q.q) add('(p.reference ILIKE ? OR p.phone ILIKE ? OR p.external_ref ILIKE ?)', `%${q.q}%`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await c.query(
      `SELECT p.id, p.channel, p.wallet, p.purpose, p.purpose_id, p.amount, p.phone, p.reference, p.external_ref, p.status,
              p.failure_reason, p.created_at, p.confirmed_at, p.meta, cu.name AS customer_name, u.name AS recorded_by_name,
              coalesce(pk.name, pl.name) AS item_name
         FROM payments p LEFT JOIN customers cu ON cu.id = p.customer_id LEFT JOIN users u ON u.id = p.recorded_by
         LEFT JOIN packages pk ON p.purpose = 'hotspot' AND pk.id = p.purpose_id
         LEFT JOIN subscriptions s ON p.purpose = 'subscription' AND s.id = p.purpose_id LEFT JOIN plans pl ON pl.id = s.plan_id
        ${w} ORDER BY p.created_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`, vals);
    const { rows: [tot] } = await c.query(
      `SELECT count(*)::int AS total, coalesce(sum(amount) FILTER (WHERE status = 'success'), 0)::bigint AS collected
         FROM payments p ${w}`, vals);
    return { payments: rows, ...tot };
  });
  res.json(out);
}));

/** Confirm a pending payment: with the wallet transaction id, or (owner/manager) by hand with a reason. */
payments.post('/:id/confirm', requireRole(...ROLES.sales), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const b = parse(z.object({ txn_id: z.string().trim().min(3).max(40).optional(), reason: z.string().trim().min(3).max(200).optional() })
    .refine((x) => x.txn_id || x.reason, { message: 'Give the transaction id, or a reason for confirming by hand', path: ['txn_id'] }), req.body);
  if (!b.txn_id && !['owner', 'manager', 'platform_admin'].includes(req.user.role)) {
    throw badRequest('Only owners and managers can confirm without a transaction id');
  }
  let reconnect = null;
  const out = await withTenant(req.tenantId, async (c) => {
    const { rows: [p] } = await c.query('SELECT * FROM payments WHERE id = $1', [id]);
    if (!p) throw notFound('Payment');
    if (p.status === 'success') throw conflict('Payment is already confirmed');
    let result;
    if (b.txn_id) {
      const r = await claimWithTxnId(c, p, b.txn_id);
      if (!r.ok) throw badRequest({ txn_not_found: 'No wallet SMS with this transaction id has been received',
        txn_used: 'This transaction id is already linked to another payment', amount_low: `The SMS shows only ${r.paid} paid`,
        wrong_wallet: 'This transaction is from the other wallet', txn_invalid: 'Invalid transaction id' }[r.reason] || r.reason);
      result = r.result;
    } else {
      await c.query('UPDATE payments SET recorded_by = $1, meta = meta || $2 WHERE id = $3',
        [req.user.id, JSON.stringify({ manual_reason: b.reason }), id]);
      result = await completePayment(c, id, {});
    }
    await audit(c, req, 'payment.confirm', 'payment', id, { txn_id: b.txn_id, reason: b.reason });
    if (result.reconnect) reconnect = result.reconnect;
    return { payment: result.payment, voucher: result.voucher ? { code: result.voucher.code } : undefined };
  });
  if (reconnect) await disconnectEverywhere({ tenantId: req.tenantId, username: reconnect, kind: 'pppoe' }, req.log);
  res.json(out);
}));

payments.post('/:id/cancel', requireRole(...ROLES.sales), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  await withTenant(req.tenantId, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE payments SET status = 'failed', failure_reason = 'cancelled by operator' WHERE id = $1 AND status IN ('pending','expired')`, [id]);
    if (!rowCount) throw conflict('Only pending payments can be cancelled');
    await audit(c, req, 'payment.cancel', 'payment', id);
  });
  res.json({ ok: true });
}));

payments.get('/inbound-sms', h(async (req, res) => {
  const q = parse(zPage.extend({ unmatched: z.enum(['true', 'false']).optional() }), req.query);
  const rows = await withTenant(req.tenantId, async (c) => (await c.query(
    `SELECT i.id, i.sender, i.body, i.wallet, i.parsed_amount, i.parsed_txn_id, i.parsed_phone, i.parsed_name, i.received_at,
            i.matched_payment_id, p.reference AS matched_reference
       FROM inbound_sms i LEFT JOIN payments p ON p.id = i.matched_payment_id
      ${q.unmatched === 'true' ? 'WHERE i.matched_payment_id IS NULL' : ''}
      ORDER BY i.received_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`)).rows);
  res.json({ messages: rows });
}));

// ───────────── Wallet merchant numbers ─────────────
paymentChannels.get('/', h(async (req, res) => {
  const rows = await withTenant(req.tenantId, async (c) => (await c.query(
    `SELECT id, wallet, mode, merchant_number, merchant_name, active, created_at FROM payment_channels ORDER BY wallet`)).rows);
  res.json({ channels: rows });
}));

paymentChannels.put('/:wallet', requireRole('owner', 'manager'), h(async (req, res) => {
  const wallet = parse(z.enum(['lumicash', 'ecocash']), req.params.wallet);
  const b = parse(z.object({
    merchant_number: z.string().trim().min(3).max(30),
    merchant_name: z.string().trim().max(60).nullable().optional(),
    active: z.boolean().default(true),
    // Push-prompt API mode is enabled per operator once the wallet issues merchant API access.
    mode: z.literal('sms_match').default('sms_match'),
  }), req.body);
  const row = await withTenant(req.tenantId, async (c) => {
    const { rows: [ch] } = await c.query(
      `INSERT INTO payment_channels (tenant_id, wallet, mode, merchant_number, merchant_name, active)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, wallet) DO UPDATE SET merchant_number = EXCLUDED.merchant_number,
         merchant_name = EXCLUDED.merchant_name, active = EXCLUDED.active, mode = EXCLUDED.mode
       RETURNING id, wallet, mode, merchant_number, merchant_name, active`,
      [req.tenantId, wallet, b.mode, b.merchant_number, b.merchant_name ?? null, b.active]);
    await audit(c, req, 'payment_channel.save', 'payment_channel', ch.id, b);
    return ch;
  });
  res.json({ channel: row });
}));

// ───────────── SMS gateways ─────────────
const zGateway = z.object({
  name: z.string().trim().min(1).max(60),
  phone: zPhone.nullable().optional(),
  provider: z.enum(['smsgate', 'http']).default('smsgate'),
  base_url: z.string().url().default('https://api.sms-gate.app/3rdparty/v1'),
  username: z.string().trim().max(100).nullable().optional(),
  password: z.string().max(200).nullable().optional(),
  can_send: z.boolean().default(true),
  can_receive: z.boolean().default(true),
  wallets: z.array(z.enum(['lumicash', 'ecocash'])).default(['lumicash', 'ecocash']),
});

const GW_COLUMNS = 'id, name, phone, provider, base_url, username, can_send, can_receive, wallets, active, last_seen_at, created_at';
const webhookUrl = (token) => `${config.PUBLIC_API_URL.replace(/\/$/, '')}/api/sms-gateway/${token}/inbound`;

smsGateways.get('/', requireRole('owner', 'manager'), h(async (req, res) => {
  const rows = await withTenant(req.tenantId, async (c) => (await c.query(
    `SELECT ${GW_COLUMNS}, (SELECT max(received_at) FROM inbound_sms i WHERE i.gateway_id = g.id) AS last_sms_at
       FROM sms_gateways g ORDER BY created_at`)).rows);
  res.json({ gateways: rows });
}));

smsGateways.post('/', requireRole('owner', 'manager'), h(async (req, res) => {
  const b = parse(zGateway, req.body);
  const token = randomToken(24);
  const row = await withTenant(req.tenantId, async (c) => {
    const { rows: [g] } = await c.query(
      `INSERT INTO sms_gateways (tenant_id, name, phone, provider, base_url, username, password_enc, token_hash,
                                 can_send, can_receive, wallets)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${GW_COLUMNS}`,
      [req.tenantId, b.name, b.phone ?? null, b.provider, b.base_url, b.username ?? null,
       b.password ? encrypt(b.password) : null, sha256(token), b.can_send, b.can_receive, b.wallets]);
    await audit(c, req, 'sms_gateway.create', 'sms_gateway', g.id, { name: g.name });
    return g;
  });
  // The webhook URL contains the secret token: shown once, like a password.
  res.status(201).json({ gateway: row, webhook_url: webhookUrl(token) });
}));

smsGateways.patch('/:id', requireRole('owner', 'manager'), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const b = parse(zGateway.partial().extend({ active: z.boolean().optional(), rotate_token: z.boolean().optional() }), req.body);
  let token = null;
  const row = await withTenant(req.tenantId, async (c) => {
    const sets = [], vals = [];
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    for (const k of ['name', 'phone', 'provider', 'base_url', 'username', 'can_send', 'can_receive', 'wallets', 'active']) {
      if (b[k] !== undefined && req.body[k] !== undefined) set(k, b[k]);
    }
    if (req.body.password !== undefined) set('password_enc', b.password ? encrypt(b.password) : null);
    if (b.rotate_token) { token = randomToken(24); set('token_hash', sha256(token)); }
    if (!sets.length) throw badRequest('Nothing to update');
    vals.push(id);
    const { rows: [g] } = await c.query(`UPDATE sms_gateways SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING ${GW_COLUMNS}`, vals);
    if (!g) throw notFound('SMS gateway');
    await audit(c, req, 'sms_gateway.update', 'sms_gateway', id, { ...b, password: b.password ? '***' : undefined });
    return g;
  });
  res.json({ gateway: row, ...(token ? { webhook_url: webhookUrl(token) } : {}) });
}));

smsGateways.delete('/:id', requireRole('owner', 'manager'), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  await withTenant(req.tenantId, async (c) => {
    const { rowCount } = await c.query('DELETE FROM sms_gateways WHERE id = $1', [id]);
    if (!rowCount) throw notFound('SMS gateway');
    await audit(c, req, 'sms_gateway.delete', 'sms_gateway', id);
  });
  res.json({ ok: true });
}));

smsGateways.post('/:id/test', requireRole('owner', 'manager'), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const to = req.user.phone;
  if (!to) throw badRequest('Add a phone number to your account first');
  await withTenant(req.tenantId, async (c) => {
    const { rows: [g] } = await c.query('SELECT id FROM sms_gateways WHERE id = $1 AND can_send AND active', [id]);
    if (!g) throw notFound('Active sending gateway');
    const smsId = await queueSms(c, { tenantId: req.tenantId, to, kind: 'test', body: 'Jatelo Connect : test SMS OK.' });
    await c.query('UPDATE sms_messages SET gateway_id = $1 WHERE id = $2', [id, smsId]);
  });
  res.json({ ok: true, to });
}));

// ───────────── Connection requests ─────────────
serviceRequests.get('/', h(async (req, res) => {
  const q = parse(zPage.extend({ status: z.enum(['new', 'contacted', 'installed', 'rejected']).optional() }), req.query);
  const rows = await withTenant(req.tenantId, async (c) => (await c.query(
    `SELECT r.*, p.name AS plan_name FROM service_requests r LEFT JOIN plans p ON p.id = r.plan_id
      ${q.status ? 'WHERE r.status = $1' : ''} ORDER BY r.created_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`,
    q.status ? [q.status] : [])).rows);
  res.json({ requests: rows });
}));

serviceRequests.patch('/:id', requireRole(...ROLES.subscribers), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const b = parse(z.object({ status: z.enum(['new', 'contacted', 'installed', 'rejected']), subscription_id: zUuid.nullable().optional() }), req.body);
  const row = await withTenant(req.tenantId, async (c) => {
    const { rows: [r] } = await c.query(
      `UPDATE service_requests SET status = $1, subscription_id = coalesce($2, subscription_id) WHERE id = $3 RETURNING *`,
      [b.status, b.subscription_id ?? null, id]);
    if (!r) throw notFound('Request');
    await audit(c, req, 'service_request.update', 'service_request', id, b);
    return r;
  });
  res.json({ request: row });
}));

// ───────────── SMS gateway webhook (public, secret token in the URL) ─────────────
// Accepts the SMS Gateway for Android webhook format
//   { event: "sms:received", payload: { message, phoneNumber, receivedAt } }
// delivery reports { event: "sms:delivered" | "sms:failed", payload: { messageId } },
// and a generic { from, message } format for other gateways.
smsWebhook.post('/:token/inbound', json({ limit: '32kb', type: () => true }), h(async (req, res) => {
  const out = await asOwner(async (c) => {
    const { rows: [g] } = await c.query('SELECT * FROM sms_gateways WHERE token_hash = $1 AND active', [sha256(req.params.token)]);
    if (!g) return null;
    await c.query('UPDATE sms_gateways SET last_seen_at = now() WHERE id = $1', [g.id]);
    const b = req.body || {};
    const event = b.event || 'sms:received';
    const p = b.payload || b;
    if (event === 'sms:delivered' || event === 'sms:failed') {
      const ref = p.messageId || p.id;
      if (ref) {
        await c.query(`UPDATE sms_messages SET status = $1, error = $2 WHERE provider_ref = $3 AND gateway_id = $4`,
          [event === 'sms:delivered' ? 'delivered' : 'failed', p.reason ?? null, String(ref), g.id]);
      }
      return { ok: true };
    }
    if (event !== 'sms:received') return { ok: true, ignored: event };
    const sender = String(p.phoneNumber ?? p.from ?? p.sender ?? '');
    const body = String(p.message ?? p.text ?? p.body ?? '');
    if (!body) return { ok: true, ignored: 'empty' };
    if (!g.can_receive) return { ok: true, ignored: 'receive disabled' };
    const r = await recordInboundSms(c, { tenantId: g.tenant_id, gatewayId: g.id, sender, body, raw: b });
    return { ok: true, matched: Boolean(r.matched), reconnect: r.matched?.reconnect ? { tenantId: g.tenant_id, username: r.matched.reconnect } : null };
  });
  if (!out) throw new HttpError(404, 'not_found', 'Not found');
  if (out.reconnect) await disconnectEverywhere({ ...out.reconnect, kind: 'pppoe' }, req.log);
  res.json({ ok: true, matched: out.matched ?? false });
}));
