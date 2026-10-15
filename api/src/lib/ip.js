// Small IPv4 helpers for router address planning.

export const ipToInt = (ip) => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
export const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

export function parseCidr(cidr) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(cidr).trim());
  if (!m) throw new Error(`Invalid network ${cidr}`);
  const prefix = Number(m[2]);
  if (prefix > 32) throw new Error(`Invalid network ${cidr}`);
  const parts = m[1].split('.').map(Number);
  if (parts.some((p) => p > 255)) throw new Error(`Invalid network ${cidr}`);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipToInt(m[1]) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { network: intToIp(network), prefix, broadcast: intToIp(broadcast), first: network + 1, last: broadcast - 1 };
}

/**
 * Plan a LAN: gateway = first host, DHCP pool from the 10th host (or 2nd on tiny nets) to the last.
 */
export function planLan(cidr) {
  const n = parseCidr(cidr);
  if (n.prefix < 16 || n.prefix > 29) throw new Error('Client network must be between /16 and /29');
  const size = n.last - n.first + 1;
  const poolStart = size > 20 ? n.first + 9 : n.first + 1;
  return {
    cidr: `${n.network}/${n.prefix}`,
    prefix: n.prefix,
    gateway: intToIp(n.first),
    poolStart: intToIp(poolStart),
    poolEnd: intToIp(n.last),
  };
}

export function isPrivate(ip) {
  const n = ipToInt(ip);
  return (n >>> 24) === 10 || (n >>> 20) === (172 << 4 | 1) || (n >>> 16) === (192 << 8 | 168);
}

export function inCidr(ip, cidr) {
  const n = parseCidr(cidr.includes('/') ? cidr : `${cidr}/32`);
  const v = ipToInt(ip);
  return v >= ipToInt(n.network) && v <= ipToInt(n.broadcast);
}
