// Captive portal, payments (SMS matching), renewal, sign-up requests and worker jobs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import pino from 'pino';

const { createApp } = await import('../src/server.js');
const { ownerPool, closePools } = await import('../src/db.js');
const jobs = await import('../src/jobs.js');

const log = pino({ level: 'silent' });
let server, base, token, routerId, slug, webhook;
const S = {};

async function call(method, path, body, tk = token) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const sms = (sender, message) => fetch(webhook, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ event: 'sms:received', payload: { message, phoneNumber: sender, receivedAt: new Date().toISOString() } }),
}).then((r) => r.json());

before(async () => {
  await ownerPool.query(`TRUNCATE tenants, users, otp_codes, sms_messages, radacct, radpostauth RESTART IDENTITY CASCADE`);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await call('POST', '/api/auth/signup', {
    business_name: 'Rohero WiFi', name: 'Aline', email: 'aline@rohero.bi', phone: '79000100', password: 'secret123',
  }, null);
  token = r.body.access_token;
  slug = r.body.tenant.slug;
  routerId = (await call('POST', '/api/routers', { name: 'Rohero AP' })).body.router.id;
  assert.equal((await call('PUT', '/api/payment-channels/lumicash', { merchant_number: '12345', merchant_name: 'ROHERO WIFI' })).status, 200);
  const g = await call('POST', '/api/sms-gateways', { name: 'Merchant phone', phone: '79000200', username: 'u', password: 'p' });
  assert.equal(g.status, 201);
  webhook = g.body.webhook_url.replace(/^https?:\/\/[^/]+/, base);
  S.pkgDay = (await call('GET', '/api/packages')).body.packages.find((p) => p.name === '1 jour');
});

after(async () => { server.close(); await closePools(); });

test('portal page renders and its script compiles', async () => {
  const r = await fetch(`${base}/h/${routerId}?mac=AA:BB:CC:00:00:01&ll=http://login.wifi/login`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Rohero WiFi/);
  assert.ok(html.length < 100_000, `portal page is ${html.length} bytes`);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2);
  for (const s of scripts) new vm.Script(s); // throws on syntax errors
  assert.equal((await fetch(`${base}/h/00000000-0000-0000-0000-000000000000`)).status, 404);
  for (const p of ['/renew', `/join/${slug}`, `/h/${routerId}/ok`]) assert.equal((await fetch(`${base}${p}`)).status, 200, p);
});

test('portal config shows paid packages, trial and wallets', async () => {
  const r = await call('GET', `/portal-api/r/${routerId}`, null, null);
  assert.equal(r.status, 200);
  assert.equal(r.body.packages.length, 5);
  assert.ok(r.body.packages.every((p) => p.price > 0));
  assert.equal(r.body.trial.duration_minutes, 10);
  assert.deepEqual(r.body.wallets, [{ wallet: 'lumicash', merchant_number: '12345', merchant_name: 'ROHERO WIFI' }]);
});

test('free trial once per device per day; code check gives clear reasons', async () => {
  const t1 = await call('POST', `/portal-api/r/${routerId}/trial`, { mac: 'aa-bb-cc-00-00-01' }, null);
  assert.equal(t1.status, 200);
  const t2 = await call('POST', `/portal-api/r/${routerId}/trial`, { mac: 'AA:BB:CC:00:00:01' }, null);
  assert.equal(t2.body.error.code, 'trial_used');
  assert.equal((await call('POST', `/portal-api/r/${routerId}/check`, { code: t1.body.code.toLowerCase() }, null)).status, 200);
  assert.equal((await call('POST', `/portal-api/r/${routerId}/check`, { code: 'ZZZZZZZZ' }, null)).body.error.code, 'not_found');
  await ownerPool.query(`UPDATE vouchers SET device_macs = '{11:11:11:11:11:11}' WHERE code = $1`, [t1.body.code]);
  const d = await call('POST', `/portal-api/r/${routerId}/check`, { code: t1.body.code, mac: 'AA:BB:CC:00:00:09' }, null);
  assert.equal(d.body.error.code, 'device_limit');
});

test('purchase auto-completes when the wallet SMS arrives from the same phone', async () => {
  const p = await call('POST', `/portal-api/r/${routerId}/pay`, { package_id: S.pkgDay.id, phone: '79 11 12 22', wallet: 'lumicash', mac: 'AA:BB:CC:00:00:02', lang: 'rn' }, null);
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.match(p.body.reference, /^JC[A-Z0-9]{6}$/);
  assert.equal(p.body.merchant_number, '12345');
  const pend = await call('GET', `/portal-api/payments/${p.body.reference}?secret=${p.body.client_secret}`, null, null);
  assert.equal(pend.body.status, 'pending');
  assert.equal((await call('GET', `/portal-api/payments/${p.body.reference}?secret=wrong-secret-xx`, null, null)).status, 404);
  const w = await sms('LUMICASH', 'Vous avez reçu 2 000 FBU de 79111222 JEAN N. Ref: LC2610150001. Nouveau solde: 45 300 FBU.');
  assert.equal(w.matched, true);
  const done = await call('GET', `/portal-api/payments/${p.body.reference}?secret=${p.body.client_secret}`, null, null);
  assert.equal(done.body.status, 'success');
  assert.match(done.body.code, /^[A-Z0-9]{8}$/);
  S.code = done.body.code;
  const { rows: [m] } = await ownerPool.query(`SELECT body FROM sms_messages WHERE kind = 'voucher_purchased' ORDER BY created_at DESC LIMIT 1`);
  assert.match(m.body, /^Rohero WiFi: twakiriye 2 000 BIF/, 'SMS in the language chosen on the portal');
  S.pin = /(\d{4})\.$/.exec(m.body)?.[1];
  assert.ok(S.pin);
  // The same SMS delivered twice by the gateway is ignored
  const dup = await sms('LUMICASH', 'Vous avez reçu 2 000 FBU de 79111222 JEAN N. Ref: LC2610150001. Nouveau solde: 45 300 FBU.');
  assert.equal(dup.matched, false);
});

test('recover codes with phone + PIN', async () => {
  assert.equal((await call('POST', `/portal-api/r/${routerId}/recover`, { phone: '79111222', pin: '0000' === S.pin ? '1111' : '0000' }, null)).body.error.code, 'pin');
  const r = await call('POST', `/portal-api/r/${routerId}/recover`, { phone: '+25779111222', pin: S.pin }, null);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.vouchers.map((v) => v.code), [S.code]);
});

test('paying from another phone: claim with the transaction id; ids cannot be reused or underpay', async () => {
  const a = await call('POST', `/portal-api/r/${routerId}/pay`, { package_id: S.pkgDay.id, phone: '61000001', wallet: 'lumicash' }, null);
  const b = await call('POST', `/portal-api/r/${routerId}/pay`, { package_id: S.pkgDay.id, phone: '61000002', wallet: 'lumicash' }, null);
  const early = await call('POST', `/portal-api/payments/${a.body.reference}/claim`, { secret: a.body.client_secret, txn_id: 'LC9999' }, null);
  assert.equal(early.body.error.code, 'txn_not_found');
  await sms('Lumicash', 'Payment received: BIF 2000 from 72445566 CLAUDE M. Transaction ID 7ZK2P9Q1. Balance BIF 120000');
  await sms('Lumicash', 'Payment received: BIF 1000 from 72445567 ERIC. Transaction ID 8LOW0001. Balance BIF 121000');
  const ok = await call('POST', `/portal-api/payments/${a.body.reference}/claim`, { secret: a.body.client_secret, txn_id: '7zk2-p9q1' }, null);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'success');
  const reuse = await call('POST', `/portal-api/payments/${b.body.reference}/claim`, { secret: b.body.client_secret, txn_id: '7ZK2P9Q1' }, null);
  assert.equal(reuse.body.error.code, 'txn_used');
  const low = await call('POST', `/portal-api/payments/${b.body.reference}/claim`, { secret: b.body.client_secret, txn_id: '8LOW0001' }, null);
  assert.equal(low.body.error.code, 'amount_low');
  const list = await call('GET', '/api/payments?status=success');
  assert.equal(list.body.total, 2);
  assert.equal(list.body.collected, 4000);
});

test('operator confirms by hand, and sees unmatched SMS', async () => {
  const p = await call('POST', `/portal-api/r/${routerId}/pay`, { package_id: S.pkgDay.id, phone: '61000003', wallet: 'lumicash' }, null);
  const { rows: [row] } = await ownerPool.query('SELECT id FROM payments WHERE reference = $1', [p.body.reference]);
  const c = await call('POST', `/api/payments/${row.id}/confirm`, { reason: 'Customer paid cash at the counter' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.match(c.body.voucher.code, /^[A-Z0-9]{8}$/);
  const un = await call('GET', '/api/payments/inbound-sms?unmatched=true');
  assert.equal(un.body.messages.length, 1);
  assert.equal(un.body.messages[0].parsed_txn_id, '8LOW0001');
});

test('expired PPPoE subscriber renews from the walled page and is renewed by the wallet SMS', async () => {
  const plan = (await call('GET', '/api/plans')).body.plans[0];
  const s = await call('POST', '/api/subscriptions', { customer: { name: 'Jean Bosco', phone: '79222333' }, plan_id: plan.id, activation: 'free_period' });
  await ownerPool.query(`UPDATE subscriptions SET expires_at = now() - interval '1 hour' WHERE id = $1`, [s.body.subscription.id]);
  assert.equal(await jobs.processExpiries(log), 1);
  const { rows: [exp] } = await ownerPool.query(`SELECT body FROM sms_messages WHERE kind = 'pppoe_expired'`);
  assert.match(exp.body, /Lumicash 12345/);
  const look = await call('POST', '/portal-api/renew/lookup', { phone: '79222333' }, null);
  assert.equal(look.body.subscriptions.length, 1);
  assert.equal(look.body.subscriptions[0].username, 'jea***');
  assert.equal((await call('POST', '/portal-api/renew/pay', { subscription_id: look.body.subscriptions[0].id, phone: '79000000', wallet: 'lumicash' }, null)).status, 404,
    'cannot start a renewal for someone else');
  // The expiry SMS already created a pending renewal for this phone: paying the merchant renews automatically
  const w = await sms('LUMICASH', `Vous avez reçu ${plan.price.toLocaleString('fr-FR')} FBU de 79222333 JEAN BOSCO. Ref: LC2610159999.`);
  assert.equal(w.matched, true);
  const sub = await call('GET', `/api/subscriptions/${s.body.subscription.id}`);
  assert.equal(sub.body.subscription.status, 'active');
  const days = (new Date(sub.body.subscription.expires_at) - Date.now()) / 86400000;
  assert.ok(days > 29 && days < 31);
});

test('reminders go out once, N days before expiry, in daytime', async () => {
  const plan = (await call('GET', '/api/plans')).body.plans[0];
  const s = await call('POST', '/api/subscriptions', { customer: { name: 'Marie', phone: '79444555' }, plan_id: plan.id, activation: 'free_period' });
  await ownerPool.query(`UPDATE subscriptions SET expires_at = now() + interval '2 days 20 hours' WHERE id = $1`, [s.body.subscription.id]);
  const offset = 12 - new Date().getUTCHours(); // make it noon for the tenant
  await ownerPool.query(`UPDATE tenants SET timezone = $1`, [offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`]);
  assert.equal(await jobs.sendReminders(log), 1);
  assert.equal(await jobs.sendReminders(log), 0, 'not twice');
  const { rows } = await ownerPool.query(`SELECT body FROM sms_messages WHERE kind = 'pppoe_reminder'`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].body, /référence JC[A-Z0-9]{6}/);
});

test('connection request from the public sign-up page reaches the operator', async () => {
  const plan = (await call('GET', '/api/plans')).body.plans[0];
  const r = await call('POST', `/portal-api/join/${slug}`, { name: 'Didier K', phone: '68999000', address: 'Kinindo', plan_id: plan.id }, null);
  assert.equal(r.status, 201);
  const list = await call('GET', '/api/service-requests');
  assert.equal(list.body.requests[0].name, 'Didier K');
  const { rows } = await ownerPool.query(`SELECT to_phone FROM sms_messages WHERE kind = 'service_request'`);
  assert.equal(rows[0].to_phone, '+25779000100');
});

test('worker: SMS queue drains (development logs), voucher expiry, tenant trial end', async () => {
  await ownerPool.query(`UPDATE sms_gateways SET can_send = false`); // no real gateway in tests
  const n = await jobs.sendQueuedSms(log, 100);
  assert.ok(n > 5);
  const { rows: [q] } = await ownerPool.query(`SELECT count(*)::int AS n FROM sms_messages WHERE status = 'queued'`);
  assert.equal(q.n, 0);
  await ownerPool.query(`UPDATE vouchers SET status = 'active', activated_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE code = $1`, [S.code]);
  await jobs.processExpiries(log);
  assert.equal((await ownerPool.query('SELECT status FROM vouchers WHERE code = $1', [S.code])).rows[0].status, 'expired');
  await ownerPool.query(`UPDATE tenants SET trial_ends_at = now() - interval '1 hour'`);
  assert.equal(await jobs.updateTenantStatuses(log), 1);
  const w = await call('POST', '/api/packages', { name: 'x', price: 100, duration_minutes: 60 });
  assert.equal(w.status, 402, 'read-only operator cannot change things');
  assert.equal((await call('GET', '/api/packages')).status, 200, 'but can still read');
  assert.equal((await call('GET', `/portal-api/r/${routerId}`, null, null)).status, 200, 'and customers can still buy');
});
