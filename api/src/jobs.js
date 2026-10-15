// Background jobs. Each is safe to run concurrently on several workers (advisory locks,
// SKIP LOCKED) and safe to re-run (idempotent state changes).
import { asOwner, ownerPool } from './db.js';
import { deliver } from './services/sms-send.js';
import { queueTemplate } from './services/sms.js';
import { createPayment } from './services/payments.js';
import { disconnectEverywhere } from './services/sessions.js';
import { formatMoney, formatDate } from './lib/messages.js';
import * as wg from './services/wireguard.js';
import * as ros from './services/routeros.js';
import { config } from './config.js';

const ONLINE_HANDSHAKE_S = 180;   // WireGuard keepalive is 25 s; 3 minutes without a handshake = offline
const OFFLINE_ALERT_MIN = 5;

// ───────────── SMS delivery ─────────────
export async function sendQueuedSms(log, batch = 20) {
  const claimed = await asOwner(async (c) => (await c.query(
    `UPDATE sms_messages SET status = 'sending', attempts = attempts + 1
      WHERE id IN (SELECT id FROM sms_messages WHERE status = 'queued' AND next_attempt_at <= now()
                    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [batch])).rows);
  for (const msg of claimed) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await deliver(ownerPool, msg, log);
      // eslint-disable-next-line no-await-in-loop
      await ownerPool.query(
        `UPDATE sms_messages SET status = 'sent', sent_at = now(), provider = $2, provider_ref = $3,
                gateway_id = coalesce(gateway_id, $4), error = NULL WHERE id = $1`,
        [msg.id, r.provider, r.providerRef, r.gatewayId]);
    } catch (e) {
      const final = msg.attempts >= 5;
      // eslint-disable-next-line no-await-in-loop
      await ownerPool.query(
        `UPDATE sms_messages SET status = $2, error = $3,
                next_attempt_at = now() + make_interval(mins => power(2, $4)::int) WHERE id = $1`,
        [msg.id, final ? 'failed' : 'queued', e.message.slice(0, 300), msg.attempts]);
      log.warn({ sms: msg.id, err: e.message, final }, 'sms delivery failed');
    }
  }
  return claimed.length;
}

// ───────────── Expiry ─────────────
async function merchantLine(c, tenantId) {
  const { rows } = await c.query(
    `SELECT wallet, merchant_number FROM payment_channels WHERE tenant_id = $1 AND active ORDER BY wallet DESC`, [tenantId]);
  return rows.map((r) => `${r.wallet === 'lumicash' ? 'Lumicash' : 'EcoCash'} ${r.merchant_number}`).join(' / ');
}

async function tenantBrand(c, tenantId) {
  const { rows: [t] } = await c.query(
    `SELECT t.id, t.phone, t.language, t.currency, t.timezone, t.status, coalesce(s.portal->>'brand', t.name) AS brand
       FROM tenants t LEFT JOIN LATERAL (SELECT portal FROM sites WHERE tenant_id = t.id ORDER BY created_at LIMIT 1) s ON true
      WHERE t.id = $1`, [tenantId]);
  return t;
}

/**
 * A long-lived pending payment for a subscriber, so that paying the merchant number
 * with the right amount from their phone auto-renews them (SMS auto-match).
 */
async function renewalPayment(c, sub) {
  const { rows: [existing] } = await c.query(
    `SELECT reference FROM payments WHERE purpose = 'subscription' AND purpose_id = $1 AND status = 'pending'
        AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [sub.id]);
  if (existing) return existing.reference;
  const { payment } = await createPayment(c, {
    tenantId: sub.tenant_id, purpose: 'subscription', purposeId: sub.id, amount: sub.price, phone: sub.phone,
    wallet: null, customerId: sub.customer_id, meta: { source: 'reminder', username: sub.username },
  });
  await c.query(`UPDATE payments SET expires_at = greatest($2::timestamptz, now()) + interval '10 days' WHERE id = $1`,
    [payment.id, sub.expires_at]);
  return payment.reference;
}

export async function processExpiries(log) {
  const due = await asOwner(async (c) => (await c.query('SELECT * FROM jc_expire_due()')).rows);
  for (const d of due) {
    try {
      if (d.kind === 'voucher') {
        const { rows: [v] } = await ownerPool.query('SELECT code FROM vouchers WHERE id = $1', [d.item_id]);
        if (v) await disconnectEverywhere({ tenantId: d.tenant_id, username: v.code, kind: 'hotspot' }, log);
      } else {
        await asOwner(async (c) => {
          const { rows: [s] } = await c.query(
            `SELECT s.*, cu.phone, cu.language, pl.price FROM subscriptions s JOIN customers cu ON cu.id = s.customer_id
               JOIN plans pl ON pl.id = s.plan_id WHERE s.id = $1 AND s.expiry_notified_at IS NULL FOR UPDATE OF s`, [d.item_id]);
          if (!s) return;
          await c.query('UPDATE subscriptions SET expiry_notified_at = now() WHERE id = $1', [s.id]);
          if (!s.phone) return;
          const t = await tenantBrand(c, s.tenant_id);
          const ref = await renewalPayment(c, s);
          await queueTemplate(c, {
            tenantId: s.tenant_id, to: s.phone, template: 'pppoe_expired', lang: s.language || t.language,
            vars: { brand: t.brand, amount: formatMoney(s.price, t.currency), merchant: (await merchantLine(c, s.tenant_id)) || t.phone || t.brand, ref },
          });
        });
        const { rows: [s] } = await ownerPool.query('SELECT username FROM subscriptions WHERE id = $1', [d.item_id]);
        // Reconnect so the session comes back walled to the payment page
        if (s) await disconnectEverywhere({ tenantId: d.tenant_id, username: s.username, kind: 'pppoe' }, log);
      }
    } catch (e) {
      log.error({ err: e.message, item: d }, 'expiry handling failed');
    }
  }
  return due.length;
}

/** Vouchers whose data ran out mid-session (marked by the accounting trigger). */
export async function cutExhausted(log) {
  const { rows } = await ownerPool.query(
    `SELECT DISTINCT v.tenant_id, v.code FROM vouchers v JOIN radacct a ON a.voucher_id = v.id
      WHERE v.status IN ('exhausted','disabled','expired') AND a.acctstoptime IS NULL`);
  for (const r of rows) await disconnectEverywhere({ tenantId: r.tenant_id, username: r.code, kind: 'hotspot' }, log);
  return rows.length;
}

export async function closeStaleSessions() {
  const { rows: [r] } = await ownerPool.query('SELECT jc_close_stale_sessions(16) AS n');
  return r.n;
}

export async function expirePendingPayments() {
  const { rowCount } = await ownerPool.query(
    `UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at < now()`);
  return rowCount;
}

// ───────────── PPPoE reminders ─────────────
/** Sends reminders N days before expiry (tenant setting, default 3 and 1 days), 08:00–20:00 local time. */
export async function sendReminders(log) {
  const { rows } = await ownerPool.query(
    `SELECT s.id, s.tenant_id, s.username, s.expires_at, s.customer_id, s.reminders_sent, cu.phone, cu.language, pl.price,
            ceil(extract(epoch FROM (s.expires_at - now())) / 86400)::int AS days_left,
            coalesce((SELECT array_agg(x::int) FROM jsonb_array_elements_text(t.settings->'reminders'->'days_before') x), '{3,1}') AS days_before
       FROM subscriptions s JOIN customers cu ON cu.id = s.customer_id JOIN plans pl ON pl.id = s.plan_id
       JOIN tenants t ON t.id = s.tenant_id
      WHERE s.status = 'active' AND s.expires_at > now() AND s.expires_at < now() + interval '15 days'
        AND cu.phone IS NOT NULL AND t.status NOT IN ('suspended','closed')
        AND extract(hour FROM now() AT TIME ZONE t.timezone) BETWEEN 8 AND 19`);
  let sent = 0;
  for (const s of rows) {
    if (!s.days_before.includes(s.days_left) || s.reminders_sent.includes(s.days_left)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await asOwner(async (c) => {
        const { rowCount } = await c.query(
          `UPDATE subscriptions SET reminders_sent = array_append(reminders_sent, $2), last_reminder_at = now()
            WHERE id = $1 AND NOT ($2 = ANY (reminders_sent))`, [s.id, s.days_left]);
        if (!rowCount) return;
        const t = await tenantBrand(c, s.tenant_id);
        const ref = await renewalPayment(c, s);
        await queueTemplate(c, {
          tenantId: s.tenant_id, to: s.phone, template: 'pppoe_reminder', lang: s.language || t.language,
          vars: { brand: t.brand, amount: formatMoney(s.price, t.currency), expires: formatDate(s.expires_at, t.timezone),
                  merchant: (await merchantLine(c, s.tenant_id)) || t.phone || t.brand, ref },
        });
        sent++;
      });
    } catch (e) {
      log.error({ err: e.message, subscription: s.id }, 'reminder failed');
    }
  }
  return sent;
}

// ───────────── Routers ─────────────
async function raiseAlert(c, { tenantId, kind, entityId, message, severity = 'warning' }) {
  const { rows } = await c.query(
    `INSERT INTO alerts (tenant_id, kind, entity_id, message, severity) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, kind, entity_id) WHERE resolved_at IS NULL DO NOTHING RETURNING id`,
    [tenantId, kind, entityId, message, severity]);
  return rows[0]?.id ?? null;
}

async function resolveAlert(c, { tenantId, kind, entityId }) {
  const { rowCount } = await c.query(
    `UPDATE alerts SET resolved_at = now() WHERE tenant_id = $1 AND kind = $2 AND entity_id = $3 AND resolved_at IS NULL`,
    [tenantId, kind, entityId]);
  return rowCount > 0;
}

/** Online/offline from WireGuard handshakes; owner gets an SMS after 5 minutes offline and when it recovers. */
export async function checkRouterHealth(log) {
  if (!config.WG_MANAGE) return 0;
  const hs = await wg.handshakes(log);
  const now = Math.floor(Date.now() / 1000);
  const { rows } = await ownerPool.query(
    `SELECT r.id, r.tenant_id, r.name, r.status, r.wg_public_key, r.last_seen_at, t.phone, t.language, t.timezone
       FROM routers r JOIN tenants t ON t.id = r.tenant_id
      WHERE r.vendor = 'mikrotik' AND r.status IN ('online','offline') AND t.status NOT IN ('closed')`);
  for (const r of rows) {
    const last = hs.get(r.wg_public_key) || 0;
    const online = last > 0 && now - last < ONLINE_HANDSHAKE_S;
    // eslint-disable-next-line no-await-in-loop
    await asOwner(async (c) => {
      if (online) {
        await c.query(`UPDATE routers SET status = 'online', last_seen_at = to_timestamp($2) WHERE id = $1`, [r.id, last]);
        if (await resolveAlert(c, { tenantId: r.tenant_id, kind: 'router_offline', entityId: r.id }) && r.phone) {
          await queueTemplate(c, { tenantId: r.tenant_id, to: r.phone, template: 'router_online', lang: r.language, vars: { router: r.name } });
        }
        return;
      }
      if (r.status === 'online') await c.query(`UPDATE routers SET status = 'offline' WHERE id = $1`, [r.id]);
      const seen = last ? last : (r.last_seen_at ? Math.floor(new Date(r.last_seen_at) / 1000) : now);
      if (now - seen >= OFFLINE_ALERT_MIN * 60) {
        const since = formatDate(new Date(seen * 1000), r.timezone);
        const created = await raiseAlert(c, { tenantId: r.tenant_id, kind: 'router_offline', entityId: r.id,
          message: `${r.name} offline since ${since}`, severity: 'critical' });
        if (created && r.phone) {
          await queueTemplate(c, { tenantId: r.tenant_id, to: r.phone, template: 'router_offline', lang: r.language, vars: { router: r.name, since } });
        }
      }
    });
  }
  return rows.length;
}

export async function refreshRouterInfo(log) {
  const { rows } = await ownerPool.query(`SELECT * FROM routers WHERE vendor = 'mikrotik' AND status = 'online'`);
  await Promise.all(rows.map(async (r) => {
    try {
      const info = await ros.fetchInfo(r);
      await ownerPool.query(
        `UPDATE routers SET info = $1, identity = $2, os_version = $3, last_seen_at = now() WHERE id = $4`,
        [JSON.stringify(info), info.identity, info.version, r.id]);
    } catch (e) {
      log.debug({ router: r.id, err: e.message }, 'router info refresh failed');
    }
  }));
  return rows.length;
}

/** Interface byte counters → bits per second, one row per interface per minute. */
export async function sampleTraffic(log) {
  const { rows } = await ownerPool.query(`SELECT * FROM routers WHERE vendor = 'mikrotik' AND status = 'online'`);
  await Promise.all(rows.map(async (r) => {
    try {
      const ifaces = (await ros.fetchTraffic(r)).filter((i) => i.running && !i.name.startsWith('<'));
      const ts = new Date();
      await asOwner(async (c) => {
        for (const i of ifaces) {
          const { rows: [prev] } = await c.query(
            `INSERT INTO router_counters AS rc (router_id, iface, ts, rx_bytes, tx_bytes) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (router_id, iface) DO UPDATE SET ts = EXCLUDED.ts, rx_bytes = EXCLUDED.rx_bytes, tx_bytes = EXCLUDED.tx_bytes
             RETURNING (SELECT row_to_json(o) FROM (SELECT ts, rx_bytes, tx_bytes FROM router_counters WHERE router_id = $1 AND iface = $2) o) AS old`,
            [r.id, i.name, ts, i.rx, i.tx]);
          const old = prev?.old;
          if (!old) continue;
          const secs = (ts - new Date(old.ts)) / 1000;
          // Counter reset (reboot) or a gap too long to be meaningful: skip this sample
          if (secs < 20 || secs > 600 || i.rx < old.rx_bytes || i.tx < old.tx_bytes) continue;
          await c.query(
            `INSERT INTO router_traffic (router_id, tenant_id, iface, ts, rx_bps, tx_bps) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT DO NOTHING`,
            [r.id, r.tenant_id, i.name, ts, Math.round(((i.rx - old.rx_bytes) * 8) / secs), Math.round(((i.tx - old.tx_bytes) * 8) / secs)]);
        }
      });
    } catch (e) {
      log.debug({ router: r.id, err: e.message }, 'traffic sample failed');
    }
  }));
  return rows.length;
}

// ───────────── Operator accounts & housekeeping ─────────────
/** Trial ends → read-only (customers keep working). 21 days past due → suspended (logins refused). */
export async function updateTenantStatuses(log) {
  const changes = await asOwner(async (c) => (await c.query(
    `WITH ro AS (
       UPDATE tenants SET status = 'read_only', updated_at = now()
        WHERE (status = 'trial' AND trial_ends_at < now())
           OR (status = 'active' AND paid_until < now() - interval '7 days')
       RETURNING id, 'read_only'::text AS status, phone, language),
     su AS (
       UPDATE tenants SET status = 'suspended', updated_at = now()
        WHERE status = 'read_only' AND coalesce(paid_until, trial_ends_at) < now() - interval '21 days'
       RETURNING id, 'suspended'::text AS status, phone, language)
     SELECT * FROM ro UNION ALL SELECT * FROM su`)).rows);
  for (const t of changes) {
    if (!t.phone) continue;
    // eslint-disable-next-line no-await-in-loop
    await asOwner((c) => queueTemplate(c, { to: t.phone, template: t.status === 'suspended' ? 'account_suspended' : 'account_read_only', lang: t.language }));
  }
  if (changes.length) log.info({ changes: changes.map((x) => [x.id, x.status]) }, 'tenant status changes');
  return changes.length;
}

/** Wallet SMS that arrived but matched nothing for an hour: alert the operator once per day. */
export async function flagUnmatchedPayments() {
  return asOwner(async (c) => {
    const { rows } = await c.query(
      `SELECT i.tenant_id, count(*)::int AS n, t.phone, t.language FROM inbound_sms i JOIN tenants t ON t.id = i.tenant_id
        WHERE i.matched_payment_id IS NULL AND i.parsed_amount IS NOT NULL
          AND i.received_at < now() - interval '1 hour' AND i.received_at > now() - interval '2 days'
        GROUP BY i.tenant_id, t.phone, t.language`);
    for (const r of rows) {
      const created = await raiseAlert(c, { tenantId: r.tenant_id, kind: 'unmatched_payments', entityId: r.tenant_id,
        message: `${r.n} wallet payment(s) not matched to a customer` });
      if (created && r.phone) await queueTemplate(c, { tenantId: r.tenant_id, to: r.phone, template: 'unmatched_payments', lang: r.language, vars: { count: r.n } });
    }
    // Re-arm daily: resolve yesterday's alert so a new one can fire if the problem persists
    await c.query(`UPDATE alerts SET resolved_at = now() WHERE kind = 'unmatched_payments' AND resolved_at IS NULL AND created_at < now() - interval '1 day'`);
    return rows.length;
  });
}

export async function housekeeping() {
  await ownerPool.query(`DELETE FROM router_traffic WHERE ts < now() - interval '31 days'`);
  await ownerPool.query(`DELETE FROM radpostauth WHERE authdate < now() - interval '90 days'`);
  await ownerPool.query(`DELETE FROM otp_codes WHERE created_at < now() - interval '2 days'`);
  await ownerPool.query(`DELETE FROM trial_uses WHERE day < current_date - 14`);
  await ownerPool.query(`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '7 days'`);
  await ownerPool.query(`DELETE FROM sms_messages WHERE created_at < now() - interval '180 days'`);
  return true;
}
