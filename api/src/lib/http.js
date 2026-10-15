// HTTP helpers: typed errors, request validation, async wrapper, phone numbers, audit.
import { z } from 'zod';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You do not have permission for this action') => new HttpError(403, 'forbidden', msg);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (msg) => new HttpError(409, 'conflict', msg);
export const limitReached = (msg) => new HttpError(402, 'plan_limit', msg);

/** Wrap an async route handler so rejections reach the error middleware. */
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Parse req[part] with a zod schema; throws 400 with field errors. */
export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] = i.message;
    throw badRequest('Invalid input', fields);
  }
  return r.data;
}

/**
 * Normalise a phone number to E.164. Bare 8-digit numbers are Burundian (+257).
 * Returns null when the input cannot be a valid number.
 */
export function normalizePhone(input, defaultCountry = '257') {
  if (!input) return null;
  let d = String(input).replace(/[^\d+]/g, '');
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (d.startsWith('+')) {
    d = '+' + d.slice(1).replace(/\D/g, '');
  } else if (d.length === 8) {
    d = `+${defaultCountry}${d}`;
  } else if (d.startsWith('0') && d.length === 9) {
    d = `+${defaultCountry}${d.slice(1)}`;
  } else if (d.startsWith(defaultCountry) && d.length === defaultCountry.length + 8) {
    d = '+' + d;
  } else {
    d = '+' + d;
  }
  return /^\+\d{9,15}$/.test(d) ? d : null;
}

export const zPhone = z.string().transform((v, ctx) => {
  const p = normalizePhone(v);
  if (!p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid phone number' });
  return p ?? v;
});

export const zUuid = z.string().uuid();
export const zMoney = z.coerce.number().int().min(0).max(1_000_000_000);
export const zPage = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().max(100).optional(),
});

/** Append an audit entry inside the current tenant transaction. */
export async function audit(client, req, action, entity, entityId, data) {
  await client.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, data, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [req.tenantId ?? null, req.user?.id ?? null, action, entity, entityId ? String(entityId) : null,
     data ? JSON.stringify(data) : null, req.ip?.replace(/^::ffff:/, '') || null],
  );
}
