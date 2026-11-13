-- 129 — Track what the AI agent actually costs to run.
--
-- Before this, there was zero visibility into AI spend: no token counts, no
-- cost estimate, nothing. ai_audit_log (migration 094) records WHAT a tool
-- call did, not what the underlying model call cost — and a single chat turn
-- can make several model calls (one per step of agent.js's runLoop) before it
-- ever reaches a tool. This table is the missing half: one row per model call,
-- independent of whether that call went on to invoke a tool.
--
-- estimated_cost_usd is nullable on purpose. This deployment's "OpenAI" key is
-- routed at other providers behind an OpenAI-compatible API (see
-- OPENAI_BASE_URL in config/aiConfig.js — DeepSeek today, something else
-- tomorrow), so cost is looked up by model NAME from a small static pricing
-- table (services/ai/usageTracking.js), not assumed from the client library.
-- A model that isn't in that table gets NULL here — never a guessed number —
-- so a manager summing this column sees an honest "cost not estimated" rather
-- than a wrong total that looks precise.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  user_id             UUID REFERENCES users(id),
  -- Mirrors ai_audit_log.actor: 'ai-agent', 'background-task', etc. — which
  -- surface made this model call, not who is billed for it.
  actor               TEXT,

  model               TEXT NOT NULL,
  prompt_tokens       INT,
  completion_tokens   INT,
  total_tokens        INT,
  -- NULL means "not estimated" — see note above. Never default this to 0.
  estimated_cost_usd  NUMERIC(10,6),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The two lookups this table exists to serve: "spend over time" (a day-by-day
-- summary) and "spend for this one user" (per-user, time-bounded).
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_created_at ON ai_usage_log (created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_user_created ON ai_usage_log (user_id, created_at);

COMMENT ON TABLE ai_usage_log IS
  'One row per model call (not per tool call) from the AI agent, with actual token usage and an estimated USD cost where the model''s price is known. See services/ai/usageTracking.js.';
