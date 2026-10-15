// Creates a demo operator with 30 days of realistic activity, for demos and screenshots.
//   node src/seed-demo.js            → demo@jateloconnect.com / demo12345
// Safe to re-run: the previous demo operator is deleted first.
import { asOwner, closePools } from './db.js';
import { createTenantWithOwner } from './services/tenants.js';
import { issueVouchers } from './services/vouchers.js';
import { renewSubscription } from './services/subscriptions.js';
import { encrypt, randomCode, wgKeypair } from './lib/crypto.js';

const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const NAMES = ['Jean Ndayishimiye', 'Aline Irakoze', 'Eric Niyonzima', 'Claudine Uwimana', 'Didier Hakizimana', 'Grace Ndikumana',
  'Patrick Nshimirimana', 'Sandrine Kaneza', 'Olivier Bigirimana', 'Josiane Iradukunda', 'Fabrice Manirakiza', 'Divine Ineza',
  'Emmanuel Nzeyimana', 'Chantal Ntakirutimana', 'Bosco Havyarimana', 'Nadine Akimana'];
const AREAS = ['Rohero', 'Kinindo', 'Kiriri', 'Gihosha', 'Ngagara', 'Kamenge', 'Nyakabiga', 'Buyenzi', 'Kanyosha'];
const phone = () => `+257${pick(['79', '71', '72', '61', '68', '69'])}${rand(100000, 999999)}`;

await asOwner(async (c) => {
  await c.query(`DELETE FROM tenants WHERE id IN (SELECT tenant_id FROM users WHERE email = 'demo@jateloconnect.com')`);
  const { tenant } = await createTenantWithOwner(c, {
    businessName: 'Rohero WiFi', name: 'Aline Irakoze', email: 'demo@jateloconnect.com', phone: '+25779000100', password: 'demo12345',
  });
  const T = tenant.id;
  await c.query(`UPDATE tenants SET status = 'active', tier = 'business', max_routers = 5, paid_until = now() + interval '40 days' WHERE id = $1`, [T]);
  await c.query(`UPDATE users SET phone_verified_at = now() WHERE tenant_id = $1`, [T]);
  const { rows: [site] } = await c.query('SELECT id FROM sites WHERE tenant_id = $1', [T]);

  // Routers
  const routers = [];
  for (const [name, status, model, ver] of [['Rohero Tower', 'online', 'CCR2004-1G-12S+2XS', '7.16.2'], ['Kinindo AP', 'online', 'hAP ax2', '7.16.1'], ['Kiriri Relay', 'offline', 'hAP ac2', '7.15.3'], ['Gihosha (new)', 'pending', null, null]]) {
    const k = wgKeypair();
    const { rows: [{ ip }] } = await c.query('SELECT host(jc_next_tunnel_ip()) AS ip');
    const { rows: [r] } = await c.query(
      `INSERT INTO routers (tenant_id, site_id, name, model, os_version, tunnel_ip, wg_public_key, wg_private_key_enc, api_username, api_password_enc,
         status, last_seen_at, registered_at, hotspot_ports, info)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'jcapi',$9,$10,$11,$12,$13,$14) RETURNING *`,
      [T, site.id, name, model, ver, ip, k.publicKey, encrypt(k.privateKey), encrypt('x'), status,
       status === 'pending' ? null : (status === 'online' ? new Date() : new Date(Date.now() - 47 * 60000)),
       status === 'pending' ? null : new Date(Date.now() - 20 * 86400000), ['ether3', 'ether4'],
       JSON.stringify(status === 'pending' ? {} : { uptime: status === 'online' ? `${rand(3, 19)}d${rand(1, 23)}h` : '—', cpu_load: rand(4, 38), free_memory: 600e6, total_memory: 1024e6,
         board: model, interfaces: [{ name: 'ether1', type: 'ether', running: true, rx_bytes: 9.1e11, tx_bytes: 2.2e11 }, { name: 'jc-hotspot', type: 'bridge', running: true, rx_bytes: 1.9e11, tx_bytes: 8.4e11 }, { name: 'jc-wg', type: 'wg', running: true, rx_bytes: 4e8, tx_bytes: 3e8 }, { name: 'ether5', type: 'ether', running: false, rx_bytes: 0, tx_bytes: 0 }] })]);
    await c.query('INSERT INTO nas (nasname, shortname, secret, tenant_id, router_id) VALUES ($1,$2,$3,$4,$5)', [ip, name.slice(0, 20), 'x', T, r.id]);
    routers.push(r);
  }
  const [r1, r2] = routers;

  // Bandwidth for the main router: evening peaks
  for (let m = 0; m < 24 * 60 * 7; m += 5) {
    const ts = new Date(Date.now() - m * 60000);
    const h = (ts.getUTCHours() + 2) % 24;
    const load = 0.15 + 0.85 * Math.max(0, Math.sin(((h - 6) / 18) * Math.PI)) ** 2;
    await c.query(`INSERT INTO router_traffic (router_id, tenant_id, iface, ts, rx_bps, tx_bps) VALUES ($1,$2,'ether1',$3,$4,$5)`,
      [r1.id, T, ts, Math.round(load * 9e6 * (0.8 + Math.random() * 0.4)), Math.round(load * 42e6 * (0.8 + Math.random() * 0.4))]);
  }

  const { rows: pkgs } = await c.query('SELECT * FROM packages WHERE tenant_id = $1 AND NOT is_trial ORDER BY price', [T]);
  const { rows: plans } = await c.query('SELECT * FROM plans WHERE tenant_id = $1 ORDER BY price', [T]);
  await c.query(`INSERT INTO payment_channels (tenant_id, wallet, merchant_number, merchant_name) VALUES ($1,'lumicash','45120','ROHERO WIFI'), ($1,'ecocash','887766','ROHERO WIFI')`, [T]);
  await c.query(`INSERT INTO sms_gateways (tenant_id, name, phone, username, password_enc, token_hash, last_seen_at) VALUES ($1,'Téléphone marchand','+25779000200','demo',$2,$3, now())`, [T, encrypt('x'), randomCode(30)]);

  // Agents
  const agents = [];
  for (const [name, loc] of [['Boutique Kamenge', 'Kamenge, marché'], ['Chez Didier', 'Rohero, avenue de l’Amitié'], ['Kiosque Ngagara', 'Ngagara Q.4']]) {
    const { rows: [a] } = await c.query(`INSERT INTO agents (tenant_id, name, phone, location, discount_pct, balance) VALUES ($1,$2,$3,$4,10,$5) RETURNING *`, [T, name, phone(), loc, rand(5, 40) * 1000]);
    agents.push(a);
  }

  // 30 days of hotspot sales and agent top-ups
  for (let d = 29; d >= 0; d--) {
    const n = rand(18, 45) + (d < 7 ? 10 : 0);
    for (let i = 0; i < n; i++) {
      const pkg = pick([pkgs[0], pkgs[0], pkgs[0], pkgs[1], pkgs[1], pkgs[2], pkgs[3], pkgs[4]]);
      const ts = new Date(Date.now() - d * 86400000 - rand(0, 14) * 3600000);
      if (d === 0 && ts > new Date()) continue;
      const ph = phone();
      const { rows: [cu] } = await c.query(`INSERT INTO customers (tenant_id, phone, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [T, ph, ts]);
      const [v] = await issueVouchers(c, { tenantId: T, pkg, source: 'portal', customerId: cu?.id, siteId: site.id });
      const wallet = Math.random() < 0.72 ? 'lumicash' : 'ecocash';
      const channel = Math.random() < 0.12 ? 'cash' : 'sms_match';
      await c.query(
        `INSERT INTO payments (tenant_id, customer_id, channel, wallet, purpose, purpose_id, amount, phone, reference, external_ref, status, result_id, site_id, created_at, confirmed_at)
         VALUES ($1,$2,$3,$4,'hotspot',$5,$6,$7,$8,$9,'success',$10,$11,$12,$12)`,
        [T, cu?.id, channel, channel === 'cash' ? null : wallet, pkg.id, pkg.price, ph, `JC${randomCode(6)}`, channel === 'cash' ? null : `LC${rand(1e8, 9e8)}`, v.id, site.id, ts]);
      const exp = new Date(ts.getTime() + (pkg.duration_minutes || 1440) * 60000);
      await c.query(`UPDATE vouchers SET created_at = $2, sold_at = $2, activated_at = $2, expires_at = $3, status = CASE WHEN $3 < now() THEN 'expired' ELSE 'active' END,
                       bytes_used = $4, device_macs = $5 WHERE id = $1`,
        [v.id, ts, exp, rand(50, 900) * 1048576, [`A4:${rand(10, 99)}:3C:${rand(10, 99)}:9E:${rand(10, 99)}`]]);
    }
    if (d % 5 === 0) {
      const a = pick(agents);
      await c.query(`INSERT INTO payments (tenant_id, channel, purpose, purpose_id, amount, reference, status, created_at, confirmed_at) VALUES ($1,'cash','agent_topup',$2,$3,$4,'success',$5,$5)`,
        [T, a.id, rand(2, 6) * 10000, `JC${randomCode(6)}`, new Date(Date.now() - d * 86400000)]);
    }
  }
  // Unused printed stock
  const { rows: [b] } = await c.query(`INSERT INTO voucher_batches (tenant_id, package_id, quantity, unit_price, note) VALUES ($1,$2,40,$3,'Stock comptoir') RETURNING id`, [T, pkgs[1].id, pkgs[1].price]);
  await issueVouchers(c, { tenantId: T, pkg: pkgs[1], quantity: 40, source: 'batch', batchId: b.id });
  for (const a of agents) {
    const { rows: [ab] } = await c.query(`INSERT INTO voucher_batches (tenant_id, package_id, agent_id, quantity, unit_price, note) VALUES ($1,$2,$3,20,$4,'Agent') RETURNING id`, [T, pkgs[0].id, a.id, pkgs[0].price]);
    await issueVouchers(c, { tenantId: T, pkg: pkgs[0], quantity: 20, source: 'batch', batchId: ab.id, agentId: a.id });
  }

  // PPPoE subscribers
  const subs = [];
  for (let i = 0; i < 14; i++) {
    const name = NAMES[i];
    const { rows: [cu] } = await c.query(`INSERT INTO customers (tenant_id, name, phone, address) VALUES ($1,$2,$3,$4) RETURNING *`, [T, name, phone(), `${pick(AREAS)}, Bujumbura`]);
    const plan = pick(plans);
    const user = name.toLowerCase().normalize('NFKD').replace(/[^a-z ]/g, '').replace(' ', '.');
    const { rows: [s] } = await c.query(
      `INSERT INTO subscriptions (tenant_id, customer_id, plan_id, router_id, username, password, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,'pending', now() - interval '60 days') RETURNING *`,
      [T, cu.id, plan.id, pick([r1, r2]).id, user, randomCode(8).toLowerCase()]);
    const r = await renewSubscription(c, { tenantId: T, subscriptionId: s.id, periods: 1 });
    const shift = i < 3 ? rand(1, 6) : i < 5 ? -rand(1, 4) : rand(8, 28);
    await c.query(`UPDATE subscriptions SET expires_at = now() + make_interval(days => $2), status = CASE WHEN $2 < 0 THEN 'expired' ELSE 'active' END,
                     installed_at = now() - interval '60 days', period_bytes = $3 WHERE id = $1`, [s.id, shift, rand(5, 120) * 1073741824]);
    await c.query(
      `INSERT INTO payments (tenant_id, customer_id, channel, wallet, purpose, purpose_id, amount, phone, reference, external_ref, status, result_id, created_at, confirmed_at)
       VALUES ($1,$2,'sms_match','lumicash','subscription',$3,$4,$5,$6,$7,'success',$8, now() - make_interval(days => $9), now() - make_interval(days => $9))`,
      [T, cu.id, s.id, plan.price, cu.phone, `JC${randomCode(6)}`, `LC${rand(1e8, 9e8)}`, r.invoice.id, 30 - Math.max(0, shift)]);
    subs.push({ ...s, cu, active: shift > 0 });
  }

  // Live sessions
  const { rows: live } = await c.query(`SELECT v.code, v.device_macs FROM vouchers v WHERE v.tenant_id = $1 AND v.status = 'active' LIMIT 23`, [T]);
  let n = 0;
  for (const v of live) {
    const r = n % 3 === 0 ? r2 : r1;
    await c.query(`INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, acctstarttime, acctupdatetime, acctsessiontime, acctinputoctets, acctoutputoctets, callingstationid, framedipaddress)
                   VALUES ($1,$1,$2,$3, now() - make_interval(mins => $4), now() - interval '2 minutes', $4 * 60, $5, $6, $7, $8)`,
      [`hs${n}`, v.code, r.tunnel_ip, rand(5, 300), rand(5, 80) * 1048576, rand(40, 900) * 1048576, v.device_macs[0], `10.5.50.${20 + n}`]);
    n++;
  }
  for (const s of subs.filter((x) => x.active).slice(0, 9)) {
    await c.query(`INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, acctstarttime, acctupdatetime, acctsessiontime, acctinputoctets, acctoutputoctets, callingstationid, framedipaddress, framedprotocol)
                   VALUES ($1,$1,$2,$3, now() - make_interval(hours => $4), now() - interval '3 minutes', $4 * 3600, $5, $6, $7, $8, 'PPP')`,
      [`pp${n}`, s.username, (s.router_id === r1.id ? r1 : r2).tunnel_ip, rand(2, 90), rand(1, 9) * 1073741824, rand(5, 60) * 1073741824, `5C:${rand(10, 99)}:A1:22:${rand(10, 99)}:0F`, `10.10.0.${20 + n++}`]);
  }

  // Things needing attention
  await c.query(`INSERT INTO alerts (tenant_id, kind, entity_id, message, severity, created_at) VALUES ($1,'router_offline',$2,'Kiriri Relay hors ligne depuis 47 min','critical', now() - interval '42 minutes')`, [T, routers[2].id]);
  await c.query(`INSERT INTO service_requests (tenant_id, plan_id, name, phone, address, latitude, longitude, notes) VALUES
    ($1,$2,'Didier Kwizera','+25768999000','Kinindo, près de l’école',-3.4011,29.3667,'Disponible le samedi'),
    ($1,$3,'Restaurant Le Lac','+25779443322','Boulevard du Peuple Murundi',-3.3961,29.3550,'3 bureaux, besoin d’une IP fixe')`, [T, plans[0].id, plans[1].id]);
  await c.query(`INSERT INTO inbound_sms (tenant_id, sender, body, wallet, parsed_amount, parsed_txn_id, parsed_phone, parsed_name, received_at) VALUES
    ($1,'LUMICASH','Vous avez reçu 2 000 FBU de 71445566 GILBERT N. Ref: LC2610151777.','lumicash',2000,'LC2610151777','+25771445566','GILBERT N', now() - interval '25 minutes')`, [T]);
  await c.query(`INSERT INTO payments (tenant_id, channel, wallet, purpose, purpose_id, amount, phone, reference, status, expires_at, created_at)
    VALUES ($1,'sms_match','lumicash','hotspot',$2,$3,'+25761777888',$4,'pending', now() + interval '25 minutes', now() - interval '5 minutes')`, [T, pkgs[1].id, pkgs[1].price, `JC${randomCode(6)}`]);
  console.log('Demo operator ready: demo@jateloconnect.com / demo12345');
});
await closePools();
