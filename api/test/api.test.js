// End-to-end API test against a real PostgreSQL. Run with the env from .env.test:
//   node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/server.js');
const { ownerPool, closePools } = await import('../src/db.js');

let server, base, token, agentToken;
const state = {};

async function call(method, path, body, tk = token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) },
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
});

after(async () => {
  server.close();
  await closePools();
});

test('operator signs up and gets a trial with starter catalogue', async () => {
  const r = await call('POST', '/api/auth/signup', {
    business_name: 'Bujumbura WiFi', name: 'Aline', email: 'aline@example.com', phone: '79 123 456', password: 'secret123',
  }, null);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.user.phone, '+25779123456');
  token = r.body.access_token;
  const { rows } = await ownerPool.query(`SELECT kind, to_phone FROM sms_messages`);
  assert.equal(rows[0].kind, 'otp');
  const pk = await call('GET', '/api/packages');
  assert.equal(pk.body.packages.length, 6);
  state.pkgDay = pk.body.packages.find((p) => p.name === '1 jour');
  const pl = await call('GET', '/api/plans');
  state.plan = pl.body.plans[0];
});

test('login by phone works, wrong password does not', async () => {
  assert.equal((await call('POST', '/api/auth/login', { login: '+257 79 123 456', password: 'secret123' }, null)).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { login: 'aline@example.com', password: 'nope' }, null)).status, 401);
  const me = await call('GET', '/api/auth/me');
  assert.equal(me.body.tenant.status, 'trial');
});

test('router create, plan limit, onboarding script', async () => {
  const r = await call('POST', '/api/routers', { name: 'Kinindo AP', hotspot_ports: ['ether3', 'ether4'], pppoe_interface: 'ether5' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  state.router = r.body.router;
  assert.match(state.router.tunnel_ip, /^10\.88\./);
  assert.equal(r.body.router.api_password_enc, undefined, 'secrets never leave the API');
  const limit = await call('POST', '/api/routers', { name: 'Second' });
  assert.equal(limit.status, 402);
  const s = await call('POST', `/api/routers/${state.router.id}/setup`);
  assert.equal(s.status, 200);
  const script = s.body.script;
  assert.match(script, /\/interface wireguard add name=jc-wg/);
  assert.match(script, new RegExp(`address=${state.router.tunnel_ip.replace(/\./g, '\\.')}/16`));
  assert.match(script, /\/radius add address=10\.88\.0\.1 secret="testing123testing123"/);
  assert.match(script, /interface="ether3"/);
  assert.match(script, /service-name=jatelo interface="ether5"/);
  assert.match(script, /walled-garden ip add dst-address=203\.0\.113\.10/);
  const tokenMatch = /token=([A-Za-z0-9_-]+)/.exec(script);
  assert.ok(tokenMatch);
  state.setupToken = tokenMatch[1];
});

test('internal endpoints refuse non-tunnel callers', async () => {
  const r = await fetch(`${base}/internal/routers/register`, { method: 'POST', body: JSON.stringify({ token: state.setupToken }) });
  assert.equal(r.status, 404);
});

test('voucher batch, counter sale, disable and extend', async () => {
  const b = await call('POST', '/api/vouchers/batches', { package_id: state.pkgDay.id, quantity: 25 });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.body.vouchers.length, 25);
  assert.ok(b.body.vouchers.every((v) => /^[234679ACDEFGHJKMNPQRTUVWXYZ]{8}$/.test(v.code)));
  state.voucher = b.body.vouchers[0];
  const exp = await call('GET', `/api/vouchers/batches/${b.body.batch.id}/export?format=csv`);
  assert.equal(exp.body.split('\n').length, 26);
  const sale = await call('POST', '/api/vouchers/sell', { package_id: state.pkgDay.id, phone: '61000111' });
  assert.equal(sale.status, 201);
  const pay = await ownerPool.query(`SELECT channel, amount, status FROM payments WHERE purpose = 'hotspot'`);
  assert.deepEqual(pay.rows[0], { channel: 'cash', amount: 2000, status: 'success' });
  assert.equal((await call('POST', `/api/vouchers/${state.voucher.id}/disable`)).status, 200);
  assert.equal((await call('POST', `/api/vouchers/${state.voucher.id}/enable`)).status, 200);
  const ext = await call('POST', `/api/vouchers/${state.voucher.id}/extend`, { minutes: 60 });
  assert.equal(ext.status, 200);
  const list = await call('GET', '/api/vouchers?status=unused&limit=5');
  assert.equal(list.body.vouchers.length, 5);
  assert.equal(list.body.total, 26, 'batch of 25 plus the counter sale');
});

test('agents: float top-up, purchase at discount, insufficient balance', async () => {
  const a = await call('POST', '/api/agents', { name: 'Boutique Kamenge', phone: '68111222', discount_pct: 10, password: 'agentpass1' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal((await call('POST', `/api/agents/${a.body.agent.id}/topup`, { amount: 5000 })).status, 200);
  const login = await call('POST', '/api/auth/login', { login: '68111222', password: 'agentpass1' }, null);
  assert.equal(login.status, 200);
  agentToken = login.body.access_token;
  const buy = await call('POST', '/api/agent/vouchers', { package_id: state.pkgDay.id, quantity: 2 }, agentToken);
  assert.equal(buy.status, 201, JSON.stringify(buy.body));
  assert.equal(buy.body.cost, 3600);
  assert.equal(buy.body.balance, 1400);
  const tooMuch = await call('POST', '/api/agent/vouchers', { package_id: state.pkgDay.id, quantity: 1 }, agentToken);
  assert.equal(tooMuch.status, 409);
  assert.equal((await call('GET', '/api/routers', null, agentToken)).status, 200, 'agents can read');
  assert.equal((await call('POST', '/api/packages', { name: 'x', price: 1, duration_minutes: 1 }, agentToken)).status, 403);
});

test('PPPoE subscription: create awaiting payment, renew in cash, suspend, resume', async () => {
  const s = await call('POST', '/api/subscriptions', {
    customer: { name: 'Jean Ndayishimiye', phone: '79000001', address: 'Rohero' }, plan_id: state.plan.id,
  });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.subscription.status, 'pending');
  assert.equal(s.body.subscription.username, 'jean.ndayishimiye');
  state.sub = s.body.subscription;
  const r = await call('POST', `/api/subscriptions/${state.sub.id}/renew`, { periods: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.subscription.status, 'active');
  assert.equal(r.body.invoice.amount, state.plan.price * 2);
  const days = (new Date(r.body.subscription.expires_at) - Date.now()) / 86400000;
  assert.ok(days > 59 && days < 61, `expected ~60 days, got ${days}`);
  assert.equal((await call('POST', `/api/subscriptions/${state.sub.id}/suspend`)).body.subscription.status, 'suspended');
  assert.equal((await call('POST', `/api/subscriptions/${state.sub.id}/resume`)).body.subscription.status, 'active');
  const sms = await ownerPool.query(`SELECT kind FROM sms_messages WHERE to_phone = '+25779000001' ORDER BY created_at`);
  assert.deepEqual(sms.rows.map((x) => x.kind), ['pppoe_welcome', 'pppoe_renewed']);
  const exp = await call('GET', '/api/subscriptions?expiring_days=60');
  assert.equal(exp.body.total, 1);
});

test('tenant isolation: a second operator sees nothing of the first', async () => {
  const r = await call('POST', '/api/auth/signup', {
    business_name: 'Gitega Net', name: 'Eric', email: 'eric@example.com', phone: '69000000', password: 'secret456',
  }, null);
  const t2 = r.body.access_token;
  assert.equal((await call('GET', '/api/routers', null, t2)).body.routers.length, 0);
  assert.equal((await call('GET', '/api/vouchers', null, t2)).body.total, 0);
  assert.equal((await call('GET', `/api/subscriptions/${state.sub.id}`, null, t2)).status, 404);
  assert.equal((await call('POST', `/api/vouchers/${state.voucher.id}/disable`, null, t2)).status, 404);
});

test('staff roles: cashier cannot change packages or routers', async () => {
  const c = await call('POST', '/api/staff', { name: 'Caissier', phone: '79555555', role: 'cashier', password: 'cashier123' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const login = await call('POST', '/api/auth/login', { login: '79555555', password: 'cashier123' }, null);
  const ct = login.body.access_token;
  assert.equal((await call('POST', '/api/vouchers/sell', { package_id: state.pkgDay.id }, ct)).status, 201);
  assert.equal((await call('PATCH', `/api/packages/${state.pkgDay.id}`, { price: 1 }, ct)).status, 403);
  assert.equal((await call('POST', `/api/routers/${state.router.id}/setup`, null, ct)).status, 403);
  const audit = await call('GET', '/api/audit');
  assert.ok(audit.body.entries.some((e) => e.action === 'voucher.sell' && e.user_name === 'Caissier'));
});
