-- External identities: the people who use an application from outside the
-- company that runs it.
--
-- ===========================================================================
-- WHY AN EXTERNAL USER IS NOT A USER ROW WITH A DIFFERENT ROLE
-- ===========================================================================
-- A supplier logging in to answer a quality finding, and a customer tracking a
-- warranty claim, are not employees with fewer permissions. They differ in a
-- way no role string can express:
--
--   • They are ANCHORED to a business record. A supplier user is the identity
--     of supplier 0f3a…; every row they may see is derived from that anchor,
--     not from a permission grant. "Supplier sees their own findings" is a
--     property of the identity, not of a role.
--   • Their access has a lifecycle a company controls from outside: invited,
--     accepted, suspended, revoked — with revocation needing to be instant and
--     total, not a role edit.
--   • They must never be reachable by any code path that assumes `users` means
--     "someone who works here". Every existing query in this product that says
--     `FROM users` was written under that assumption. Adding portal accounts to
--     that table would make each of those queries a question rather than a
--     fact.
--
-- So external identities live in their own table, authenticate through their
-- own path, and reach application data only through a portal membership that
-- names the instance, the surface, and the scope. The scope is derived by the
-- server from the identity's anchor; it is never supplied by the client.
--
-- The UI is not the security boundary. services/platform/runtime/authorization.js
-- turns a membership into a mandatory WHERE clause that the caller cannot see,
-- influence, or omit.

CREATE TABLE IF NOT EXISTS app_external_identities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- What this identity IS, in the company's own business terms.
  --   customer/supplier — anchored to a canonical EMBMIS record.
  --   partner           — anchored to nothing canonical yet; scope comes from
  --                       the membership.
  subject_kind   TEXT NOT NULL,
  -- The canonical record this identity speaks for: suppliers.id, customers.id.
  -- Untyped on purpose — a FK would have to name one table, and this column
  -- addresses several. Resolution and validation happen in the service layer,
  -- against the canonical entity catalogue.
  subject_id     UUID,

  email          TEXT NOT NULL,
  display_name   TEXT,

  -- Portal credentials. Separate from users.password_hash for the same reason
  -- the table is separate: a credential reset path that walks `users` must not
  -- be able to reach a portal account, and vice versa.
  password_hash  TEXT,
  invite_token_hash TEXT,
  invite_expires_at TIMESTAMPTZ,

  status         TEXT NOT NULL DEFAULT 'invited',
  last_login_at  TIMESTAMPTZ,
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,

  invited_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at     TIMESTAMPTZ,
  revoked_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_ext_identity_kind
    CHECK (subject_kind IN ('customer', 'supplier', 'partner', 'public')),
  CONSTRAINT chk_ext_identity_status
    CHECK (status IN ('invited', 'active', 'suspended', 'revoked')),
  CONSTRAINT chk_ext_identity_email CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

-- One identity per email per company. An email that is a customer in one
-- company and a supplier in another is two identities, which is correct: they
-- are two relationships with two different companies.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ext_identity_company_email
  ON app_external_identities (company_id, lower(email));

-- ---------------------------------------------------------------------------
-- Portal membership: which application, which surface, at what scope.
--
-- `scope` is computed by the server from the identity's anchor at grant time
-- and re-derived on every request. Storing it makes an audit possible ("what
-- could this identity see on 3 March?"); it is never read as the sole source of
-- truth for a live query, because an anchor that has since been revoked must
-- take effect immediately.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_portal_memberships (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  external_identity_id UUID NOT NULL REFERENCES app_external_identities(id) ON DELETE CASCADE,
  app_instance_id      UUID NOT NULL REFERENCES app_company_instances(id) ON DELETE CASCADE,

  surface_key          TEXT NOT NULL,
  role_key             TEXT NOT NULL,
  scope                JSONB NOT NULL DEFAULT '{}'::jsonb,

  status               TEXT NOT NULL DEFAULT 'active',
  granted_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at           TIMESTAMPTZ,

  CONSTRAINT chk_portal_membership_status CHECK (status IN ('active', 'suspended', 'revoked')),
  CONSTRAINT chk_portal_membership_surface CHECK (surface_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  CONSTRAINT chk_portal_membership_role CHECK (role_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  CONSTRAINT uq_portal_membership UNIQUE (external_identity_id, app_instance_id, surface_key)
);

-- Portal sessions. Short-lived, revocable server-side, and keyed by a hash so a
-- database dump does not hand out live sessions.
CREATE TABLE IF NOT EXISTS app_portal_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  external_identity_id UUID NOT NULL REFERENCES app_external_identities(id) ON DELETE CASCADE,
  token_hash           TEXT NOT NULL,
  issued_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at           TIMESTAMPTZ NOT NULL,
  revoked_at           TIMESTAMPTZ,
  user_agent           TEXT,

  CONSTRAINT uq_portal_session_token UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_ext_identity_company  ON app_external_identities (company_id, status);
CREATE INDEX IF NOT EXISTS idx_ext_identity_subject  ON app_external_identities (subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS idx_portal_membership_id  ON app_portal_memberships (external_identity_id, status);
CREATE INDEX IF NOT EXISTS idx_portal_membership_inst ON app_portal_memberships (app_instance_id, status);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_ident ON app_portal_sessions (external_identity_id, expires_at);

DO $$
DECLARE
  default_id UUID;
  t TEXT;
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;
  FOREACH t IN ARRAY ARRAY['app_external_identities', 'app_portal_memberships', 'app_portal_sessions'] LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
      t, default_id
    );
  END LOOP;
END $$;

INSERT INTO company_scoped_tables (table_name)
VALUES ('app_external_identities'), ('app_portal_memberships'), ('app_portal_sessions')
ON CONFLICT (table_name) DO NOTHING;

-- Back-references now that the identity table exists. Deferred from the core
-- migration so that neither file depends on the other's order.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_app_comments_external') THEN
    ALTER TABLE app_record_comments
      ADD CONSTRAINT fk_app_comments_external
      FOREIGN KEY (author_external_id) REFERENCES app_external_identities(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_app_attachments_external') THEN
    ALTER TABLE app_record_attachments
      ADD CONSTRAINT fk_app_attachments_external
      FOREIGN KEY (uploaded_by_external_id) REFERENCES app_external_identities(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_app_notifications_external') THEN
    ALTER TABLE app_notifications
      ADD CONSTRAINT fk_app_notifications_external
      FOREIGN KEY (recipient_external_id) REFERENCES app_external_identities(id) ON DELETE CASCADE;
  END IF;
END $$;

COMMENT ON TABLE app_external_identities IS
  'A person outside the company who uses one of its applications. Anchored to a canonical record (supplier/customer) rather than granted a role; revocation is immediate and total.';
COMMENT ON COLUMN app_portal_memberships.scope IS
  'Server-derived record visibility for this membership. Recorded for audit; re-derived from the identity anchor on every request, never trusted from the client.';
