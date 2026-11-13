-- Which employees hold which role inside which application instance.
--
-- ===========================================================================
-- WHY THIS IS NOT users.role
-- ===========================================================================
-- EMBMIS already has a coarse platform role on `users` (ADMIN / MANAGER /
-- USER). It answers "may this person administer EMBMIS", which is a different
-- question from "is this person a quality reviewer in the Supplier Quality
-- application". An application declares its own roles — quality_engineer,
-- approver, supplier_manager — and those roles carry permissions, record scopes
-- and approval authority that mean nothing outside that application.
--
-- Mapping application roles onto the three platform ones would collapse every
-- application's security model into the same three buckets, which is exactly
-- what makes a generated application a real application rather than a screen:
-- segregation of duties inside one application has to be expressible without
-- touching anyone's EMBMIS-wide standing.
--
-- THE ADMIN FALLBACK
-- ---------------------------------------------------------------------------
-- A company ADMIN with no explicit assignment is treated by the runtime as
-- holding every INTERNAL role of every application their company has installed.
-- Without that, deploying an application would leave it unusable until someone
-- assigned themselves to it — including the person who just built it. The
-- fallback is internal-only and deliberate: it can never grant an external
-- role, because an external role is held by an external identity, which is not
-- a `users` row at all.

CREATE TABLE IF NOT EXISTS app_role_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  app_instance_id UUID NOT NULL REFERENCES app_company_instances(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  role_key        TEXT NOT NULL,

  granted_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at      TIMESTAMPTZ,

  CONSTRAINT chk_app_role_key CHECK (role_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  CONSTRAINT uq_app_role_assignment UNIQUE (app_instance_id, user_id, role_key)
);

CREATE INDEX IF NOT EXISTS idx_app_role_user ON app_role_assignments (user_id, app_instance_id);
CREATE INDEX IF NOT EXISTS idx_app_role_inst ON app_role_assignments (app_instance_id, role_key);

DO $$
DECLARE default_id UUID;
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN default_id := '11111111-1111-1111-1111-111111111111'::uuid; END IF;
  EXECUTE format(
    'ALTER TABLE app_role_assignments ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );
END $$;

INSERT INTO company_scoped_tables (table_name) VALUES ('app_role_assignments')
ON CONFLICT (table_name) DO NOTHING;

COMMENT ON TABLE app_role_assignments IS
  'An employee''s role inside one application instance. Application roles are the application''s own; they never widen anyone''s EMBMIS-wide standing.';
