-- Repoint every company_id column default that falls back to a company that
-- does not exist in THIS database.
--
-- The baseline snapshot (database/baseline/000_baseline_schema.sql) was
-- pg_dumped from a development database and carried that database's company
-- UUID — e2b38a3c-9bec-4190-a183-4113114a91e1 — into the column default of 97
-- company-scoped tables:
--
--   DEFAULT COALESCE(current_company_id(), 'e2b38a3c-9bec-4190-a183-4113114a91e1'::uuid)
--
-- On deployments where that UUID is not a real company, every insert that
-- runs WITHOUT a request's company context (one-off scripts, raw SQL, test
-- fixtures) failed with a foreign-key violation:
--
--   ERROR: insert or update on table "x" violates foreign key constraint
--   DETAIL: Key (company_id)=(e2b38a3c-...) is not present in table "companies".
--
-- In-request writes are unaffected (middleware/auth.js wraps every request in
-- companyContext, and config/database.js applies SET LOCAL
-- app.current_company_id per query), so this was invisible in the UI but
-- poisoned every non-HTTP writer — including the DoA grants created outside
-- a request during verification.
--
-- This migration points the fallback at this deployment's default company:
-- the one that owns the real data (the DoA starter grant, items, suppliers,
-- customers, orders). It targets only defaults that still carry the dead UUID,
-- so it is idempotent and safe on databases that already have sane defaults.
--
-- NOTE for fresh builds: the baseline snapshot must be regenerated from a
-- fixed database (see database/baseline/README.md) so new deployments do not
-- inherit the dead UUID again; this migration then leaves those defaults
-- untouched because no column still carries it.

DO $$
DECLARE
  target_company uuid := '18575681-4f4d-4034-b403-bb26a766e301';
  dead_default   text  := 'e2b38a3c-9bec-4190-a183-4113114a91e1';
  r record;
  ddl text;
BEGIN
  -- On a brand-new database (CI, a fresh volume) there are no companies yet
  -- — the deployment's first register-company creates them. Repointing the
  -- fallback to a company that does not exist would be just as dangling, so
  -- leave the defaults alone and let the app's per-request company context
  -- carry inserts; the operator should regenerate the baseline snapshot (see
  -- database/baseline/README.md) so fresh builds never inherit the dead UUID.
  IF NOT EXISTS (SELECT 1 FROM companies WHERE id = target_company) THEN
    RAISE NOTICE 'target company % does not exist — leaving company_id defaults untouched (fresh database; regenerate the baseline snapshot to fix the dead fallback)', target_company;
    RETURN;
  END IF;

  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name
      FROM pg_attrdef d
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND pg_get_expr(d.adbin, d.adrelid) LIKE '%' || dead_default || '%'
     ORDER BY c.relname
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT COALESCE(current_company_id(), %L::uuid)',
      r.schema_name, r.table_name, r.column_name, target_company
    );
    RAISE NOTICE 'repointed %.%.% -> %', r.schema_name, r.table_name, r.column_name, target_company;
  END LOOP;
END $$;
