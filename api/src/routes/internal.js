// Endpoints only routers may call, through the WireGuard tunnel (source 10.88.0.0/16).
import { Router, json } from 'express';
import { asOwner } from '../db.js';
import { config } from '../config.js';
import { h, HttpError } from '../lib/http.js';
import { sha256 } from '../lib/crypto.js';
import { inCidr } from '../lib/ip.js';
import { hotspotFile } from '../services/mikrotik-script.js';

const router = Router();

const sourceIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

// Only accept direct connections from the tunnel — never via the public reverse proxy.
router.use((req, _res, next) => {
  const ip = sourceIp(req);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !inCidr(ip, '10.88.0.0/16') || req.get('x-forwarded-for')) {
    return next(new HttpError(404, 'not_found', 'Not found'));
  }
  next();
});

/** Router identified by a valid setup token AND arriving from its own tunnel address. */
async function routerByToken(c, token, ip) {
  if (!token) return null;
  const { rows } = await c.query(
    `SELECT * FROM routers WHERE setup_token_hash = $1 AND setup_token_expires_at > now() AND host(tunnel_ip) = $2`,
    [sha256(token), ip],
  );
  return rows[0] ?? null;
}

router.get('/routers/hotspot-file/:name', h(async (req, res) => {
  const r = await asOwner((c) => routerByToken(c, req.query.token, sourceIp(req)));
  if (!r) throw new HttpError(403, 'forbidden', 'Invalid setup token');
  const body = hotspotFile(req.params.name, { portalUrl: config.PORTAL_URL, routerId: r.id });
  if (!body) throw new HttpError(404, 'not_found', 'Not found');
  res.type('text/html').send(body);
}));

router.post('/routers/register', json({ limit: '4kb', type: () => true }), h(async (req, res) => {
  const b = req.body || {};
  const ip = sourceIp(req);
  const r = await asOwner(async (c) => {
    const row = await routerByToken(c, b.token, ip);
    if (!row) return null;
    await c.query(
      `UPDATE routers SET status = 'online', registered_at = coalesce(registered_at, now()), last_seen_at = now(),
              identity = $1, os_version = $2, model = coalesce(nullif($3, ''), model), serial = nullif($4, ''),
              setup_token_hash = NULL, setup_token_expires_at = NULL
        WHERE id = $5`,
      [String(b.identity ?? '').slice(0, 64), String(b.version ?? '').slice(0, 64), String(b.board ?? '').slice(0, 64),
       String(b.serial ?? '').slice(0, 64), row.id],
    );
    await c.query(
      `INSERT INTO audit_log (tenant_id, action, entity, entity_id, data, ip) VALUES ($1, 'router.registered', 'router', $2, $3, $4)`,
      [row.tenant_id, row.id, JSON.stringify({ identity: b.identity, version: b.version, board: b.board }), ip],
    );
    return row;
  });
  if (!r) throw new HttpError(403, 'forbidden', 'Invalid or expired setup token');
  req.log.info({ router: r.id }, 'router registered');
  res.json({ ok: true });
}));

export default router;
