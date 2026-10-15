// Delivers queued SMS through an operator's own gateway, else the platform gateway.
//   smsgate: SMS Gateway for Android (sms-gate.app) — cloud or local server API
//   http:    a generic aggregator accepting POST { to, text } with a bearer token
import { decrypt } from '../lib/crypto.js';
import { isProd } from '../config.js';

const TIMEOUT_MS = 15_000;

async function post(url, body, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, data, text };
  } finally {
    clearTimeout(t);
  }
}

async function sendSmsGate(gw, to, text) {
  const url = `${gw.base_url.replace(/\/$/, '')}/message`;
  const auth = { authorization: `Basic ${Buffer.from(`${gw.username}:${decrypt(gw.password_enc)}`).toString('base64')}` };
  let r = await post(url, { textMessage: { text }, phoneNumbers: [to] }, auth);
  if (r.status === 400) r = await post(url, { message: text, phoneNumbers: [to] }, auth); // older app versions
  if (!r.ok) throw new Error(`SMS gateway HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  return r.data?.id ? String(r.data.id) : null;
}

async function sendHttp(gw, to, text) {
  const r = await post(gw.base_url, { to, text }, gw.password_enc ? { authorization: `Bearer ${decrypt(gw.password_enc)}` } : {});
  if (!r.ok) throw new Error(`SMS provider HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  return r.data?.id ? String(r.data.id) : (r.data?.message_id ? String(r.data.message_id) : null);
}

/** Picks the gateway for a message: explicit, operator's own, then the platform's. */
export async function pickGateway(c, msg) {
  const { rows } = await c.query(
    `SELECT * FROM sms_gateways WHERE active AND can_send AND
       (id = $1 OR ($1::uuid IS NULL AND (tenant_id = $2 OR tenant_id IS NULL)))
     ORDER BY (id = $1) DESC NULLS LAST, (tenant_id IS NULL) ASC, created_at LIMIT 1`,
    [msg.gateway_id, msg.tenant_id]);
  return rows[0] ?? null;
}

/**
 * Sends one message. Returns { provider, providerRef }.
 * Without any gateway: in development the message is logged as sent; in production it fails.
 */
export async function deliver(c, msg, log) {
  const gw = await pickGateway(c, msg);
  if (!gw) {
    if (!isProd) {
      log?.info?.({ to: msg.to_phone, body: msg.body }, 'SMS (no gateway, development: logged only)');
      return { provider: 'log', providerRef: null, gatewayId: null };
    }
    throw new Error('No SMS gateway configured');
  }
  const ref = gw.provider === 'http' ? await sendHttp(gw, msg.to_phone, msg.body) : await sendSmsGate(gw, msg.to_phone, msg.body);
  return { provider: gw.provider, providerRef: ref, gatewayId: gw.id };
}
