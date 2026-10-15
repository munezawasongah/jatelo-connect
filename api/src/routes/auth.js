// Operator sign-up, sign-in, token refresh, phone verification and password reset.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asOwner, ownerPool } from '../db.js';
import { isProd } from '../config.js';
import { h, parse, zPhone, normalizePhone, unauthorized, badRequest } from '../lib/http.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { signAccessToken, requireAuth, ACCESS_TTL_SECONDS } from '../middleware/auth.js';
import { createTenantWithOwner } from '../services/tenants.js';
import { createOtp, verifyOtp } from '../services/otp.js';
import { queueTemplate } from '../services/sms.js';

const router = Router();
const REFRESH_DAYS = 30;
const COOKIE = 'jc_refresh';

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 11);
const zPassword = z.string().min(8, 'At least 8 characters').max(128);

async function issueSession(client, req, res, user) {
  const refresh = randomToken(48);
  await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)`,
    [user.id, sha256(refresh), REFRESH_DAYS, req.get('user-agent')?.slice(0, 300) ?? null,
     req.ip?.replace(/^::ffff:/, '') || null],
  );
  await client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  res.cookie(COOKIE, refresh, {
    httpOnly: true, secure: isProd, sameSite: 'lax', path: '/api/auth', maxAge: REFRESH_DAYS * 86400 * 1000,
  });
  return {
    access_token: signAccessToken(user),
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refresh, // also returned for the mobile app; browsers use the cookie
  };
}

// ── Sign up a new operator (starts the free trial) ──
router.post('/signup', authLimiter, h(async (req, res) => {
  const body = parse(z.object({
    business_name: z.string().trim().min(2).max(80),
    name: z.string().trim().min(2).max(80),
    email: z.string().trim().toLowerCase().email(),
    phone: zPhone,
    password: zPassword,
    language: z.enum(['fr', 'rn', 'en']).default('fr'),
  }), req.body);

  const result = await asOwner(async (c) => {
    const { tenant, user } = await createTenantWithOwner(c, {
      businessName: body.business_name, name: body.name, email: body.email,
      phone: body.phone, password: body.password, language: body.language,
    });
    const code = await createOtp(c, { purpose: 'verify_phone', target: body.phone, tenantId: tenant.id });
    await queueTemplate(c, { tenantId: null, to: body.phone, template: 'otp', lang: body.language, vars: { code } });
    const session = await issueSession(c, req, res, user);
    return { tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, trial_ends_at: tenant.trial_ends_at }, user, ...session };
  });
  res.status(201).json(result);
}));

// ── Sign in with email or phone ──
router.post('/login', authLimiter, h(async (req, res) => {
  const { login, password } = parse(z.object({ login: z.string().trim().min(3), password: z.string().min(1) }), req.body);
  const phone = login.includes('@') ? null : normalizePhone(login);
  const { rows } = await ownerPool.query(
    `SELECT id, tenant_id, name, email, phone, role, status, language, password_hash
       FROM users WHERE email = $1 OR ($2::text IS NOT NULL AND phone = $2)`,
    [login.toLowerCase(), phone],
  );
  let user = null;
  for (const u of rows) {
    // eslint-disable-next-line no-await-in-loop
    if (u.status === 'active' && await bcrypt.compare(password, u.password_hash)) { user = u; break; }
  }
  if (!user) {
    if (!rows.length) await bcrypt.compare(password, DUMMY_HASH); // same timing whether or not the user exists
    throw unauthorized('Wrong email/phone or password');
  }
  delete user.password_hash;
  const session = await asOwner((c) => issueSession(c, req, res, user));
  res.json({ user, ...session });
}));

// ── Rotate refresh token ──
router.post('/refresh', h(async (req, res) => {
  const token = req.cookies?.[COOKIE] || req.body?.refresh_token;
  if (!token) throw unauthorized();
  const result = await asOwner(async (c) => {
    const { rows } = await c.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [sha256(token)],
    );
    if (!rows[0]) return null;
    const { rows: [user] } = await c.query(
      `SELECT id, tenant_id, name, email, phone, role, language FROM users WHERE id = $1 AND status = 'active'`,
      [rows[0].user_id],
    );
    if (!user) return null;
    return { user, ...(await issueSession(c, req, res, user)) };
  });
  if (!result) {
    res.clearCookie(COOKIE, { path: '/api/auth' });
    throw unauthorized('Session expired, please sign in again');
  }
  res.json(result);
}));

router.post('/logout', h(async (req, res) => {
  const token = req.cookies?.[COOKIE] || req.body?.refresh_token;
  if (token) await ownerPool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1', [sha256(token)]);
  res.clearCookie(COOKIE, { path: '/api/auth' });
  res.json({ ok: true });
}));

// ── Current user, tenant and plan ──
router.get('/me', requireAuth, h(async (req, res) => {
  const u = req.user;
  const { rows: [v] } = await ownerPool.query('SELECT phone_verified_at FROM users WHERE id = $1', [u.id]);
  res.json({
    user: { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, language: u.language,
            phone_verified: Boolean(v?.phone_verified_at) },
    tenant: u.tenant_id ? {
      id: u.tenant_id, name: u.tenant_name, status: u.tenant_status, tier: u.tier, currency: u.currency,
      trial_ends_at: u.trial_ends_at, paid_until: u.paid_until, max_routers: u.max_routers,
      max_active_users: u.max_active_users,
    } : null,
  });
}));

// ── Phone verification ──
router.post('/verify-phone/send', requireAuth, authLimiter, h(async (req, res) => {
  if (!req.user.phone) throw badRequest('No phone number on this account');
  await asOwner(async (c) => {
    const code = await createOtp(c, { purpose: 'verify_phone', target: req.user.phone, tenantId: req.user.tenant_id });
    await queueTemplate(c, { to: req.user.phone, template: 'otp', lang: req.user.language, vars: { code } });
  });
  res.json({ ok: true });
}));

router.post('/verify-phone/confirm', requireAuth, authLimiter, h(async (req, res) => {
  const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
  const ok = await asOwner(async (c) => {
    const valid = await verifyOtp(c, { purpose: 'verify_phone', target: req.user.phone, code });
    if (valid) await c.query('UPDATE users SET phone_verified_at = now() WHERE id = $1', [req.user.id]);
    return valid;
  });
  if (!ok) throw badRequest('Wrong or expired code');
  res.json({ ok: true });
}));

// ── Password reset by SMS code ──
router.post('/password/forgot', authLimiter, h(async (req, res) => {
  const { phone: raw } = parse(z.object({ phone: z.string() }), req.body);
  const phone = normalizePhone(raw);
  if (phone) {
    await asOwner(async (c) => {
      const { rows } = await c.query(`SELECT language FROM users WHERE phone = $1 AND status = 'active' LIMIT 1`, [phone]);
      if (!rows[0]) return; // do not reveal whether the number exists
      const code = await createOtp(c, { purpose: 'reset_password', target: phone });
      await queueTemplate(c, { to: phone, template: 'otp', lang: rows[0].language, vars: { code } });
    });
  }
  res.json({ ok: true });
}));

router.post('/password/reset', authLimiter, h(async (req, res) => {
  const body = parse(z.object({ phone: zPhone, code: z.string().regex(/^\d{6}$/), password: zPassword }), req.body);
  const ok = await asOwner(async (c) => {
    const valid = await verifyOtp(c, { purpose: 'reset_password', target: body.phone, code: body.code });
    if (!valid) return false;
    const hash = await bcrypt.hash(body.password, 11);
    const { rows } = await c.query(
      `UPDATE users SET password_hash = $1, phone_verified_at = coalesce(phone_verified_at, now())
        WHERE phone = $2 AND status = 'active' RETURNING id`, [hash, body.phone]);
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = ANY($1) AND revoked_at IS NULL',
      [rows.map((r) => r.id)]);
    return true;
  });
  if (!ok) throw badRequest('Wrong or expired code');
  res.json({ ok: true });
}));

export default router;
