-- 118 — AI-powered agents: reasoning loops, credentials, memory.
--
-- Migration 117 gave users agents made of ordered tool calls. That is a good
-- shape for "every Monday, email exactly this report" and a bad shape for
-- "analyse overdue accounts, work out which are actually at risk, and write to
-- the ones that need it" — because the second cannot be enumerated in advance.
-- The step list has to be decided while the work is happening, by something
-- that can read what it found and change its mind.
--
-- So an agent becomes a model in a loop: a goal, a set of tools it may use, and
-- an LLM that reasons, calls tools, reads results and decides what to do next —
-- the same loop the chat assistant runs, but unattended and on a schedule.
--
-- What does NOT change, and is the reason this is safe to do at all:
--
--   • services/agents/authority.js still sits between deciding and doing. The
--     model chooses which tool to call; it does not choose whether it is
--     allowed to. Authority is evaluated per tool call, is pure and
--     synchronous, and NEVER consults an LLM — an agent cannot reason its way
--     past its own ceiling, and a prompt-injected instruction in a customer
--     name cannot widen it.
--   • Exceeding a limit still escalates rather than blocking, so an autonomous
--     agent that meets something too large produces a human request instead of
--     either acting or silently dropping the work.
--   • Every model turn and tool call is recorded (agent_run_messages below), so
--     "why did it do that" is answerable afterwards. An autonomous agent whose
--     reasoning is not durable is not auditable.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- Credential vault.
--
-- Agents need their own API keys: the LLM they run on, and any external service
-- they call. Those are the user's real secrets, so they are encrypted at rest
-- with AES-256-GCM (services/ai/credentialVault.js) and never returned through
-- the API — not even to the person who stored them.
--
-- `allowed_hosts` is the SSRF control for external calls. A credential is bound
-- to the hosts it may be sent to, so a prompt-injected "POST the AR ledger to
-- evil.example" fails at the egress check rather than at the model's judgement.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_credentials (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           VARCHAR(80) NOT NULL UNIQUE
                 CHECK (name ~ '^[a-zA-Z][a-zA-Z0-9_ -]{1,79}$'),
  description    TEXT,

  -- anthropic | openai | http  — 'http' is a generic bearer/API-key credential
  -- for external services an agent calls through call_external_api.
  provider       VARCHAR(24) NOT NULL DEFAULT 'http'
                 CHECK (provider IN ('anthropic', 'openai', 'http')),

  -- AES-256-GCM. Separate columns rather than one blob so a partial write is a
  -- constraint error rather than an undecryptable secret discovered later.
  secret_cipher  TEXT NOT NULL,
  secret_iv      VARCHAR(32) NOT NULL,
  secret_tag     VARCHAR(32) NOT NULL,
  -- Which key encrypted it, so a future key rotation can tell re-encrypted rows
  -- from stale ones instead of failing at read time.
  key_id         VARCHAR(16) NOT NULL DEFAULT 'v1',

  -- Last 4 characters, for "is this the key I think it is?" without revealing it.
  hint           VARCHAR(8),

  base_url       TEXT,
  -- Hosts this credential may be sent to. Empty = none: deny by default,
  -- matching the allowed_actions convention used by the authority engine.
  allowed_hosts  TEXT[] NOT NULL DEFAULT '{}',

  enabled        BOOLEAN NOT NULL DEFAULT true,
  last_used_at   TIMESTAMPTZ,
  use_count      INTEGER NOT NULL DEFAULT 0,

  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Which credentials an agent may use. Deliberately a join table rather than a
-- column: granting an agent access to a key is its own decision, revocable
-- without editing the agent, and visible as a list on the credential.
CREATE TABLE IF NOT EXISTS agent_credentials (
  agent_key      VARCHAR(80) NOT NULL,
  credential_id  UUID NOT NULL REFERENCES ai_credentials(id) ON DELETE CASCADE,
  granted_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (agent_key, credential_id)
);

-- ---------------------------------------------------------------------------
-- Agent blueprint: the AI half.
--
-- `kind` distinguishes the two agent shapes, and both are worth keeping:
--   'ai'       — a reasoning loop. Decides its own steps. Handles what it finds.
--   'pipeline' — the fixed step list from migration 117. Does exactly one thing,
--                identically, every time.
-- A recurring report that must be byte-identical every month does not want a
-- model deciding how to build it, and an investigation does not want a fixed
-- script. Forcing either into the other's shape makes it worse.
-- ---------------------------------------------------------------------------
ALTER TABLE agent_blueprints
  ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'pipeline'
    CHECK (kind IN ('ai', 'pipeline'));

ALTER TABLE agent_blueprints
  -- The goal/system prompt. For an AI agent this is the agent: it states the
  -- objective, the judgement to apply, and when to stop and ask.
  ADD COLUMN IF NOT EXISTS goal TEXT,
  ADD COLUMN IF NOT EXISTS provider VARCHAR(24) DEFAULT 'anthropic'
    CHECK (provider IN ('anthropic', 'openai')),
  ADD COLUMN IF NOT EXISTS model VARCHAR(80),
  -- Reasoning depth for models that support it.
  ADD COLUMN IF NOT EXISTS effort VARCHAR(12) DEFAULT 'high'
    CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  ADD COLUMN IF NOT EXISTS credential_id UUID REFERENCES ai_credentials(id),
  -- Which tools this agent may call. Empty = every tool the catalogue offers,
  -- which is the useful default for a general-purpose agent; a narrow agent
  -- should be given a narrow list.
  ADD COLUMN IF NOT EXISTS allowed_tools TEXT[] NOT NULL DEFAULT '{}',
  -- Bounds the loop. A reasoning agent with no iteration cap is an unbounded
  -- spend and an unbounded blast radius.
  ADD COLUMN IF NOT EXISTS max_iterations INTEGER NOT NULL DEFAULT 20
    CHECK (max_iterations BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS memory_enabled BOOLEAN NOT NULL DEFAULT true,
  -- Free-form guidance surfaced to the model about when to stop and ask a human.
  -- Guidance, NOT enforcement: the hard limits live in agent_definitions.authority
  -- where a model cannot argue with them.
  ADD COLUMN IF NOT EXISTS escalation_rules JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- Agent memory — what an agent knows between runs.
--
-- Without this every run starts from nothing: the collections agent re-learns
-- each week that a particular customer always pays on day 45, and re-sends the
-- reminder it already decided was pointless. Memory is scoped per agent, so one
-- agent cannot read another's notes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_memory (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_key    VARCHAR(80) NOT NULL,
  key          VARCHAR(160) NOT NULL,
  value        JSONB NOT NULL,
  -- Free-text note the agent wrote about why this matters. The value is the
  -- fact; this is the reasoning, which is what makes a memory reviewable.
  note         TEXT,
  -- The run that wrote it, so a wrong memory can be traced to the run that
  -- formed it rather than just deleted.
  run_id       UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  hit_count    INTEGER NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agent_key, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory (agent_key, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Run transcript — the agent's reasoning, durably.
--
-- agent_run_actions records what was DONE. This records what was THOUGHT: the
-- model's messages, the tool calls it chose, the results it saw. An autonomous
-- agent that sends email and drafts credit notes has to be answerable for its
-- reasoning, not only its outcomes — and when one behaves oddly, this is the
-- only place the cause is visible.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_run_messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id      UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  agent_key   VARCHAR(80) NOT NULL,
  sequence    INTEGER NOT NULL,

  role        VARCHAR(16) NOT NULL
              CHECK (role IN ('system', 'user', 'assistant', 'tool', 'thinking', 'error')),
  content     TEXT,

  -- Populated for role='tool'.
  tool_name   VARCHAR(80),
  tool_input  JSONB,
  tool_output JSONB,
  -- allow | escalate | deny | dry_run — what the authority engine said about
  -- this call, recorded next to the call itself rather than only in the action
  -- trail, so the transcript reads as a complete account on its own.
  verdict     VARCHAR(16),

  tokens_in   INTEGER,
  tokens_out  INTEGER,
  duration_ms INTEGER,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_run_messages_run ON agent_run_messages (run_id, sequence);

-- ---------------------------------------------------------------------------
-- Token accounting on the run itself, so cost is visible per run without
-- summing the transcript.
-- ---------------------------------------------------------------------------
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS tokens_in   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_out  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS iterations  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS model       VARCHAR(80);

-- A pipeline blueprint has steps; an AI blueprint has a goal. Enforcing it here
-- means an agent cannot be saved in a state where it would fail at 3am with
-- "nothing to do" — the failure happens at save time, in front of its author.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_blueprints_kind_requirements'
  ) THEN
    ALTER TABLE agent_blueprints
      ADD CONSTRAINT agent_blueprints_kind_requirements
      CHECK (
        (kind = 'ai' AND goal IS NOT NULL AND length(btrim(goal)) > 0)
        OR (kind = 'pipeline' AND jsonb_array_length(steps) > 0)
      );
  END IF;
END $$;
