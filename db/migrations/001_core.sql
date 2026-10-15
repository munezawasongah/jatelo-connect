-- Jatelo Connect — core schema
-- Multi-tenant ISP & hotspot management. Every business table carries tenant_id.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ───────────────────────── Tenants & users ─────────────────────────

CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            citext NOT NULL UNIQUE,
  country         text NOT NULL DEFAULT 'BI',
  currency        text NOT NULL DEFAULT 'BIF',
  language        text NOT NULL DEFAULT 'fr' CHECK (language IN ('fr','rn','en')),
  timezone        text NOT NULL DEFAULT 'Africa/Bujumbura',
  phone           text,
  email           citext,
  tier            text NOT NULL DEFAULT 'trial' CHECK (tier IN ('trial','starter','business','isp','enterprise')),
  status          text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','read_only','suspended','closed')),
  trial_ends_at   timestamptz,
  paid_until      timestamptz,
  max_routers     int NOT NULL DEFAULT 1,
  max_active_users int,                       -- NULL = unlimited
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = platform staff
  name            text NOT NULL,
  email           citext UNIQUE,
  phone           text,
  password_hash   text NOT NULL,
  role            text NOT NULL CHECK (role IN ('platform_admin','owner','manager','technician','cashier','agent')),
  phone_verified_at timestamptz,
  email_verified_at timestamptz,
  totp_secret_enc text,
  totp_enabled    boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  language        text NOT NULL DEFAULT 'fr',
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (role = 'platform_admin' OR tenant_id IS NOT NULL),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE UNIQUE INDEX users_phone_tenant ON users (tenant_id, phone) WHERE phone IS NOT NULL;

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose     text NOT NULL,                  -- signup, login, reset, portal_recover
  target      text NOT NULL,                  -- phone or email
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_target ON otp_codes (purpose, target, created_at DESC);

-- ───────────────────────── Sites & routers ─────────────────────────

CREATE TABLE sites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        citext NOT NULL,
  address     text,
  latitude    numeric(9,6),
  longitude   numeric(9,6),
  portal      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- logo, colours, languages, trial, terms, support phone
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE routers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id           uuid REFERENCES sites(id) ON DELETE SET NULL,
  name              text NOT NULL,
  vendor            text NOT NULL DEFAULT 'mikrotik' CHECK (vendor IN ('mikrotik','ruijie','generic')),
  model             text,
  os_version        text,
  serial            text,
  identity          text,
  -- MikroTik: reached through the WireGuard tunnel. Other vendors: fixed public IP + per-router RADIUS secret.
  tunnel_ip         inet UNIQUE,
  public_ip         inet UNIQUE,
  wg_public_key     text,
  wg_private_key_enc text,
  api_username      text,
  api_password_enc  text,
  radius_secret_enc text,
  setup_token_hash  text,                     -- one-time token used by the onboarding script
  setup_token_expires_at timestamptz,
  hotspot_enabled   boolean NOT NULL DEFAULT true,
  pppoe_enabled     boolean NOT NULL DEFAULT true,
  hotspot_ports     text[] NOT NULL DEFAULT '{}',   -- physical ports moved into the hotspot bridge
  hotspot_network   cidr NOT NULL DEFAULT '10.5.50.0/24',
  pppoe_interface   text,                           -- interface the PPPoE server listens on
  pppoe_network     cidr NOT NULL DEFAULT '10.10.0.0/16',
  wan_interface     text NOT NULL DEFAULT 'ether1',
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','online','offline','disabled')),
  last_seen_at      timestamptz,
  registered_at     timestamptz,
  info              jsonb NOT NULL DEFAULT '{}'::jsonb,  -- cpu, memory, uptime, interfaces
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (vendor <> 'mikrotik' OR (tunnel_ip IS NOT NULL AND wg_public_key IS NOT NULL AND api_username IS NOT NULL)),
  CHECK (vendor = 'mikrotik' OR public_ip IS NOT NULL)
);
CREATE INDEX routers_tenant ON routers (tenant_id);

-- Tunnel addresses: 10.88.0.1 is the hub; routers get 10.88.0.2 upwards.
CREATE SEQUENCE tunnel_ip_seq START 2;
CREATE OR REPLACE FUNCTION jc_next_tunnel_ip() RETURNS inet LANGUAGE sql AS $$
  SELECT ('10.88.0.0'::inet + nextval('tunnel_ip_seq'))
$$;

-- FreeRADIUS NAS table (one row per router, keyed on tunnel IP)
CREATE TABLE nas (
  id          serial PRIMARY KEY,
  nasname     text NOT NULL UNIQUE,           -- router tunnel IP (MikroTik) or public IP (other vendors)
  shortname   text NOT NULL,
  type        text NOT NULL DEFAULT 'other',
  ports       int,
  secret      text NOT NULL,
  server      text,
  community   text,
  description text,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  router_id   uuid NOT NULL UNIQUE REFERENCES routers(id) ON DELETE CASCADE
);

-- ───────────────────────── Products ─────────────────────────

CREATE TABLE packages (                       -- hotspot packages
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               text NOT NULL,
  description        text,
  price              bigint NOT NULL CHECK (price >= 0),   -- in tenant currency, whole francs
  duration_minutes   int CHECK (duration_minutes > 0),    -- NULL = no time limit (data only)
  data_limit_mb      bigint CHECK (data_limit_mb > 0),    -- NULL = unlimited data
  rate_up_kbps       int CHECK (rate_up_kbps > 0),        -- NULL = no limit
  rate_down_kbps     int CHECK (rate_down_kbps > 0),
  device_limit       int NOT NULL DEFAULT 1 CHECK (device_limit BETWEEN 1 AND 20),
  is_trial           boolean NOT NULL DEFAULT false,
  visible_on_portal  boolean NOT NULL DEFAULT true,
  active             boolean NOT NULL DEFAULT true,
  sort_order         int NOT NULL DEFAULT 0,
  site_ids           uuid[],                               -- NULL = all sites
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (duration_minutes IS NOT NULL OR data_limit_mb IS NOT NULL)
);
CREATE INDEX packages_tenant ON packages (tenant_id);

CREATE TABLE plans (                          -- PPPoE plans
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  description          text,
  price                bigint NOT NULL CHECK (price >= 0),
  period_days          int NOT NULL DEFAULT 30 CHECK (period_days > 0),
  rate_up_kbps         int NOT NULL CHECK (rate_up_kbps > 0),
  rate_down_kbps       int NOT NULL CHECK (rate_down_kbps > 0),
  burst                jsonb,                 -- {up_kbps, down_kbps, threshold_pct, time_s}
  data_cap_mb          bigint CHECK (data_cap_mb > 0),
  fup_rate_up_kbps     int,                   -- speed after cap
  fup_rate_down_kbps   int,
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plans_tenant ON plans (tenant_id);

-- ───────────────────────── Customers ─────────────────────────

CREATE TABLE customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone       text,
  name        text,
  email       citext,
  address     text,
  latitude    numeric(9,6),
  longitude   numeric(9,6),
  notes       text,
  pin_hash    text,                           -- hotspot session-recovery PIN
  language    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)
);

CREATE TABLE subscriptions (                  -- PPPoE accounts
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  plan_id          uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  router_id        uuid REFERENCES routers(id) ON DELETE SET NULL,  -- NULL = any router of the tenant
  username         text NOT NULL,
  password         text NOT NULL,             -- cleartext required for CHAP/MS-CHAP
  static_ip        inet,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','expired','suspended','cancelled')),
  billing_mode     text NOT NULL DEFAULT 'prepaid' CHECK (billing_mode IN ('prepaid','postpaid')),
  expires_at       timestamptz,
  grace_days       int NOT NULL DEFAULT 0,
  period_bytes     bigint NOT NULL DEFAULT 0,  -- usage in the current period (FUP)
  period_started_at timestamptz,
  installed_at     timestamptz,
  last_reminder_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username)
);
CREATE INDEX subscriptions_expiry ON subscriptions (expires_at) WHERE status IN ('active','expired');

-- ───────────────────────── Agents & vouchers ─────────────────────────

CREATE TABLE agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  name            text NOT NULL,
  phone           text,
  location        text,
  discount_pct    numeric(5,2) NOT NULL DEFAULT 10 CHECK (discount_pct BETWEEN 0 AND 100),
  balance         bigint NOT NULL DEFAULT 0,   -- prepaid float the agent can spend on vouchers
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_ledger (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  amount      bigint NOT NULL,                 -- + top-up, − voucher purchase
  balance_after bigint NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('topup','purchase','adjustment','refund')),
  reference   text,
  user_id     uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE voucher_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  package_id  uuid NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
  agent_id    uuid REFERENCES agents(id) ON DELETE SET NULL,
  quantity    int NOT NULL CHECK (quantity BETWEEN 1 AND 5000),
  unit_price  bigint NOT NULL,
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Every hotspot entitlement is a voucher: printed, sold by an agent, or bought on the portal.
CREATE TABLE vouchers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  package_id     uuid NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
  batch_id       uuid REFERENCES voucher_batches(id) ON DELETE SET NULL,
  agent_id       uuid REFERENCES agents(id) ON DELETE SET NULL,
  customer_id    uuid REFERENCES customers(id) ON DELETE SET NULL,
  code           text NOT NULL,                -- uppercase, unambiguous alphabet
  source         text NOT NULL CHECK (source IN ('batch','portal','manual','trial')),
  status         text NOT NULL DEFAULT 'unused' CHECK (status IN ('unused','active','expired','exhausted','disabled')),
  -- entitlement copied from the package at creation, so later package edits never change sold vouchers
  duration_minutes int,
  data_limit_mb  bigint,
  rate_up_kbps   int,
  rate_down_kbps int,
  device_limit   int NOT NULL DEFAULT 1,
  price          bigint NOT NULL DEFAULT 0,
  device_macs    text[] NOT NULL DEFAULT '{}',
  bytes_used     bigint NOT NULL DEFAULT 0,
  seconds_used   bigint NOT NULL DEFAULT 0,
  activated_at   timestamptz,
  expires_at     timestamptz,
  sold_at        timestamptz,
  site_id        uuid REFERENCES sites(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX vouchers_status ON vouchers (tenant_id, status);
CREATE INDEX vouchers_customer ON vouchers (customer_id);
CREATE INDEX vouchers_expiry ON vouchers (expires_at) WHERE status = 'active';

-- Trial use tracking (one free session per device per day per site)
CREATE TABLE trial_uses (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mac        text NOT NULL,
  day        date NOT NULL,
  voucher_id uuid REFERENCES vouchers(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, mac, day)
);

-- ───────────────────────── Payments & billing ─────────────────────────

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL only for platform revenue rows
  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,
  channel         text NOT NULL CHECK (channel IN ('lumicash','ecocash','sms_match','cash','agent','manual')),
  purpose         text NOT NULL CHECK (purpose IN ('hotspot','subscription','agent_topup','tenant_billing')),
  purpose_id      uuid,                        -- package_id / subscription_id / agent_id / tenant_id
  amount          bigint NOT NULL CHECK (amount > 0),
  currency        text NOT NULL DEFAULT 'BIF',
  phone           text,
  reference       text NOT NULL UNIQUE,        -- our reference, shown to the customer
  external_ref    text,                        -- wallet transaction id
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed','expired','refunded')),
  failure_reason  text,
  result_id       uuid,                        -- voucher or invoice created on success
  site_id         uuid REFERENCES sites(id) ON DELETE SET NULL,
  client_mac      text,
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw             jsonb,
  recorded_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz
);
CREATE UNIQUE INDEX payments_external ON payments (channel, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX payments_tenant_time ON payments (tenant_id, created_at DESC);
CREATE INDEX payments_pending ON payments (status, created_at) WHERE status = 'pending';

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,
  number          text NOT NULL,
  period_start    timestamptz,
  period_end      timestamptz,
  lines           jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount          bigint NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  due_at          timestamptz,
  paid_at         timestamptz,
  payment_id      uuid REFERENCES payments(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE invoice_counters (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  last_no   int NOT NULL DEFAULT 0
);

-- Inbound SMS forwarded by the Android gateway, used to confirm merchant-code payments
CREATE TABLE sms_gateways (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = platform-owned
  name         text NOT NULL,
  phone        text,
  token_hash   text NOT NULL UNIQUE,
  can_send     boolean NOT NULL DEFAULT true,
  can_receive  boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inbound_sms (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenants(id) ON DELETE CASCADE,
  gateway_id     uuid REFERENCES sms_gateways(id) ON DELETE SET NULL,
  sender         text NOT NULL,
  body           text NOT NULL,
  wallet         text,                         -- lumicash / ecocash / unknown
  parsed_amount  bigint,
  parsed_txn_id  text,
  parsed_phone   text,
  matched_payment_id uuid REFERENCES payments(id),
  received_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inbound_sms_txn ON inbound_sms (tenant_id, wallet, parsed_txn_id) WHERE parsed_txn_id IS NOT NULL;

CREATE TABLE sms_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid REFERENCES tenants(id) ON DELETE CASCADE,
  to_phone     text NOT NULL,
  body         text NOT NULL,
  kind         text NOT NULL DEFAULT 'general',
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','delivered','failed')),
  provider     text,
  provider_ref text,
  error        text,
  attempts     int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);
CREATE INDEX sms_messages_queue ON sms_messages (status, created_at) WHERE status IN ('queued','sending');

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity      text,
  entity_id   text,
  data        jsonb,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant ON audit_log (tenant_id, created_at DESC);

-- ───────────────────────── FreeRADIUS tables ─────────────────────────

CREATE TABLE radacct (
  radacctid           bigserial PRIMARY KEY,
  acctsessionid       text NOT NULL,
  acctuniqueid        text NOT NULL UNIQUE,
  username            text,
  realm               text,
  nasipaddress        inet NOT NULL,
  nasportid           text,
  nasporttype         text,
  acctstarttime       timestamptz,
  acctupdatetime      timestamptz,
  acctstoptime        timestamptz,
  acctinterval        bigint,
  acctsessiontime     bigint,
  acctauthentic       text,
  connectinfo_start   text,
  connectinfo_stop    text,
  acctinputoctets     bigint,
  acctoutputoctets    bigint,
  calledstationid     text,
  callingstationid    text,
  acctterminatecause  text,
  servicetype         text,
  framedprotocol      text,
  framedipaddress     inet,
  framedipv6address   inet,
  framedipv6prefix    inet,
  framedinterfaceid   text,
  delegatedipv6prefix inet,
  class               text,
  -- Jatelo Connect columns, filled by trigger
  tenant_id           uuid,
  router_id           uuid,
  voucher_id          uuid,
  subscription_id     uuid
);
CREATE INDEX radacct_active ON radacct (acctuniqueid) WHERE acctstoptime IS NULL;
CREATE INDEX radacct_bulk_close ON radacct (nasipaddress, acctstarttime) WHERE acctstoptime IS NULL;
CREATE INDEX radacct_start_user ON radacct (acctstarttime, username);
CREATE INDEX radacct_tenant_open ON radacct (tenant_id) WHERE acctstoptime IS NULL;
CREATE INDEX radacct_tenant_time ON radacct (tenant_id, acctstarttime DESC);
CREATE INDEX radacct_voucher ON radacct (voucher_id) WHERE voucher_id IS NOT NULL;
CREATE INDEX radacct_subscription ON radacct (subscription_id) WHERE subscription_id IS NOT NULL;

CREATE TABLE radpostauth (
  id                bigserial PRIMARY KEY,
  username          text NOT NULL,
  reply             text,
  nasipaddress      inet,
  callingstationid  text,
  servicetype       text,
  reply_message     text,
  authdate          timestamptz NOT NULL DEFAULT now(),
  tenant_id         uuid
);
CREATE INDEX radpostauth_tenant ON radpostauth (tenant_id, authdate DESC);

-- ───────────────────────── Helpers ─────────────────────────

CREATE OR REPLACE FUNCTION jc_norm_mac(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p IS NULL OR p = '' THEN NULL
         ELSE upper(regexp_replace(regexp_replace(p, '[^0-9A-Fa-f]', '', 'g'), '(..)(?!$)', '\1:', 'g')) END
$$;

-- MikroTik rate string "rx/tx" from the router's view: rx = client upload, tx = client download
CREATE OR REPLACE FUNCTION jc_rate(p_up int, p_down int) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_up IS NULL AND p_down IS NULL THEN NULL
         ELSE coalesce(p_up::text || 'k', '0') || '/' || coalesce(p_down::text || 'k', '0') END
$$;

-- ───────────────────────── RADIUS decision logic ─────────────────────────
-- FreeRADIUS calls these through rlm_sql. They return the standard
-- (id, username, attribute, value, op) shape. Hotspot logins (Service-Type
-- Login-User or unset) map to vouchers; PPP logins (Framed-User) map to subscriptions.

CREATE OR REPLACE FUNCTION jc_radius_check(p_user text, p_nas text, p_mac text, p_service text)
RETURNS TABLE (id int, username text, attribute text, value text, op text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_tenant uuid; v_router uuid; v_tstatus text;
  v record; s record;
  v_mac text := jc_norm_mac(p_mac);
BEGIN
  SELECT n.tenant_id, n.router_id, t.status INTO v_tenant, v_router, v_tstatus
    FROM nas n JOIN tenants t ON t.id = n.tenant_id WHERE n.nasname = p_nas;
  IF v_tenant IS NULL OR v_tstatus IN ('suspended','closed') THEN
    RETURN QUERY SELECT 1, p_user, 'Auth-Type'::text, 'Reject'::text, ':='::text;
    RETURN;
  END IF;

  IF p_service = 'Framed-User' THEN
    SELECT * INTO s FROM subscriptions x
      WHERE x.tenant_id = v_tenant AND x.username = p_user
        AND (x.router_id IS NULL OR x.router_id = v_router);
    IF NOT FOUND OR s.status IN ('pending','suspended','cancelled') THEN
      RETURN QUERY SELECT 1, p_user, 'Auth-Type'::text, 'Reject'::text, ':='::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT 1, p_user, 'Cleartext-Password'::text, s.password, ':='::text;
    RETURN;
  END IF;

  SELECT * INTO v FROM vouchers x WHERE x.tenant_id = v_tenant AND x.code = upper(p_user);
  IF NOT FOUND
     OR v.status IN ('disabled','expired','exhausted')
     OR (v.expires_at IS NOT NULL AND v.expires_at <= now())
     OR (v.data_limit_mb IS NOT NULL AND v.bytes_used >= v.data_limit_mb * 1048576)
     OR (v_mac IS NOT NULL AND NOT (v_mac = ANY (v.device_macs))
         AND cardinality(v.device_macs) >= v.device_limit) THEN
    RETURN QUERY SELECT 1, p_user, 'Auth-Type'::text, 'Reject'::text, ':='::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 1, p_user, 'Cleartext-Password'::text, v.code, ':='::text;
END $$;

CREATE OR REPLACE FUNCTION jc_radius_reply(p_user text, p_nas text, p_mac text, p_service text)
RETURNS TABLE (id int, username text, attribute text, value text, op text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_tenant uuid; v_router uuid;
  v record; s record; pl record;
  v_secs bigint; v_left bigint; v_rate text; v_expired boolean;
BEGIN
  SELECT n.tenant_id, n.router_id INTO v_tenant, v_router FROM nas n WHERE n.nasname = p_nas;
  IF v_tenant IS NULL THEN RETURN; END IF;

  IF p_service = 'Framed-User' THEN
    SELECT * INTO s FROM subscriptions x WHERE x.tenant_id = v_tenant AND x.username = p_user;
    IF NOT FOUND THEN RETURN; END IF;
    SELECT * INTO pl FROM plans WHERE plans.id = s.plan_id;
    v_expired := s.status = 'expired'
              OR (s.expires_at IS NOT NULL AND s.expires_at + make_interval(days => s.grace_days) <= now());
    IF v_expired THEN
      -- Connected but walled: the router redirects this address list to the payment page
      RETURN QUERY VALUES
        (1, p_user, 'Mikrotik-Address-List'::text, 'jc-expired'::text, ':='::text),
        (2, p_user, 'Mikrotik-Rate-Limit', '256k/256k', ':='),
        (3, p_user, 'Session-Timeout', '3600', ':='),
        (4, p_user, 'Acct-Interim-Interval', '300', ':=');
    ELSE
      IF pl.data_cap_mb IS NOT NULL AND s.period_bytes >= pl.data_cap_mb * 1048576
         AND pl.fup_rate_down_kbps IS NOT NULL THEN
        v_rate := jc_rate(pl.fup_rate_up_kbps, pl.fup_rate_down_kbps);
      ELSIF pl.burst IS NOT NULL THEN
        -- rx/tx rate, burst-rate, burst-threshold, burst-time
        v_rate := jc_rate(pl.rate_up_kbps, pl.rate_down_kbps) || ' ' ||
                  jc_rate((pl.burst->>'up_kbps')::int, (pl.burst->>'down_kbps')::int) || ' ' ||
                  jc_rate(pl.rate_up_kbps * coalesce((pl.burst->>'threshold_pct')::int, 75) / 100,
                          pl.rate_down_kbps * coalesce((pl.burst->>'threshold_pct')::int, 75) / 100) || ' ' ||
                  coalesce(pl.burst->>'time_s', '16') || '/' || coalesce(pl.burst->>'time_s', '16');
      ELSE
        v_rate := jc_rate(pl.rate_up_kbps, pl.rate_down_kbps);
      END IF;
      RETURN QUERY SELECT 1, p_user, 'Mikrotik-Rate-Limit'::text, v_rate, ':='::text;
      RETURN QUERY SELECT 2, p_user, 'Acct-Interim-Interval'::text, '300'::text, ':='::text;
      IF s.expires_at IS NOT NULL THEN
        -- Reconnect at expiry so the session picks up the walled profile
        v_secs := greatest(60, extract(epoch FROM (s.expires_at + make_interval(days => s.grace_days) - now()))::bigint);
        RETURN QUERY SELECT 3, p_user, 'Session-Timeout'::text, least(v_secs, 86400)::text, ':='::text;
      END IF;
      IF s.static_ip IS NOT NULL THEN
        RETURN QUERY SELECT 4, p_user, 'Framed-IP-Address'::text, host(s.static_ip), ':='::text;
      END IF;
    END IF;
    RETURN;
  END IF;

  SELECT * INTO v FROM vouchers x WHERE x.tenant_id = v_tenant AND x.code = upper(p_user);
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY SELECT 0, p_user, 'Mikrotik-Group'::text, 'jc-users'::text, ':='::text;
  v_rate := jc_rate(v.rate_up_kbps, v.rate_down_kbps);
  IF v_rate IS NOT NULL THEN
    RETURN QUERY SELECT 1, p_user, 'Mikrotik-Rate-Limit'::text, v_rate, ':='::text;
  END IF;
  RETURN QUERY SELECT 2, p_user, 'Acct-Interim-Interval'::text, '300'::text, ':='::text;

  IF v.duration_minutes IS NOT NULL THEN
    IF v.expires_at IS NOT NULL THEN
      v_secs := greatest(1, extract(epoch FROM (v.expires_at - now()))::bigint);
    ELSE
      v_secs := v.duration_minutes::bigint * 60;
    END IF;
    RETURN QUERY SELECT 3, p_user, 'Session-Timeout'::text, v_secs::text, ':='::text;
  END IF;

  IF v.data_limit_mb IS NOT NULL THEN
    v_left := greatest(0, v.data_limit_mb * 1048576 - v.bytes_used);
    RETURN QUERY SELECT 4, p_user, 'Mikrotik-Total-Limit'::text, (v_left % 4294967296)::text, ':='::text;
    IF v_left >= 4294967296 THEN
      RETURN QUERY SELECT 5, p_user, 'Mikrotik-Total-Limit-Gigawords'::text, (v_left / 4294967296)::text, ':='::text;
    END IF;
  END IF;
END $$;

-- Post-auth: FreeRADIUS inserts a row into radpostauth; this trigger activates
-- vouchers on their first accepted login and binds the device.
CREATE OR REPLACE FUNCTION jc_postauth_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_mac text := jc_norm_mac(NEW.callingstationid);
BEGIN
  SELECT n.tenant_id INTO NEW.tenant_id FROM nas n WHERE n.nasname = host(NEW.nasipaddress);
  IF NEW.tenant_id IS NULL OR NEW.reply <> 'Access-Accept' OR NEW.servicetype = 'Framed-User' THEN
    RETURN NEW;
  END IF;
  UPDATE vouchers SET
    status       = 'active',
    activated_at = coalesce(activated_at, now()),
    expires_at   = coalesce(expires_at,
                     CASE WHEN duration_minutes IS NOT NULL THEN now() + make_interval(mins => duration_minutes) END),
    device_macs  = CASE WHEN v_mac IS NULL OR v_mac = ANY (device_macs) THEN device_macs
                        ELSE device_macs || v_mac END
  WHERE tenant_id = NEW.tenant_id AND code = upper(NEW.username);
  RETURN NEW;
END $$;
CREATE TRIGGER radpostauth_activate BEFORE INSERT ON radpostauth
  FOR EACH ROW EXECUTE FUNCTION jc_postauth_trigger();

-- Accounting: tag each session with tenant/router/voucher/subscription and roll usage up.
CREATE OR REPLACE FUNCTION jc_radacct_tag() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    SELECT n.tenant_id, n.router_id INTO NEW.tenant_id, NEW.router_id
      FROM nas n WHERE n.nasname = host(NEW.nasipaddress);
  END IF;
  IF NEW.tenant_id IS NOT NULL AND NEW.voucher_id IS NULL AND NEW.subscription_id IS NULL THEN
    IF NEW.framedprotocol = 'PPP' OR NEW.servicetype = 'Framed-User' THEN
      SELECT x.id INTO NEW.subscription_id FROM subscriptions x
        WHERE x.tenant_id = NEW.tenant_id AND x.username = NEW.username;
    ELSE
      SELECT x.id INTO NEW.voucher_id FROM vouchers x
        WHERE x.tenant_id = NEW.tenant_id AND x.code = upper(NEW.username);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER radacct_tag BEFORE INSERT ON radacct
  FOR EACH ROW EXECUTE FUNCTION jc_radacct_tag();

CREATE OR REPLACE FUNCTION jc_radacct_usage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d_bytes bigint; d_secs bigint;
BEGIN
  d_bytes := coalesce(NEW.acctinputoctets,0) + coalesce(NEW.acctoutputoctets,0);
  d_secs  := coalesce(NEW.acctsessiontime,0);
  IF TG_OP = 'UPDATE' THEN
    d_bytes := d_bytes - coalesce(OLD.acctinputoctets,0) - coalesce(OLD.acctoutputoctets,0);
    d_secs  := d_secs - coalesce(OLD.acctsessiontime,0);
  END IF;
  IF d_bytes <= 0 AND d_secs <= 0 THEN RETURN NULL; END IF;
  d_bytes := greatest(d_bytes, 0); d_secs := greatest(d_secs, 0);

  IF NEW.voucher_id IS NOT NULL THEN
    UPDATE vouchers SET
      bytes_used = bytes_used + d_bytes,
      seconds_used = seconds_used + d_secs,
      status = CASE WHEN data_limit_mb IS NOT NULL AND bytes_used + d_bytes >= data_limit_mb * 1048576
                    THEN 'exhausted' ELSE status END
    WHERE id = NEW.voucher_id;
  ELSIF NEW.subscription_id IS NOT NULL THEN
    UPDATE subscriptions SET period_bytes = period_bytes + d_bytes WHERE id = NEW.subscription_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER radacct_usage AFTER INSERT OR UPDATE OF acctinputoctets, acctoutputoctets, acctsessiontime
  ON radacct FOR EACH ROW EXECUTE FUNCTION jc_radacct_usage();

-- Timer: mark expired vouchers and subscriptions (called every minute by the worker)
CREATE OR REPLACE FUNCTION jc_expire_due() RETURNS TABLE (kind text, item_id uuid, tenant_id uuid)
LANGUAGE sql AS $$
  WITH v AS (
    UPDATE vouchers SET status = 'expired'
     WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now()
     RETURNING 'voucher'::text, id, vouchers.tenant_id
  ), s AS (
    UPDATE subscriptions SET status = 'expired'
     WHERE status = 'active' AND expires_at IS NOT NULL
       AND expires_at + make_interval(days => grace_days) <= now()
     RETURNING 'subscription'::text, id, subscriptions.tenant_id
  )
  SELECT * FROM v UNION ALL SELECT * FROM s
$$;

-- ───────────────────────── Row-level security ─────────────────────────
-- The API sets app.tenant_id per request; platform jobs use a role that bypasses RLS.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sites','routers','packages','plans','customers','subscriptions','agents',
    'agent_ledger','voucher_batches','vouchers','payments','invoices','sms_messages','inbound_sms',
    'audit_log','trial_uses']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
