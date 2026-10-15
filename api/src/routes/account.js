// Operator account: business settings, staff accounts, audit log.
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { withTenant, asOwner } from '../db.js';
import { h, parse, notFound, badRequest, conflict, forbidden, audit, zUuid, zPhone, zPage } from '../lib/http.js';
import { requireRole } from '../middleware/auth.js';

export const settings = Router();
export const staff = Router();
export const auditLog = Router();

// ───────────── Business settings ─────────────
const zSettings = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  phone: zPhone.nullable().optional(),
  email: z.string().trim().email().nullable().optional(),
  language: z.enum(['fr', 'rn', 'en']).optional(),
  settings: z.object({
    payments: z.object({
      lumicash_merchant: z.string().trim().max(30).nullable().optional(),
      ecocash_merchant: z.string().trim().max(30).nullable().optional(),
      merchant_name: z.string().trim().max(60).nullable().optional(),
    }).partial().optional(),
    reminders: z.object({
      days_before: z.array(z.number().int().min(0).max(14)).max(4).optional(),
      on_expiry: z.boolean().optional(),
    }).partial().optional(),
    receipts: z.object({ footer: z.string().max(200).nullable().optional() }).partial().optional(),
  }).partial().optional(),
});

settings.get('/', h(async (req, res) => {
  const { rows: [t] } = await asOwner((c) => c.query(
    `SELECT id, name, slug, country, currency, language, timezone, phone, email, tier, status, trial_ends_at, paid_until,
            max_routers, max_active_users, settings, created_at FROM tenants WHERE id = $1`, [req.tenantId]));
  if (!t) throw notFound('Account');
  res.json({ account: t });
}));

settings.patch('/', requireRole('owner', 'manager'), h(async (req, res) => {
  const b = parse(zSettings, req.body);
  const t = await asOwner(async (c) => {
    const { rows: [cur] } = await c.query('SELECT settings FROM tenants WHERE id = $1 FOR UPDATE', [req.tenantId]);
    const merged = { ...cur.settings };
    for (const [k, v] of Object.entries(b.settings || {})) merged[k] = { ...(merged[k] || {}), ...v };
    const { rows: [row] } = await c.query(
      `UPDATE tenants SET name = coalesce($1, name), phone = coalesce($2, phone), email = coalesce($3, email),
              language = coalesce($4, language), settings = $5, updated_at = now() WHERE id = $6
        RETURNING id, name, slug, phone, email, language, settings`,
      [b.name ?? null, b.phone ?? null, b.email ?? null, b.language ?? null, JSON.stringify(merged), req.tenantId]);
    await c.query(
      `INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, data) VALUES ($1,$2,'settings.update','tenant',$1,$3)`,
      [req.tenantId, req.user.id, JSON.stringify(b)]);
    return row;
  });
  res.json({ account: t });
}));

// ───────────── Staff ─────────────
const STAFF_ROLES = ['owner', 'manager', 'technician', 'cashier'];
const zStaff = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  phone: zPhone.nullable().optional(),
  role: z.enum(STAFF_ROLES),
  password: z.string().min(8).max(128),
  language: z.enum(['fr', 'rn', 'en']).optional(),
}).refine((b) => b.email || b.phone, { message: 'Email or phone is required', path: ['email'] });

staff.get('/', requireRole('owner', 'manager'), h(async (req, res) => {
  const rows = await withTenant(req.tenantId, async (c) => (await c.query(
    `SELECT id, name, email, phone, role, status, language, last_login_at, created_at FROM users
      WHERE tenant_id = $1 AND role <> 'agent' ORDER BY role, name`, [req.tenantId])).rows);
  res.json({ staff: rows });
}));

staff.post('/', requireRole('owner'), h(async (req, res) => {
  const b = parse(zStaff, req.body);
  const row = await withTenant(req.tenantId, async (c) => {
    const hash = await bcrypt.hash(b.password, 11);
    const { rows: [u] } = await c.query(
      `INSERT INTO users (tenant_id, name, email, phone, password_hash, role, language)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, email, phone, role, status, language, created_at`,
      [req.tenantId, b.name, b.email ?? null, b.phone ?? null, hash, b.role, b.language ?? 'fr']);
    await audit(c, req, 'staff.create', 'user', u.id, { name: u.name, role: u.role });
    return u;
  }).catch((e) => { if (e.code === '23505') throw conflict('This email or phone already has an account'); throw e; });
  res.status(201).json({ user: row });
}));

staff.patch('/:id', requireRole('owner'), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const b = parse(z.object({
    name: z.string().trim().min(1).max(80).optional(),
    role: z.enum(STAFF_ROLES).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    password: z.string().min(8).max(128).optional(),
  }), req.body);
  if (id === req.user.id && (b.role && b.role !== 'owner' || b.status === 'disabled')) {
    throw forbidden('You cannot demote or disable your own account');
  }
  const row = await withTenant(req.tenantId, async (c) => {
    const hash = b.password ? await bcrypt.hash(b.password, 11) : null;
    const { rows: [u] } = await c.query(
      `UPDATE users SET name = coalesce($1, name), role = coalesce($2, role), status = coalesce($3, status),
              password_hash = coalesce($4, password_hash)
        WHERE id = $5 AND tenant_id = $6 AND role <> 'agent'
        RETURNING id, name, email, phone, role, status, language`,
      [b.name ?? null, b.role ?? null, b.status ?? null, hash, id, req.tenantId]);
    if (!u) throw notFound('Staff member');
    if (b.status === 'disabled' || b.password) {
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    }
    const { rows: [{ n }] } = await c.query(
      `SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND role = 'owner' AND status = 'active'`, [req.tenantId]);
    if (n === 0) throw badRequest('The account must keep at least one active owner');
    await audit(c, req, 'staff.update', 'user', id, { ...b, password: b.password ? '***' : undefined });
    return u;
  });
  res.json({ user: row });
}));

// ───────────── Audit log ─────────────
auditLog.get('/', requireRole('owner', 'manager'), h(async (req, res) => {
  const q = parse(zPage.extend({ entity: z.string().max(40).optional(), entity_id: z.string().max(60).optional() }), req.query);
  const rows = await withTenant(req.tenantId, async (c) => {
    const vals = []; const where = [];
    if (q.entity) { vals.push(q.entity); where.push(`a.entity = $${vals.length}`); }
    if (q.entity_id) { vals.push(q.entity_id); where.push(`a.entity_id = $${vals.length}`); }
    return (await c.query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.data, host(a.ip) AS ip, a.created_at, u.name AS user_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ${q.limit} OFFSET ${q.offset}`, vals)).rows;
  });
  res.json({ entries: rows });
}));
