// Dashboard data: home summary, revenue series, live sessions, router bandwidth,
// alerts, reports, and the real-time event stream.
import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { h, parse, notFound, audit, zUuid } from '../lib/http.js';
import { requireRole, ROLES } from '../middleware/auth.js';
import { disconnectEverywhere } from '../services/sessions.js';
import { subscribe } from '../services/events.js';

export const dashboard = Router();
export const sessions = Router();
export const alerts = Router();
export const reports = Router();
export const events = Router();

// Local-day boundaries use the operator's time zone
const TODAY = `date_trunc('day', now() AT TIME ZONE t.timezone) AT TIME ZONE t.timezone`;

dashboard.get('/summary', h(async (req, res) => {
  const out = await withTenant(req.tenantId, async (c) => {
    const { rows: [k] } = await c.query(
      `SELECT
         (SELECT coalesce(sum(amount),0)::bigint FROM payments WHERE status='success' AND confirmed_at >= ${TODAY}) AS revenue_today,
         (SELECT coalesce(sum(amount),0)::bigint FROM payments WHERE status='success'
            AND confirmed_at >= ${TODAY} - interval '1 day' AND confirmed_at < ${TODAY}) AS revenue_yesterday,
         (SELECT coalesce(sum(amount),0)::bigint FROM payments WHERE status='success'
            AND confirmed_at >= date_trunc('month', now() AT TIME ZONE t.timezone) AT TIME ZONE t.timezone) AS revenue_month,
         (SELECT count(*)::int FROM radacct WHERE tenant_id = t.id AND acctstoptime IS NULL AND voucher_id IS NOT NULL) AS online_hotspot,
         (SELECT count(*)::int FROM radacct WHERE tenant_id = t.id AND acctstoptime IS NULL AND subscription_id IS NOT NULL) AS online_pppoe,
         (SELECT count(*)::int FROM routers) AS routers_total,
         (SELECT count(*)::int FROM routers WHERE status = 'online') AS routers_online,
         (SELECT count(*)::int FROM routers WHERE status = 'offline') AS routers_offline,
         (SELECT count(*)::int FROM routers WHERE status = 'pending') AS routers_pending,
         (SELECT count(*)::int FROM subscriptions WHERE status = 'active') AS subs_active,
         (SELECT count(*)::int FROM subscriptions WHERE status = 'expired') AS subs_expired,
         (SELECT count(*)::int FROM subscriptions WHERE status = 'active' AND expires_at < now() + interval '7 days') AS subs_expiring,
         (SELECT count(*)::int FROM vouchers WHERE status = 'unused') AS vouchers_unused,
         (SELECT count(*)::int FROM vouchers WHERE status = 'active') AS vouchers_active,
         (SELECT count(*)::int FROM payments WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > now())
            AND purpose = 'hotspot') AS payments_pending,
         (SELECT count(*)::int FROM inbound_sms WHERE matched_payment_id IS NULL AND parsed_amount IS NOT NULL
            AND received_at > now() - interval '7 days') AS sms_unmatched,
         (SELECT count(*)::int FROM service_requests WHERE status = 'new') AS requests_new,
         (SELECT count(*)::int FROM payment_channels WHERE active) AS channels,
         (SELECT count(*)::int FROM sms_gateways WHERE active) AS gateways
       FROM tenants t WHERE t.id = current_setting('app.tenant_id')::uuid`);
    const { rows: byChannel } = await c.query(
      `SELECT channel, coalesce(wallet, '') AS wallet, sum(amount)::bigint AS amount, count(*)::int AS n
         FROM payments p, tenants t WHERE t.id = p.tenant_id AND p.status = 'success' AND p.confirmed_at >= ${TODAY}
        GROUP BY 1, 2 ORDER BY 3 DESC`);
    const { rows: openAlerts } = await c.query(
      `SELECT id, kind, entity_id, message, severity, created_at FROM alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 20`);
    const { rows: recent } = await c.query(
      `SELECT p.id, p.channel, p.wallet, p.purpose, p.amount, p.phone, p.reference, p.status, p.created_at, p.confirmed_at,
              coalesce(pk.name, pl.name) AS item_name
         FROM payments p
         LEFT JOIN packages pk ON p.purpose = 'hotspot' AND pk.id = p.purpose_id
         LEFT JOIN subscriptions s ON p.purpose = 'subscription' AND s.id = p.purpose_id LEFT JOIN plans pl ON pl.id = s.plan_id
        WHERE p.status IN ('success','pending') ORDER BY p.created_at DESC LIMIT 8`);
    const { rows: expiring } = await c.query(
      `SELECT s.id, s.username, s.expires_at, cu.name AS customer_name, cu.phone AS customer_phone, pl.name AS plan_name, pl.price
         FROM subscriptions s JOIN customers cu ON cu.id = s.customer_id JOIN plans pl ON pl.id = s.plan_id
        WHERE s.status = 'active' AND s.expires_at < now() + interval '7 days' ORDER BY s.expires_at LIMIT 10`);
    return { kpis: k, revenue_today_by_channel: byChannel, alerts: openAlerts, recent_payments: recent, expiring };
  });
  res.json(out);
}));

dashboard.get('/revenue', h(async (req, res) => {
  const { days } = parse(z.object({ days: z.coerce.number().int().min(7).max(366).default(30) }), req.query);
  const rows = await withTenant(req.tenantId, async (c) => (await c.query(
    `WITH t AS (SELECT timezone FROM tenants WHERE id = current_setting('app.tenant_id')::uuid),
          d AS (SELECT generate_series((now() AT TIME ZONE (SELECT timezone FROM t))::date - ($1::int - 1),
                                       (now() AT TIME ZONE (SELECT timezone FROM t))::date, '1 day')::date AS day)
     SELECT d.day::text AS day,
            coalesce(sum(p.amount) FILTER (WHERE p.purpose = 'hotspot'), 0)::bigint AS hotspot,
            coalesce(sum(p.amount) FILTER (WHERE p.purpose = 'subscription'), 0)::bigint AS subscription,
            coalesce(sum(p.amount) FILTER (WHERE p.purpose = 'agent_topup'), 0)::bigint AS agents
       FROM d LEFT JOIN payments p ON p.status = 'success'
        AND (p.confirmed_at AT TIME ZONE (SELECT timezone FROM t))::date = d.day
      GROUP BY d.day ORDER BY d.day`, [days])).rows);
  res.json({ days: rows });
}));

// ───────────── Live sessions ─────────────
sessions.get('/', h(async (req, res) => {
  const q = parse(z.object({
    type: z.enum(['hotspot', 'pppoe']).optional(), router_id: zUuid.optional(), q: z.string().trim().max(60).optional(),
  }), req.query);
  const rows = await withTenant(req.tenantId, async (c) => {
    const where = ['a.acctstoptime IS NULL', 'a.tenant_id = current_setting(\'app.tenant_id\')::uuid'], vals = [];
    if (q.type === 'hotspot') where.push('a.voucher_id IS NOT NULL');
    if (q.type === 'pppoe') where.push('a.subscription_id IS NOT NULL');
    if (q.router_id) { vals.push(q.router_id); where.push(`a.router_id = $${vals.length}`); }
    if (q.q) { vals.push(`%${q.q}%`); where.push(`(a.username ILIKE $${vals.length} OR a.callingstationid ILIKE $${vals.length} OR cu.phone ILIKE $${vals.length} OR cu.name ILIKE $${vals.length})`); }
    return (await c.query(
      `SELECT a.radacctid AS id, a.username, CASE WHEN a.subscription_id IS NOT NULL THEN 'pppoe' ELSE 'hotspot' END AS type,
              a.acctstarttime AS started_at, a.acctupdatetime AS updated_at,
              coalesce(a.acctsessiontime, 0) + extract(epoch FROM now() - coalesce(a.acctupdatetime, a.acctstarttime))::int AS seconds,
              coalesce(a.acctinputoctets, 0) AS upload_bytes, coalesce(a.acctoutputoctets, 0) AS download_bytes,
              host(a.framedipaddress) AS ip, a.callingstationid AS mac, r.id AS router_id, r.name AS router_name,
              coalesce(pk.name, pl.name) AS product, cu.name AS customer_name, cu.phone AS customer_phone,
              v.expires_at AS voucher_expires_at, s.expires_at AS subscription_expires_at, v.id AS voucher_id, s.id AS subscription_id
         FROM radacct a LEFT JOIN routers r ON r.id = a.router_id
         LEFT JOIN vouchers v ON v.id = a.voucher_id LEFT JOIN packages pk ON pk.id = v.package_id
         LEFT JOIN subscriptions s ON s.id = a.subscription_id LEFT JOIN plans pl ON pl.id = s.plan_id
         LEFT JOIN customers cu ON cu.id = coalesce(s.customer_id, v.customer_id)
        WHERE ${where.join(' AND ')} ORDER BY a.acctstarttime DESC LIMIT 1000`, vals)).rows;
  });
  res.json({ sessions: rows });
}));

sessions.post('/disconnect', requireRole(...ROLES.subscribers), h(async (req, res) => {
  const b = parse(z.object({ username: z.string().min(1).max(64), type: z.enum(['hotspot', 'pppoe']) }), req.body);
  await withTenant(req.tenantId, (c) => audit(c, req, 'session.disconnect', 'session', b.username, b));
  const n = await disconnectEverywhere({ tenantId: req.tenantId, username: b.username, kind: b.type }, req.log);
  res.json({ disconnected: n });
}));

// ───────────── Router bandwidth ─────────────
export const routerTraffic = h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const { hours, iface } = parse(z.object({ hours: z.coerce.number().int().min(1).max(744).default(24), iface: z.string().max(40).optional() }), req.query);
  const bucket = hours <= 6 ? 60 : hours <= 48 ? 300 : hours <= 240 ? 3600 : 21600; // seconds
  const out = await withTenant(req.tenantId, async (c) => {
    const { rows: [r] } = await c.query('SELECT id, wan_interface FROM routers WHERE id = $1', [id]);
    if (!r) throw notFound('Router');
    const { rows: ifaces } = await c.query(
      `SELECT iface, max(greatest(rx_bps, tx_bps))::bigint AS peak FROM router_traffic
        WHERE router_id = $1 AND ts > now() - make_interval(hours => $2) GROUP BY iface ORDER BY peak DESC`, [id, hours]);
    const pick = iface || (ifaces.find((i) => i.iface === r.wan_interface) ? r.wan_interface : ifaces[0]?.iface);
    const { rows: points } = pick ? await c.query(
      `SELECT to_timestamp(floor(extract(epoch FROM ts) / $3) * $3) AS ts,
              avg(rx_bps)::bigint AS rx_bps, avg(tx_bps)::bigint AS tx_bps, max(rx_bps)::bigint AS rx_peak, max(tx_bps)::bigint AS tx_peak
         FROM router_traffic WHERE router_id = $1 AND iface = $2 AND ts > now() - make_interval(hours => $4)
        GROUP BY 1 ORDER BY 1`, [id, pick, bucket, hours]) : { rows: [] };
    return { iface: pick ?? null, interfaces: ifaces, bucket_seconds: bucket, points };
  });
  res.json(out);
});

// ───────────── Alerts ─────────────
alerts.get('/', h(async (req, res) => {
  const { all } = parse(z.object({ all: z.enum(['true', 'false']).optional() }), req.query);
  const rows = await withTenant(req.tenantId, async (c) => (await c.query(
    `SELECT * FROM alerts ${all === 'true' ? '' : 'WHERE resolved_at IS NULL'} ORDER BY created_at DESC LIMIT 200`)).rows);
  res.json({ alerts: rows });
}));

alerts.post('/:id/resolve', h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  await withTenant(req.tenantId, async (c) => {
    const { rowCount } = await c.query('UPDATE alerts SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL', [id]);
    if (!rowCount) throw notFound('Open alert');
    await audit(c, req, 'alert.resolve', 'alert', id);
  });
  res.json({ ok: true });
}));

// ───────────── Reports ─────────────
const GROUPS = {
  day: { key: `(p.confirmed_at AT TIME ZONE t.timezone)::date::text`, label: 'Day' },
  channel: { key: `p.channel || coalesce(':' || p.wallet, '')`, label: 'Channel' },
  purpose: { key: 'p.purpose', label: 'Type' },
  package: { key: `coalesce(pk.name, pl.name, p.purpose)`, label: 'Product' },
  site: { key: `coalesce(si.name, '—')`, label: 'Site' },
  agent: { key: `coalesce(ag.name, '—')`, label: 'Agent' },
};

reports.get('/revenue', requireRole('owner', 'manager'), h(async (req, res) => {
  const q = parse(z.object({
    from: z.coerce.date(), to: z.coerce.date(), group: z.enum(Object.keys(GROUPS)).default('day'),
    format: z.enum(['json', 'csv']).default('json'),
  }), req.query);
  const g = GROUPS[q.group];
  const rows = await withTenant(req.tenantId, async (c) => (await c.query(
    `SELECT ${g.key} AS key, count(*)::int AS payments, sum(p.amount)::bigint AS amount
       FROM payments p JOIN tenants t ON t.id = p.tenant_id
       LEFT JOIN packages pk ON p.purpose = 'hotspot' AND pk.id = p.purpose_id
       LEFT JOIN subscriptions s ON p.purpose = 'subscription' AND s.id = p.purpose_id LEFT JOIN plans pl ON pl.id = s.plan_id
       LEFT JOIN sites si ON si.id = p.site_id
       LEFT JOIN agents ag ON p.purpose = 'agent_topup' AND ag.id = p.purpose_id
      WHERE p.status = 'success' AND p.confirmed_at >= $1 AND p.confirmed_at < $2
      GROUP BY 1 ORDER BY ${q.group === 'day' ? '1' : '3 DESC'}`, [q.from, q.to])).rows);
  if (q.format === 'csv') {
    res.type('text/csv').attachment(`revenue-${q.group}.csv`);
    return res.send([`${g.label},Payments,Amount`, ...rows.map((r) => `"${String(r.key).replace(/"/g, '""')}",${r.payments},${r.amount}`)].join('\n'));
  }
  res.json({ group: q.group, rows, total: rows.reduce((s, r) => s + r.amount, 0) });
}));

/** Voucher sales by agent: face value of vouchers each agent bought and how many were used. */
reports.get('/agents', requireRole('owner', 'manager'), h(async (req, res) => {
  const q = parse(z.object({ from: z.coerce.date(), to: z.coerce.date() }), req.query);
  const rows = await withTenant(req.tenantId, async (c) => (await c.query(
    `SELECT a.id, a.name, count(v.id)::int AS vouchers, coalesce(sum(v.price), 0)::bigint AS face_value,
            count(v.id) FILTER (WHERE v.status <> 'unused')::int AS used,
            coalesce((SELECT sum(-l.amount) FROM agent_ledger l WHERE l.agent_id = a.id AND l.kind = 'purchase'
                       AND l.created_at >= $1 AND l.created_at < $2), 0)::bigint AS paid_to_operator
       FROM agents a LEFT JOIN vouchers v ON v.agent_id = a.id AND v.created_at >= $1 AND v.created_at < $2
      GROUP BY a.id ORDER BY face_value DESC`, [q.from, q.to])).rows);
  res.json({ rows });
}));

/** Subscriber movement: new, renewed, lapsed (expired more than 7 days and not renewed), ARPU. */
reports.get('/subscribers', requireRole('owner', 'manager'), h(async (req, res) => {
  const q = parse(z.object({ from: z.coerce.date(), to: z.coerce.date() }), req.query);
  const out = await withTenant(req.tenantId, async (c) => (await c.query(
    `SELECT
       (SELECT count(*)::int FROM subscriptions WHERE created_at >= $1 AND created_at < $2) AS new,
       (SELECT count(DISTINCT subscription_id)::int FROM invoices WHERE paid_at >= $1 AND paid_at < $2) AS renewed,
       (SELECT count(*)::int FROM subscriptions WHERE status = 'expired' AND expires_at < now() - interval '7 days'
          AND expires_at >= $1 AND expires_at < $2) AS lapsed,
       (SELECT count(*)::int FROM subscriptions WHERE status = 'active') AS active,
       (SELECT coalesce(sum(amount), 0)::bigint FROM payments WHERE status = 'success' AND purpose = 'subscription'
          AND confirmed_at >= $1 AND confirmed_at < $2) AS revenue`, [q.from, q.to])).rows[0]);
  out.arpu = out.active ? Math.round(out.revenue / out.active) : 0;
  res.json(out);
}));

/** Data used per day and the heaviest users. */
reports.get('/usage', requireRole('owner', 'manager', 'technician'), h(async (req, res) => {
  const q = parse(z.object({ from: z.coerce.date(), to: z.coerce.date() }), req.query);
  const out = await withTenant(req.tenantId, async (c) => {
    const { rows: days } = await c.query(
      `SELECT (a.acctstarttime AT TIME ZONE t.timezone)::date::text AS day, count(*)::int AS sessions,
              (sum(coalesce(a.acctinputoctets,0) + coalesce(a.acctoutputoctets,0)))::bigint AS bytes
         FROM radacct a JOIN tenants t ON t.id = a.tenant_id
        WHERE a.tenant_id = current_setting('app.tenant_id')::uuid AND a.acctstarttime >= $1 AND a.acctstarttime < $2
        GROUP BY 1 ORDER BY 1`, [q.from, q.to]);
    const { rows: top } = await c.query(
      `SELECT a.username, CASE WHEN a.subscription_id IS NOT NULL THEN 'pppoe' ELSE 'hotspot' END AS type,
              (sum(coalesce(a.acctinputoctets,0) + coalesce(a.acctoutputoctets,0)))::bigint AS bytes, count(*)::int AS sessions
         FROM radacct a WHERE a.tenant_id = current_setting('app.tenant_id')::uuid AND a.acctstarttime >= $1 AND a.acctstarttime < $2
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`, [q.from, q.to]);
    return { days, top };
  });
  res.json(out);
}));

// ───────────── Real-time stream ─────────────
events.get('/', h(async (req, res) => {
  await subscribe(req.tenantId, req, res, req.log);
}));
