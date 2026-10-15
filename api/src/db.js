// Database access.
//  - appPool:   the jc_app role; row-level security isolates tenants.
//  - ownerPool: the owner role; used by migrations, workers and pre-auth lookups.
import pg from 'pg';
import { config } from './config.js';

// Return BIGINT (int8) as JS numbers: money in BIF and byte counters stay well under 2^53.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const appPool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 20 });
export const ownerPool = new pg.Pool({ connectionString: config.DATABASE_OWNER_URL, max: 10 });

/** Run fn(client) in a transaction scoped to one tenant (RLS applies). */
export async function withTenant(tenantId, fn) {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Run fn(client) in a transaction as the owner (bypasses RLS — platform code only). */
export async function asOwner(fn) {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePools() {
  await Promise.allSettled([appPool.end(), ownerPool.end()]);
}
