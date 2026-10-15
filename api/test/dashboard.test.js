// Dashboard summary, live sessions, bandwidth, reports, alerts, real-time events, platform admin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';

const { createApp } = await import('../src/server.js');
const { ownerPool, closePools } = await import('../src/db.js');
const { closeListener } = await import('../src/services/events.js');

let server, base, token, tenantId, routerId, adminToken;

async function call(method, path, body, tk = token) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

before(async () => {
  await ownerPool.query(`TRUNCATE tenants, users, otp_codes, sms_messages, radacct, radpostauth RESTART IDENTITY CASCADE`);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await call('POST', '/api/auth/signup', { business_name: 'Ngozi Net', name: 'Paul', email: 'paul@ngozi.bi', phone: '79300300', password: 'secret123' }, null);
  token = r.body.access_token; tenantId = r.body.tenant.id;
  routerId = (await call('POST', '/api/routers', { name: 'Ngozi Tower' })).body.router.id;
  const pkg = (await call('GET', '/api/packages')).body.packages.find((p) => p.name === '1 jour');
  const sale = await call('POST', '/api/vouchers/sell', { package_id: pkg.id, phone: '61222333' });
  const plan = (await call('GET', '/api/plans')).body.plans[0];
  const sub = await call('POST', '/api/subscriptions', { customer: { name: 'Anne', phone: '79555666' }, plan_id: plan.id, activation: 'paid_cash' });
  const { rows: [r1] } = await ownerPool.query('SELECT host(tunnel_ip) AS ip FROM routers WHERE id = $1', [routerId]);
  // Two live sessions as FreeRADIUS would write them
  await ownerPool.query(
    `INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, acctstarttime, acctupdatetime, acctinputoctets, acctoutputoctets, acctsessiontime, callingstationid, framedipaddress, framedprotocol)
     VALUES ('a1','u1',$1,$3,now()-interval '20 minutes',now()-interval '1 minute',1000000,9000000,1140,'AA:BB:CC:DD:EE:01','10.5.50.20',NULL),
            ('a2','u2',$2,$3,now()-interval '2 hours',now()-interval '2 minutes',5000000,80000000,7080,'AA:BB:CC:DD:EE:02','10.10.0.20','PPP')`,
    [sale.body.voucher.code, sub.body.subscription.username, r1.ip]);
  for (let i = 30; i > 0; i--) {
    await ownerPool.query(`INSERT INTO router_traffic (router_id, tenant_id, iface, ts, rx_bps, tx_bps) VALUES ($1,$2,'ether1', now() - make_interval(mins => $3), $4, $5)`,
      [routerId, tenantId, i, 4_000_000 + i * 1000, 20_000_000 + i * 5000]);
  }
});

after(async () => { server.close(); await closeListener(); await closePools(); });

test('home summary counts today\'s money, live users and routers', async () => {
  const r = await call('GET', '/api/dashboard/summary');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const k = r.body.kpis;
  const plan = (await call('GET', '/api/plans')).body.plans[0];
  assert.equal(k.revenue_today, 2000 + plan.price);
  assert.equal(k.online_hotspot, 1);
  assert.equal(k.online_pppoe, 1);
  assert.equal(k.routers_total, 1);
  assert.equal(k.subs_active, 1);
  assert.equal(r.body.recent_payments.length, 2);
  assert.equal(r.body.revenue_today_by_channel[0].channel, 'cash');
  const rev = await call('GET', '/api/dashboard/revenue?days=7');
  assert.equal(rev.body.days.length, 7);
  assert.equal(rev.body.days.at(-1).hotspot, 2000);
});

test('live sessions list with filters, router bandwidth series', async () => {
  const all = await call('GET', '/api/sessions');
  assert.equal(all.body.sessions.length, 2);
  const p = await call('GET', '/api/sessions?type=pppoe');
  assert.equal(p.body.sessions.length, 1);
  assert.equal(p.body.sessions[0].customer_name, 'Anne');
  assert.equal(p.body.sessions[0].router_name, 'Ngozi Tower');
  const t = await call('GET', `/api/routers/${routerId}/traffic?hours=1`);
  assert.equal(t.status, 200);
  assert.equal(t.body.iface, 'ether1');
  assert.ok(t.body.points.length >= 29);
  assert.ok(t.body.points[0].tx_bps > 20_000_000);
});

test('reports: revenue by product and CSV, subscribers, usage', async () => {
  const from = new Date(Date.now() - 86400000).toISOString(), to = new Date(Date.now() + 86400000).toISOString();
  const r = await call('GET', `/api/reports/revenue?from=${from}&to=${to}&group=package`);
  assert.equal(r.body.rows.length, 2);
  const csv = await fetch(`${base}/api/reports/revenue?from=${from}&to=${to}&group=day&format=csv`, { headers: { authorization: `Bearer ${token}` } });
  assert.match(await csv.text(), /^Day,Payments,Amount\n"\d{4}-\d\d-\d\d",2,\d+$/);
  const s = await call('GET', `/api/reports/subscribers?from=${from}&to=${to}`);
  assert.equal(s.body.new, 1);
  assert.equal(s.body.renewed, 1);
  const u = await call('GET', `/api/reports/usage?from=${from}&to=${to}`);
  assert.equal(u.body.top.length, 2);
});

test('alerts are listed and resolved', async () => {
  await ownerPool.query(`INSERT INTO alerts (tenant_id, kind, entity_id, message, severity) VALUES ($1,'router_offline',$2,'Ngozi Tower offline','critical')`, [tenantId, routerId]);
  const a = await call('GET', '/api/alerts');
  assert.equal(a.body.alerts.length, 1);
  assert.equal((await call('POST', `/api/alerts/${a.body.alerts[0].id}/resolve`)).status, 200);
  assert.equal((await call('GET', '/api/alerts')).body.alerts.length, 0);
});

test('real-time: a payment pushes an event to the open dashboard stream', async () => {
  const got = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/events?access_token=${token}`, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      let buf = '';
      res.on('data', async (d) => {
        buf += d;
        if (buf.includes('event: ready')) {
          buf = buf.replace('event: ready', '');
          const pkg = (await call('GET', '/api/packages')).body.packages.find((p) => p.name === '1 heure');
          await call('POST', '/api/vouchers/sell', { package_id: pkg.id });
        }
        if (buf.includes('event: payment')) { req.destroy(); resolve(true); }
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    setTimeout(() => reject(new Error('no event within 5s')), 5000);
  });
  assert.ok(got);
  assert.equal((await fetch(`${base}/api/events`)).status, 401);
});

test('platform admin: stats, operator list, recording a payment reactivates the account', async () => {
  execFileSync('node', ['src/cli.js', 'create-admin', 'admin@jatelo.tech', 'super-secret-1', 'Jatelo', 'Admin'], { env: process.env });
  adminToken = (await call('POST', '/api/auth/login', { login: 'admin@jatelo.tech', password: 'super-secret-1' }, null)).body.access_token;
  assert.equal((await call('GET', '/api/admin/stats', null, token)).status, 403, 'operators cannot see admin');
  const st = await call('GET', '/api/admin/stats', null, adminToken);
  assert.equal(st.status, 200);
  assert.equal(st.body.sessions_online, 2);
  await ownerPool.query(`UPDATE tenants SET status = 'read_only' WHERE id = $1`, [tenantId]);
  const b = await call('POST', `/api/admin/tenants/${tenantId}/billing`, { tier: 'business', months: 3, amount: 135000, reference: 'LC777' }, adminToken);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.tenant.status, 'active');
  assert.equal(b.body.tenant.max_routers, 5);
  const days = (new Date(b.body.tenant.paid_until) - Date.now()) / 86400000;
  assert.ok(days > 88 && days < 93);
  const mine = await call('GET', '/api/settings/billing');
  assert.equal(mine.body.billing[0].amount, 135000);
  // Support access to one operator's data, audited
  const asOp = await fetch(`${base}/api/routers`, { headers: { authorization: `Bearer ${adminToken}`, 'x-tenant-id': tenantId } });
  assert.equal((await asOp.json()).routers.length, 1);
});
