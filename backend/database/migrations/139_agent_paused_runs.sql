-- 139 — Paused agent runs survive a restart.
--
-- WHAT BREAKS TODAY
-- ===========================================================================
-- When the chat agent calls a tool that needs confirmation, services/ai/agent.js
-- freezes the run and keeps it here:
--
--     const paused = new Map();  // pauseId -> { messages, step, ... }
--
-- A process-local Map. Two consequences, both of which look to the user like
-- the assistant losing its train of thought:
--
--   • A deploy, a crash, or an idle-timeout restart silently discards every
--     run waiting on a human. The person clicks "Approve" on a prompt that is
--     still on their screen and gets "No pending confirmation found for this
--     session". They did nothing wrong and there is nothing they can do.
--   • It cannot work behind more than one instance. The resume request is a
--     separate HTTP call, so any load balancer will eventually route it to a
--     process that never saw the pause. The failure is intermittent and
--     load-dependent — the worst kind to diagnose.
--
-- That second point matters beyond convenience: it means the confirmation
-- mechanism — the thing standing between the model and a write — is the least
-- reliable part of the system. A guardrail people learn to expect to fail is a
-- guardrail they learn to route around.
--
-- WHAT THIS STORES, AND WHAT IT DELIBERATELY DOES NOT
-- ===========================================================================
-- `state` is the frozen run: the message list so far, the step counter, the
-- autonomy mode, and the tool calls awaiting a decision. It is JSONB because
-- its shape is the OpenAI/Anthropic message format, which is the SDK's to
-- change, not this schema's — modelling it in columns would mean a migration
-- every time a provider adds a content block type.
--
-- It is NOT a conversation log. Conversations live in migration 136; this is
-- the suspended continuation of one turn, and it is deleted the moment the
-- turn resumes. Rows here are short-lived by design.
--
-- `expires_at` keeps the original 10-minute TTL, now enforced by the database
-- rather than by a timestamp compared in application memory. A cleanup on read
-- is enough: these rows are small, few, and only ever consulted by id.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS agent_paused_runs (
  id          UUID PRIMARY KEY,

  -- Who may resume this. A pause is a question put to one person; anyone else
  -- resuming it would be answering on their behalf, and the decision being
  -- made is "may this tool run" — precisely the thing that must be attributable.
  user_id     VARCHAR(100) NOT NULL,

  -- Frozen run state: { messages, step, mode, ctx, toolsUsed, pendingConfirm }.
  state       JSONB NOT NULL,

  -- Denormalised out of state for the "what am I waiting on?" listing, so the
  -- UI can show pending confirmations without deserialising every run.
  pending_tools TEXT[] NOT NULL DEFAULT '{}',

  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Sweeping expired rows and listing a user's pending confirmations are the
-- only two queries besides lookup by primary key.
CREATE INDEX IF NOT EXISTS idx_agent_paused_runs_expiry ON agent_paused_runs (expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_paused_runs_user   ON agent_paused_runs (user_id, created_at DESC);

COMMENT ON TABLE agent_paused_runs IS
  'Agent runs suspended awaiting human confirmation. Short-lived: deleted on resume, '
  'swept after expires_at. Replaces a process-local Map that could not survive a '
  'restart or work behind more than one instance.';
