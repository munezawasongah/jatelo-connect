// Manages router peers on the WireGuard hub (wg0) on the platform server.
// Peers are runtime state; syncAllPeers() rebuilds them from the database at boot.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { ownerPool } from '../db.js';

const run = promisify(execFile);

async function wg(args, log) {
  if (!config.WG_MANAGE) {
    log?.debug?.({ args }, 'wireguard management disabled; skipping');
    return '';
  }
  const { stdout } = await run('wg', args, { timeout: 10_000 });
  return stdout;
}

export async function addPeer(publicKey, tunnelIp, log) {
  await wg(['set', config.WG_INTERFACE, 'peer', publicKey, 'allowed-ips', `${tunnelIp}/32`, 'persistent-keepalive', '25'], log);
}

export async function removePeer(publicKey, log) {
  await wg(['set', config.WG_INTERFACE, 'peer', publicKey, 'remove'], log);
}

/** Latest handshake per peer public key (unix seconds), for online detection. */
export async function handshakes(log) {
  const out = await wg(['show', config.WG_INTERFACE, 'latest-handshakes'], log);
  const map = new Map();
  for (const line of out.split('\n')) {
    const [key, ts] = line.trim().split(/\s+/);
    if (key && ts) map.set(key, Number(ts));
  }
  return map;
}

/** Ensure every MikroTik router in the database is a peer, and remove peers that are gone. */
export async function syncAllPeers(log) {
  if (!config.WG_MANAGE) return;
  const { rows } = await ownerPool.query(
    `SELECT wg_public_key, host(tunnel_ip) AS ip FROM routers
      WHERE vendor = 'mikrotik' AND status <> 'disabled' AND wg_public_key IS NOT NULL`,
  );
  const want = new Map(rows.map((r) => [r.wg_public_key, r.ip]));
  const current = await handshakes(log);
  for (const [key, ip] of want) await addPeer(key, ip, log);
  for (const key of current.keys()) if (!want.has(key)) await removePeer(key, log);
  log?.info?.({ peers: want.size }, 'wireguard peers synced');
}
