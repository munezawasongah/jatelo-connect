// Routers: create, configure, onboarding script, health, reboot, disconnect.
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, asOwner } from '../db.js';
import { config } from '../config.js';
import { h, parse, notFound, badRequest, limitReached, audit, zUuid } from '../lib/http.js';
import { encrypt, decrypt, wgKeypair, randomPassword, randomToken, sha256 } from '../lib/crypto.js';
import { planLan, isPrivate } from '../lib/ip.js';
import { requireRole, ROLES } from '../middleware/auth.js';
import { buildMikrotikScript, isValidInterfaceName } from '../services/mikrotik-script.js';
import * as wg from '../services/wireguard.js';
import * as ros from '../services/routeros.js';

const router = Router();

const zIface = z.string().trim().refine(isValidInterfaceName, 'Invalid interface name');
const zLan = z.string().trim().refine((v) => { try { planLan(v); return isPrivate(v.split('/')[0]); } catch { return false; } },
  'Must be a private network between /16 and /29, e.g. 10.5.50.0/24');

const routerFields = {
  name: z.string().trim().min(1).max(60),
  site_id: zUuid.nullable().optional(),
  model: z.string().trim().max(60).nullable().optional(),
  hotspot_enabled: z.boolean().optional(),
  pppoe_enabled: z.boolean().optional(),
  hotspot_ports: z.array(zIface).max(24).optional(),
  hotspot_network: zLan.optional(),
  pppoe_interface: zIface.nullable().optional(),
  pppoe_network: zLan.optional(),
  wan_interface: zIface.optional(),
};

const PUBLIC_COLUMNS = `r.id, r.site_id, s.name AS site_name, r.name, r.vendor, r.model, r.os_version, r.serial, r.identity,
  host(r.tunnel_ip) AS tunnel_ip, host(r.public_ip) AS public_ip, r.hotspot_enabled, r.pppoe_enabled, r.hotspot_ports,
  r.hotspot_network::text, r.pppoe_interface, r.pppoe_network::text, r.wan_interface, r.status, r.last_seen_at,
  r.registered_at, r.info, r.created_at,
  (SELECT count(*)::int FROM radacct a WHERE a.router_id = r.id AND a.acctstoptime IS NULL AND a.voucher_id IS NOT NULL) AS hotspot_online,
  (SELECT count(*)::int FROM radacct a WHERE a.router_id = r.id AND a.acctstoptime IS NULL AND a.subscription_id IS NOT NULL) AS pppoe_online`;

async function loadRouter(c, id) {
  const { rows } = await c.query('SELECT * FROM routers WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Router');
  return rows[0];
}

async function publicRouter(c, id) {
  const { rows } = await c.query(`SELECT ${PUBLIC_COLUMNS} FROM routers r LEFT JOIN sites s ON s.id = r.site_id WHERE r.id = $1`, [id]);
  return rows[0];
}

router.get('/', h(async (req, res) => {
  const rows = await withTenant(req.tenantId, async (c) =>
    (await c.query(`SELECT ${PUBLIC_COLUMNS} FROM routers r LEFT JOIN sites s ON s.id = r.site_id ORDER BY r.created_at`)).rows);
  res.json({ routers: rows });
}));

router.get('/:id', h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const r = await withTenant(req.tenantId, async (c) => { await loadRouter(c, id); return publicRouter(c, id); });
  res.json({ router: r });
}));

router.post('/', requireRole(...ROLES.network), h(async (req, res) => {
  const body = parse(z.object({
    ...routerFields,
    vendor: z.enum(['mikrotik', 'ruijie', 'generic']).default('mikrotik'),
    public_ip: z.string().ip({ version: 'v4' }).optional(),
  }).refine((b) => b.vendor === 'mikrotik' || b.public_ip, { message: 'A fixed public IP is required for this router type', path: ['public_ip'] }), req.body);

  const created = await withTenant(req.tenantId, async (c) => {
    const { rows: [{ n }] } = await c.query(`SELECT count(*)::int AS n FROM routers WHERE status <> 'disabled'`);
    if (n >= req.user.max_routers && req.user.role !== 'platform_admin') {
      throw limitReached(`Your plan allows ${req.user.max_routers} router(s). Upgrade to add more.`);
    }
    if (body.site_id) {
      const { rowCount } = await c.query('SELECT 1 FROM sites WHERE id = $1', [body.site_id]);
      if (!rowCount) throw badRequest('Unknown site');
    }
    let r;
    if (body.vendor === 'mikrotik') {
      const keys = wgKeypair();
      const { rows: [{ ip }] } = await c.query('SELECT host(jc_next_tunnel_ip()) AS ip');
      ({ rows: [r] } = await c.query(
        `INSERT INTO routers (tenant_id, site_id, name, vendor, model, tunnel_ip, wg_public_key, wg_private_key_enc,
           api_username, api_password_enc, hotspot_enabled, pppoe_enabled, hotspot_ports, hotspot_network,
           pppoe_interface, pppoe_network, wan_interface)
         VALUES ($1,$2,$3,'mikrotik',$4,$5,$6,$7,'jcapi',$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [req.tenantId, body.site_id ?? null, body.name, body.model ?? null, ip, keys.publicKey, encrypt(keys.privateKey),
         encrypt(randomPassword(20)), body.hotspot_enabled ?? true, body.pppoe_enabled ?? true, body.hotspot_ports ?? [],
         body.hotspot_network ?? '10.5.50.0/24', body.pppoe_interface ?? null, body.pppoe_network ?? '10.10.0.0/16',
         body.wan_interface ?? 'ether1'],
      ));
      await c.query(`INSERT INTO nas (nasname, shortname, secret, tenant_id, router_id, description)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
        [ip, `r-${r.id.slice(0, 8)}`, config.RADIUS_SECRET, req.tenantId, r.id, body.name]);
    } else {
      const secret = randomPassword(24);
      ({ rows: [r] } = await c.query(
        `INSERT INTO routers (tenant_id, site_id, name, vendor, model, public_ip, radius_secret_enc,
           hotspot_enabled, pppoe_enabled, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING *`,
        [req.tenantId, body.site_id ?? null, body.name, body.vendor, body.model ?? null, body.public_ip,
         encrypt(secret), body.hotspot_enabled ?? true, body.pppoe_enabled ?? false],
      ));
      await c.query(`INSERT INTO nas (nasname, shortname, secret, tenant_id, router_id, description)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
        [body.public_ip, `r-${r.id.slice(0, 8)}`, secret, req.tenantId, r.id, body.name]);
    }
    await audit(c, req, 'router.create', 'router', r.id, { name: r.name, vendor: r.vendor });
    return r;
  }).catch((e) => {
    if (e.code === '23505' && /public_ip|nasname/.test(e.detail || e.constraint || '')) throw badRequest('This public IP is already registered');
    throw e;
  });

  if (created.vendor === 'mikrotik') await wg.addPeer(created.wg_public_key, created.tunnel_ip, req.log);
  const out = await withTenant(req.tenantId, (c) => publicRouter(c, created.id));
  res.status(201).json({ router: out });
}));

router.patch('/:id', requireRole(...ROLES.network), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const body = parse(z.object(routerFields).partial(), req.body);
  const out = await withTenant(req.tenantId, async (c) => {
    await loadRouter(c, id);
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(body)) { if (v !== undefined) { vals.push(v); sets.push(`${k} = $${vals.length}`); } }
    if (sets.length) {
      vals.push(id);
      await c.query(`UPDATE routers SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
      if (body.name) await c.query('UPDATE nas SET description = $1 WHERE router_id = $2', [body.name, id]);
      await audit(c, req, 'router.update', 'router', id, body);
    }
    return publicRouter(c, id);
  });
  res.json({ router: out, note: 'Run the setup script again on the router to apply network changes.' });
}));

router.delete('/:id', requireRole('owner', 'manager'), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const r = await withTenant(req.tenantId, async (c) => {
    const row = await loadRouter(c, id);
    await c.query('DELETE FROM routers WHERE id = $1', [id]); // nas row cascades
    await audit(c, req, 'router.delete', 'router', id, { name: row.name });
    return row;
  });
  if (r.wg_public_key) await wg.removePeer(r.wg_public_key, req.log).catch((e) => req.log.warn(e, 'peer removal failed'));
  res.json({ ok: true });
}));

// ── Onboarding: MikroTik script, or the values to type into other devices ──
router.post('/:id/setup', requireRole(...ROLES.network), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const result = await withTenant(req.tenantId, async (c) => {
    const r = await loadRouter(c, id);
    const portalHost = new URL(config.PORTAL_URL).hostname;
    if (r.vendor !== 'mikrotik') {
      return {
        vendor: r.vendor,
        settings: {
          radius_server: config.SERVER_PUBLIC_IP,
          auth_port: 1812,
          accounting_port: 1813,
          coa_port: 3799,
          radius_secret: decrypt(r.radius_secret_enc),
          nas_ip: host(r.public_ip),
          external_portal_url: `${config.PORTAL_URL.replace(/\/$/, '')}/h/${r.id}`,
          walled_garden: [portalHost, config.SERVER_PUBLIC_IP],
          accounting_interim_seconds: 300,
        },
      };
    }
    const token = randomToken(24);
    await c.query(
      `UPDATE routers SET setup_token_hash = $1, setup_token_expires_at = now() + interval '24 hours' WHERE id = $2`,
      [sha256(token), id],
    );
    await audit(c, req, 'router.setup_script', 'router', id);
    const script = buildMikrotikScript({
      router: { ...r, tunnel_ip: host(r.tunnel_ip), hotspot_network: String(r.hotspot_network), pppoe_network: String(r.pppoe_network) },
      privateKey: decrypt(r.wg_private_key_enc),
      apiPassword: decrypt(r.api_password_enc),
      setupToken: token,
      env: {
        hubPublicKey: config.WG_HUB_PUBLIC_KEY,
        serverIp: config.SERVER_PUBLIC_IP,
        wgPort: config.WG_PORT,
        radiusSecret: config.RADIUS_SECRET,
        radiusHost: config.RADIUS_HOST,
        radiusBackupHost: config.RADIUS_BACKUP_HOST,
        apiPort: config.PORT,
        portalHost,
      },
    });
    return { vendor: 'mikrotik', script, expires_in_hours: 24 };
  });
  res.json(result);
}));

function host(ip) { return ip ? String(ip).replace(/\/\d+$/, '') : null; }

// ── Live health from the router ──
router.post('/:id/refresh', requireRole(...ROLES.network), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const r = await withTenant(req.tenantId, (c) => loadRouter(c, id));
  let info;
  try {
    info = await ros.fetchInfo(r);
  } catch (e) {
    await asOwner((c) => c.query(`UPDATE routers SET status = CASE WHEN status = 'pending' THEN status ELSE 'offline' END WHERE id = $1`, [id]));
    throw badRequest(`Router did not respond: ${e.message}`);
  }
  const out = await withTenant(req.tenantId, async (c) => {
    await c.query(
      `UPDATE routers SET info = $1, identity = $2, os_version = $3, status = 'online', last_seen_at = now(),
              model = coalesce(model, $4) WHERE id = $5`,
      [JSON.stringify(info), info.identity, info.version, info.board, id],
    );
    return publicRouter(c, id);
  });
  res.json({ router: out });
}));

router.post('/:id/reboot', requireRole(...ROLES.network), h(async (req, res) => {
  const id = parse(zUuid, req.params.id);
  const r = await withTenant(req.tenantId, async (c) => {
    const row = await loadRouter(c, id);
    await audit(c, req, 'router.reboot', 'router', id);
    return row;
  });
  await ros.reboot(r);
  res.json({ ok: true });
}));

export default router;
