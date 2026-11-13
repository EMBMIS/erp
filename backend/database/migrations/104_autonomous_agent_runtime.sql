-- 104 — Autonomous agent runtime.
--
-- Until now every AI action in this system required a human to type into a chat
-- box: services/ai/agent.js is invoked only from a chat/insight surface. That
-- makes the AI reactive. These tables are what let an agent run unattended —
-- monitor on a schedule, decide, and act — while remaining accountable.
--
-- The design problem with an unattended agent is not capability, it is
-- authority. An agent that can act without a human present must have a ceiling
-- it cannot cross, and everything above that ceiling has to become a request
-- rather than an action. That is what agent_definitions.authority encodes and
-- what agent_escalations records.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- Registered agents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_definitions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_key        VARCHAR(80)  NOT NULL UNIQUE,   -- stable code identifier
  display_name     VARCHAR(160) NOT NULL,
  description      TEXT,
  domain           VARCHAR(40)  NOT NULL,          -- FINANCE | PROCUREMENT | SALES | INVENTORY | HR | DATA

  -- Execution mode. Deliberately ordered by how much the agent may do alone:
  --   observe : detect and record findings only. Never writes business data.
  --   propose : may create DRAFT records and escalations for humans to approve.
  --   act     : may perform real, bounded actions within its authority limits.
  -- Default is the cautious one; making an agent autonomous is an explicit act.
  mode             VARCHAR(16)  NOT NULL DEFAULT 'observe'
                   CHECK (mode IN ('observe', 'propose', 'act')),

  enabled          BOOLEAN      NOT NULL DEFAULT false,

  -- Interval scheduling. NULL interval = manual/triggered only.
  schedule_seconds INTEGER,
  next_run_at      TIMESTAMPTZ,
  last_run_at      TIMESTAMPTZ,

  -- Authority envelope, e.g.
  --   { "max_amount": 5000, "currency": "USD", "max_actions_per_run": 25,
  --     "allowed_actions": ["send_dunning", "reconcile_exact_match"] }
  -- A value above max_amount does not fail — it escalates.
  authority        JSONB        NOT NULL DEFAULT '{}'::jsonb,

  -- Free-form per-agent tuning (thresholds, windows).
  config           JSONB        NOT NULL DEFAULT '{}'::jsonb,

  -- Consecutive failures; the runtime disables an agent that keeps failing so a
  -- broken agent cannot hammer the database on a schedule forever.
  failure_count    INTEGER      NOT NULL DEFAULT 0,
  last_error       TEXT,

  created_at       TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_definitions_due
  ON agent_definitions (next_run_at)
  WHERE enabled = true;

-- ---------------------------------------------------------------------------
-- Run history. One row per execution, durable across restarts (unlike the
-- in-memory pause map in services/ai/agent.js).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_runs (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id          UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  agent_key         VARCHAR(80) NOT NULL,

  trigger           VARCHAR(24) NOT NULL DEFAULT 'schedule'
                    CHECK (trigger IN ('schedule', 'manual', 'event', 'chain')),
  triggered_by      UUID REFERENCES users(id),

  status            VARCHAR(20) NOT NULL DEFAULT 'RUNNING'
                    CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL', 'SKIPPED')),

  -- Mode actually used for this run — an agent's mode can change between runs,
  -- so the run must record what it was allowed to do at the time.
  mode              VARCHAR(16) NOT NULL,
  dry_run           BOOLEAN     NOT NULL DEFAULT false,

  observations      INTEGER     NOT NULL DEFAULT 0,  -- things detected
  actions_taken     INTEGER     NOT NULL DEFAULT 0,  -- things actually done
  escalations       INTEGER     NOT NULL DEFAULT 0,  -- handed to a human
  errors            INTEGER     NOT NULL DEFAULT 0,

  summary           TEXT,
  error             TEXT,

  started_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at       TIMESTAMPTZ,
  duration_ms       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent   ON agent_runs (agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status  ON agent_runs (status, started_at DESC);

-- ---------------------------------------------------------------------------
-- Every individual decision and action, with its reasoning.
--
-- This is the audit trail the AI itself can analyse: each row states what was
-- observed, what was decided, why, and what happened. An agent that acted must
-- be answerable for each action separately, not just for the run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_run_actions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id        UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  agent_key     VARCHAR(80) NOT NULL,

  sequence      INTEGER NOT NULL,
  action_type   VARCHAR(60) NOT NULL,     -- e.g. send_dunning, reconcile_match

  entity_type   VARCHAR(60),
  entity_id     UUID,
  entity_label  VARCHAR(200),             -- human-readable, survives entity deletion

  amount        DECIMAL(15,2),
  currency      VARCHAR(3),

  -- What the agent concluded and why. `rationale` is written by the agent's own
  -- deterministic logic, not by a language model, so it is reproducible.
  decision      VARCHAR(24) NOT NULL
                CHECK (decision IN ('acted', 'proposed', 'escalated', 'skipped', 'failed', 'observed')),
  rationale     TEXT NOT NULL,

  outcome       JSONB,
  error         TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_run_actions_run    ON agent_run_actions (run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_agent_run_actions_entity ON agent_run_actions (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_actions_type   ON agent_run_actions (action_type, created_at DESC);

-- ---------------------------------------------------------------------------
-- Escalations: what the agent decided it was NOT authorised to do.
--
-- This table is the point of the whole design. An autonomous agent that hits
-- its ceiling must produce a request for a human rather than either acting
-- anyway or silently dropping the work.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_escalations (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id         UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  agent_key      VARCHAR(80) NOT NULL,

  reason         VARCHAR(40) NOT NULL,   -- AMOUNT_ABOVE_AUTHORITY | ACTION_NOT_PERMITTED | AMBIGUOUS | MODE_RESTRICTED
  title          VARCHAR(200) NOT NULL,
  detail         TEXT NOT NULL,
  proposed_action VARCHAR(60),

  entity_type    VARCHAR(60),
  entity_id      UUID,
  amount         DECIMAL(15,2),
  currency       VARCHAR(3),

  status         VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN', 'APPROVED', 'REJECTED', 'EXPIRED')),
  resolved_by    UUID REFERENCES users(id),
  resolved_at    TIMESTAMPTZ,
  resolution_note TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_escalations_open
  ON agent_escalations (status, created_at DESC);

-- Stop the same escalation being raised on every scheduled run. A repeat of an
-- unresolved escalation for the same entity+action is noise, not new
-- information.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_escalations_dedupe
  ON agent_escalations (agent_key, entity_type, entity_id, proposed_action)
  WHERE status = 'OPEN';
