-- Step 4: real-time events for the dashboard (LISTEN jc_events → Server-Sent Events).

CREATE OR REPLACE FUNCTION jc_notify(p_tenant uuid, p_type text, p_id text) RETURNS void LANGUAGE sql AS $$
  SELECT pg_notify('jc_events', json_build_object('tenant_id', p_tenant, 'type', p_type, 'id', p_id)::text)
$$;

CREATE OR REPLACE FUNCTION jc_payments_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    PERFORM jc_notify(NEW.tenant_id, 'payment', NEW.id::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER payments_notify AFTER INSERT OR UPDATE OF status ON payments
  FOR EACH ROW EXECUTE FUNCTION jc_payments_notify();

CREATE OR REPLACE FUNCTION jc_sessions_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS NOT NULL AND (TG_OP = 'INSERT' OR (NEW.acctstoptime IS NOT NULL AND OLD.acctstoptime IS NULL)) THEN
    PERFORM jc_notify(NEW.tenant_id, 'session', NEW.radacctid::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER radacct_notify AFTER INSERT OR UPDATE OF acctstoptime ON radacct
  FOR EACH ROW EXECUTE FUNCTION jc_sessions_notify();

CREATE OR REPLACE FUNCTION jc_routers_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM jc_notify(NEW.tenant_id, 'router', NEW.id::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER routers_notify AFTER INSERT OR UPDATE OF status ON routers
  FOR EACH ROW EXECUTE FUNCTION jc_routers_notify();

CREATE OR REPLACE FUNCTION jc_alerts_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM jc_notify(NEW.tenant_id, 'alert', NEW.id::text);
  RETURN NULL;
END $$;
CREATE TRIGGER alerts_notify AFTER INSERT OR UPDATE OF resolved_at ON alerts
  FOR EACH ROW EXECUTE FUNCTION jc_alerts_notify();

CREATE OR REPLACE FUNCTION jc_requests_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM jc_notify(NEW.tenant_id, 'request', NEW.id::text);
  RETURN NULL;
END $$;
CREATE TRIGGER service_requests_notify AFTER INSERT ON service_requests
  FOR EACH ROW EXECUTE FUNCTION jc_requests_notify();

-- Platform billing: what each operator owes us and has paid (recorded by Jatelo staff)
CREATE TABLE tenant_billing (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tier        text NOT NULL,
  months      int NOT NULL CHECK (months > 0),
  amount      bigint NOT NULL CHECK (amount >= 0),
  paid_until  timestamptz NOT NULL,
  reference   text,
  recorded_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_billing_tenant ON tenant_billing (tenant_id, created_at DESC);
GRANT SELECT ON tenant_billing TO jc_app;
