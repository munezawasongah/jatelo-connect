// Applies SQL files in db/migrations in order, once each, as the owner role.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.MIGRATIONS_DIR || path.resolve(here, '../../db/migrations');

export async function migrate(connectionString = process.env.DATABASE_OWNER_URL, log = console) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Serialise concurrent boots (API + worker starting together)
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
      if (log.info) log.info(`migrating ${file}`); else log.log(`migrating ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().then(() => { console.log('migrations complete'); }).catch((e) => { console.error(e.message); process.exit(1); });
}

/** Gives the API and RADIUS roles their login passwords from the environment (idempotent). */
export async function setRolePasswords(connectionString = process.env.DATABASE_OWNER_URL) {
  const pairs = [['jc_app', process.env.APP_DB_PASSWORD], ['jc_radius', process.env.RADIUS_DB_PASSWORD]].filter(([, p]) => p);
  if (!pairs.length) return;
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const [role, pass] of pairs) await client.query(`ALTER ROLE ${role} LOGIN PASSWORD ${client.escapeLiteral(pass)}`);
  } finally {
    await client.end();
  }
}
