// One-time codes for phone verification, password reset and portal session recovery.
import { randomDigits, sha256 } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';

const TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_PER_HOUR = 5;

const hashCode = (target, code) => sha256(`${target}:${code}`);

/** Creates a code; returns it so the caller can send it. Must run as owner (no RLS on otp_codes). */
export async function createOtp(client, { purpose, target, tenantId = null }) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM otp_codes
      WHERE purpose = $1 AND target = $2 AND created_at > now() - interval '1 hour'`,
    [purpose, target],
  );
  if (rows[0].n >= MAX_PER_HOUR) {
    throw new HttpError(429, 'too_many_codes', 'Too many codes requested. Try again in an hour.');
  }
  const code = randomDigits(6);
  await client.query(
    `INSERT INTO otp_codes (purpose, target, tenant_id, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
    [purpose, target, tenantId, hashCode(target, code), TTL_MINUTES],
  );
  return code;
}

/** Checks the latest unused code; consumes it on success. Returns true/false. */
export async function verifyOtp(client, { purpose, target, code }) {
  const { rows } = await client.query(
    `SELECT id, code_hash, attempts FROM otp_codes
      WHERE purpose = $1 AND target = $2 AND used_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [purpose, target],
  );
  const otp = rows[0];
  if (!otp || otp.attempts >= MAX_ATTEMPTS) return false;
  if (otp.code_hash !== hashCode(target, String(code).trim())) {
    await client.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
    return false;
  }
  await client.query('UPDATE otp_codes SET used_at = now() WHERE id = $1', [otp.id]);
  return true;
}
