-- 114 — Saved reports, scheduled distribution and dashboards.
--
-- The reporting problem in an ERP is not producing numbers — the ledger has
-- them — it is that every question anyone actually asks is slightly different
-- from the twelve reports that shipped. So this stores report *definitions*
-- rather than adding more hardcoded screens.
--
-- A definition is either:
--   BUILTIN — names an existing endpoint (trial balance, aged debt, project
--             P&L). No SQL is stored; the parameters are.
--   QUERY   — stores SQL, which is validated against the same allowlist
--             gauntlet as the natural-language query feature before it runs
--             (services/ai/nlQuery.js). That validator is deliberately reused
--             rather than reimplemented: a second query surface with its own
--             slightly different rules is how one of them ends up weaker, and
--             the weaker one is the one that gets found.
--
-- Storing SQL means a saved report is a stored, repeatedly-executed query, so
-- it is validated on save AND again on every run. Validating only on save
-- would leave rows written directly to the table — by a future migration, an
-- import, or anyone with table access — executing unchecked.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS report_definitions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           VARCHAR(200) NOT NULL,
  description    TEXT,
  category       VARCHAR(40) NOT NULL DEFAULT 'GENERAL',

  report_type    VARCHAR(20) NOT NULL DEFAULT 'QUERY'
                 CHECK (report_type IN ('QUERY','BUILTIN')),

  -- QUERY only. Always re-validated at run time.
  sql_text       TEXT,
  -- BUILTIN only: which packaged report, e.g. 'trial_balance'.
  builtin_key    VARCHAR(60),

  -- Declared parameters: [{name, label, type, default, required}]. Values are
  -- passed as bind parameters at run time and are never interpolated into the
  -- SQL text — the whole point of declaring them.
  parameters     JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- How to draw it: {type: 'table'|'bar'|'line'|'pie', x, y, ...}
  visualization  JSONB NOT NULL DEFAULT '{"type":"table"}'::jsonb,

  owner_id       UUID REFERENCES users(id),
  -- Shared reports are visible to everyone; private ones only to their owner.
  is_shared      BOOLEAN NOT NULL DEFAULT false,
  is_system      BOOLEAN NOT NULL DEFAULT false,

  company_id     UUID REFERENCES companies(id),

  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at     TIMESTAMPTZ,

  -- A definition must actually say what to run.
  CONSTRAINT chk_report_definition_body CHECK (
    (report_type = 'QUERY'   AND sql_text IS NOT NULL AND length(btrim(sql_text)) > 0) OR
    (report_type = 'BUILTIN' AND builtin_key IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_report_definitions_owner ON report_definitions (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_report_definitions_shared ON report_definitions (is_shared) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Scheduled distribution
-- ---------------------------------------------------------------------------
--
-- Interval-based rather than cron, matching the agent scheduler (see
-- services/agents/scheduler.js) — the same reasoning applies: ERP background
-- work is interval-shaped, and a cron parser is a dependency and a parsing
-- surface for no gain. `next_run_at` in the database rather than a timer in
-- memory is what makes this survive a restart without double-sending.

CREATE TABLE IF NOT EXISTS report_schedules (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_id         UUID NOT NULL REFERENCES report_definitions(id) ON DELETE CASCADE,
  name              VARCHAR(200),

  interval_seconds  INTEGER NOT NULL CHECK (interval_seconds >= 300),
  next_run_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_run_at       TIMESTAMPTZ,

  -- Values for the report's declared parameters.
  parameter_values  JSONB NOT NULL DEFAULT '{}'::jsonb,

  format            VARCHAR(10) NOT NULL DEFAULT 'CSV'
                    CHECK (format IN ('CSV','JSON','HTML')),
  recipients        TEXT[] NOT NULL DEFAULT '{}',

  enabled           BOOLEAN NOT NULL DEFAULT true,
  company_id        UUID REFERENCES companies(id),

  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Drives the scheduler's claim query.
CREATE INDEX IF NOT EXISTS idx_report_schedules_due
  ON report_schedules (next_run_at) WHERE enabled = true;

-- ---------------------------------------------------------------------------
-- Run history.
--
-- Kept for every run, scheduled or manual, because "the report I got on Monday
-- said something different" is unanswerable without it. Row counts and timings
-- are stored rather than the result set: results can be large, and a report
-- that reruns should be recomputed from current data, not replayed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_runs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_id       UUID NOT NULL REFERENCES report_definitions(id) ON DELETE CASCADE,
  schedule_id     UUID REFERENCES report_schedules(id) ON DELETE SET NULL,

  status          VARCHAR(20) NOT NULL DEFAULT 'SUCCESS'
                  CHECK (status IN ('SUCCESS','FAILED','TRUNCATED')),
  row_count       INTEGER,
  duration_ms     INTEGER,
  error           TEXT,

  parameter_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivered_to    TEXT[],

  run_by          UUID REFERENCES users(id),
  run_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_report_runs_report ON report_runs (report_id, run_at DESC);

-- ---------------------------------------------------------------------------
-- Dashboards
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dashboards (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(200) NOT NULL,
  description TEXT,
  owner_id    UUID REFERENCES users(id),
  is_shared   BOOLEAN NOT NULL DEFAULT false,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  company_id  UUID REFERENCES companies(id),
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dashboard_id  UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  report_id     UUID REFERENCES report_definitions(id) ON DELETE CASCADE,

  title         VARCHAR(200),
  widget_type   VARCHAR(20) NOT NULL DEFAULT 'TABLE'
                CHECK (widget_type IN ('TABLE','BAR','LINE','PIE','METRIC','TEXT')),

  -- Grid placement, 12 columns wide.
  position_x    SMALLINT NOT NULL DEFAULT 0 CHECK (position_x BETWEEN 0 AND 11),
  position_y    SMALLINT NOT NULL DEFAULT 0,
  width         SMALLINT NOT NULL DEFAULT 6 CHECK (width BETWEEN 1 AND 12),
  height        SMALLINT NOT NULL DEFAULT 4 CHECK (height BETWEEN 1 AND 20),

  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- A TEXT widget carries its own content; everything else must name a report.
  CONSTRAINT chk_widget_source CHECK (widget_type = 'TEXT' OR report_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_dashboard ON dashboard_widgets (dashboard_id);

COMMENT ON COLUMN report_definitions.sql_text IS
  'Validated against the nlQuery allowlist gauntlet on save AND on every run. Run-time validation is not redundant: rows can reach this table without passing through the save path.';
