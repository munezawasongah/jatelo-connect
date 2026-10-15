// PPPoE subscription lifecycle: activation, renewal and invoicing.

/** Next invoice number for the tenant, e.g. INV-2026-000042. */
export async function nextInvoiceNumber(c, tenantId) {
  const { rows: [r] } = await c.query(
    `INSERT INTO invoice_counters (tenant_id, last_no) VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET last_no = invoice_counters.last_no + 1 RETURNING last_no`, [tenantId]);
  return `INV-${new Date().getFullYear()}-${String(r.last_no).padStart(6, '0')}`;
}

/**
 * Extends a subscription by `periods` billing periods from max(now, current expiry),
 * marks it active, resets the fair-use counter, and writes a paid invoice.
 * Returns { subscription, invoice, wasExpired }.
 */
export async function renewSubscription(c, { tenantId, subscriptionId, periods = 1, paymentId = null, amount = null }) {
  const { rows: [s] } = await c.query(
    `SELECT s.*, p.price, p.period_days, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.id = $1 FOR UPDATE OF s`, [subscriptionId]);
  if (!s) throw new Error('Subscription not found');
  if (s.status === 'cancelled') throw new Error('Subscription is cancelled');
  const wasExpired = s.status === 'expired' || (s.expires_at && new Date(s.expires_at) <= new Date());
  const { rows: [u] } = await c.query(
    `UPDATE subscriptions SET
       expires_at = greatest(coalesce(expires_at, now()), now()) + make_interval(days => $2::int * $3::int),
       status = 'active',
       period_bytes = 0,
       period_started_at = now(),
       installed_at = coalesce(installed_at, now())
     WHERE id = $1 RETURNING *`, [subscriptionId, periods, s.period_days]);
  const total = amount ?? s.price * periods;
  const number = await nextInvoiceNumber(c, tenantId);
  const { rows: [inv] } = await c.query(
    `INSERT INTO invoices (tenant_id, subscription_id, customer_id, number, period_start, period_end, lines, amount,
                           status, due_at, paid_at, payment_id)
     VALUES ($1,$2,$3,$4, $5::timestamptz - make_interval(days => $6::int * $7::int), $5, $8, $9, 'paid', now(), now(), $10)
     RETURNING *`,
    [tenantId, s.id, s.customer_id, number, u.expires_at, periods, s.period_days,
     JSON.stringify([{ description: `${s.plan_name} × ${periods}`, quantity: periods, unit_price: s.price, total }]),
     total, paymentId]);
  return { subscription: u, invoice: inv, wasExpired, planName: s.plan_name };
}

/** PPPoE username from a name: "Jean Ndayishimiye" → "jean.ndayishimiye", made unique with digits. */
export async function suggestUsername(c, name) {
  const base = String(name || 'client').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 20) || 'client';
  let candidate = base;
  for (let i = 0; i < 50; i++) {
    // eslint-disable-next-line no-await-in-loop
    const { rowCount } = await c.query('SELECT 1 FROM subscriptions WHERE username = $1', [candidate]);
    if (!rowCount) return candidate;
    candidate = `${base}${Math.floor(100 + Math.random() * 900)}`;
  }
  return `${base}${Date.now() % 100000}`;
}
