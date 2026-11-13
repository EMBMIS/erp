-- 127 — Ad-hoc background tasks the chat agent can spin off.
--
-- Separate from agent_blueprints/agent_blueprint_versions (migration 117):
-- those are named, reusable, schedulable definitions with observe/propose/act
-- authority tiers — deliberately heavyweight, because they run unattended
-- forever. A background task is the opposite: a ONE-TIME, throwaway sub-run
-- the chat agent proposes mid-conversation for work it judges separable from
-- the current reply ("reindex all the contracts", "check every supplier for
-- duplicates") — never scheduled, never reused, gone once it finishes.
--
-- It still never runs without a person saying yes: propose_background_task
-- (services/ai/metaTools.js) is markedAlwaysConfirm in the tool registry, so
-- agent.js's needsConfirmation() stops and asks regardless of chat mode
-- (manual/accept_edits/auto/bypass) — the same unconditional-confirmation
-- treatment already given to tools from a connected MCP server, because
-- "starts something that keeps running after I've stopped watching" carries
-- the same trust requirement as "runs code I didn't review."
--
-- Once approved, the run itself is capped to accept_edits-equivalent
-- behaviour and cannot escalate itself: if it hits a highImpact tool with
-- nobody there to confirm, it stops and status becomes 'blocked' rather than
-- auto-approving or hanging forever waiting on a confirmation that will never
-- come (see services/ai/backgroundTasks.js#runBackgroundTask).
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS background_tasks (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  title         TEXT NOT NULL,
  -- The actual instructions handed to the inner agent run — effectively the
  -- "user message" of a fresh, unattended runAgent() call.
  description   TEXT NOT NULL,

  -- queued: approved, not yet started (should be near-instant in practice —
  --   execution kicks off in the same tick the confirmation lands).
  -- running: the inner agent loop is in progress.
  -- done: finished normally; result_summary has the final answer.
  -- blocked: stopped because it hit a highImpact tool with nobody present to
  --   confirm — pending_tools has what it was about to ask for.
  -- failed: an unexpected error ended the run; error has the message.
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'done', 'blocked', 'failed')),

  created_by    UUID REFERENCES users(id),
  -- The chat session that proposed this, so a finished task can be reported
  -- back into the same conversation rather than vanishing into a void.
  session_id    TEXT,
  mode          TEXT NOT NULL DEFAULT 'accept_edits',

  -- Append-only high-level trace: tool_call/tool_result/tool_denied/step_end
  -- entries, NOT raw token deltas (those are noise once nobody is watching
  -- live) — see services/ai/backgroundTasks.js.
  steps_log     JSONB NOT NULL DEFAULT '[]'::jsonb,
  tools_used    JSONB NOT NULL DEFAULT '[]'::jsonb,
  pending_tools JSONB,
  result_summary TEXT,
  error         TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_background_tasks_session ON background_tasks (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_background_tasks_status ON background_tasks (status);

COMMENT ON TABLE background_tasks IS
  'One-time, throwaway agent sub-runs the chat agent proposes for separable work — always confirmed before starting, capped so it cannot self-escalate past what a human approved. See services/ai/backgroundTasks.js.';
