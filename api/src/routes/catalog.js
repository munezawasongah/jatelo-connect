// Sites (locations + portal branding), hotspot packages and PPPoE plans.
import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { h, parse, notFound, audit, zUuid, zMoney, conflict } from '../lib/http.js';
import { requireRole, ROLES } from '../middleware/auth.js';
import { slugify } from '../services/tenants.js';

export const sites = Router();
export const packages = Router();
export const plans = Router();

// Builds "SET a = $1, b = $2" from defined keys
function updateSql(table, body, id, jsonKeys = []) {
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    vals.push(jsonKeys.includes(k) && v !== null ? JSON.stringify(v) : v);
    sets.push(`${k} = $${vals.length}`);
  }
  vals.push(id);
  return sets.length ? { sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals } : null;
}

// ───────────── Sites ─────────────
const zPortal = z.object({
  brand: z.string().trim().max(60).optional(),
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logo_url: z.string().url().max(500).nullable().optional(),
  languages: z.array(z.enum(['fr', 'rn', 'en'])).min(1).optional(),
  default_language: z.enum(['fr', 'rn', 'en']).optional(),
  trial_enabled: z.boolean().optional(),
  support_phone: z.string().max(30).nullable().optional(),
  welcome: z.object({ fr: z.string().max(300), rn: z.string().max(300), en: z.string().max(300) }).partial().optional(),
  terms: z.string().max(5000).nullable().optional(),
}).strict();

const zSite = z.object({
  name: z.string().trim().min(1).max(80),
  address: z.string().trim().max(200).nullable().optional(),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
  portal: zPortal.optional(),
});

sites.get('/', h(async (req, res) => {
  const rows = await withTenant(req.tenantId, async (c) => (await c.query(
    `SELECT s.*, (SELECT count(*)::int FROM routers r WHERE r.site_id = s.id) AS routers
       FROM sites s ORDER BY s.created_at`)).rows);
  res.json({ sites: rows });
}));

sites.post('/', requireRole(...ROLES.admin), h(async (req, res) => {
  const b = parse(zSite, req.body);
  const row = await withTenant(req.tenantId, async (c) => {
    const base = slugify(b.name);
    let slug = base, n = 1;
    while ((await c.query('SELECT 1 FROM sites WHERE slug = $1', [slug])).rowCount) slug = `${base}-${++n}`;
    const { rows: [s] } = await c.query(
      `INSERT INTO sites (tenant_id, name, slug, address, latitude, longitude, portal)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.tenantId, b.name, slug, b.address ?? null, b.latitude ?? null, b.longitude ?? null,
       JSON.stringify({ brand: b.name, primary_color: '#0E7C66', languages: ['fr', 'rn', 'en'], default_language: 'fr', trial_enabled: true, ...(b.portal || {}) })],
    );
    await audit(c, req, 'site.create', 'site', s.id, { name: s.name });
    return s;
  });
  res.status(201).json({ site: row });
}));

sites.patch('/:id', requireRole(...ROLES.admin), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const b = parse(zSite.partial(), req.body);
  const row = await withTenant(req.tenantId, async (c) => {
    const { rows: [cur] } = await c.query('SELECT * FROM sites WHERE id = $1', [id]);
    if (!cur) throw notFound('Site');
    if (b.portal) b.portal = { ...cur.portal, ...b.portal }; // merge portal settings
    const q = updateSql('sites', b, id, ['portal']);
    const out = q ? (await c.query(q.sql, q.vals)).rows[0] : cur;
    await audit(c, req, 'site.update', 'site', id, b);
    return out;
  });
  res.json({ site: row });
}));

sites.delete('/:id', requireRole('owner'), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  await withTenant(req.tenantId, async (c) => {
    const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM sites');
    if (n <= 1) throw conflict('You need at least one site');
    const { rowCount } = await c.query('DELETE FROM sites WHERE id = $1', [id]);
    if (!rowCount) throw notFound('Site');
    await audit(c, req, 'site.delete', 'site', id);
  });
  res.json({ ok: true });
}));

// ───────────── Hotspot packages ─────────────
const zPackage = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).nullable().optional(),
  price: zMoney,
  duration_minutes: z.coerce.number().int().min(1).max(525600).nullable().optional(),
  data_limit_mb: z.coerce.number().int().min(1).max(10_000_000).nullable().optional(),
  rate_up_kbps: z.coerce.number().int().min(64).max(10_000_000).nullable().optional(),
  rate_down_kbps: z.coerce.number().int().min(64).max(10_000_000).nullable().optional(),
  device_limit: z.coerce.number().int().min(1).max(20).optional(),
  is_trial: z.boolean().optional(),
  visible_on_portal: z.boolean().optional(),
  active: z.boolean().optional(),
  sort_order: z.coerce.number().int().optional(),
  site_ids: z.array(zUuid).nullable().optional(),
});
const needsLimit = (b) => b.duration_minutes || b.data_limit_mb;

packages.get('/', h(async (req, res) => {
  const rows = await withTenant(req.tenantId, async (c) => (await c.query(
    `SELECT p.*,
       (SELECT count(*)::int FROM vouchers v WHERE v.package_id = p.id) AS vouchers_total,
       (SELECT count(*)::int FROM vouchers v WHERE v.package_id = p.id AND v.status = 'unused') AS vouchers_unused
     FROM packages p ORDER BY p.active DESC, p.sort_order, p.price`)).rows);
  res.json({ packages: rows });
}));

packages.post('/', requireRole(...ROLES.admin), h(async (req, res) => {
  const b = parse(zPackage.refine(needsLimit, { message: 'Set a duration, a data limit, or both', path: ['duration_minutes'] }), req.body);
  const row = await withTenant(req.tenantId, async (c) => {
    if (b.is_trial) await c.query('UPDATE packages SET is_trial = false WHERE is_trial');
    const { rows: [p] } = await c.query(
      `INSERT INTO packages (tenant_id, name, description, price, duration_minutes, data_limit_mb, rate_up_kbps,
         rate_down_kbps, device_limit, is_trial, visible_on_portal, active, sort_order, site_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.tenantId, b.name, b.description ?? null, b.is_trial ? 0 : b.price, b.duration_minutes ?? null,
       b.data_limit_mb ?? null, b.rate_up_kbps ?? null, b.rate_down_kbps ?? null, b.device_limit ?? 1,
       b.is_trial ?? false, b.is_trial ? false : (b.visible_on_portal ?? true), b.active ?? true, b.sort_order ?? 0, b.site_ids ?? null],
    );
    await audit(c, req, 'package.create', 'package', p.id, { name: p.name, price: p.price });
    return p;
  });
  res.status(201).json({ package: row });
}));

packages.patch('/:id', requireRole(...ROLES.admin), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const b = parse(zPackage.partial(), req.body);
  const row = await withTenant(req.tenantId, async (c) => {
    const { rows: [cur] } = await c.query('SELECT * FROM packages WHERE id = $1', [id]);
    if (!cur) throw notFound('Package');
    const merged = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
    if (!needsLimit(merged)) throw conflict('A package needs a duration, a data limit, or both');
    if (b.is_trial) {
      await c.query('UPDATE packages SET is_trial = false WHERE is_trial AND id <> $1', [id]);
      b.price = 0; b.visible_on_portal = false;
    }
    const q = updateSql('packages', b, id);
    const out = q ? (await c.query(q.sql, q.vals)).rows[0] : cur;
    await audit(c, req, 'package.update', 'package', id, b);
    return out;
  });
  res.json({ package: row, note: 'Vouchers already sold keep the terms they were sold with.' });
}));

packages.delete('/:id', requireRole(...ROLES.admin), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const result = await withTenant(req.tenantId, async (c) => {
    const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM vouchers WHERE package_id = $1', [id]);
    if (n > 0) {
      await c.query('UPDATE packages SET active = false, visible_on_portal = false WHERE id = $1', [id]);
      await audit(c, req, 'package.archive', 'package', id);
      return { archived: true };
    }
    const { rowCount } = await c.query('DELETE FROM packages WHERE id = $1', [id]);
    if (!rowCount) throw notFound('Package');
    await audit(c, req, 'package.delete', 'package', id);
    return { deleted: true };
  });
  res.json(result);
}));

// ───────────── PPPoE plans ─────────────
const zPlan = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).nullable().optional(),
  price: zMoney,
  period_days: z.coerce.number().int().min(1).max(366).optional(),
  rate_up_kbps: z.coerce.number().int().min(64).max(10_000_000),
  rate_down_kbps: z.coerce.number().int().min(64).max(10_000_000),
  burst: z.object({
    up_kbps: z.number().int().min(64), down_kbps: z.number().int().min(64),
    threshold_pct: z.number().int().min(10).max(100).optional(), time_s: z.number().int().min(1).max(600).optional(),
  }).nullable().optional(),
  data_cap_mb: z.coerce.number().int().min(1).nullable().optional(),
  fup_rate_up_kbps: z.coerce.number().int().min(64).nullable().optional(),
  fup_rate_down_kbps: z.coerce.number().int().min(64).nullable().optional(),
  active: z.boolean().optional(),
});

plans.get('/', h(async (req, res) => {
  const rows = await withTenant(req.tenantId, async (c) => (await c.query(
    `SELECT p.*, (SELECT count(*)::int FROM subscriptions s WHERE s.plan_id = p.id AND s.status IN ('active','expired')) AS subscribers
       FROM plans p ORDER BY p.active DESC, p.price`)).rows);
  res.json({ plans: rows });
}));

plans.post('/', requireRole(...ROLES.admin), h(async (req, res) => {
  const b = parse(zPlan, req.body);
  const row = await withTenant(req.tenantId, async (c) => {
    const { rows: [p] } = await c.query(
      `INSERT INTO plans (tenant_id, name, description, price, period_days, rate_up_kbps, rate_down_kbps, burst,
         data_cap_mb, fup_rate_up_kbps, fup_rate_down_kbps, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.tenantId, b.name, b.description ?? null, b.price, b.period_days ?? 30, b.rate_up_kbps, b.rate_down_kbps,
       b.burst ? JSON.stringify(b.burst) : null, b.data_cap_mb ?? null, b.fup_rate_up_kbps ?? null,
       b.fup_rate_down_kbps ?? null, b.active ?? true],
    );
    await audit(c, req, 'plan.create', 'plan', p.id, { name: p.name, price: p.price });
    return p;
  });
  res.status(201).json({ plan: row });
}));

plans.patch('/:id', requireRole(...ROLES.admin), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const b = parse(zPlan.partial(), req.body);
  const row = await withTenant(req.tenantId, async (c) => {
    const q = updateSql('plans', b, id, ['burst']);
    const { rows } = q ? await c.query(q.sql, q.vals) : await c.query('SELECT * FROM plans WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Plan');
    await audit(c, req, 'plan.update', 'plan', id, b);
    return rows[0];
  });
  res.json({ plan: row, note: 'Speed changes apply to each subscriber at their next connection.' });
}));

plans.delete('/:id', requireRole(...ROLES.admin), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const result = await withTenant(req.tenantId, async (c) => {
    const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM subscriptions WHERE plan_id = $1', [id]);
    if (n > 0) {
      await c.query('UPDATE plans SET active = false WHERE id = $1', [id]);
      return { archived: true };
    }
    const { rowCount } = await c.query('DELETE FROM plans WHERE id = $1', [id]);
    if (!rowCount) throw notFound('Plan');
    await audit(c, req, 'plan.delete', 'plan', id);
    return { deleted: true };
  });
  res.json(result);
}));
