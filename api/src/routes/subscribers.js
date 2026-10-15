// Customers and PPPoE subscriptions.
import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { h, parse, notFound, badRequest, conflict, audit, zUuid, zPage, zPhone, zMoney } from '../lib/http.js';
import { randomPassword, randomCode } from '../lib/crypto.js';
import { requireRole, ROLES } from '../middleware/auth.js';
import { renewSubscription, suggestUsername } from '../services/subscriptions.js';
import { disconnectEverywhere } from '../services/sessions.js';
import { queueTemplate } from '../services/sms.js';
import { formatMoney, formatDate } from '../lib/messages.js';

export const customers = Router();
export const subscriptions = Router();

const tenantInfo = async (c) => (await c.query(
  `SELECT t.name, t.currency, t.timezone, t.language, coalesce(s.portal->>'brand', t.name) AS brand
     FROM tenants t LEFT JOIN LATERAL (SELECT portal FROM sites WHERE tenant_id = t.id ORDER BY created_at LIMIT 1) s ON true
    WHERE t.id = current_setting('app.tenant_id')::uuid`)).rows[0];

// ───────────── Customers ─────────────
const zCustomer = z.object({
  name: z.string().trim().min(1).max(100).nullable().optional(),
  phone: zPhone.nullable().optional(),
  email: z.string().trim().email().nullable().optional(),
  address: z.string().trim().max(200).nullable().optional(),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  language: z.enum(['fr', 'rn', 'en']).nullable().optional(),
});

customers.get('/', h(async (req, res) => {
  const q = parse(zPage, req.query);
  const out = await withTenant(req.tenantId, async (c) => {
    const vals = [];
    let w = '';
    if (q.q) { vals.push(`%${q.q}%`); w = `WHERE cu.name ILIKE $1 OR cu.phone ILIKE $1 OR cu.address ILIKE $1`; }
    const { rows } = await c.query(
      `SELECT cu.*,
         (SELECT count(*)::int FROM subscriptions s WHERE s.customer_id = cu.id AND s.status <> 'cancelled') AS subscriptions,
         (SELECT count(*)::int FROM vouchers v WHERE v.customer_id = cu.id) AS vouchers,
         (SELECT coalesce(sum(amount), 0)::bigint FROM payments p WHERE p.customer_id = cu.id AND p.status = 'success') AS total_paid
       FROM customers cu ${w} ORDER BY cu.created_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`, vals);
    const { rows: [{ total }] } = await c.query(`SELECT count(*)::int AS total FROM customers cu ${w}`, vals);
    return { customers: rows.map(({ pin_hash: _p, ...r }) => r), total };
  });
  res.json(out);
}));

customers.get('/:id', h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const out = await withTenant(req.tenantId, async (c) => {
    const { rows: [cu] } = await c.query('SELECT * FROM customers WHERE id = $1', [id]);
    if (!cu) throw notFound('Customer');
    delete cu.pin_hash;
    const [subs, vch, pays] = await Promise.all([
      c.query(`SELECT s.id, s.username, s.status, s.expires_at, p.name AS plan_name FROM subscriptions s
                 JOIN plans p ON p.id = s.plan_id WHERE s.customer_id = $1 ORDER BY s.created_at DESC`, [id]),
      c.query(`SELECT v.id, v.code, v.status, v.expires_at, v.created_at, p.name AS package_name FROM vouchers v
                 JOIN packages p ON p.id = v.package_id WHERE v.customer_id = $1 ORDER BY v.created_at DESC LIMIT 50`, [id]),
      c.query(`SELECT id, channel, purpose, amount, status, reference, created_at FROM payments
                WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
    ]);
    return { customer: cu, subscriptions: subs.rows, vouchers: vch.rows, payments: pays.rows };
  });
  res.json(out);
}));

customers.post('/', requireRole(...ROLES.subscribers), h(async (req, res) => {
  const b = parse(zCustomer, req.body);
  const row = await withTenant(req.tenantId, async (c) => {
    const { rows: [cu] } = await c.query(
      `INSERT INTO customers (tenant_id, name, phone, email, address, latitude, longitude, notes, language)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.tenantId, b.name ?? null, b.phone ?? null, b.email ?? null, b.address ?? null, b.latitude ?? null,
       b.longitude ?? null, b.notes ?? null, b.language ?? null]);
    await audit(c, req, 'customer.create', 'customer', cu.id, { name: cu.name, phone: cu.phone });
    return cu;
  }).catch((e) => { if (e.code === '23505') throw conflict('A customer with this phone number already exists'); throw e; });
  delete row.pin_hash;
  res.status(201).json({ customer: row });
}));

customers.patch('/:id', requireRole(...ROLES.subscribers), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const b = parse(zCustomer.partial(), req.body);
  const row = await withTenant(req.tenantId, async (c) => {
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(b)) if (v !== undefined) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
    if (!sets.length) throw badRequest('Nothing to update');
    vals.push(id);
    const { rows: [cu] } = await c.query(`UPDATE customers SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
    if (!cu) throw notFound('Customer');
    await audit(c, req, 'customer.update', 'customer', id, b);
    return cu;
  }).catch((e) => { if (e.code === '23505') throw conflict('A customer with this phone number already exists'); throw e; });
  delete row.pin_hash;
  res.json({ customer: row });
}));

// ───────────── PPPoE subscriptions ─────────────
const SUB_COLUMNS = `s.id, s.customer_id, s.plan_id, s.router_id, s.username, s.password, host(s.static_ip) AS static_ip,
  s.status, s.billing_mode, s.expires_at, s.grace_days, s.period_bytes, s.period_started_at, s.installed_at, s.created_at,
  cu.name AS customer_name, cu.phone AS customer_phone, cu.address AS customer_address,
  p.name AS plan_name, p.price AS plan_price, p.rate_down_kbps, p.rate_up_kbps, p.data_cap_mb, r.name AS router_name,
  (SELECT row_to_json(x) FROM (SELECT host(a.framedipaddress) AS ip, a.acctstarttime AS since, a.callingstationid AS mac
     FROM radacct a WHERE a.subscription_id = s.id AND a.acctstoptime IS NULL ORDER BY a.acctstarttime DESC LIMIT 1) x) AS session`;

async function loadSub(c, id) {
  const { rows: [s] } = await c.query(
    `SELECT ${SUB_COLUMNS} FROM subscriptions s JOIN customers cu ON cu.id = s.customer_id JOIN plans p ON p.id = s.plan_id
       LEFT JOIN routers r ON r.id = s.router_id WHERE s.id = $1`, [id]);
  if (!s) throw notFound('Subscription');
  return s;
}

subscriptions.get('/', h(async (req, res) => {
  const q = parse(zPage.extend({
    status: z.enum(['pending', 'active', 'expired', 'suspended', 'cancelled']).optional(),
    plan_id: zUuid.optional(), router_id: zUuid.optional(),
    expiring_days: z.coerce.number().int().min(0).max(60).optional(),
    online: z.enum(['true', 'false']).optional(),
  }), req.query);
  const out = await withTenant(req.tenantId, async (c) => {
    const where = [], vals = [];
    const add = (sql, v) => { vals.push(v); where.push(sql.replaceAll('?', `$${vals.length}`)); };
    if (q.status) add('s.status = ?', q.status);
    if (q.plan_id) add('s.plan_id = ?', q.plan_id);
    if (q.router_id) add('s.router_id = ?', q.router_id);
    if (q.expiring_days !== undefined) add(`s.status = 'active' AND s.expires_at <= now() + make_interval(days => ?)`, q.expiring_days);
    if (q.q) add('(s.username ILIKE ? OR cu.name ILIKE ? OR cu.phone ILIKE ?)', `%${q.q}%`);
    if (q.online) where.push(`${q.online === 'true' ? '' : 'NOT '}EXISTS (SELECT 1 FROM radacct a WHERE a.subscription_id = s.id AND a.acctstoptime IS NULL)`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM subscriptions s JOIN customers cu ON cu.id = s.customer_id JOIN plans p ON p.id = s.plan_id
                  LEFT JOIN routers r ON r.id = s.router_id ${w}`;
    const { rows } = await c.query(`SELECT ${SUB_COLUMNS} ${from} ORDER BY s.expires_at NULLS LAST LIMIT ${q.limit} OFFSET ${q.offset}`, vals);
    const { rows: [{ total }] } = await c.query(`SELECT count(*)::int AS total ${from}`, vals);
    return { subscriptions: rows, total };
  });
  res.json(out);
}));

subscriptions.get('/:id', h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const out = await withTenant(req.tenantId, async (c) => {
    const s = await loadSub(c, id);
    const { rows: sessions } = await c.query(
      `SELECT acctstarttime, acctstoptime, acctsessiontime, acctinputoctets, acctoutputoctets, host(framedipaddress) AS ip,
              callingstationid AS mac, acctterminatecause FROM radacct WHERE subscription_id = $1
        ORDER BY acctstarttime DESC LIMIT 50`, [id]);
    const { rows: invoices } = await c.query(
      `SELECT id, number, amount, status, period_start, period_end, paid_at FROM invoices
        WHERE subscription_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]);
    return { subscription: s, sessions, invoices };
  });
  res.json(out);
}));

const zSubCreate = z.object({
  customer_id: zUuid.optional(),
  customer: z.object({
    name: z.string().trim().min(1).max(100), phone: zPhone, address: z.string().trim().max(200).optional(),
    latitude: z.coerce.number().optional(), longitude: z.coerce.number().optional(),
    language: z.enum(['fr', 'rn', 'en']).optional(),
  }).optional(),
  plan_id: zUuid,
  router_id: zUuid.nullable().optional(),
  username: z.string().trim().regex(/^[a-z0-9._-]{3,32}$/, '3–32 lowercase letters, digits, . _ -').optional(),
  password: z.string().min(6).max(32).regex(/^[\x21-\x7e]+$/, 'No spaces or special characters').optional(),
  static_ip: z.string().ip({ version: 'v4' }).nullable().optional(),
  billing_mode: z.enum(['prepaid', 'postpaid']).default('prepaid'),
  grace_days: z.coerce.number().int().min(0).max(30).default(0),
  // How the first period starts: paid now in cash, a free first period, or wait for the first payment
  activation: z.enum(['paid_cash', 'free_period', 'await_payment']).default('await_payment'),
  periods: z.coerce.number().int().min(1).max(24).default(1),
  send_sms: z.boolean().default(true),
}).refine((b) => b.customer_id || b.customer, { message: 'Choose an existing customer or enter a new one', path: ['customer'] });

subscriptions.post('/', requireRole(...ROLES.subscribers), h(async (req, res) => {
  const b = parse(zSubCreate, req.body);
  const out = await withTenant(req.tenantId, async (c) => {
    const { rows: [plan] } = await c.query('SELECT * FROM plans WHERE id = $1 AND active', [b.plan_id]);
    if (!plan) throw badRequest('Unknown or archived plan');
    if (b.router_id && !(await c.query('SELECT 1 FROM routers WHERE id = $1', [b.router_id])).rowCount) throw badRequest('Unknown router');
    let cust;
    if (b.customer_id) {
      ({ rows: [cust] } = await c.query('SELECT * FROM customers WHERE id = $1', [b.customer_id]));
      if (!cust) throw badRequest('Unknown customer');
    } else {
      ({ rows: [cust] } = await c.query(
        `INSERT INTO customers (tenant_id, name, phone, address, latitude, longitude, language)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id, phone) DO UPDATE SET name = EXCLUDED.name,
           address = coalesce(EXCLUDED.address, customers.address) RETURNING *`,
        [req.tenantId, b.customer.name, b.customer.phone, b.customer.address ?? null, b.customer.latitude ?? null,
         b.customer.longitude ?? null, b.customer.language ?? null]));
    }
    const username = b.username ?? await suggestUsername(c, cust.name);
    const password = b.password ?? randomPassword(8).toLowerCase();
    const { rows: [s] } = await c.query(
      `INSERT INTO subscriptions (tenant_id, customer_id, plan_id, router_id, username, password, static_ip, status,
                                  billing_mode, grace_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9) RETURNING *`,
      [req.tenantId, cust.id, plan.id, b.router_id ?? null, username, password, b.static_ip ?? null, b.billing_mode, b.grace_days],
    ).catch((e) => { if (e.code === '23505') throw conflict(`Username ${username} is already taken`); throw e; });

    let paymentId = null;
    if (b.activation === 'paid_cash' && plan.price > 0) {
      ({ rows: [{ id: paymentId }] } = await c.query(
        `INSERT INTO payments (tenant_id, customer_id, channel, purpose, purpose_id, amount, phone, reference, status,
                               recorded_by, confirmed_at)
         VALUES ($1,$2,'cash','subscription',$3,$4,$5,$6,'success',$7,now()) RETURNING id`,
        [req.tenantId, cust.id, s.id, plan.price * b.periods, cust.phone, `JC-${randomCode(8)}`, req.user.id]));
    }
    let sub = s;
    if (b.activation !== 'await_payment') {
      const r = await renewSubscription(c, {
        tenantId: req.tenantId, subscriptionId: s.id, periods: b.periods, paymentId,
        amount: b.activation === 'free_period' ? 0 : plan.price * b.periods,
      });
      sub = r.subscription;
      if (paymentId) await c.query('UPDATE payments SET result_id = $1 WHERE id = $2', [r.invoice.id, paymentId]);
    }
    if (b.send_sms && cust.phone) {
      const t = await tenantInfo(c);
      await queueTemplate(c, {
        tenantId: req.tenantId, to: cust.phone, template: 'pppoe_welcome', lang: cust.language || t.language,
        vars: { brand: t.brand, name: cust.name ?? '', username, password,
                expires: sub.expires_at ? formatDate(sub.expires_at, t.timezone) : '—' },
      });
    }
    await audit(c, req, 'subscription.create', 'subscription', s.id, { username, plan: plan.name, activation: b.activation });
    return loadSub(c, s.id);
  });
  res.status(201).json({ subscription: out });
}));

const zSubUpdate = z.object({
  plan_id: zUuid.optional(),
  router_id: zUuid.nullable().optional(),
  password: z.string().min(6).max(32).regex(/^[\x21-\x7e]+$/).optional(),
  static_ip: z.string().ip({ version: 'v4' }).nullable().optional(),
  billing_mode: z.enum(['prepaid', 'postpaid']).optional(),
  grace_days: z.coerce.number().int().min(0).max(30).optional(),
  expires_at: z.coerce.date().optional(), // manual correction by owner/manager
});

subscriptions.patch('/:id', requireRole(...ROLES.subscribers), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const b = parse(zSubUpdate, req.body);
  if (b.expires_at && !['owner', 'manager', 'platform_admin'].includes(req.user.role)) throw badRequest('Only owners and managers can change expiry dates');
  const out = await withTenant(req.tenantId, async (c) => {
    const before = await loadSub(c, id);
    if (b.plan_id && !(await c.query('SELECT 1 FROM plans WHERE id = $1 AND active', [b.plan_id])).rowCount) throw badRequest('Unknown plan');
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(b)) if (v !== undefined) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
    if (b.expires_at) sets.push(`status = CASE WHEN status IN ('active','expired') THEN (CASE WHEN $${vals.indexOf(b.expires_at) + 1}::timestamptz > now() THEN 'active' ELSE 'expired' END) ELSE status END`);
    if (!sets.length) throw badRequest('Nothing to update');
    vals.push(id);
    await c.query(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    await audit(c, req, 'subscription.update', 'subscription', id, { ...b, password: b.password ? '***' : undefined });
    return { before, after: await loadSub(c, id) };
  });
  // Speed, password, IP and expiry changes take effect on the next login: reconnect now.
  const cut = await disconnectEverywhere({ tenantId: req.tenantId, username: out.before.username, kind: 'pppoe' }, req.log);
  res.json({ subscription: out.after, reconnected: cut > 0 });
}));

subscriptions.post('/:id/renew', requireRole(...ROLES.sales, 'technician'), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const b = parse(z.object({
    periods: z.coerce.number().int().min(1).max(24).default(1),
    channel: z.enum(['cash', 'manual']).default('cash'),
    amount: zMoney.optional(),
    note: z.string().max(200).optional(),
    send_sms: z.boolean().default(true),
  }), req.body);
  const out = await withTenant(req.tenantId, async (c) => {
    const s = await loadSub(c, id);
    const amount = b.amount ?? s.plan_price * b.periods;
    let paymentId = null;
    if (amount > 0) {
      ({ rows: [{ id: paymentId }] } = await c.query(
        `INSERT INTO payments (tenant_id, customer_id, channel, purpose, purpose_id, amount, phone, reference, status,
                               recorded_by, confirmed_at, meta)
         VALUES ($1,$2,$3,'subscription',$4,$5,$6,$7,'success',$8,now(),$9) RETURNING id`,
        [req.tenantId, s.customer_id, b.channel, id, amount, s.customer_phone, `JC-${randomCode(8)}`, req.user.id,
         JSON.stringify({ note: b.note ?? null })]));
    }
    const r = await renewSubscription(c, { tenantId: req.tenantId, subscriptionId: id, periods: b.periods, paymentId, amount });
    if (paymentId) await c.query('UPDATE payments SET result_id = $1 WHERE id = $2', [r.invoice.id, paymentId]);
    if (b.send_sms && s.customer_phone) {
      const t = await tenantInfo(c);
      await queueTemplate(c, {
        tenantId: req.tenantId, to: s.customer_phone, template: 'pppoe_renewed', lang: t.language,
        vars: { brand: t.brand, amount: formatMoney(amount, t.currency), expires: formatDate(r.subscription.expires_at, t.timezone) },
      });
    }
    await audit(c, req, 'subscription.renew', 'subscription', id, { periods: b.periods, amount, channel: b.channel });
    return { ...r, username: s.username };
  });
  if (out.wasExpired) await disconnectEverywhere({ tenantId: req.tenantId, username: out.username, kind: 'pppoe' }, req.log);
  res.json({ subscription: await withTenant(req.tenantId, (c) => loadSub(c, id)), invoice: out.invoice });
}));

for (const [action, from, to] of [
  ['suspend', ['active', 'expired', 'pending'], 'suspended'],
  ['resume', ['suspended'], null],
  ['cancel', ['active', 'expired', 'suspended', 'pending'], 'cancelled'],
]) {
  subscriptions.post(`/:id/${action}`, requireRole(...ROLES.subscribers), h(async (req, res) => {
    const id = parse(zUuid, req.params.id);
    const s = await withTenant(req.tenantId, async (c) => {
      const cur = await loadSub(c, id);
      if (!from.includes(cur.status)) throw conflict(`Cannot ${action} a ${cur.status} subscription`);
      const next = to ?? (cur.expires_at && new Date(cur.expires_at) > new Date() ? 'active' : (cur.expires_at ? 'expired' : 'pending'));
      await c.query('UPDATE subscriptions SET status = $1 WHERE id = $2', [next, id]);
      await audit(c, req, `subscription.${action}`, 'subscription', id, { from: cur.status, to: next });
      return cur;
    });
    if (action !== 'resume') await disconnectEverywhere({ tenantId: req.tenantId, username: s.username, kind: 'pppoe' }, req.log);
    res.json({ subscription: await withTenant(req.tenantId, (c) => loadSub(c, id)) });
  }));
}

subscriptions.post('/:id/disconnect', requireRole(...ROLES.subscribers), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const s = await withTenant(req.tenantId, async (c) => {
    const cur = await loadSub(c, id);
    await audit(c, req, 'subscription.disconnect', 'subscription', id);
    return cur;
  });
  const cut = await disconnectEverywhere({ tenantId: req.tenantId, username: s.username, kind: 'pppoe' }, req.log);
  res.json({ ok: true, disconnected: cut });
}));
