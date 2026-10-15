// Operator (tenant) provisioning and plan limits.
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { conflict } from '../lib/http.js';

export const TIERS = {
  trial:      { max_routers: 1,    max_active_users: 50,   price: 0 },
  starter:    { max_routers: 1,    max_active_users: 150,  price: 15000 },
  business:   { max_routers: 5,    max_active_users: null, price: 45000 },
  isp:        { max_routers: 25,   max_active_users: null, price: 120000 },
  enterprise: { max_routers: 1000, max_active_users: null, price: null },
};

export function slugify(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'operator';
}

async function uniqueSlug(client, base) {
  let slug = base, n = 1;
  // eslint-disable-next-line no-await-in-loop
  while ((await client.query('SELECT 1 FROM tenants WHERE slug = $1', [slug])).rowCount) slug = `${base}-${++n}`;
  return slug;
}

// Starting catalogue so a new operator can sell within minutes. All editable.
const DEFAULT_PACKAGES = [
  { name: 'Essai gratuit 10 min', price: 0, duration_minutes: 10, rate_up_kbps: 512, rate_down_kbps: 1024, is_trial: true, visible_on_portal: false, sort_order: 0 },
  { name: '1 heure', price: 500, duration_minutes: 60, rate_up_kbps: 1024, rate_down_kbps: 3072, sort_order: 1 },
  { name: '1 jour', price: 2000, duration_minutes: 1440, rate_up_kbps: 1024, rate_down_kbps: 3072, sort_order: 2 },
  { name: '7 jours', price: 10000, duration_minutes: 10080, rate_up_kbps: 1024, rate_down_kbps: 3072, sort_order: 3 },
  { name: '30 jours', price: 30000, duration_minutes: 43200, rate_up_kbps: 2048, rate_down_kbps: 5120, sort_order: 4 },
  { name: '1 Go', price: 1500, data_limit_mb: 1024, duration_minutes: 10080, rate_up_kbps: 2048, rate_down_kbps: 5120, sort_order: 5 },
];

const DEFAULT_PLANS = [
  { name: 'Maison 5 Mbps', price: 60000, rate_up_kbps: 2048, rate_down_kbps: 5120 },
  { name: 'Business 10 Mbps', price: 120000, rate_up_kbps: 5120, rate_down_kbps: 10240 },
];

/** Creates tenant, owner, default site, packages and plans. Runs as owner (no RLS). */
export async function createTenantWithOwner(client, { businessName, name, email, phone, password, language = 'fr' }) {
  if (email) {
    const { rowCount } = await client.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (rowCount) throw conflict('An account with this email already exists');
  }
  const slug = await uniqueSlug(client, slugify(businessName));
  const { rows: [tenant] } = await client.query(
    `INSERT INTO tenants (name, slug, language, phone, email, tier, status, trial_ends_at, max_routers, max_active_users, currency)
     VALUES ($1, $2, $3, $4, $5, 'trial', 'trial', now() + make_interval(days => $6), $7, $8, $9)
     RETURNING *`,
    [businessName, slug, language, phone, email, config.TRIAL_DAYS, TIERS.trial.max_routers,
     TIERS.trial.max_active_users, config.DEFAULT_CURRENCY],
  );
  const hash = await bcrypt.hash(password, 11);
  const { rows: [user] } = await client.query(
    `INSERT INTO users (tenant_id, name, email, phone, password_hash, role, language)
     VALUES ($1, $2, $3, $4, $5, 'owner', $6) RETURNING id, tenant_id, name, email, phone, role, language`,
    [tenant.id, name, email, phone, hash, language],
  );
  await client.query(
    `INSERT INTO sites (tenant_id, name, slug, portal) VALUES ($1, $2, 'main', $3)`,
    [tenant.id, businessName, JSON.stringify({
      brand: businessName, primary_color: '#0E7C66', languages: ['fr', 'rn', 'en'],
      default_language: language, trial_enabled: true, support_phone: phone,
    })],
  );
  for (const p of DEFAULT_PACKAGES) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO packages (tenant_id, name, price, duration_minutes, data_limit_mb, rate_up_kbps, rate_down_kbps,
                             is_trial, visible_on_portal, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tenant.id, p.name, p.price, p.duration_minutes ?? null, p.data_limit_mb ?? null, p.rate_up_kbps,
       p.rate_down_kbps, p.is_trial ?? false, p.visible_on_portal ?? true, p.sort_order],
    );
  }
  for (const p of DEFAULT_PLANS) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      'INSERT INTO plans (tenant_id, name, price, rate_up_kbps, rate_down_kbps) VALUES ($1,$2,$3,$4,$5)',
      [tenant.id, p.name, p.price, p.rate_up_kbps, p.rate_down_kbps],
    );
  }
  return { tenant, user };
}
