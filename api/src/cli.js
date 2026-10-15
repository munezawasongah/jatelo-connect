// Operations commands, run inside the API container:
//   docker compose exec api node src/cli.js create-admin <email> <password> [name]
import bcrypt from 'bcryptjs';
import { asOwner, closePools } from './db.js';

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  if (cmd === 'create-admin') {
    const [email, password, ...name] = args;
    if (!email || !password || password.length < 10) throw new Error('Usage: create-admin <email> <password (10+ chars)> [name]');
    const hash = await bcrypt.hash(password, 12);
    await asOwner((c) => c.query(
      `INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (NULL, $1, $2, $3, 'platform_admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'platform_admin', status = 'active'`,
      [name.join(' ') || 'Jatelo Admin', email.toLowerCase(), hash]));
    console.log(`Platform admin ready: ${email}`);
  } else {
    console.log('Commands: create-admin <email> <password> [name]');
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(closePools);
