// Cutting live sessions on routers (voucher disabled, subscriber suspended, plan changed).
import { ownerPool } from '../db.js';
import * as ros from './routeros.js';

/**
 * Disconnects every open session of a voucher code or PPPoE username on the routers
 * where it is currently online. Failures are logged, not thrown: the database state
 * already blocks re-login, and the RADIUS Session-Timeout cuts the session at worst.
 */
export async function disconnectEverywhere({ tenantId, username, kind }, log) {
  const { rows } = await ownerPool.query(
    `SELECT DISTINCT r.* FROM radacct a JOIN routers r ON r.id = a.router_id
      WHERE a.tenant_id = $1 AND upper(a.username) = upper($2) AND a.acctstoptime IS NULL`,
    [tenantId, username],
  );
  let cut = 0;
  for (const r of rows) {
    if (r.vendor !== 'mikrotik') continue;
    try {
      cut += await ros.disconnectUser(r, username, { hotspot: kind !== 'pppoe', ppp: kind !== 'hotspot' });
    } catch (e) {
      log?.warn?.({ err: e.message, router: r.id, username }, 'disconnect failed');
    }
  }
  return cut;
}
