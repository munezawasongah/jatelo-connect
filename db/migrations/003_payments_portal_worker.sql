-- Step 3: payment channels, SMS gateways, portal payments, router traffic, worker bookkeeping.

-- How each operator collects money. One row per wallet.
--   mode 'sms_match' : customer pays the merchant number by USSD; the SMS gateway forwards the
--                      wallet's confirmation SMS and the platform matches it.
--   mode 'api'       : direct merchant API (push prompt + callback), once the wallet grants access.
CREATE TABLE payment_channels (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wallet           text NOT NULL CHECK (wallet IN ('lumicash','ecocash')),
  mode             text NOT NULL DEFAULT 'sms_match' CHECK (mode IN ('sms_match','api')),
  merchant_number  text NOT NULL,            -- number or merchant code customers pay to
  merchant_name    text,                     -- name the wallet shows the customer, to reassure them
  credentials_enc  text,                     -- encrypted JSON for API mode
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wallet)
);
ALTER TABLE payment_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_channels
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Payments started from the captive portal or renewal page carry a browser secret so only
-- the device that paid can collect the voucher code.
ALTER TABLE payments ADD COLUMN wallet text CHECK (wallet IN ('lumicash','ecocash'));
ALTER TABLE payments ADD COLUMN client_secret_hash text;
ALTER TABLE payments ADD COLUMN expires_at timestamptz;
ALTER TABLE payments ADD COLUMN router_id uuid REFERENCES routers(id) ON DELETE SET NULL;
CREATE INDEX payments_match ON payments (tenant_id, status, wallet, amount, created_at) WHERE status = 'pending';

-- SMS gateways: an Android phone running the SMS Gateway app (sms-gate.app), or an aggregator.
ALTER TABLE sms_gateways ADD COLUMN provider text NOT NULL DEFAULT 'smsgate' CHECK (provider IN ('smsgate','http'));
ALTER TABLE sms_gateways ADD COLUMN base_url text;            -- e.g. https://api.sms-gate.app/3rdparty/v1
ALTER TABLE sms_gateways ADD COLUMN username text;
ALTER TABLE sms_gateways ADD COLUMN password_enc text;
ALTER TABLE sms_gateways ADD COLUMN wallets text[] NOT NULL DEFAULT '{lumicash,ecocash}';  -- whose SMS it receives
ALTER TABLE sms_gateways ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE sms_gateways ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sms_gateways
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE inbound_sms ADD COLUMN raw jsonb;
ALTER TABLE inbound_sms ADD COLUMN parsed_name text;

ALTER TABLE sms_messages ADD COLUMN gateway_id uuid REFERENCES sms_gateways(id) ON DELETE SET NULL;
ALTER TABLE sms_messages ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();

-- Customers asking to be connected (public sign-up link)
CREATE TABLE service_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id     uuid REFERENCES plans(id) ON DELETE SET NULL,
  name        text NOT NULL,
  phone       text NOT NULL,
  address     text,
  latitude    numeric(9,6),
  longitude   numeric(9,6),
  notes       text,
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','installed','rejected')),
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE service_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON service_requests
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Router interface throughput, sampled every minute by the worker (kept 31 days)
CREATE TABLE router_traffic (
  router_id  uuid NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  iface      text NOT NULL,
  ts         timestamptz NOT NULL,
  rx_bps     bigint NOT NULL,
  tx_bps     bigint NOT NULL,
  PRIMARY KEY (router_id, iface, ts)
);
CREATE INDEX router_traffic_ts ON router_traffic (ts);
ALTER TABLE router_traffic ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON router_traffic
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Last raw byte counters per interface, to turn counters into rates
CREATE TABLE router_counters (
  router_id  uuid NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  iface      text NOT NULL,
  ts         timestamptz NOT NULL,
  rx_bytes   bigint NOT NULL,
  tx_bytes   bigint NOT NULL,
  PRIMARY KEY (router_id, iface)
);

-- Alerts raised by the worker (router offline, payment mismatch, ...), shown on the dashboard
CREATE TABLE alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  entity_id   uuid,
  message     text NOT NULL,
  severity    text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  resolved_at timestamptz,
  notified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX alerts_open ON alerts (tenant_id, kind, entity_id) WHERE resolved_at IS NULL;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON alerts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Reminder bookkeeping: which reminder (days before expiry) was last sent for this expiry date
ALTER TABLE subscriptions ADD COLUMN reminders_sent int[] NOT NULL DEFAULT '{}';
ALTER TABLE subscriptions ADD COLUMN expiry_notified_at timestamptz;

-- Close sessions whose router stopped sending accounting (reboot, power cut).
CREATE OR REPLACE FUNCTION jc_close_stale_sessions(p_minutes int DEFAULT 16) RETURNS int LANGUAGE sql AS $$
  WITH c AS (
    UPDATE radacct SET acctstoptime = coalesce(acctupdatetime, acctstarttime), acctterminatecause = 'Stale-Session'
     WHERE acctstoptime IS NULL
       AND coalesce(acctupdatetime, acctstarttime) < now() - make_interval(mins => p_minutes)
     RETURNING 1)
  SELECT count(*)::int FROM c
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON payment_channels, service_requests, router_traffic, router_counters, alerts TO jc_app;
