// Real-time dashboard events: one PostgreSQL LISTEN connection fans out to Server-Sent
// Event streams, grouped by tenant.
import pg from 'pg';
import { config } from '../config.js';

const streams = new Map(); // tenantId -> Set<res>
let client = null;
let starting = null;

async function connect(log) {
  const c = new pg.Client({ connectionString: config.DATABASE_OWNER_URL });
  c.on('notification', (msg) => {
    let ev; try { ev = JSON.parse(msg.payload); } catch { return; }
    const set = streams.get(ev.tenant_id);
    if (!set) return;
    const line = `event: ${ev.type}\ndata: ${JSON.stringify({ id: ev.id })}\n\n`;
    for (const res of set) res.write(line);
  });
  c.on('error', (e) => {
    log?.warn?.({ err: e.message }, 'event listener lost; reconnecting');
    client = null;
    setTimeout(() => ensureListener(log).catch(() => {}), 2000);
  });
  await c.connect();
  await c.query('LISTEN jc_events');
  return c;
}

export async function ensureListener(log) {
  if (client) return client;
  if (!starting) starting = connect(log).then((c) => { client = c; return c; }).finally(() => { starting = null; });
  return starting;
}

/** Attach an SSE response to a tenant's event stream until the browser disconnects. */
export async function subscribe(tenantId, req, res, log) {
  await ensureListener(log);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 5000\n\nevent: ready\ndata: {}\n\n');
  if (!streams.has(tenantId)) streams.set(tenantId, new Set());
  streams.get(tenantId).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    const set = streams.get(tenantId);
    set?.delete(res);
    if (set && !set.size) streams.delete(tenantId);
  });
}

export async function closeListener() {
  if (client) await client.end().catch(() => {});
  client = null;
}
