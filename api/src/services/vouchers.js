// Voucher issuing. Every hotspot entitlement — printed, agent-sold or bought on the portal — is a voucher.
import { randomCode } from '../lib/crypto.js';

/**
 * Creates `quantity` vouchers for a package inside the caller's transaction.
 * Codes are unique per tenant; collisions are retried.
 */
export async function issueVouchers(c, {
  tenantId, pkg, quantity = 1, source, batchId = null, agentId = null, customerId = null, siteId = null, codeLength = 8,
}) {
  const created = [];
  let attempts = 0;
  while (created.length < quantity) {
    if (++attempts > 20) throw new Error('Could not generate unique voucher codes');
    const need = quantity - created.length;
    const codes = Array.from({ length: need }, () => randomCode(codeLength));
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await c.query(
      `INSERT INTO vouchers (tenant_id, package_id, batch_id, agent_id, customer_id, site_id, code, source,
                             duration_minutes, data_limit_mb, rate_up_kbps, rate_down_kbps, device_limit, price, sold_at)
       SELECT $1, $2, $3, $4, $5, $6, code, $7, $8, $9, $10, $11, $12, $13,
              CASE WHEN $7 IN ('portal','manual') OR $4::uuid IS NOT NULL THEN now() END
         FROM unnest($14::text[]) AS code
       ON CONFLICT (tenant_id, code) DO NOTHING
       RETURNING id, code, status, price, created_at`,
      [tenantId, pkg.id, batchId, agentId, customerId, siteId, source, pkg.duration_minutes, pkg.data_limit_mb,
       pkg.rate_up_kbps, pkg.rate_down_kbps, pkg.device_limit, pkg.price, codes],
    );
    created.push(...rows);
  }
  return created;
}

/** Human description of a package or voucher entitlement, e.g. "1 jour · 5 Go · 3 Mbps". */
export function describeEntitlement(p, lang = 'fr') {
  const parts = [];
  const m = p.duration_minutes;
  if (m) {
    const L = { fr: ['min', 'h', 'jour', 'jours'], rn: ['min', 'h', 'umusi', 'imisi'], en: ['min', 'h', 'day', 'days'] }[lang] || [];
    if (m < 60) parts.push(`${m} ${L[0]}`);
    else if (m < 1440) parts.push(`${Math.round(m / 60)} ${L[1]}`);
    else { const d = Math.round(m / 1440); parts.push(`${d} ${d === 1 ? L[2] : L[3]}`); }
  }
  const [gb, mb] = lang === 'en' ? ['GB', 'MB'] : ['Go', 'Mo'];
  if (p.data_limit_mb) parts.push(p.data_limit_mb >= 1024 ? `${+(p.data_limit_mb / 1024).toFixed(1)} ${gb}` : `${p.data_limit_mb} ${mb}`);
  if (p.rate_down_kbps) parts.push(`${+(p.rate_down_kbps / 1024).toFixed(1)} Mbps`);
  return parts.join(' · ');
}
