-- 117 — AI platform meta-layer.
--
-- Until now the AI surface was fixed at deploy time: the tools it could call
-- lived in services/ai/toolRegistry.js and the agents that ran unattended lived
-- in services/agents/definitions/. Adding either meant a code change and a
-- deploy. These tables move that catalogue into the database so the people who
-- run the business can extend it — build an agent, build a tool, design a
-- document — without waiting on an engineer.
--
-- Two boundaries are deliberately preserved from the existing design, because
-- letting users author behaviour is exactly when they matter most:
--
--   1. A user-authored TOOL cannot write. It runs in a sandbox whose only
--      outward capabilities are read-only SQL (the nlQuery allowlist) and
--      read-only built-in tools. Writing is composed at the AGENT level, where
--      services/agents/authority.js already governs what may happen unattended.
--      That keeps "arbitrary code someone typed into a form" and "may change
--      the ledger" as two separate grants rather than one.
--
--   2. A user-authored AGENT is still just a row in agent_definitions as far as
--      the runtime is concerned. It inherits the advisory lock, the authority
--      envelope, escalation, the audit trail and auto-disable — none of which
--      are reimplemented here. agent_blueprints holds only the *declaration*;
--      agent_definitions continues to own operational state, so an agent built
--      by chat still ships disabled and must be granted autonomy explicitly.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- Custom AI tools
--
-- `implementation` is a JavaScript function body executed in a restricted
-- node:vm context (services/ai/sandbox.js). Node's vm is not a security
-- boundary against a determined attacker, so the real control is authorisation:
-- only ADMIN/MANAGER may create or edit a tool, every revision is retained
-- below with its author, and the sandbox has no filesystem, network, require or
-- process access to reach for in the first place.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_tools (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Same shape as a built-in tool name, because the model sees them in one flat
  -- namespace. Uniqueness against built-ins is enforced in the service layer,
  -- which is the only place that knows what the built-in names are.
  name           VARCHAR(64) NOT NULL UNIQUE
                 CHECK (name ~ '^[a-z][a-z0-9_]{2,63}$'),
  display_name   VARCHAR(160),

  -- The description is not documentation — it is the prompt fragment the model
  -- uses to decide whether to call this tool, so it is required.
  description    TEXT NOT NULL,

  input_schema   JSONB NOT NULL DEFAULT '{"type":"object","properties":{}}'::jsonb,
  output_schema  JSONB,

  implementation TEXT NOT NULL,

  enabled        BOOLEAN NOT NULL DEFAULT true,

  -- Sandbox envelope. A tool that hangs must fail its own call and nothing else.
  timeout_ms     INTEGER NOT NULL DEFAULT 5000 CHECK (timeout_ms BETWEEN 100 AND 30000),

  -- Which read-only built-in tools this tool may call through erp.callTool().
  -- Empty means none: deny-by-default, mirroring authority.allowed_actions.
  allowed_tools  TEXT[] NOT NULL DEFAULT '{}',
  allow_sql      BOOLEAN NOT NULL DEFAULT true,

  version        INTEGER NOT NULL DEFAULT 1,
  created_by     UUID REFERENCES users(id),
  updated_by     UUID REFERENCES users(id),

  -- Health, so a tool that always throws is visible without reading the audit log.
  run_count      INTEGER NOT NULL DEFAULT 0,
  error_count    INTEGER NOT NULL DEFAULT 0,
  last_run_at    TIMESTAMPTZ,
  last_error     TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_tools_enabled ON ai_tools (enabled, name);

-- Every revision, so an edit that breaks a tool can be rolled back rather than
-- reconstructed from memory. The snapshot is the whole tool, not a diff.
CREATE TABLE IF NOT EXISTS ai_tool_versions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tool_id     UUID NOT NULL REFERENCES ai_tools(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  snapshot    JSONB NOT NULL,
  note        TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tool_id, version)
);

-- ---------------------------------------------------------------------------
-- Agent blueprints — the declarative half of a user-created agent.
--
-- Operational state (enabled, mode, authority, schedule, next_run_at, failure
-- count) deliberately stays in agent_definitions. Splitting it this way means
-- editing what an agent DOES cannot accidentally change what it is ALLOWED to
-- do, and the scheduler needs no knowledge that blueprints exist.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_blueprints (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_key      VARCHAR(80) NOT NULL UNIQUE
                 CHECK (agent_key ~ '^[a-z][a-z0-9_]{2,79}$'),

  display_name   VARCHAR(160) NOT NULL,
  description    TEXT,
  domain         VARCHAR(40)  NOT NULL DEFAULT 'DATA',

  trigger_type   VARCHAR(16)  NOT NULL DEFAULT 'manual'
                 CHECK (trigger_type IN ('schedule', 'event', 'manual')),
  -- For trigger_type='event': the domain event that fires this agent.
  event_key      VARCHAR(80),
  -- Mirrors agent_definitions.schedule_seconds; kept here so an exported
  -- blueprint carries its intended cadence to another installation.
  schedule_seconds INTEGER,

  -- Ordered steps. Each: { id, tool, args, save_as, condition, on_error, note }.
  -- args may contain {{config.x}} / {{steps.y.z}} references, resolved at run
  -- time by services/agents/blueprintRunner.js.
  steps          JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Editable key/value tuning surfaced as the agent's config panel.
  config         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Declared shape of `config` for the UI: [{key,label,type,help,default}].
  config_schema  JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- The natural-language request this was generated from, when it was built by
  -- chat. Worth keeping: it is the only record of what the author actually
  -- asked for, as opposed to what the model produced.
  source_prompt  TEXT,

  version        INTEGER NOT NULL DEFAULT 1,
  created_by     UUID REFERENCES users(id),
  updated_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_blueprint_versions (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  blueprint_id UUID NOT NULL REFERENCES agent_blueprints(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  snapshot     JSONB NOT NULL,
  note         TEXT,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (blueprint_id, version)
);

-- ---------------------------------------------------------------------------
-- PDF templates — letterhead, colours and default layout for generated documents.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pdf_templates (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key          VARCHAR(64) NOT NULL UNIQUE
               CHECK (key ~ '^[a-z][a-z0-9_]{2,63}$'),
  name         VARCHAR(160) NOT NULL,
  description  TEXT,

  page_size    VARCHAR(12) NOT NULL DEFAULT 'A4',
  orientation  VARCHAR(10) NOT NULL DEFAULT 'portrait'
               CHECK (orientation IN ('portrait', 'landscape')),
  margin       INTEGER NOT NULL DEFAULT 50 CHECK (margin BETWEEN 10 AND 150),

  -- { show_company, title, subtitle, logo_url }
  header       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- { text, show_page_numbers, show_generated_at }
  footer       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- { primary, text, muted, border, band }
  colors       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- { family, base_size, heading_size }
  fonts        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Optional default body: the same section array generate_pdf_report accepts,
  -- so a template can be a whole document with {{placeholders}}, not just a skin.
  sections     JSONB NOT NULL DEFAULT '[]'::jsonb,

  is_builtin   BOOLEAN NOT NULL DEFAULT false,
  version      INTEGER NOT NULL DEFAULT 1,
  created_by   UUID REFERENCES users(id),
  updated_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pdf_template_versions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id UUID NOT NULL REFERENCES pdf_templates(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  snapshot    JSONB NOT NULL,
  note        TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (template_id, version)
);

-- ---------------------------------------------------------------------------
-- Generated documents.
--
-- A PDF produced by the AI has to be fetchable later — from a chat transcript,
-- from a run history row, from an email. The bytes live on disk; this row is
-- the permission check and the provenance. There is deliberately no unguessable
-- URL token: downloads go through the authenticated API so a link pasted into a
-- ticket does not become a credential.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS generated_documents (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title         VARCHAR(200) NOT NULL,
  kind          VARCHAR(40)  NOT NULL DEFAULT 'report',
  template_key  VARCHAR(64),

  file_name     VARCHAR(255) NOT NULL,
  storage_path  TEXT NOT NULL,
  byte_size     INTEGER NOT NULL DEFAULT 0,
  sha256        VARCHAR(64),

  -- Who/what produced it. agent_run_id ties a document to the unattended run
  -- that created it, which is what makes an emailed report auditable.
  created_by    UUID REFERENCES users(id),
  agent_run_id  UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  company_id    UUID REFERENCES companies(id),

  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_generated_documents_creator ON generated_documents (created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_documents_run     ON generated_documents (agent_run_id);

-- ---------------------------------------------------------------------------
-- Global AI settings — one row.
--
-- The CHECK (id) with a BOOLEAN primary key is the standard single-row idiom:
-- there is exactly one global configuration and the database enforces it, so no
-- code path has to guess which row is the real one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_settings (
  id                 BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),

  -- NULL means "use AI_MODEL from the environment" — a UI override should not
  -- be indistinguishable from the deployment default.
  model              VARCHAR(80),
  response_style     VARCHAR(24) NOT NULL DEFAULT 'balanced'
                     CHECK (response_style IN ('concise', 'balanced', 'detailed')),
  default_agent_mode VARCHAR(24) NOT NULL DEFAULT 'accept_edits'
                     CHECK (default_agent_mode IN ('manual', 'accept_edits', 'auto', 'bypass')),
  max_steps          INTEGER NOT NULL DEFAULT 8 CHECK (max_steps BETWEEN 1 AND 30),

  -- Highest agent mode each role may select, e.g. {"USER":"manual","MANAGER":"auto"}.
  role_permissions   JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra              JSONB NOT NULL DEFAULT '{}'::jsonb,

  updated_by         UUID REFERENCES users(id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO ai_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Per-tool settings, for built-in and custom tools alike.
--
-- `defaults` are merged UNDER the model's arguments, never over them: a default
-- is a starting point for a tool the model called without saying much, not a way
-- to silently rewrite an argument it did choose.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_tool_settings (
  tool_name   VARCHAR(64) PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  defaults    JSONB   NOT NULL DEFAULT '{}'::jsonb,
  -- NULL = any authenticated user. Otherwise the minimum role, checked against
  -- the same ladder middleware/auth.js uses.
  min_role    VARCHAR(32),
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Default PDF template, so document generation works before anyone configures
-- anything. is_builtin marks it undeletable rather than uneditable.
-- ---------------------------------------------------------------------------
INSERT INTO pdf_templates (key, name, description, header, footer, colors, fonts, is_builtin)
VALUES (
  'standard_report',
  'Standard report',
  'Default letterhead used when no template is specified.',
  '{"show_company": true, "subtitle": ""}'::jsonb,
  '{"show_page_numbers": true, "show_generated_at": true, "text": ""}'::jsonb,
  '{"primary": "#2563eb", "text": "#111827", "muted": "#6b7280", "border": "#e5e7eb", "band": "#f3f4f6"}'::jsonb,
  '{"family": "Helvetica", "base_size": 10, "heading_size": 14}'::jsonb,
  true
)
ON CONFLICT (key) DO NOTHING;
