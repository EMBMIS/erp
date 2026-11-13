-- 202608160200 — Backfill RLS policies for HR tables left unprotected by
-- 202608141000_hr_payroll_leave_org.sql.
--
-- Why this exists:
--   202608141000 created seven HR tables (leave_requests, attendance_records,
--   leave_accrual_policies, leave_balances, leave_balance_transactions,
--   employee_job_history, employee_documents), registered them in
--   company_scoped_tables, and its "section 5" self-healing block only
--   applies RLS when company_isolation_config.application_role is already
--   set. On this install the config row was empty even though isolation had
--   been applied to every previously-registered table, so those seven tables
--   were registered as company-scoped but never given a policy.
--
--   One unprotected registered table is not a leak — it is a total outage.
--   company_policies_active() (migration 110) requires EVERY table in
--   company_scoped_tables to have RLS enabled AND forced. The seven gaps make
--   it false, which makes multi_company_enabled() false, which tells
--   config/database.js's pool wrapper to stop applying
--   SET LOCAL app.current_company_id. Every RLS-protected table then matches
--   no rows on the qira_app connection: all company data goes blank, the
--   sidebar shows only core sections, and the admin Modules screen shows
--   every optional module as disabled (toggles fail with a policy violation).
--
-- Repair:
--   Record the application role — the role this stack's app actually connects
--   as (qira_app, per docker-compose.yml and docker/postgres-init/
--   10-create-app-role.sh) — then re-run enable_multi_company() so every
--   table currently in company_scoped_tables gets ENABLE/FORCE ROW LEVEL
--   SECURITY and its company_isolation policy. enable_multi_company() is
--   idempotent (DROP POLICY IF EXISTS then CREATE; ENABLE/FORCE are no-ops on
--   already-forced tables), so this is safe to repeat. The db-migrate.js
--   end-of-pass resync then covers any future registration automatically.
--
-- Guard: on a database where isolation was never enabled (no company-scoped
-- table is RLS-forced), this migration records nothing and runs nothing —
-- it must never be the thing that silently turns isolation on for a
-- deployment that has not opted in.

INSERT INTO company_isolation_config (id) VALUES (true) ON CONFLICT DO NOTHING;

DO $$
DECLARE
  app_role NAME;
  isolation_ever_applied BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.relname IN (SELECT table_name FROM company_scoped_tables)
       AND c.relforcerowsecurity
  ) INTO isolation_ever_applied;

  IF NOT isolation_ever_applied THEN
    RAISE NOTICE 'company isolation was never enabled on this database — nothing to backfill.';
    RETURN;
  END IF;

  SELECT application_role INTO app_role
    FROM company_isolation_config WHERE id AND application_role IS NOT NULL;

  IF app_role IS NULL THEN
    -- No role recorded, but isolation is already forced on other tables: the
    -- application connects as qira_app on every deployment of this stack and
    -- qira_app is the role those policies are forced for. Record the reality
    -- so this and future resyncs have something to read.
    UPDATE company_isolation_config
       SET application_role = 'qira_app',
           enabled_at = CURRENT_TIMESTAMP,
           enabled_by = current_user
     WHERE id;
    app_role := 'qira_app';
  END IF;

  -- Re-apply isolation to every table in company_scoped_tables, closing the
  -- HR gap. Raises with a clear message if the recorded role is missing or
  -- unusable, which is the right behaviour for a repair migration.
  PERFORM public.enable_multi_company(app_role);
END $$;
