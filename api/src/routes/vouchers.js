// Vouchers (batches, counter sales, disable, device reset) and agents (resellers).
import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { h, parse, notFound, badRequest, conflict, audit, zUuid, zPage, zPhone } from '../lib/http.js';
import { randomCode } from '../lib/crypto.js';
import { requireRole, ROLES } from '../middleware/auth.js';
import { issueVouchers, describeEntitlement } from '../services/vouchers.js';
import { disconnectEverywhere } from '../services/sessions.js';
import bcrypt from 'bcryptjs';

export const vouchers = Router();
export const agents = Router();
export const agentSelf = Router(); // what a logged-in agent can do

async function loadPackage(c, id) {
  const { rows: [p] } = await c.query('SELECT * FROM packages WHERE id = $1', [id]);
  if (!p) throw notFound('Package');
  if (!p.active) throw badRequest('This package is archived');
  return p;
}

// Debit an agent's float atomically and write the ledger line.
async function debitAgent(c, agentId, amount, reference, userId) {
  const { rows: [a] } = await c.query(
    `UPDATE agents SET balance = balance - $1 WHERE id = $2 AND active AND balance >= $1 RETURNING balance`, [amount, agentId]);
  if (!a) throw conflict('Agent balance is too low for this purchase');
  await c.query(
    `INSERT INTO agent_ledger (tenant_id, agent_id, amount, balance_after, kind, reference, user_id)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, 'purchase', $4, $5)`,
    [agentId, -amount, a.balance, reference, userId]);
  return a.balance;
}

const agentCost = (pkg, qty, agent) => Math.round(pkg.price * qty * (1 - Number(agent.discount_pct) / 100));

// ───────────── Vouchers ─────────────
vouchers.get('/', h(async (req, res) => {
  const q = parse(zPage.extend({
    status: z.enum(['unused', 'active', 'expired', 'exhausted', 'disabled']).optional(),
    package_id: zUuid.optional(), batch_id: zUuid.optional(), agent_id: zUuid.optional(),
  }), req.query);
  const out = await withTenant(req.tenantId, async (c) => {
    const where = [], vals = [];
    const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
    if (q.status) add('v.status = ?', q.status);
    if (q.package_id) add('v.package_id = ?', q.package_id);
    if (q.batch_id) add('v.batch_id = ?', q.batch_id);
    if (q.agent_id) add('v.agent_id = ?', q.agent_id);
    if (q.q) add('(v.code ILIKE ? OR cu.phone ILIKE ?)'.replace('?', `$${vals.length + 2}`), `%${q.q}%`);
    if (q.q) vals.push(`%${q.q}%`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await c.query(
      `SELECT v.id, v.code, v.status, v.source, v.price, v.duration_minutes, v.data_limit_mb, v.rate_down_kbps,
              v.device_limit, v.device_macs, v.bytes_used, v.seconds_used, v.activated_at, v.expires_at, v.sold_at,
              v.created_at, p.name AS package_name, a.name AS agent_name, cu.phone AS customer_phone,
              EXISTS (SELECT 1 FROM radacct r WHERE r.voucher_id = v.id AND r.acctstoptime IS NULL) AS online
         FROM vouchers v JOIN packages p ON p.id = v.package_id
         LEFT JOIN agents a ON a.id = v.agent_id LEFT JOIN customers cu ON cu.id = v.customer_id
         ${w} ORDER BY v.created_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`, vals);
    const { rows: [{ total }] } = await c.query(
      `SELECT count(*)::int AS total FROM vouchers v LEFT JOIN customers cu ON cu.id = v.customer_id ${w}`, vals);
    return { vouchers: rows, total };
  });
  res.json(out);
}));

vouchers.get('/batches', h(async (req, res) => {
  const rows = await withTenant(req.tenantId, async (c) => (await c.query(
    `SELECT b.*, p.name AS package_name, a.name AS agent_name, u.name AS created_by_name,
            count(v.id) FILTER (WHERE v.status = 'unused')::int AS unused,
            count(v.id) FILTER (WHERE v.status <> 'unused')::int AS used
       FROM voucher_batches b JOIN packages p ON p.id = b.package_id
       LEFT JOIN agents a ON a.id = b.agent_id LEFT JOIN users u ON u.id = b.created_by
       LEFT JOIN vouchers v ON v.batch_id = b.id
      GROUP BY b.id, p.name, a.name, u.name ORDER BY b.created_at DESC LIMIT 200`)).rows);
  res.json({ batches: rows });
}));

const zBatch = z.object({
  package_id: zUuid,
  quantity: z.coerce.number().int().min(1).max(5000),
  agent_id: zUuid.nullable().optional(),
  charge_agent: z.boolean().default(false),  // debit the agent's float for this batch
  code_length: z.coerce.number().int().min(6).max(12).default(8),
  note: z.string().trim().max(200).nullable().optional(),
});

vouchers.post('/batches', requireRole(...ROLES.sales), h(async (req, res) => {
  const b = parse(zBatch, req.body);
  const out = await withTenant(req.tenantId, async (c) => {
    const pkg = await loadPackage(c, b.package_id);
    let agent = null;
    if (b.agent_id) {
      ({ rows: [agent] } = await c.query('SELECT * FROM agents WHERE id = $1 AND active', [b.agent_id]));
      if (!agent) throw badRequest('Unknown or inactive agent');
    }
    const { rows: [batch] } = await c.query(
      `INSERT INTO voucher_batches (tenant_id, package_id, agent_id, quantity, unit_price, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.tenantId, pkg.id, agent?.id ?? null, b.quantity, pkg.price, b.note ?? null, req.user.id]);
    if (agent && b.charge_agent) await debitAgent(c, agent.id, agentCost(pkg, b.quantity, agent), `batch:${batch.id}`, req.user.id);
    const list = await issueVouchers(c, {
      tenantId: req.tenantId, pkg, quantity: b.quantity, source: 'batch', batchId: batch.id,
      agentId: agent?.id ?? null, codeLength: b.code_length,
    });
    await audit(c, req, 'voucher.batch', 'voucher_batch', batch.id, { package: pkg.name, quantity: b.quantity, agent: agent?.name });
    return { batch, vouchers: list };
  });
  res.status(201).json(out);
}));

/** Everything the dashboard needs to print a sheet or export CSV for a batch. */
vouchers.get('/batches/:id/export', h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const out = await withTenant(req.tenantId, async (c) => {
    const { rows: [batch] } = await c.query(
      `SELECT b.*, p.name AS package_name, p.duration_minutes, p.data_limit_mb, p.rate_down_kbps, p.price
         FROM voucher_batches b JOIN packages p ON p.id = b.package_id WHERE b.id = $1`, [id]);
    if (!batch) throw notFound('Batch');
    const { rows: list } = await c.query(
      `SELECT code, status FROM vouchers WHERE batch_id = $1 ORDER BY created_at, code`, [id]);
    const { rows: [site] } = await c.query(`SELECT portal FROM sites ORDER BY created_at LIMIT 1`);
    return { batch, vouchers: list, brand: site?.portal?.brand, description: describeEntitlement(batch) };
  });
  if (format === 'csv') {
    res.type('text/csv').attachment(`vouchers-${id.slice(0, 8)}.csv`);
    res.send(['code,package,price,status', ...out.vouchers.map((v) => `${v.code},"${out.batch.package_name}",${out.batch.price},${v.status}`)].join('\n'));
    return;
  }
  res.json(out);
}));

/** Counter sale: cashier sells one voucher for cash, optionally SMS'd to the buyer. */
vouchers.post('/sell', requireRole(...ROLES.sales), h(async (req, res) => {
  const b = parse(z.object({ package_id: zUuid, phone: zPhone.optional(), site_id: zUuid.nullable().optional() }), req.body);
  const out = await withTenant(req.tenantId, async (c) => {
    const pkg = await loadPackage(c, b.package_id);
    let customerId = null;
    if (b.phone) {
      const { rows: [cu] } = await c.query(
        `INSERT INTO customers (tenant_id, phone) VALUES ($1, $2)
         ON CONFLICT (tenant_id, phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING id`, [req.tenantId, b.phone]);
      customerId = cu.id;
    }
    const [v] = await issueVouchers(c, { tenantId: req.tenantId, pkg, source: 'manual', customerId, siteId: b.site_id ?? null });
    if (pkg.price > 0) {
      await c.query(
        `INSERT INTO payments (tenant_id, customer_id, channel, purpose, purpose_id, amount, phone, reference, status,
                               result_id, recorded_by, confirmed_at, site_id)
         VALUES ($1,$2,'cash','hotspot',$3,$4,$5,$6,'success',$7,$8,now(),$9)`,
        [req.tenantId, customerId, pkg.id, pkg.price, b.phone ?? null, `JC-${randomCode(8)}`, v.id, req.user.id, b.site_id ?? null]);
    }
    await audit(c, req, 'voucher.sell', 'voucher', v.id, { package: pkg.name, price: pkg.price });
    return { voucher: { ...v, package_name: pkg.name, description: describeEntitlement(pkg) } };
  });
  res.status(201).json(out);
}));

vouchers.post('/:id/disable', requireRole(...ROLES.sales), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const v = await withTenant(req.tenantId, async (c) => {
    const { rows: [row] } = await c.query(`UPDATE vouchers SET status = 'disabled' WHERE id = $1 RETURNING *`, [id]);
    if (!row) throw notFound('Voucher');
    await audit(c, req, 'voucher.disable', 'voucher', id, { code: row.code });
    return row;
  });
  const cut = await disconnectEverywhere({ tenantId: req.tenantId, username: v.code, kind: 'hotspot' }, req.log);
  res.json({ ok: true, disconnected: cut });
}));

vouchers.post('/:id/enable', requireRole(...ROLES.sales), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  await withTenant(req.tenantId, async (c) => {
    const { rows: [row] } = await c.query(
      `UPDATE vouchers SET status = CASE WHEN activated_at IS NULL THEN 'unused' ELSE 'active' END
        WHERE id = $1 AND status = 'disabled' RETURNING code`, [id]);
    if (!row) throw notFound('Disabled voucher');
    await audit(c, req, 'voucher.enable', 'voucher', id, { code: row.code });
  });
  res.json({ ok: true });
}));

/** Customer changed phone: free the device slots so they can log in on the new one. */
vouchers.post('/:id/reset-devices', requireRole(...ROLES.sales), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const v = await withTenant(req.tenantId, async (c) => {
    const { rows: [row] } = await c.query(`UPDATE vouchers SET device_macs = '{}' WHERE id = $1 RETURNING code`, [id]);
    if (!row) throw notFound('Voucher');
    await audit(c, req, 'voucher.reset_devices', 'voucher', id, { code: row.code });
    return row;
  });
  const cut = await disconnectEverywhere({ tenantId: req.tenantId, username: v.code, kind: 'hotspot' }, req.log);
  res.json({ ok: true, disconnected: cut });
}));

/** Give extra time to an active or expired voucher (complaints, outages). */
vouchers.post('/:id/extend', requireRole('owner', 'manager'), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const { minutes } = parse(z.object({ minutes: z.coerce.number().int().min(1).max(43200) }), req.body);
  const row = await withTenant(req.tenantId, async (c) => {
    const { rows: [v] } = await c.query(
      `UPDATE vouchers SET
         expires_at = CASE WHEN expires_at IS NULL THEN NULL ELSE greatest(expires_at, now()) + make_interval(mins => $2) END,
         duration_minutes = CASE WHEN activated_at IS NULL AND duration_minutes IS NOT NULL THEN duration_minutes + $2 ELSE duration_minutes END,
         status = CASE WHEN status = 'expired' THEN 'active' ELSE status END
       WHERE id = $1 AND status IN ('unused','active','expired') RETURNING code, status, expires_at`, [id, minutes]);
    if (!v) throw notFound('Voucher');
    await audit(c, req, 'voucher.extend', 'voucher', id, { minutes });
    return v;
  });
  res.json({ voucher: row });
}));

// ───────────── Agents (managed by the operator) ─────────────
const zAgent = z.object({
  name: z.string().trim().min(1).max(80),
  phone: zPhone.nullable().optional(),
  location: z.string().trim().max(120).nullable().optional(),
  discount_pct: z.coerce.number().min(0).max(100).optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).max(128).optional(), // gives the agent a dashboard login
});

agents.get('/', h(async (req, res) => {
  const rows = await withTenant(req.tenantId, async (c) => (await c.query(
    `SELECT a.*, (a.user_id IS NOT NULL) AS has_login,
       (SELECT count(*)::int FROM vouchers v WHERE v.agent_id = a.id) AS vouchers_total,
       (SELECT count(*)::int FROM vouchers v WHERE v.agent_id = a.id AND v.status <> 'unused') AS vouchers_used
     FROM agents a ORDER BY a.active DESC, a.name`)).rows);
  res.json({ agents: rows.map(({ user_id: _u, ...a }) => a) });
}));

async function upsertAgentLogin(c, req, agent, password) {
  if (!password) return;
  if (!agent.phone) throw badRequest('An agent needs a phone number to sign in');
  const hash = await bcrypt.hash(password, 11);
  if (agent.user_id) {
    await c.query('UPDATE users SET password_hash = $1, phone = $2, name = $3 WHERE id = $4', [hash, agent.phone, agent.name, agent.user_id]);
  } else {
    const { rows: [u] } = await c.query(
      `INSERT INTO users (tenant_id, name, phone, password_hash, role) VALUES ($1,$2,$3,$4,'agent') RETURNING id`,
      [req.tenantId, agent.name, agent.phone, hash]);
    await c.query('UPDATE agents SET user_id = $1 WHERE id = $2', [u.id, agent.id]);
  }
}

agents.post('/', requireRole(...ROLES.admin), h(async (req, res) => {
  const b = parse(zAgent, req.body);
  const row = await withTenant(req.tenantId, async (c) => {
    const { rows: [a] } = await c.query(
      `INSERT INTO agents (tenant_id, name, phone, location, discount_pct) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.tenantId, b.name, b.phone ?? null, b.location ?? null, b.discount_pct ?? 10]);
    await upsertAgentLogin(c, req, a, b.password);
    await audit(c, req, 'agent.create', 'agent', a.id, { name: a.name });
    return a;
  }).catch((e) => { if (e.code === '23505') throw conflict('This phone number already has a login'); throw e; });
  res.status(201).json({ agent: row });
}));

agents.patch('/:id', requireRole(...ROLES.admin), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const b = parse(zAgent.partial(), req.body);
  const row = await withTenant(req.tenantId, async (c) => {
    const { rows: [a] } = await c.query(
      `UPDATE agents SET name = coalesce($1, name), phone = coalesce($2, phone), location = coalesce($3, location),
              discount_pct = coalesce($4, discount_pct), active = coalesce($5, active) WHERE id = $6 RETURNING *`,
      [b.name ?? null, b.phone ?? null, b.location ?? null, b.discount_pct ?? null, b.active ?? null, id]);
    if (!a) throw notFound('Agent');
    await upsertAgentLogin(c, req, a, b.password);
    if (a.user_id && b.active !== undefined) {
      await c.query('UPDATE users SET status = $1 WHERE id = $2', [b.active ? 'active' : 'disabled', a.user_id]);
    }
    await audit(c, req, 'agent.update', 'agent', id, { ...b, password: b.password ? '***' : undefined });
    return a;
  });
  res.json({ agent: row });
}));

agents.post('/:id/topup', requireRole(...ROLES.sales), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const b = parse(z.object({ amount: z.coerce.number().int().min(-1_000_000_000).max(1_000_000_000).refine((v) => v !== 0, 'Amount cannot be zero'),
    kind: z.enum(['topup', 'adjustment', 'refund']).default('topup'), reference: z.string().max(100).optional() }), req.body);
  const row = await withTenant(req.tenantId, async (c) => {
    const { rows: [a] } = await c.query(
      'UPDATE agents SET balance = balance + $1 WHERE id = $2 AND balance + $1 >= 0 RETURNING *', [b.amount, id]);
    if (!a) throw badRequest('Unknown agent, or the balance would go below zero');
    await c.query(
      `INSERT INTO agent_ledger (tenant_id, agent_id, amount, balance_after, kind, reference, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [req.tenantId, id, b.amount, a.balance, b.kind, b.reference ?? null, req.user.id]);
    if (b.kind === 'topup' && b.amount > 0) {
      await c.query(
        `INSERT INTO payments (tenant_id, channel, purpose, purpose_id, amount, reference, status, recorded_by, confirmed_at)
         VALUES ($1,'cash','agent_topup',$2,$3,$4,'success',$5,now())`,
        [req.tenantId, id, b.amount, `JC-${randomCode(8)}`, req.user.id]);
    }
    await audit(c, req, `agent.${b.kind}`, 'agent', id, { amount: b.amount });
    return a;
  });
  res.json({ agent: row });
}));

agents.get('/:id/ledger', h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const rows = await withTenant(req.tenantId, async (c) => (await c.query(
    `SELECT l.*, u.name AS user_name FROM agent_ledger l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.agent_id = $1 ORDER BY l.id DESC LIMIT 500`, [id])).rows);
  res.json({ ledger: rows });
}));

// ───────────── Agent self-service ─────────────
async function myAgent(c, userId) {
  const { rows: [a] } = await c.query('SELECT * FROM agents WHERE user_id = $1 AND active', [userId]);
  if (!a) throw notFound('Agent account');
  return a;
}

agentSelf.get('/', h(async (req, res) => {
  const out = await withTenant(req.tenantId, async (c) => {
    const a = await myAgent(c, req.user.id);
    const { rows: pk } = await c.query(
      `SELECT id, name, price, duration_minutes, data_limit_mb, rate_down_kbps FROM packages
        WHERE active AND NOT is_trial ORDER BY sort_order, price`);
    const { rows: recent } = await c.query(
      `SELECT v.code, v.status, v.price, v.created_at, p.name AS package_name FROM vouchers v
         JOIN packages p ON p.id = v.package_id WHERE v.agent_id = $1 ORDER BY v.created_at DESC LIMIT 100`, [a.id]);
    return {
      agent: { id: a.id, name: a.name, balance: a.balance, discount_pct: Number(a.discount_pct) },
      packages: pk.map((p) => ({ ...p, agent_price: Math.round(p.price * (1 - Number(a.discount_pct) / 100)) })),
      recent,
    };
  });
  res.json(out);
}));

agentSelf.post('/vouchers', h(async (req, res) => {
  const b = parse(z.object({ package_id: zUuid, quantity: z.coerce.number().int().min(1).max(200) }), req.body);
  const out = await withTenant(req.tenantId, async (c) => {
    const a = await myAgent(c, req.user.id);
    const pkg = await loadPackage(c, b.package_id);
    if (pkg.is_trial) throw badRequest('Trial packages cannot be sold');
    const cost = agentCost(pkg, b.quantity, a);
    const { rows: [batch] } = await c.query(
      `INSERT INTO voucher_batches (tenant_id, package_id, agent_id, quantity, unit_price, note, created_by)
       VALUES ($1,$2,$3,$4,$5,'Agent purchase',$6) RETURNING id`,
      [req.tenantId, pkg.id, a.id, b.quantity, pkg.price, req.user.id]);
    const balance = await debitAgent(c, a.id, cost, `batch:${batch.id}`, req.user.id);
    const list = await issueVouchers(c, { tenantId: req.tenantId, pkg, quantity: b.quantity, source: 'batch', batchId: batch.id, agentId: a.id });
    await audit(c, req, 'agent.buy_vouchers', 'voucher_batch', batch.id, { quantity: b.quantity, cost });
    return { vouchers: list, cost, balance, package: pkg.name, description: describeEntitlement(pkg) };
  });
  res.status(201).json(out);
}));
