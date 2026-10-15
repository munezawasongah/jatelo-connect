-- Database roles. Passwords are set by deploy/setup.sh, never stored here.
--   jc_app     – the API; row-level security applies (app.tenant_id per request)
--   jc_radius  – FreeRADIUS; reads products, writes accounting; bypasses RLS
-- The migration owner (who runs this file) is used by background workers.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jc_app') THEN
    CREATE ROLE jc_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jc_radius') THEN
    CREATE ROLE jc_radius NOLOGIN BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO jc_app, jc_radius;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO jc_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO jc_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO jc_app;

GRANT SELECT ON nas, tenants, vouchers, subscriptions, plans, packages TO jc_radius;
GRANT SELECT, INSERT, UPDATE ON radacct, radpostauth TO jc_radius;
GRANT UPDATE ON vouchers, subscriptions TO jc_radius;          -- usage and activation triggers
GRANT USAGE, SELECT ON radacct_radacctid_seq, radpostauth_id_seq TO jc_radius;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO jc_radius;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO jc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO jc_app, jc_radius;
