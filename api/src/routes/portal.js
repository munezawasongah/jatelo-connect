// Public captive portal, PPPoE renewal page and connection request page.
// No operator login here: the tenant is derived from the router (or sign-up slug).
import { Router, json } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asOwner } from '../db.js';
import { h, parse, HttpError, normalizePhone, zUuid } from '../lib/http.js';
import { sha256, timingSafeEqualStr } from '../lib/crypto.js';
import { renderPage } from '../portal/page.js';
import { createPayment, completePayment, claimWithTxnId, pinHash } from '../services/payments.js';
import { issueVouchers } from '../services/vouchers.js';
import { disconnectEverywhere } from '../services/sessions.js';
import { queueSms } from '../services/sms.js';

export const portalPages = Router();
export const portalApi = Router();

const fail = (status, code, message) => new HttpError(status, code, message || code);
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const normMac = (m) => (m ? String(m).toUpperCase().replace(/-/g, ':') : null);

// Captive portal clients all share the router's public IP, so limits are keyed on the
// phone / MAC the request is about, with a generous per-IP ceiling.
const keyed = (limit, windowMin, pick) => rateLimit({
  windowMs: windowMin * 60_000, limit, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `${pick(req) || ''}|${req.ip}`,
  handler: (_req, res) => res.status(429).json({ error: { code: 'rate_limited', message: 'Too many attempts. Wait a few minutes.' } }),
});
const ipCeiling = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false });

// ───────────── Context ─────────────
async function routerContext(c, routerId) {
  const { rows: [r] } = await c.query(
    `SELECT r.id, r.tenant_id, r.site_id, t.status AS tenant_status, t.currency, t.language, t.name AS tenant_name,
            t.phone AS tenant_phone, coalesce(s.portal, '{}'::jsonb) AS portal
       FROM routers r JOIN tenants t ON t.id = r.tenant_id
       LEFT JOIN sites s ON s.id = coalesce(r.site_id, (SELECT id FROM sites WHERE tenant_id = r.tenant_id ORDER BY created_at LIMIT 1))
      WHERE r.id = $1`, [routerId]);
  if (!r || ['suspended', 'closed'].includes(r.tenant_status)) throw fail(404, 'not_found', 'Hotspot not found');
  return r;
}

async function walletsFor(c, tenantId) {
  const { rows } = await c.query(
    `SELECT wallet, merchant_number, merchant_name FROM payment_channels WHERE tenant_id = $1 AND active ORDER BY wallet DESC`,
    [tenantId]);
  return rows; // lumicash first
}

async function portalConfig(c, routerId) {
  const r = await routerContext(c, routerId);
  const { rows: pk } = await c.query(
    `SELECT id, name, description, price, duration_minutes, data_limit_mb, rate_down_kbps, is_trial FROM packages
      WHERE tenant_id = $1 AND active AND (visible_on_portal OR is_trial)
        AND (site_ids IS NULL OR $2::uuid = ANY (site_ids)) ORDER BY sort_order, price`, [r.tenant_id, r.site_id]);
  const p = r.portal || {};
  const trial = p.trial_enabled !== false ? pk.find((x) => x.is_trial) : null;
  return {
    ctx: r,
    brand: p.brand || r.tenant_name,
    color: p.primary_color,
    logo: p.logo_url,
    config: {
      router_id: r.id,
      brand: p.brand || r.tenant_name,
      languages: p.languages?.length ? p.languages : ['fr', 'rn', 'en'],
      default_language: p.default_language || r.language || 'fr',
      welcome: p.welcome || null,
      support_phone: p.support_phone || r.tenant_phone || null,
      currency: r.currency,
      packages: pk.filter((x) => !x.is_trial && x.price > 0),
      trial: trial ? { duration_minutes: trial.duration_minutes } : null,
      wallets: await walletsFor(c, r.tenant_id),
      link_login: 'http://login.wifi/login',
    },
  };
}

const sendPage = (res, html) => {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src * data:; connect-src 'self'; form-action *; base-uri 'none'");
  res.type('html').send(html);
};

// ───────────── Pages ─────────────
for (const [path, mode] of [['/h/:routerId', 'hotspot'], ['/h/:routerId/ok', 'ok'], ['/h/:routerId/status', 'status'], ['/h/:routerId/bye', 'bye']]) {
  portalPages.get(path, ipCeiling, h(async (req, res) => {
    const id = zUuid.safeParse(req.params.routerId);
    if (!id.success) throw fail(404, 'not_found');
    const pc = await asOwner((c) => portalConfig(c, id.data));
    sendPage(res, renderPage({ mode, brand: pc.brand, color: pc.color, logo: pc.logo, config: pc.config }));
  }));
}

portalPages.get('/renew', ipCeiling, (_req, res) => {
  sendPage(res, renderPage({
    mode: 'renew', brand: 'Internet', config: { languages: ['fr', 'rn', 'en'], default_language: 'fr', currency: 'BIF', wallets: [] },
  }));
});

portalPages.get('/join/:slug', ipCeiling, h(async (req, res) => {
  const out = await asOwner(async (c) => {
    const { rows: [t] } = await c.query(
      `SELECT t.id, t.name, t.slug, t.currency, t.language, t.phone, coalesce(s.portal, '{}'::jsonb) AS portal FROM tenants t
         LEFT JOIN LATERAL (SELECT portal FROM sites WHERE tenant_id = t.id ORDER BY created_at LIMIT 1) s ON true
        WHERE t.slug = $1 AND t.status NOT IN ('suspended','closed')`, [req.params.slug]);
    if (!t) return null;
    const { rows: plans } = await c.query(
      'SELECT id, name, price, period_days FROM plans WHERE tenant_id = $1 AND active ORDER BY price', [t.id]);
    return { t, plans };
  });
  if (!out) throw fail(404, 'not_found');
  const p = out.t.portal;
  sendPage(res, renderPage({
    mode: 'join', brand: p.brand || out.t.name, color: p.primary_color, logo: p.logo_url,
    config: { slug: out.t.slug, plans: out.plans, currency: out.t.currency, languages: p.languages || ['fr', 'rn', 'en'],
              default_language: p.default_language || out.t.language, support_phone: p.support_phone || out.t.phone, wallets: [] },
  }));
}));

// ───────────── Portal JSON API ─────────────
portalApi.use(ipCeiling, json({ limit: '8kb' }));

portalApi.get('/r/:routerId', h(async (req, res) => {
  const id = parse(zUuid, req.params.routerId);
  const pc = await asOwner((c) => portalConfig(c, id));
  res.json(pc.config);
}));

/** Pre-login check, so the customer sees a clear reason instead of a router error. */
portalApi.post('/r/:routerId/check', keyed(30, 5, (r) => r.body?.mac), h(async (req, res) => {
  const id = parse(zUuid, req.params.routerId);
  const b = parse(z.object({ code: z.string().trim().min(4).max(20), mac: z.string().nullable().optional() }), req.body);
  const mac = normMac(b.mac);
  const status = await asOwner(async (c) => {
    const r = await routerContext(c, id);
    const { rows: [v] } = await c.query(
      `SELECT status, expires_at, data_limit_mb, bytes_used, device_macs, device_limit FROM vouchers
        WHERE tenant_id = $1 AND code = upper($2)`, [r.tenant_id, b.code]);
    if (!v) return 'not_found';
    if (v.status === 'disabled') return 'disabled';
    if (v.status === 'expired' || (v.expires_at && new Date(v.expires_at) <= new Date())) return 'expired';
    if (v.status === 'exhausted' || (v.data_limit_mb && v.bytes_used >= v.data_limit_mb * 1048576)) return 'exhausted';
    if (mac && MAC_RE.test(mac) && !v.device_macs.includes(mac) && v.device_macs.length >= v.device_limit) return 'device_limit';
    return 'ok';
  });
  if (status !== 'ok') throw fail(400, status);
  res.json({ ok: true });
}));

/** One free trial per device per day. */
portalApi.post('/r/:routerId/trial', keyed(10, 15, (r) => r.body?.mac), h(async (req, res) => {
  const id = parse(zUuid, req.params.routerId);
  const mac = normMac(req.body?.mac);
  if (!mac || !MAC_RE.test(mac)) throw fail(400, 'generic', 'Device not identified');
  const code = await asOwner(async (c) => {
    const r = await routerContext(c, id);
    if (r.portal?.trial_enabled === false) throw fail(400, 'generic', 'Trial disabled');
    const { rows: [pkg] } = await c.query('SELECT * FROM packages WHERE tenant_id = $1 AND is_trial AND active LIMIT 1', [r.tenant_id]);
    if (!pkg) throw fail(400, 'generic', 'No trial package');
    const { rows: [tz] } = await c.query(`SELECT (now() AT TIME ZONE timezone)::date AS day FROM tenants WHERE id = $1`, [r.tenant_id]);
    const ins = await c.query(
      `INSERT INTO trial_uses (tenant_id, mac, day) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [r.tenant_id, mac, tz.day]);
    if (!ins.rowCount) throw fail(400, 'trial_used');
    const [v] = await issueVouchers(c, { tenantId: r.tenant_id, pkg, source: 'trial', siteId: r.site_id });
    await c.query('UPDATE trial_uses SET voucher_id = $1 WHERE tenant_id = $2 AND mac = $3 AND day = $4', [v.id, r.tenant_id, mac, tz.day]);
    return v.code;
  });
  res.json({ code });
}));

/** Start a purchase: returns the merchant instructions and a secret to collect the code. */
portalApi.post('/r/:routerId/pay', keyed(10, 10, (r) => r.body?.phone), h(async (req, res) => {
  const id = parse(zUuid, req.params.routerId);
  const b = parse(z.object({
    package_id: zUuid, phone: z.string(), wallet: z.enum(['lumicash', 'ecocash']),
    mac: z.string().nullable().optional(), lang: z.enum(['fr', 'rn', 'en']).optional(),
  }), req.body);
  const phone = normalizePhone(b.phone);
  if (!phone) throw fail(400, 'phone');
  const out = await asOwner(async (c) => {
    const r = await routerContext(c, id);
    const { rows: [pkg] } = await c.query(
      `SELECT * FROM packages WHERE id = $1 AND tenant_id = $2 AND active AND visible_on_portal AND NOT is_trial AND price > 0`,
      [b.package_id, r.tenant_id]);
    if (!pkg) throw fail(400, 'generic', 'Package not available');
    const { rows: [ch] } = await c.query(
      'SELECT * FROM payment_channels WHERE tenant_id = $1 AND wallet = $2 AND active', [r.tenant_id, b.wallet]);
    if (!ch) throw fail(400, 'no_channel');
    const mac = normMac(b.mac);
    const { payment, clientSecret } = await createPayment(c, {
      tenantId: r.tenant_id, purpose: 'hotspot', purposeId: pkg.id, amount: pkg.price, phone, wallet: b.wallet,
      channel: 'sms_match', siteId: r.site_id, routerId: r.id, clientMac: mac && MAC_RE.test(mac) ? mac : null,
      meta: { lang: b.lang ?? null, package_name: pkg.name },
    });
    return { reference: payment.reference, client_secret: clientSecret, amount: payment.amount, wallet: b.wallet,
             merchant_number: ch.merchant_number, expires_at: payment.expires_at };
  });
  res.status(201).json(out);
}));

async function paymentForClient(c, reference, secret) {
  const { rows: [p] } = await c.query('SELECT * FROM payments WHERE reference = $1', [String(reference).toUpperCase()]);
  if (!p || !secret || !p.client_secret_hash || !timingSafeEqualStr(p.client_secret_hash, sha256(secret))) {
    throw fail(404, 'not_found', 'Payment not found');
  }
  return p;
}

async function publicResult(c, p) {
  const out = { status: p.status, reference: p.reference, amount: p.amount };
  if (p.status === 'success' && p.purpose === 'hotspot' && p.result_id) {
    const { rows: [v] } = await c.query(
      `SELECT v.code, pk.name AS package_name FROM vouchers v JOIN packages pk ON pk.id = v.package_id WHERE v.id = $1`, [p.result_id]);
    Object.assign(out, v);
  }
  if (p.status === 'success' && p.purpose === 'subscription') {
    const { rows: [s] } = await c.query('SELECT expires_at FROM subscriptions WHERE id = $1', [p.purpose_id]);
    out.expires_at = s?.expires_at;
  }
  return out;
}

portalApi.get('/payments/:reference', h(async (req, res) => {
  const out = await asOwner(async (c) => {
    let p = await paymentForClient(c, req.params.reference, req.query.secret);
    if (p.status === 'pending' && p.expires_at && new Date(p.expires_at) < new Date()) {
      ({ rows: [p] } = await c.query(`UPDATE payments SET status = 'expired' WHERE id = $1 AND status = 'pending' RETURNING *`, [p.id]));
    }
    return publicResult(c, p);
  });
  res.json(out);
}));

portalApi.post('/payments/:reference/claim', keyed(10, 10, (r) => r.params.reference), h(async (req, res) => {
  const b = parse(z.object({ secret: z.string().min(10), txn_id: z.string().trim().min(1).max(40) }), req.body);
  let reconnect = null;
  const out = await asOwner(async (c) => {
    const p = await paymentForClient(c, req.params.reference, b.secret);
    if (p.status === 'success') return publicResult(c, p);
    if (p.status !== 'pending' && p.status !== 'expired') throw fail(400, 'generic');
    const r = await claimWithTxnId(c, p, b.txn_id);
    if (!r.ok) return { error: r.reason };
    reconnect = r.result.reconnect ? { tenantId: p.tenant_id, username: r.result.reconnect } : null;
    return publicResult(c, r.result.payment);
  });
  if (out.error) throw fail(400, out.error);
  if (reconnect) await disconnectEverywhere({ ...reconnect, kind: 'pppoe' }, req.log);
  res.json(out);
}));

/** Lost the code / changed phone: phone + PIN from the purchase SMS. */
portalApi.post('/r/:routerId/recover', keyed(6, 15, (r) => normalizePhone(r.body?.phone)), h(async (req, res) => {
  const id = parse(zUuid, req.params.routerId);
  const b = parse(z.object({ phone: z.string(), pin: z.string().regex(/^\d{4}$/) }), req.body);
  const phone = normalizePhone(b.phone);
  if (!phone) throw fail(400, 'phone');
  const vouchers = await asOwner(async (c) => {
    const r = await routerContext(c, id);
    const { rows: [cu] } = await c.query('SELECT id, pin_hash FROM customers WHERE tenant_id = $1 AND phone = $2', [r.tenant_id, phone]);
    if (!cu?.pin_hash || !timingSafeEqualStr(cu.pin_hash, pinHash(r.tenant_id, phone, b.pin))) return null;
    const { rows } = await c.query(
      `SELECT v.code, v.status, v.expires_at, pk.name AS package_name FROM vouchers v JOIN packages pk ON pk.id = v.package_id
        WHERE v.customer_id = $1 AND v.status IN ('unused','active') AND (v.expires_at IS NULL OR v.expires_at > now())
        ORDER BY v.created_at DESC LIMIT 10`, [cu.id]);
    return rows;
  });
  if (!vouchers) throw fail(400, 'pin');
  res.json({ vouchers });
}));

/** Time and data left, for the connected/status pages. */
portalApi.get('/v/:routerId/:code', h(async (req, res) => {
  const id = parse(zUuid, req.params.routerId);
  const out = await asOwner(async (c) => {
    const r = await routerContext(c, id);
    const { rows: [v] } = await c.query(
      `SELECT v.status, v.expires_at, v.duration_minutes, v.activated_at, v.data_limit_mb, v.bytes_used, pk.name AS package_name
         FROM vouchers v JOIN packages pk ON pk.id = v.package_id WHERE v.tenant_id = $1 AND v.code = upper($2)`,
      [r.tenant_id, req.params.code]);
    return v;
  });
  if (!out) throw fail(404, 'not_found');
  res.json({
    status: out.status,
    package_name: out.package_name,
    expires_at: out.expires_at,
    seconds_left: out.expires_at ? Math.max(0, Math.round((new Date(out.expires_at) - Date.now()) / 1000))
      : (out.duration_minutes ? out.duration_minutes * 60 : null),
    bytes_left: out.data_limit_mb ? Math.max(0, out.data_limit_mb * 1048576 - out.bytes_used) : null,
  });
}));

// ───────────── PPPoE renewal (walled subscribers land here) ─────────────
portalApi.post('/renew/lookup', keyed(10, 10, (r) => normalizePhone(r.body?.phone)), h(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) throw fail(400, 'phone');
  const subs = await asOwner(async (c) => {
    const { rows } = await c.query(
      `SELECT s.id, s.username, s.expires_at, s.status, s.tenant_id, pl.name AS plan_name, pl.price,
              coalesce(si.portal->>'brand', t.name) AS brand
         FROM subscriptions s JOIN customers cu ON cu.id = s.customer_id JOIN plans pl ON pl.id = s.plan_id
         JOIN tenants t ON t.id = s.tenant_id
         LEFT JOIN LATERAL (SELECT portal FROM sites WHERE tenant_id = t.id ORDER BY created_at LIMIT 1) si ON true
        WHERE cu.phone = $1 AND s.status IN ('active','expired','pending') AND t.status NOT IN ('suspended','closed')
        ORDER BY s.expires_at NULLS FIRST LIMIT 10`, [phone]);
    for (const s of rows) s.wallets = await walletsFor(c, s.tenant_id);
    // Shown to whoever knows the phone number: keep it to what a renewal needs
    return rows.map(({ tenant_id: _t, username, ...s }) => ({ ...s, username: `${username.slice(0, 3)}***` }));
  });
  res.json({ subscriptions: subs });
}));

portalApi.post('/renew/pay', keyed(10, 10, (r) => normalizePhone(r.body?.phone)), h(async (req, res) => {
  const b = parse(z.object({ subscription_id: zUuid, phone: z.string(), wallet: z.enum(['lumicash', 'ecocash']), lang: z.enum(['fr', 'rn', 'en']).optional() }), req.body);
  const phone = normalizePhone(b.phone);
  if (!phone) throw fail(400, 'phone');
  const out = await asOwner(async (c) => {
    const { rows: [s] } = await c.query(
      `SELECT s.*, pl.price, cu.phone AS customer_phone FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
         JOIN customers cu ON cu.id = s.customer_id WHERE s.id = $1 AND s.status IN ('active','expired','pending')`, [b.subscription_id]);
    if (!s || s.customer_phone !== phone) throw fail(404, 'not_found');
    const { rows: [ch] } = await c.query('SELECT * FROM payment_channels WHERE tenant_id = $1 AND wallet = $2 AND active', [s.tenant_id, b.wallet]);
    if (!ch) throw fail(400, 'no_channel');
    const { payment, clientSecret } = await createPayment(c, {
      tenantId: s.tenant_id, purpose: 'subscription', purposeId: s.id, amount: s.price, phone, wallet: b.wallet,
      customerId: s.customer_id, meta: { lang: b.lang ?? null, username: s.username },
    });
    return { reference: payment.reference, client_secret: clientSecret, amount: payment.amount, wallet: b.wallet,
             merchant_number: ch.merchant_number, expires_at: payment.expires_at };
  });
  res.status(201).json(out);
}));

// ───────────── Connection requests ─────────────
portalApi.post('/join/:slug', keyed(5, 60, (r) => normalizePhone(r.body?.phone)), h(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).max(100), phone: z.string(), address: z.string().trim().max(200).optional(),
    notes: z.string().trim().max(1000).optional(), plan_id: zUuid.nullable().optional(),
    latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
  }), req.body);
  const phone = normalizePhone(b.phone);
  if (!phone) throw fail(400, 'phone');
  await asOwner(async (c) => {
    const { rows: [t] } = await c.query(`SELECT id, phone FROM tenants WHERE slug = $1 AND status NOT IN ('suspended','closed')`, [req.params.slug]);
    if (!t) throw fail(404, 'not_found');
    let planId = null;
    if (b.plan_id) {
      const { rows: [pl] } = await c.query('SELECT id FROM plans WHERE id = $1 AND tenant_id = $2', [b.plan_id, t.id]);
      planId = pl?.id ?? null;
    }
    await c.query(
      `INSERT INTO service_requests (tenant_id, plan_id, name, phone, address, latitude, longitude, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [t.id, planId, b.name, phone, b.address ?? null, b.latitude ?? null, b.longitude ?? null, b.notes ?? null]);
    if (t.phone) {
      await queueSms(c, { tenantId: t.id, to: t.phone, kind: 'service_request',
        body: `Jatelo Connect : nouvelle demande de connexion de ${b.name} (${phone})${b.address ? `, ${b.address}` : ''}.` });
    }
  });
  res.status(201).json({ ok: true });
}));

// Re-exported so the SMS webhook can reuse it
export { completePayment };
