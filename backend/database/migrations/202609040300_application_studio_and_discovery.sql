-- The Studio's own state, and Capability Discovery's.
--
-- ===========================================================================
-- STUDIO SESSIONS
-- ===========================================================================
-- A Studio session is a conversation that produces application versions. It is
-- not a chat log with a build attached: each assistant turn that changes the
-- design points at the application_versions row it produced, so "what did the
-- system actually build when I asked for a risk trend?" is answerable by
-- joining, not by re-reading prose.
--
-- Sessions are company-scoped because the requirement — "we need to track
-- supplier quality" — is a statement about a company's business, even when the
-- application it produces ends up reusable.

CREATE TABLE IF NOT EXISTS app_studio_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  application_id UUID REFERENCES applications(id) ON DELETE SET NULL,

  title          TEXT NOT NULL,
  requirement    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'planning',

  -- The plan the user is shown before anything is built: which canonical
  -- entities were found, what new data is needed, which surfaces, which
  -- screens, which workflow.
  plan           JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_studio_session_status
    CHECK (status IN ('planning', 'building', 'preview', 'iterating', 'deploying', 'deployed', 'abandoned', 'failed'))
);

CREATE TABLE IF NOT EXISTS app_studio_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  session_id   UUID NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,

  role         TEXT NOT NULL,
  -- message | plan | build | validation | deployment | error
  kind         TEXT NOT NULL DEFAULT 'message',
  content      TEXT NOT NULL DEFAULT '',
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  version_id   UUID REFERENCES application_versions(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_studio_message_role CHECK (role IN ('user', 'assistant', 'system')),
  CONSTRAINT chk_studio_message_kind
    CHECK (kind IN ('message', 'plan', 'build', 'validation', 'deployment', 'error'))
);

-- ===========================================================================
-- CAPABILITY DISCOVERY
-- ===========================================================================
-- Discovery watches for business signals that no existing application serves,
-- and proposes one. It NEVER deploys: the strongest thing it can do is put a
-- row in this table for a person to accept.
--
-- Signals are aggregated deterministically before any model is asked anything —
-- an LLM call per database mutation would be both ruinous and useless. The
-- pipeline is: domain events -> counted signals -> a threshold crossed ->
-- deduplicated against open opportunities -> only then an analysis.
CREATE TABLE IF NOT EXISTS app_discovery_signals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  signal_key   TEXT NOT NULL,
  subject      TEXT,
  observations INTEGER NOT NULL DEFAULT 1,
  weight       NUMERIC(10,4) NOT NULL DEFAULT 1,
  evidence     JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_discovery_signal UNIQUE (company_id, signal_key, subject)
);

CREATE TABLE IF NOT EXISTS capability_opportunities (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  title                   TEXT NOT NULL,
  description             TEXT NOT NULL,
  reason                  TEXT NOT NULL,
  evidence                JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence              NUMERIC(4,3) NOT NULL DEFAULT 0.5,

  source_signal           TEXT NOT NULL,
  -- A stable digest of what this opportunity is about, so the same recurring
  -- problem does not produce a new proposal every scan.
  dedupe_key              TEXT NOT NULL,

  existing_capabilities   JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_capability      TEXT,
  requires_new_data_model BOOLEAN NOT NULL DEFAULT false,

  status                  TEXT NOT NULL DEFAULT 'detected',
  application_id          UUID REFERENCES applications(id) ON DELETE SET NULL,
  version_id              UUID REFERENCES application_versions(id) ON DELETE SET NULL,
  studio_session_id       UUID REFERENCES app_studio_sessions(id) ON DELETE SET NULL,

  reviewed_at             TIMESTAMPTZ,
  reviewed_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_opportunity_status
    CHECK (status IN ('detected', 'proposed', 'dismissed', 'accepted', 'converted', 'expired')),
  CONSTRAINT chk_opportunity_confidence CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT uq_opportunity_dedupe UNIQUE (company_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_studio_sessions_company ON app_studio_sessions (company_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_messages_session ON app_studio_messages (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_discovery_signals_co    ON app_discovery_signals (company_id, signal_key);
CREATE INDEX IF NOT EXISTS idx_opportunities_company   ON capability_opportunities (company_id, status, created_at DESC);

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
    'app_studio_sessions', 'app_studio_messages', 'app_discovery_signals', 'capability_opportunities'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
      t, default_id
    );
  END LOOP;
END $$;

INSERT INTO company_scoped_tables (table_name)
VALUES ('app_studio_sessions'), ('app_studio_messages'), ('app_discovery_signals'), ('capability_opportunities')
ON CONFLICT (table_name) DO NOTHING;

COMMENT ON TABLE capability_opportunities IS
  'A capability the business appears to need and no installed application provides. Discovery writes these; only a person converts one into an application. Nothing here deploys anything.';
