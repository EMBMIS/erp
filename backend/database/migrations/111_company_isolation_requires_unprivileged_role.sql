-- 111 — Make company isolation real rather than decorative.
--
-- ===========================================================================
-- WHAT WENT WRONG IN 110
-- ===========================================================================
--
-- Migration 110 enabled row-level security on 46 tables, with FORCE so that
-- even the table owner is subject to the policy. Tested against this database,
-- it isolated nothing: a session set to company A saw, wrote and deleted
-- company B's rows freely, and a session with no company context at all saw
-- every row in the system.
--
-- The reason is that this application connects as `postgres`, which is a
-- superuser. **Superusers, and any role with BYPASSRLS, ignore row-level
-- security unconditionally — FORCE does not apply to them.** There is no
-- policy that can be written to stop this; it is a property of the role, not
-- of the table.
--
-- That is the worst possible failure mode for a tenant boundary, because
-- everything reports success. `multi_company_enabled()` returned true,
-- pg_class.relrowsecurity was true, the policies existed and were syntactically
-- correct — and every row was visible to everyone. An operator following the
-- documented steps would have created a second company believing it was
-- separated.
--
-- So isolation is now defined as both halves being true: the policies are on
-- AND the connecting role is actually subject to them. A role that bypasses RLS
-- makes the system report itself as unisolated, which is the truth.
--
-- ===========================================================================
-- WHAT AN OPERATOR MUST DO BEFORE ENABLING MULTI-COMPANY
-- ===========================================================================
--
-- Create an application role that is not a superuser and does not have
-- BYPASSRLS, and point the application's connection string at it:
--
--     CREATE ROLE qira_app LOGIN PASSWORD 'strong-password-here';
--     GRANT CONNECT ON DATABASE <db> TO qira_app;
--     GRANT USAGE ON SCHEMA public TO qira_app;
--     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qira_app;
--     GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO qira_app;
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public
--       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qira_app;
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public
--       GRANT USAGE, SELECT ON SEQUENCES TO qira_app;
--
-- Migrations keep running as the owner/superuser; only the application's
-- runtime connection changes. `SELECT * FROM company_isolation_status();`
-- reports whether the running connection is actually isolated.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- Does the *current* connection bypass row-level security?
--
-- Checked for the session role rather than a hardcoded name, and covers both
-- routes: rolsuper (superusers ignore RLS) and rolbypassrls (granted
-- explicitly). Role membership is followed too, since BYPASSRLS inherited
-- through a group bypasses just as effectively as one granted directly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.role_bypasses_rls() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE (r.rolsuper OR r.rolbypassrls)
       AND pg_has_role(current_user, r.oid, 'USAGE')
  );
$$;

CREATE OR REPLACE FUNCTION public.company_policies_active() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity)
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN (SELECT table_name FROM company_scoped_tables)),
    false);
$$;

-- Isolation is the conjunction. Reporting the policies alone as "enabled" is
-- what made the earlier failure invisible.
CREATE OR REPLACE FUNCTION public.multi_company_enabled() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT public.company_policies_active() AND NOT public.role_bypasses_rls();
$$;

-- Human-readable readiness check. Intended to be run on the *application's*
-- connection, because that is the connection whose privileges decide the
-- answer — running it as postgres will correctly say it is not isolated.
CREATE OR REPLACE FUNCTION public.company_isolation_status()
RETURNS TABLE (
  connected_as      NAME,
  policies_active   BOOLEAN,
  role_bypasses_rls BOOLEAN,
  isolated          BOOLEAN,
  company_count     INTEGER,
  advice            TEXT
)
LANGUAGE sql STABLE AS $$
  SELECT
    current_user,
    public.company_policies_active(),
    public.role_bypasses_rls(),
    public.multi_company_enabled(),
    (SELECT COUNT(*)::int FROM companies WHERE deleted_at IS NULL),
    CASE
      WHEN public.role_bypasses_rls() THEN
        format('Connected as %I, which is a superuser or has BYPASSRLS. Row-level security cannot restrict this role, so company isolation is NOT in effect regardless of the policies. Connect the application as an unprivileged role before enabling multi-company.', current_user)
      WHEN NOT public.company_policies_active() THEN
        'Company isolation policies are not active. The system is single-company; run SELECT enable_multi_company(); to turn them on.'
      ELSE
        'Company isolation is in effect on this connection.'
    END;
$$;

-- ---------------------------------------------------------------------------
-- Refuse to enable isolation from a connection that cannot be isolated.
--
-- Enabling from a superuser session is precisely how the false sense of
-- security in 110 arose, so it now fails loudly instead.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enable_multi_company() RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  t TEXT;
  n INT := 0;
BEGIN
  IF public.role_bypasses_rls() THEN
    RAISE EXCEPTION
      'Refusing to enable company isolation from role % — it is a superuser or has BYPASSRLS and therefore ignores row-level security entirely. Enabling from here would report success while isolating nothing. Create an unprivileged application role first (see migration 111).',
      current_user;
  END IF;

  FOR t IN SELECT table_name FROM company_scoped_tables ORDER BY table_name LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS company_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY company_isolation ON %I
        USING (company_id = public.current_company_id())
        WITH CHECK (company_id = public.current_company_id())
    $p$, t);
    n := n + 1;
  END LOOP;

  RETURN format('Row-level company isolation enabled on %s tables, enforced for role %I.', n, current_user);
END $$;

-- Disabling stays available to a privileged role: an operator locked out by a
-- misconfiguration must be able to recover. It still refuses while more than
-- one company exists, which is the case where turning it off would actually
-- expose data.
CREATE OR REPLACE FUNCTION public.disable_multi_company() RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  t TEXT;
  n INT := 0;
BEGIN
  IF (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL) > 1 THEN
    RAISE EXCEPTION 'Cannot disable company isolation while % companies exist — every user would immediately see every company''s data.',
      (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL);
  END IF;

  FOR t IN SELECT table_name FROM company_scoped_tables ORDER BY table_name LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
    n := n + 1;
  END LOOP;

  RETURN format('Row-level company isolation disabled on %s tables.', n);
END $$;

-- ---------------------------------------------------------------------------
-- The gate, restated against real isolation.
--
-- Because multi_company_enabled() now accounts for the connecting role, a
-- superuser session can no longer create a second company at all — which is
-- correct: a superuser session is exactly the one that would not be isolated
-- from it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_company_insert() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL) >= 1
     AND NOT public.multi_company_enabled() THEN
    IF public.role_bypasses_rls() THEN
      RAISE EXCEPTION
        'Refusing to create a second company from role % — it bypasses row-level security, so the two companies would not be separated. Connect as an unprivileged application role and run SELECT enable_multi_company(); first.',
        current_user;
    ELSE
      RAISE EXCEPTION
        'Refusing to create a second company while row-level isolation is off. Run SELECT enable_multi_company(); first — without it both companies would share every table with nothing separating them.';
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.multi_company_enabled() IS
  'True only when the isolation policies are active AND the connecting role is actually subject to them. A superuser connection reports false, because it is not isolated.';
