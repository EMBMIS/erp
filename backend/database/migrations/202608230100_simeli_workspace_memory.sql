-- Simeli workspace memory.
--
-- A conversation was a title and a list of messages. That is enough for a
-- chatbot and not enough for an investigation: someone who asks "why did cash
-- deteriorate this month?", gets an answer three days later needs to know what
-- was looked at, what was decided, and what was actually done — without
-- re-reading forty turns.
--
-- These columns are all DERIVED from the run, never typed by the model as a
-- claim about itself:
--
--   modules    the ERP modules whose tools actually executed
--   entities   the records those tools actually returned
--   actions    the write tools that actually ran, with their approval state
--
-- so the workspace panel is a record of the investigation rather than a
-- summary of it. `objective` is the exception: it is the user's own framing,
-- editable by them, and null until they set one.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS objective  TEXT,
  ADD COLUMN IF NOT EXISTS modules    TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS entities   JSONB  NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS actions    JSONB  NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS pinned     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_stage TEXT;

COMMENT ON COLUMN conversations.modules IS
  'ERP modules whose tools executed in this conversation. Derived from the tool stream, not declared.';
COMMENT ON COLUMN conversations.entities IS
  'Records the tools returned: [{type, label, id, module}]. Derived, capped, deduplicated.';
COMMENT ON COLUMN conversations.actions IS
  'Write tools that ran: [{name, verb, module, state, at}]. state is one of proposed|approved|executed|denied.';
COMMENT ON COLUMN conversations.objective IS
  'The user''s own statement of what this investigation is for. Null until they write one.';
COMMENT ON COLUMN conversations.last_stage IS
  'Furthest stage the agent loop reached on the most recent turn (see services/ai/agentNarration.js).';

-- Listing the workspace sorts pinned first, then by recency.
CREATE INDEX IF NOT EXISTS idx_conversations_user_pinned
  ON conversations (user_id, pinned DESC, updated_at DESC);
