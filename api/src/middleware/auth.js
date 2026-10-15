// Authentication (JWT access tokens) and role-based authorisation.
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { ownerPool } from '../db.js';
import { unauthorized, forbidden, HttpError } from '../lib/http.js';

export const ACCESS_TTL_SECONDS = 15 * 60;

export function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, tid: user.tenant_id, role: user.role },
    config.JWT_SECRET,
    { expiresIn: ACCESS_TTL_SECONDS, issuer: 'jatelo-connect' },
  );
}

/** Verifies the bearer token, reloads the user and tenant, and sets req.user / req.tenant. */
export async function requireAuth(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized();
    let claims;
    try {
      claims = jwt.verify(token, config.JWT_SECRET, { issuer: 'jatelo-connect' });
    } catch {
      throw unauthorized('Session expired, please sign in again');
    }
    const { rows } = await ownerPool.query(
      `SELECT u.id, u.tenant_id, u.name, u.email, u.phone, u.role, u.status, u.language,
              t.name AS tenant_name, t.status AS tenant_status, t.tier, t.trial_ends_at, t.paid_until,
              t.max_routers, t.max_active_users, t.currency
         FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE u.id = $1`,
      [claims.sub],
    );
    const u = rows[0];
    if (!u || u.status !== 'active') throw unauthorized('Account disabled');
    req.user = u;
    req.tenantId = u.tenant_id;
    // Platform admins may act on one tenant through the X-Tenant-Id header (support access, audited)
    if (u.role === 'platform_admin' && req.get('x-tenant-id')) req.tenantId = req.get('x-tenant-id');
    next();
  } catch (err) {
    next(err);
  }
}

/** Allow only these roles (platform_admin always passes). */
export const requireRole = (...roles) => (req, _res, next) => {
  if (req.user?.role === 'platform_admin' || roles.includes(req.user?.role)) return next();
  next(forbidden());
};

/** Tenant routes: a tenant context is required and suspended/read-only tenants cannot write. */
export function requireTenant(req, _res, next) {
  if (!req.tenantId) return next(forbidden('No operator account selected'));
  const status = req.user.role === 'platform_admin' ? 'active' : req.user.tenant_status;
  const writing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (status === 'suspended' || status === 'closed') {
    return next(new HttpError(402, 'account_suspended', 'This account is suspended. Please renew your subscription.'));
  }
  if (status === 'read_only' && writing && !req.path.startsWith('/billing')) {
    return next(new HttpError(402, 'account_read_only', 'Your subscription is overdue. Renew to make changes.'));
  }
  next();
}

// Role groups used across routes
export const ROLES = {
  admin: ['owner', 'manager'],
  network: ['owner', 'manager', 'technician'],
  sales: ['owner', 'manager', 'cashier'],
  subscribers: ['owner', 'manager', 'cashier', 'technician'],
  staff: ['owner'],
  any: ['owner', 'manager', 'technician', 'cashier', 'agent'],
};
