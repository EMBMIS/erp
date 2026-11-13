-- 112 — Let the owner enable isolation on behalf of the application's role.
--
-- Migration 111 refused to enable isolation from any role that bypasses RLS.
-- Correct, but it made the operation impossible to perform: enabling isolation
-- runs ALTER TABLE, which requires table ownership, and the owner is exactly
-- the role that bypasses RLS. The unprivileged application role can be
-- isolated but cannot enable it; the owner can enable it but cannot be
-- isolated by it.
--
-- The fix is to separate the role doing the DDL from the role the DDL is being
-- done *for*. The owner enables isolation and names the application role it is
-- protecting:
--
--     SELECT enable_multi_company('qira_app');
--
-- The named role is what gets validated — it must exist, must be able to log
-- in, must not be a superuser, and must not hold BYPASSRLS (directly or by
-- inheritance). The choice is then recorded, so the readiness check can report
-- whether the connection actually in use is the one that was protected.
--
-- Idempotent.

-- Where the intended application role is remembered. A single row.
CREATE TABLE IF NOT EXISTS company_isolation_config (
  id                 BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  application_role   NAME,
  enabled_at         TIMESTAMPTZ,
  enabled_by         NAME
);

INSERT INTO company_isolation_config (id) VALUES (true) ON CONFLICT DO NOTHING;

-- Would this specific role be subject to row-level security?
CREATE OR REPLACE FUNCTION public.role_bypasses_rls(target NAME) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE (r.rolsuper OR r.rolbypassrls)
       AND pg_has_role(target, r.oid, 'USAGE')
  );
$$;

CREATE OR REPLACE FUNCTION public.enable_multi_company(app_role NAME) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  t TEXT;
  n INT := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    RAISE EXCEPTION 'Role % does not exist. Create the application role before enabling company isolation (see migration 111 for the required grants).', app_role;
  END IF;

  IF NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = app_role) THEN
    RAISE EXCEPTION 'Role % cannot log in, so it cannot be the application role.', app_role;
  END IF;

  -- The check that matters. A role with BYPASSRLS would sail through every
  -- policy below while the system reported itself isolated.
  IF public.role_bypasses_rls(app_role) THEN
    RAISE EXCEPTION
      'Role % is a superuser or holds BYPASSRLS (possibly inherited from a group), so row-level security would not restrict it. Company isolation would be reported as active while isolating nothing. Use a role without those attributes.',
      app_role;
  END IF;

  FOR t IN SELECT table_name FROM company_scoped_tables ORDER BY table_name LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE so that the owner is covered too, for any path that does connect
    -- as the owner.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS company_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY company_isolation ON %I
        USING (company_id = public.current_company_id())
        WITH CHECK (company_id = public.current_company_id())
    $p$, t);
    n := n + 1;
  END LOOP;

  UPDATE company_isolation_config
     SET application_role = app_role,
         enabled_at = CURRENT_TIMESTAMP,
         enabled_by = current_user
   WHERE id;

  RETURN format(
    'Company isolation enabled on %s tables, enforced for role %I. Point the application''s connection at %I — a connection as %I or any other superuser is NOT isolated.',
    n, app_role, app_role, current_user);
END $$;

-- The no-argument form stays, and still refuses from a bypassing role, so the
-- 111 behaviour is intact for anyone calling it that way.
CREATE OR REPLACE FUNCTION public.enable_multi_company() RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
  IF public.role_bypasses_rls() THEN
    RAISE EXCEPTION
      'Refusing to enable company isolation from role % — it bypasses row-level security. Either connect as the unprivileged application role, or name that role explicitly: SELECT enable_multi_company(''your_app_role'');',
      current_user;
  END IF;
  RETURN public.enable_multi_company(current_user::name);
END $$;

-- ---------------------------------------------------------------------------
-- Readiness, reported against the role that was actually protected.
--
-- Dropped rather than replaced: this gains an application_role column, and
-- CREATE OR REPLACE cannot change a function's return type.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.company_isolation_status();

CREATE OR REPLACE FUNCTION public.company_isolation_status()
RETURNS TABLE (
  connected_as      NAME,
  application_role  NAME,
  policies_active   BOOLEAN,
  role_bypasses_rls BOOLEAN,
  isolated          BOOLEAN,
  company_count     INTEGER,
  advice            TEXT
)
LANGUAGE sql STABLE AS $$
  SELECT
    current_user,
    cfg.application_role,
    public.company_policies_active(),
    public.role_bypasses_rls(),
    public.multi_company_enabled(),
    (SELECT COUNT(*)::int FROM companies WHERE deleted_at IS NULL),
    CASE
      WHEN NOT public.company_policies_active() THEN
        'Single-company mode: isolation policies are not active. This is correct and safe while only one company exists.'
      WHEN public.role_bypasses_rls() THEN
        format('Isolation policies are active, but this connection is %I, which bypasses row-level security and therefore sees every company. Expected application role is %s.',
               current_user, COALESCE(cfg.application_role::text, '(not recorded)'))
      WHEN cfg.application_role IS NOT NULL AND cfg.application_role <> current_user THEN
        format('Isolation is in effect for this connection (%I), though the recorded application role is %I.', current_user, cfg.application_role)
      ELSE
        format('Company isolation is in effect on this connection (%I).', current_user)
    END
  FROM company_isolation_config cfg WHERE cfg.id;
$$;

-- ---------------------------------------------------------------------------
-- The gate, restated once more.
--
-- A second company may be created when the policies are active AND the
-- creating connection is itself subject to them. That deliberately excludes a
-- superuser session: the role that cannot be isolated should not be the one
-- deciding that isolation is ready.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_company_insert() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL) < 1 THEN
    RETURN NEW;  -- first company, nothing to isolate from
  END IF;

  IF NOT public.company_policies_active() THEN
    RAISE EXCEPTION
      'Refusing to create a second company while isolation policies are off — both companies would share every table with nothing separating them. Run SELECT enable_multi_company(''your_app_role''); first.';
  END IF;

  IF public.role_bypasses_rls() THEN
    RAISE EXCEPTION
      'Refusing to create a second company from role %, which bypasses row-level security. Create it from the application''s own (unprivileged) connection, so the boundary is exercised by the same role that will enforce it.',
      current_user;
  END IF;

  RETURN NEW;
END $$;
