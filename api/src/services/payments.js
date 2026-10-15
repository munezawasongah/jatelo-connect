// Payments: creation from the portal, completion, and matching wallet SMS to payments.
// All functions run inside a caller-provided transaction (owner role: portal and webhooks
// are not logged-in operator requests).
import { randomCode, randomDigits, randomToken, sha256 } from '../lib/crypto.js';
import { parseWalletSms, normalizeTxnId } from '../lib/wallet-sms.js';
import { issueVouchers, describeEntitlement } from './vouchers.js';
import { renewSubscription } from './subscriptions.js';
import { queueTemplate } from './sms.js';
import { formatMoney, formatDate } from '../lib/messages.js';

export const PAYMENT_TTL_MINUTES = 30;
export const AUTO_MATCH_WINDOW_MINUTES = 30;

/** Short, unambiguous, easy to type into a USSD "reason/reference" field. */
export const newReference = () => `JC${randomCode(6)}`;

export const pinHash = (tenantId, phone, pin) => sha256(`${tenantId}:${phone}:${pin}`);

async function tenantInfo(c, tenantId) {
  const { rows: [t] } = await c.query(
    `SELECT t.id, t.name, t.currency, t.timezone, t.language, coalesce(s.portal->>'brand', t.name) AS brand
       FROM tenants t LEFT JOIN LATERAL (SELECT portal FROM sites WHERE tenant_id = t.id ORDER BY created_at LIMIT 1) s ON true
      WHERE t.id = $1`, [tenantId]);
  return t;
}

export async function upsertCustomer(c, tenantId, phone, extra = {}) {
  const { rows: [cu] } = await c.query(
    `INSERT INTO customers (tenant_id, phone, name, language) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, phone) DO UPDATE SET name = coalesce(customers.name, EXCLUDED.name),
       language = coalesce(EXCLUDED.language, customers.language)
     RETURNING *`, [tenantId, phone, extra.name ?? null, extra.language ?? null]);
  return cu;
}

/**
 * Creates a pending payment. Returns { payment, clientSecret } — the secret lets the
 * paying browser (and only it) collect the result.
 */
export async function createPayment(c, {
  tenantId, purpose, purposeId, amount, phone, wallet, channel = 'sms_match', siteId = null, routerId = null,
  clientMac = null, customerId = null, meta = {},
}) {
  const clientSecret = randomToken(24);
  for (let i = 0; i < 5; i++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { rows: [p] } = await c.query(
        `INSERT INTO payments (tenant_id, customer_id, channel, wallet, purpose, purpose_id, amount, phone, reference,
                               status, site_id, router_id, client_mac, client_secret_hash, expires_at, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,$13, now() + make_interval(mins => $14), $15)
         RETURNING *`,
        [tenantId, customerId, channel, wallet, purpose, purposeId, amount, phone, newReference(), siteId, routerId,
         clientMac, sha256(clientSecret), PAYMENT_TTL_MINUTES, JSON.stringify(meta)]);
      return { payment: p, clientSecret };
    } catch (e) {
      if (e.code !== '23505') throw e; // reference collision: retry
    }
  }
  throw new Error('Could not allocate a payment reference');
}

/**
 * Marks a payment successful and delivers what was bought. Idempotent: completing an
 * already-successful payment returns its existing result.
 * @returns {{ payment, voucher?, subscription?, already: boolean }}
 */
export async function completePayment(c, paymentId, { externalRef = null, raw = null, amountPaid = null } = {}) {
  const { rows: [p] } = await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
  if (!p) throw new Error('Payment not found');
  if (p.status === 'success') return { payment: p, already: true, ...(await resultOf(c, p)) };
  if (!['pending', 'expired', 'failed'].includes(p.status)) throw new Error(`Payment is ${p.status}`);

  const t = await tenantInfo(c, p.tenant_id);
  const customer = p.phone ? await upsertCustomer(c, p.tenant_id, p.phone) : null;
  const lang = customer?.language || p.meta?.lang || t.language;
  const out = { already: false };

  if (p.purpose === 'hotspot') {
    const { rows: [pkg] } = await c.query('SELECT * FROM packages WHERE id = $1', [p.purpose_id]);
    const [v] = await issueVouchers(c, {
      tenantId: p.tenant_id, pkg, source: 'portal', customerId: customer?.id ?? null, siteId: p.site_id,
    });
    const pin = randomDigits(4);
    if (customer) await c.query('UPDATE customers SET pin_hash = $1 WHERE id = $2', [pinHash(p.tenant_id, customer.phone, pin), customer.id]);
    await c.query('UPDATE payments SET result_id = $1 WHERE id = $2', [v.id, p.id]);
    if (customer?.phone) {
      await queueTemplate(c, {
        tenantId: p.tenant_id, to: customer.phone, template: 'voucher_purchased', lang,
        vars: { brand: t.brand, amount: formatMoney(p.amount, t.currency), code: v.code, package: describeEntitlement(pkg, lang), pin },
      });
    }
    out.voucher = { ...v, package_name: pkg.name };
  } else if (p.purpose === 'subscription') {
    const { rows: [s] } = await c.query(
      `SELECT s.*, pl.price FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id WHERE s.id = $1`, [p.purpose_id]);
    const periods = Math.max(1, Math.floor((amountPaid ?? p.amount) / Math.max(1, s.price)));
    const r = await renewSubscription(c, { tenantId: p.tenant_id, subscriptionId: s.id, periods, paymentId: p.id, amount: p.amount });
    await c.query('UPDATE payments SET result_id = $1 WHERE id = $2', [r.invoice.id, p.id]);
    if (customer?.phone) {
      await queueTemplate(c, {
        tenantId: p.tenant_id, to: customer.phone, template: 'pppoe_renewed', lang,
        vars: { brand: t.brand, amount: formatMoney(p.amount, t.currency), expires: formatDate(r.subscription.expires_at, t.timezone) },
      });
    }
    out.subscription = r.subscription;
    out.reconnect = r.wasExpired ? s.username : null;
  } else if (p.purpose === 'agent_topup') {
    const { rows: [a] } = await c.query('UPDATE agents SET balance = balance + $1 WHERE id = $2 RETURNING balance', [p.amount, p.purpose_id]);
    await c.query(
      `INSERT INTO agent_ledger (tenant_id, agent_id, amount, balance_after, kind, reference) VALUES ($1,$2,$3,$4,'topup',$5)`,
      [p.tenant_id, p.purpose_id, p.amount, a.balance, p.reference]);
  }

  const { rows: [done] } = await c.query(
    `UPDATE payments SET status = 'success', confirmed_at = now(), customer_id = coalesce(customer_id, $2),
            external_ref = coalesce($3, external_ref), raw = coalesce($4, raw), failure_reason = NULL
      WHERE id = $1 RETURNING *`, [p.id, customer?.id ?? null, externalRef, raw ? JSON.stringify(raw) : null]);
  await c.query(
    `INSERT INTO audit_log (tenant_id, action, entity, entity_id, data) VALUES ($1, 'payment.success', 'payment', $2, $3)`,
    [p.tenant_id, p.id, JSON.stringify({ amount: p.amount, channel: p.channel, wallet: p.wallet, reference: p.reference, external_ref: externalRef })]);
  return { payment: done, ...out };
}

async function resultOf(c, p) {
  if (p.purpose === 'hotspot' && p.result_id) {
    const { rows: [v] } = await c.query(
      `SELECT v.id, v.code, v.status, p.name AS package_name FROM vouchers v JOIN packages p ON p.id = v.package_id WHERE v.id = $1`,
      [p.result_id]);
    return { voucher: v };
  }
  return {};
}

/**
 * Stores an SMS received by a merchant phone and tries to match it to a pending payment.
 * Auto-match rules (all must hold, and exactly one candidate):
 *   same tenant, same wallet, same amount, payer phone = phone typed on the portal,
 *   created in the last 30 minutes.
 * Otherwise the customer claims it by typing the transaction id.
 */
export async function recordInboundSms(c, { tenantId, gatewayId, sender, body, raw }) {
  const parsed = parseWalletSms(sender, body);
  const { rows: [sms] } = await c.query(
    `INSERT INTO inbound_sms (tenant_id, gateway_id, sender, body, wallet, parsed_amount, parsed_txn_id, parsed_phone,
                              parsed_name, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id, wallet, parsed_txn_id) WHERE parsed_txn_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [tenantId, gatewayId, String(sender).slice(0, 40), String(body).slice(0, 1000), parsed.wallet,
     parsed.incoming ? parsed.amount : null, parsed.incoming ? parsed.txnId : null, parsed.phone, parsed.name,
     raw ? JSON.stringify(raw) : null]);
  if (!sms) return { duplicate: true };
  if (!parsed.incoming || !parsed.amount || !parsed.phone) return { sms, matched: null };

  const { rows: cands } = await c.query(
    `SELECT id FROM payments
      WHERE tenant_id = $1 AND status = 'pending' AND amount = $2 AND phone = $3
        AND (wallet IS NULL OR $4::text IS NULL OR wallet = $4)
        AND created_at > now() - make_interval(mins => $5)
      ORDER BY created_at DESC`, [tenantId, parsed.amount, parsed.phone, parsed.wallet, AUTO_MATCH_WINDOW_MINUTES]);
  if (cands.length !== 1) return { sms, matched: null, candidates: cands.length };
  const result = await completePayment(c, cands[0].id, { externalRef: parsed.txnId, raw: { sms_id: sms.id } });
  await c.query('UPDATE inbound_sms SET matched_payment_id = $1 WHERE id = $2', [cands[0].id, sms.id]);
  return { sms, matched: result };
}

/**
 * Customer typed the transaction id from their wallet receipt. Finds the unmatched wallet SMS
 * with that id for this tenant and completes the payment if the amount covers it.
 * Returns { ok, reason?, result? }.
 */
export async function claimWithTxnId(c, payment, txnInput) {
  const txn = normalizeTxnId(txnInput);
  if (txn.length < 5) return { ok: false, reason: 'txn_invalid' };
  const { rows: [sms] } = await c.query(
    `SELECT * FROM inbound_sms WHERE tenant_id = $1 AND parsed_txn_id = $2 FOR UPDATE`, [payment.tenant_id, txn]);
  if (!sms) return { ok: false, reason: 'txn_not_found' };
  if (sms.matched_payment_id && sms.matched_payment_id !== payment.id) return { ok: false, reason: 'txn_used' };
  if ((sms.parsed_amount ?? 0) < payment.amount) return { ok: false, reason: 'amount_low', paid: sms.parsed_amount };
  if (payment.wallet && sms.wallet && payment.wallet !== sms.wallet) return { ok: false, reason: 'wrong_wallet' };
  const result = await completePayment(c, payment.id, { externalRef: txn, raw: { sms_id: sms.id }, amountPaid: sms.parsed_amount });
  await c.query('UPDATE inbound_sms SET matched_payment_id = $1 WHERE id = $2', [payment.id, sms.id]);
  return { ok: true, result };
}
