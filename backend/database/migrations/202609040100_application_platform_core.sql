-- The application platform: a global application registry, per-company
-- instances, and the physical-table registry that binds the two.
--
-- ===========================================================================
-- WHAT CHANGES, AND WHY THE PREVIOUS SHAPE COULD NOT STAY
-- ===========================================================================
-- The first pass at this modelled an application as a company-scoped row
-- (`apps`, keyed on (company_id, app_key)) whose entities pointed at ordinary
-- shared tables — `supplier_shipments`, `vehicles` — that every company wrote
-- into, separated only by a company_id column. That is fine for a table the
-- product ships with. It is the wrong shape for a table the product INVENTS,
-- for three reasons:
--
--   1. The application definition and the application's data have different
--      lifetimes and different owners. "Supplier Quality Management" is a
--      design; it should be installable by any number of companies. The
--      findings ACME records under it are ACME's alone.
--   2. A shared physical table forces every installing company onto one
--      schema. The second company that needs one more column has nowhere to
--      put it that does not change the first company's table.
--   3. Isolation rests entirely on nobody ever forgetting a WHERE clause.
--
-- So the model splits in three:
--
--     applications              the global definition. One row per design.
--     application_versions      that design over time. Immutable snapshots.
--     app_company_instances     "company X has an instance of application Y".
--     app_instance_tables       "instance I's logical entity E lives in
--                                physical table T". AUTHORITATIVE.
--
-- The runtime never accepts a table name from a caller. It accepts an
-- application key and a logical entity key, and resolves the physical table
-- through app_instance_tables. That registry is the only mapping that exists.
--
-- WHY `applications` IS NOT COMPANY-SCOPED
-- ---------------------------------------------------------------------------
-- Deliberately absent from company_scoped_tables: an application definition
-- has no company_id, because it belongs to no single company. Visibility is
-- enforced above the database, in services/platform/registry.js, which never
-- lists a private application outside its origin company or the companies
-- holding an instance of it. Everything that CARRIES DATA — instances, table
-- registry, deployments, workflow history, comments — is company-scoped and
-- gets the standard RLS policy.

-- ---------------------------------------------------------------------------
-- 1. The global application definition.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Globally unique now, not per-company: the key names a design, and two
  -- companies running "supplier_quality" are running the same design.
  app_key           TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  icon              TEXT,
  category          TEXT,

  -- native    — ships with EMBMIS, implemented in hand-written code.
  -- generated — designed by the Studio; has no code of its own at all.
  kind              TEXT NOT NULL DEFAULT 'generated',
  status            TEXT NOT NULL DEFAULT 'draft',

  -- private — only the origin company and companies holding an instance may
  --           see it. shared/global widen that; nothing sets them yet, but the
  --           column is what makes an internal application marketplace a
  --           policy change rather than a migration.
  visibility        TEXT NOT NULL DEFAULT 'private',
  origin_company_id UUID REFERENCES companies(id) ON DELETE SET NULL,

  -- The published version. FK added after application_versions exists.
  current_version_id UUID,

  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_applications_key   CHECK (app_key ~ '^[a-z][a-z0-9_]{2,47}$'),
  CONSTRAINT chk_applications_kind  CHECK (kind IN ('native', 'generated')),
  CONSTRAINT chk_applications_status
    CHECK (status IN ('draft', 'published', 'deprecated', 'archived')),
  CONSTRAINT chk_applications_visibility
    CHECK (visibility IN ('private', 'shared', 'global')),
  CONSTRAINT uq_applications_key UNIQUE (app_key)
);

-- ---------------------------------------------------------------------------
-- 2. Versions. An application definition is never edited in place.
--
-- Every Studio iteration produces a NEW row here. That is what makes "add a
-- 90-day risk trend" a diffable change against a known parent rather than a
-- regeneration, and what lets a deployment record exactly which definition it
-- put into production.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_versions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL,
  parent_version_id UUID REFERENCES application_versions(id) ON DELETE SET NULL,

  -- The declarative application specification. The ONLY thing the AI produces.
  spec              JSONB NOT NULL,
  -- sha256 of the canonical serialization. Two versions with the same hash are
  -- the same design, which is how an iteration that changed nothing is caught.
  spec_hash         TEXT NOT NULL,

  status            TEXT NOT NULL DEFAULT 'draft',
  validation        JSONB,
  change_summary    TEXT,

  -- Provenance: enough to reproduce the decision that produced this version.
  -- model, prompt digest, policy version, tool versions, the canonical entities
  -- that were visible at design time.
  authored_by       TEXT NOT NULL DEFAULT 'ai',
  provenance        JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_app_versions_status
    CHECK (status IN ('draft', 'validated', 'published', 'superseded', 'rejected')),
  CONSTRAINT chk_app_versions_author CHECK (authored_by IN ('ai', 'human', 'system')),
  CONSTRAINT chk_app_versions_number CHECK (version >= 1),
  CONSTRAINT uq_app_versions UNIQUE (application_id, version)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_applications_current_version'
  ) THEN
    ALTER TABLE applications
      ADD CONSTRAINT fk_applications_current_version
      FOREIGN KEY (current_version_id)
      REFERENCES application_versions(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. "Company X has an instance of application Y."
--
-- table_prefix is computed by the server (services/platform/identifiers.js)
-- from the application id and company id and is stored so it can never drift:
-- once tables exist under a prefix, recomputing it differently would orphan
-- them. It is written once, at install.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_company_instances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- The version this company is actually running, which is not necessarily the
  -- application's current_version_id: an upgrade is a per-company decision.
  version_id      UUID REFERENCES application_versions(id) ON DELETE RESTRICT,

  status          TEXT NOT NULL DEFAULT 'installing',
  table_prefix    TEXT NOT NULL,

  settings        JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

  installed_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  installed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_app_instances_status
    CHECK (status IN ('installing', 'active', 'updating', 'paused', 'failed', 'uninstalled')),
  CONSTRAINT chk_app_instances_prefix CHECK (table_prefix ~ '^app_[a-z0-9_]{1,40}$'),
  CONSTRAINT uq_app_instances UNIQUE (application_id, company_id)
);

-- ---------------------------------------------------------------------------
-- 4. The authoritative logical-entity → physical-table mapping.
--
-- Nothing else in the system is allowed to name a generated table. A caller
-- supplies `findings`; this table says that means
-- public."app_7fa2c81d_findings", and only for the instance it belongs to.
--
-- The UNIQUE on (table_schema, table_name) is not decoration: it is the
-- database refusing to let two instances ever claim the same physical table,
-- whatever a bug upstream might compute.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_instance_tables (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  app_instance_id           UUID NOT NULL REFERENCES app_company_instances(id) ON DELETE CASCADE,

  entity_key                TEXT NOT NULL,
  table_schema              TEXT NOT NULL DEFAULT 'public',
  table_name                TEXT NOT NULL,
  -- The fully-qualified, already-quoted identifier. Stored rather than rebuilt
  -- so that the string that reaches SQL is the string that was validated.
  physical_table_identifier TEXT NOT NULL,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_app_instance_tables_entity CHECK (entity_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  CONSTRAINT chk_app_instance_tables_name   CHECK (table_name ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT chk_app_instance_tables_schema CHECK (table_schema ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT uq_app_instance_tables_entity  UNIQUE (app_instance_id, entity_key),
  CONSTRAINT uq_app_instance_tables_physical UNIQUE (table_schema, table_name)
);

-- ---------------------------------------------------------------------------
-- 5. Deployments. One row per attempt to move an instance to a version.
--
-- Keeps the migration plan, the validation report it was approved against, and
-- the failure if there was one — so a failed deployment can be inspected and
-- retried rather than guessed at.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_deployments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  application_id   UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  app_instance_id  UUID REFERENCES app_company_instances(id) ON DELETE SET NULL,

  from_version_id  UUID REFERENCES application_versions(id) ON DELETE SET NULL,
  to_version_id    UUID NOT NULL REFERENCES application_versions(id) ON DELETE RESTRICT,

  status           TEXT NOT NULL DEFAULT 'planned',
  -- safe      — additive only; may proceed on an ordinary approval.
  -- review    — behaviour- or security-sensitive; needs explicit acknowledgement.
  -- destructive — drops or narrows data; needs explicit acknowledgement AND an
  --               operator who named the destructive steps.
  safety           TEXT NOT NULL DEFAULT 'safe',

  plan             JSONB NOT NULL DEFAULT '[]'::jsonb,
  validation       JSONB,
  -- The hash of the plan the approver actually saw. Re-planning before apply
  -- must produce the same hash or the approval is void.
  plan_hash        TEXT,

  requested_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at      TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  attempt          INTEGER NOT NULL DEFAULT 1,
  error            TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_app_deployments_status
    CHECK (status IN ('planned', 'awaiting_approval', 'applying', 'deployed', 'failed', 'rolled_back', 'cancelled')),
  CONSTRAINT chk_app_deployments_safety
    CHECK (safety IN ('safe', 'review', 'destructive'))
);

-- ---------------------------------------------------------------------------
-- 6. Platform events — the observability spine.
--
-- Application creation, version, modification, schema deployment, migration,
-- permission change, workflow change, external-visibility change, approval,
-- failure, rollback, AI proposal, human approval. One table, one shape,
-- queryable per application.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_platform_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  application_id   UUID REFERENCES applications(id) ON DELETE SET NULL,
  app_instance_id  UUID REFERENCES app_company_instances(id) ON DELETE SET NULL,
  version_id       UUID REFERENCES application_versions(id) ON DELETE SET NULL,
  deployment_id    UUID REFERENCES app_deployments(id) ON DELETE SET NULL,

  event_type       TEXT NOT NULL,
  -- Which layer of the provenance chain this record belongs to. Keeping the
  -- distinction explicit is what stops a simulation reading later like an
  -- execution.
  provenance_class TEXT NOT NULL DEFAULT 'execution',
  actor_kind       TEXT NOT NULL DEFAULT 'system',
  actor_id         TEXT,
  summary          TEXT NOT NULL,
  detail           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_app_events_actor
    CHECK (actor_kind IN ('user', 'ai', 'system', 'external')),
  CONSTRAINT chk_app_events_provenance
    CHECK (provenance_class IN ('observation', 'decision', 'simulation', 'authorization', 'execution', 'outcome'))
);

-- ---------------------------------------------------------------------------
-- 7. Workflow history.
--
-- This is platform metadata about application records, not application data:
-- its shape (which record moved from which state to which, when, by whom) is
-- identical for every application that will ever exist, and it is written by
-- the runtime rather than by the application's own schema. So it lives in one
-- company-scoped table rather than in a per-instance one — the same reasoning
-- that puts audit_log in one table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_workflow_transitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  app_instance_id UUID NOT NULL REFERENCES app_company_instances(id) ON DELETE CASCADE,
  entity_key      TEXT NOT NULL,
  record_id       UUID NOT NULL,
  workflow_key    TEXT NOT NULL,
  from_state      TEXT,
  to_state        TEXT NOT NULL,
  transition_key  TEXT,
  actor_kind      TEXT NOT NULL DEFAULT 'user',
  actor_id        TEXT,
  surface_key     TEXT,
  reason          TEXT,
  context         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_app_wf_actor CHECK (actor_kind IN ('user', 'ai', 'system', 'external'))
);

-- ---------------------------------------------------------------------------
-- 8. Comments and attachments against any application record.
--
-- Same argument as workflow history: uniform shape, written by the runtime.
-- `visibility` is the load-bearing column — an internal note on a finding must
-- not reach the supplier looking at that same finding in their portal.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_record_comments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  app_instance_id      UUID NOT NULL REFERENCES app_company_instances(id) ON DELETE CASCADE,
  entity_key           TEXT NOT NULL,
  record_id            UUID NOT NULL,
  body                 TEXT NOT NULL,
  visibility           TEXT NOT NULL DEFAULT 'internal',
  author_kind          TEXT NOT NULL DEFAULT 'user',
  author_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  author_external_id   UUID,
  author_label         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_app_comment_visibility CHECK (visibility IN ('internal', 'shared')),
  CONSTRAINT chk_app_comment_author CHECK (author_kind IN ('user', 'ai', 'system', 'external'))
);

CREATE TABLE IF NOT EXISTS app_record_attachments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  app_instance_id      UUID NOT NULL REFERENCES app_company_instances(id) ON DELETE CASCADE,
  entity_key           TEXT NOT NULL,
  record_id            UUID NOT NULL,
  file_name            TEXT NOT NULL,
  content_type         TEXT,
  byte_size            BIGINT,
  storage_key          TEXT NOT NULL,
  visibility           TEXT NOT NULL DEFAULT 'internal',
  uploaded_by_kind     TEXT NOT NULL DEFAULT 'user',
  uploaded_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  uploaded_by_external_id UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_app_attachment_visibility CHECK (visibility IN ('internal', 'shared')),
  CONSTRAINT chk_app_attachment_uploader CHECK (uploaded_by_kind IN ('user', 'ai', 'system', 'external'))
);

-- ---------------------------------------------------------------------------
-- 9. Automation runs and application notifications.
--
-- `depth` and `root_run_id` are the loop protection: an automation whose action
-- writes a record that triggers the same automation gets a bounded chain, and
-- the bound is recorded rather than assumed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_automation_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  app_instance_id UUID NOT NULL REFERENCES app_company_instances(id) ON DELETE CASCADE,
  automation_key  TEXT NOT NULL,
  trigger_kind    TEXT NOT NULL,
  trigger_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'running',
  actions         JSONB NOT NULL DEFAULT '[]'::jsonb,
  depth           INTEGER NOT NULL DEFAULT 0,
  root_run_id     UUID,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at     TIMESTAMPTZ,

  CONSTRAINT chk_app_automation_status
    CHECK (status IN ('running', 'succeeded', 'failed', 'skipped', 'suppressed')),
  CONSTRAINT chk_app_automation_trigger
    CHECK (trigger_kind IN ('record_created', 'record_updated', 'state_changed', 'schedule', 'manual'))
);

CREATE TABLE IF NOT EXISTS app_notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  app_instance_id   UUID NOT NULL REFERENCES app_company_instances(id) ON DELETE CASCADE,
  recipient_kind    TEXT NOT NULL DEFAULT 'user',
  recipient_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  recipient_external_id UUID,
  recipient_role    TEXT,
  subject           TEXT NOT NULL,
  body              TEXT,
  entity_key        TEXT,
  record_id         UUID,
  read_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_app_notification_recipient
    CHECK (recipient_kind IN ('user', 'role', 'external'))
);

-- ---------------------------------------------------------------------------
-- Indexes.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_applications_status      ON applications (status, kind);
CREATE INDEX IF NOT EXISTS idx_applications_origin      ON applications (origin_company_id);
CREATE INDEX IF NOT EXISTS idx_app_versions_app         ON application_versions (application_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_app_instances_company    ON app_company_instances (company_id, status);
CREATE INDEX IF NOT EXISTS idx_app_instances_app        ON app_company_instances (application_id);
CREATE INDEX IF NOT EXISTS idx_app_instance_tables_inst ON app_instance_tables (app_instance_id);
CREATE INDEX IF NOT EXISTS idx_app_instance_tables_co   ON app_instance_tables (company_id);
CREATE INDEX IF NOT EXISTS idx_app_deployments_instance ON app_deployments (app_instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_deployments_company  ON app_deployments (company_id, status);
CREATE INDEX IF NOT EXISTS idx_app_events_app           ON app_platform_events (application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_events_company       ON app_platform_events (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_wf_record            ON app_workflow_transitions (app_instance_id, entity_key, record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_comments_record      ON app_record_comments (app_instance_id, entity_key, record_id, created_at);
CREATE INDEX IF NOT EXISTS idx_app_attachments_record   ON app_record_attachments (app_instance_id, entity_key, record_id, created_at);
CREATE INDEX IF NOT EXISTS idx_app_automation_instance  ON app_automation_runs (app_instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_notifications_user   ON app_notifications (recipient_user_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_notifications_ext    ON app_notifications (recipient_external_id, read_at, created_at DESC);

-- ---------------------------------------------------------------------------
-- Company isolation for everything that carries company data.
--
-- `applications` and `application_versions` are absent on purpose (see header).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  default_id UUID;
  t TEXT;
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'app_company_instances', 'app_instance_tables', 'app_deployments',
    'app_platform_events', 'app_workflow_transitions', 'app_record_comments',
    'app_record_attachments', 'app_automation_runs', 'app_notifications'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
      t, default_id
    );
  END LOOP;
END $$;

INSERT INTO company_scoped_tables (table_name)
VALUES
  ('app_company_instances'), ('app_instance_tables'), ('app_deployments'),
  ('app_platform_events'), ('app_workflow_transitions'), ('app_record_comments'),
  ('app_record_attachments'), ('app_automation_runs'), ('app_notifications')
ON CONFLICT (table_name) DO NOTHING;

COMMENT ON TABLE applications IS
  'The global definition of an application. Not company-scoped: a design belongs to no single company. Data belongs to app_company_instances.';
COMMENT ON TABLE application_versions IS
  'Immutable snapshots of an application specification. Studio iterations append; nothing is edited in place.';
COMMENT ON TABLE app_company_instances IS
  'One company''s installation of one application. Owns that company''s physical tables via app_instance_tables.';
COMMENT ON TABLE app_instance_tables IS
  'AUTHORITATIVE logical-entity to physical-table mapping. The runtime resolves every table name through this and accepts none from a caller.';
