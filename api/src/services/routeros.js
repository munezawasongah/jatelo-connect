// RouterOS API client (port 8728, only reachable through the WireGuard tunnel).
import { RouterOSAPI } from 'node-routeros';
import { decrypt } from '../lib/crypto.js';

async function withRouter(router, fn) {
  if (router.vendor !== 'mikrotik' || !router.tunnel_ip) throw new Error('Router is not managed through the RouterOS API');
  const conn = new RouterOSAPI({
    host: String(router.tunnel_ip).replace(/\/32$/, ''),
    user: router.api_username,
    password: decrypt(router.api_password_enc),
    port: 8728,
    timeout: 10,
    keepalive: false,
  });
  conn.on('error', () => {}); // errors surface through the awaited calls
  await conn.connect();
  try {
    return await fn(conn);
  } finally {
    await conn.close().catch(() => {});
  }
}

/** Health and inventory: identity, version, CPU, memory, uptime and interfaces. */
export async function fetchInfo(router) {
  return withRouter(router, async (c) => {
    const [res] = await c.write('/system/resource/print');
    const [ident] = await c.write('/system/identity/print');
    const ifaces = await c.write('/interface/print', ['=.proplist=name,type,running,disabled,rx-byte,tx-byte']);
    const hsActive = await c.write('/ip/hotspot/active/print', ['=count-only=']).catch(() => []);
    const pppActive = await c.write('/ppp/active/print', ['=count-only=']).catch(() => []);
    return {
      identity: ident?.name,
      version: res?.version,
      board: res?.['board-name'],
      architecture: res?.['architecture-name'],
      uptime: res?.uptime,
      cpu_load: Number(res?.['cpu-load'] ?? 0),
      free_memory: Number(res?.['free-memory'] ?? 0),
      total_memory: Number(res?.['total-memory'] ?? 0),
      free_hdd: Number(res?.['free-hdd-space'] ?? 0),
      interfaces: ifaces.map((i) => ({
        name: i.name, type: i.type, running: i.running === 'true', disabled: i.disabled === 'true',
        rx_bytes: Number(i['rx-byte'] ?? 0), tx_bytes: Number(i['tx-byte'] ?? 0),
      })),
      hotspot_active: Number(hsActive?.[0]?.ret ?? 0),
      ppp_active: Number(pppActive?.[0]?.ret ?? 0),
      fetched_at: new Date().toISOString(),
    };
  });
}

/** Per-interface byte counters, for bandwidth graphs (sampled every minute by the worker). */
export async function fetchTraffic(router) {
  return withRouter(router, async (c) => {
    const rows = await c.write('/interface/print', ['=.proplist=name,rx-byte,tx-byte,running']);
    return rows.map((r) => ({ name: r.name, rx: Number(r['rx-byte'] ?? 0), tx: Number(r['tx-byte'] ?? 0), running: r.running === 'true' }));
  });
}

/** Disconnect a hotspot user (voucher code) and/or a PPPoE user by name. Returns how many sessions were cut. */
export async function disconnectUser(router, username, { hotspot = true, ppp = true } = {}) {
  return withRouter(router, async (c) => {
    let n = 0;
    if (hotspot) {
      const act = await c.write('/ip/hotspot/active/print', [`?user=${username}`, '=.proplist=.id']).catch(() => []);
      for (const a of act) { await c.write('/ip/hotspot/active/remove', [`=.id=${a['.id']}`]); n++; }
      // Drop MAC cookies too, otherwise the phone logs straight back in
      const ck = await c.write('/ip/hotspot/cookie/print', [`?user=${username}`, '=.proplist=.id']).catch(() => []);
      for (const k of ck) await c.write('/ip/hotspot/cookie/remove', [`=.id=${k['.id']}`]).catch(() => {});
    }
    if (ppp) {
      const act = await c.write('/ppp/active/print', [`?name=${username}`, '=.proplist=.id']).catch(() => []);
      for (const a of act) { await c.write('/ppp/active/remove', [`=.id=${a['.id']}`]); n++; }
    }
    return n;
  });
}

export async function reboot(router) {
  return withRouter(router, async (c) => {
    await c.write('/system/reboot').catch(() => {}); // the connection drops as the router restarts
    return true;
  });
}
