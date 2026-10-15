// Jatelo staff only: operators, their plans and billing, platform health.
import { Router } from 'express';
import { z } from 'zod';
import { asOwner } from '../db.js';
import { h, parse, notFound, zUuid, zPage, zMoney } from '../lib/http.js';
import { TIERS } from '../services/tenants.js';

export const admin = Router();

admin.get('/stats', h(async (_req, res) => {
  const out = await asOwner(async (c) => (await c.query(
    `SELECT
       (SELECT json_object_agg(status, n) FROM (SELECT status, count(*)::int AS n FROM tenants GROUP BY status) x) AS tenants,
       (SELECT count(*)::int FROM routers) AS routers,
       (SELECT count(*)::int FROM routers WHERE status = 'online') AS routers_online,
       (SELECT count(*)::int FROM radacct WHERE acctstoptime IS NULL) AS sessions_online,
       (SELECT count(*)::int FROM subscriptions WHERE status = 'active') AS subscriptions_active,
       (SELECT coalesce(sum(amount), 0)::bigint FROM payments WHERE status = 'success' AND confirmed_at > now() - interval '30 days') AS gmv_30d,
       (SELECT coalesce(sum(amount), 0)::bigint FROM tenant_billing WHERE created_at > now() - interval '30 days') AS billing_30d,
       (SELECT count(*)::int FROM sms_messages WHERE status = 'failed' AND created_at > now() - interval '1 day') AS sms_failed_24h,
       (SELECT count(*)::int FROM sms_messages WHERE status = 'queued' AND created_at < now() - interval '10 minutes') AS sms_stuck`)).rows[0]);
  res.json(out);
}));

admin.get('/tenants', h(async (req, res) => {
  const q = parse(zPage.extend({ status: z.string().max(20).optional() }), req.query);
  const rows = await asOwner(async (c) => {
    const where = [], vals = [];
    if (q.status) { vals.push(q.status); where.push(`t.status = $${vals.length}`); }
    if (q.q) { vals.push(`%${q.q}%`); where.push(`(t.name ILIKE $${vals.length} OR t.phone ILIKE $${vals.length} OR t.email ILIKE $${vals.length})`); }
    return (await c.query(
      `SELECT t.id, t.name, t.slug, t.phone, t.email, t.tier, t.status, t.trial_ends_at, t.paid_until, t.max_routers, t.created_at,
              (SELECT count(*)::int FROM routers r WHERE r.tenant_id = t.id) AS routers,
              (SELECT count(*)::int FROM routers r WHERE r.tenant_id = t.id AND r.status = 'online') AS routers_online,
              (SELECT count(*)::int FROM subscriptions s WHERE s.tenant_id = t.id AND s.status = 'active') AS subscribers,
              (SELECT coalesce(sum(amount), 0)::bigint FROM payments p WHERE p.tenant_id = t.id AND p.status = 'success'
                 AND p.confirmed_at > now() - interval '30 days') AS gmv_30d,
              (SELECT max(last_login_at) FROM users u WHERE u.tenant_id = t.id) AS last_login_at
         FROM tenants t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY t.created_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`, vals)).rows;
  });
  res.json({ tenants: rows, tiers: TIERS });
}));

admin.patch('/tenants/:id', h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const b = parse(z.object({
    tier: z.enum(Object.keys(TIERS)).optional(),
    status: z.enum(['trial', 'active', 'read_only', 'suspended', 'closed']).optional(),
    trial_ends_at: z.coerce.date().optional(),
    max_routers: z.coerce.number().int().min(0).max(10000).optional(),
  }), req.body);
  const row = await asOwner(async (c) => {
    const lim = b.tier ? TIERS[b.tier] : null;
    const { rows: [t] } = await c.query(
      `UPDATE tenants SET tier = coalesce($1, tier), status = coalesce($2, status), trial_ends_at = coalesce($3, trial_ends_at),
              max_routers = coalesce($4, $5, max_routers),
              max_active_users = CASE WHEN $1::text IS NULL THEN max_active_users ELSE $6 END, updated_at = now()
        WHERE id = $7 RETURNING *`,
      [b.tier ?? null, b.status ?? null, b.trial_ends_at ?? null, b.max_routers ?? null, lim?.max_routers ?? null,
       lim?.max_active_users ?? null, id]);
    if (!t) throw notFound('Operator');
    await c.query(`INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, data) VALUES ($1::uuid,$2,'admin.tenant_update','tenant',$1::text,$3)`,
      [id, req.user.id, JSON.stringify(b)]);
    return t;
  });
  res.json({ tenant: row });
}));

/** Record an operator's subscription payment to Jatelo: extends paid_until and reactivates the account. */
admin.post('/tenants/:id/billing', h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const b = parse(z.object({
    tier: z.enum(['starter', 'business', 'isp', 'enterprise']),
    months: z.coerce.number().int().min(1).max(24),
    amount: zMoney,
    reference: z.string().trim().max(100).optional(),
  }), req.body);
  const out = await asOwner(async (c) => {
    const lim = TIERS[b.tier];
    const { rows: [t] } = await c.query(
      `UPDATE tenants SET tier = $1, status = 'active', max_routers = $2, max_active_users = $3,
              paid_until = greatest(coalesce(paid_until, now()), now()) + make_interval(months => $4::int), updated_at = now()
        WHERE id = $5 RETURNING *`, [b.tier, lim.max_routers, lim.max_active_users, b.months, id]);
    if (!t) throw notFound('Operator');
    const { rows: [bill] } = await c.query(
      `INSERT INTO tenant_billing (tenant_id, tier, months, amount, paid_until, reference, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [id, b.tier, b.months, b.amount, t.paid_until, b.reference ?? null, req.user.id]);
    await c.query(`INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, data) VALUES ($1::uuid,$2,'admin.billing','tenant',$1::text,$3)`,
      [id, req.user.id, JSON.stringify(b)]);
    return { tenant: t, billing: bill };
  });
  res.json(out);
}));

admin.get('/tenants/:id/billing', h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const rows = await asOwner(async (c) => (await c.query(
    `SELECT b.*, u.name AS recorded_by_name FROM tenant_billing b LEFT JOIN users u ON u.id = b.recorded_by
      WHERE b.tenant_id = $1 ORDER BY b.created_at DESC`, [id])).rows);
  res.json({ billing: rows });
}));
