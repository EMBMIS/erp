-- 136 — Persistent conversation memory.
--
-- Replaces the in-process Map in routes/ai-chat.js with database-backed
-- conversations and messages. Every message stores its full record: role,
-- content, tool calls, tool results, token counts, and timestamps.
-- Conversations are scoped by user_id and company_id.

CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  company_id      UUID REFERENCES companies(id),
  title           TEXT,                    -- auto-generated from first turn
  session_id      TEXT NOT NULL,           -- client-supplied stable id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content         TEXT,                    -- text content (null for tool-only messages)
  tool_calls      JSONB,                  -- [{id, name, arguments}]
  tool_results    JSONB,                  -- [{tool_call_id, name, result, error}]
  artifacts       JSONB,                  -- [{document_id, content_type, title}]
  token_count     INT,                    -- prompt + completion tokens for this turn
  model           TEXT,                   -- model used for this turn
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cm_conversation ON conversation_messages (conversation_id, created_at);

COMMENT ON TABLE conversations IS 'Persistent AI chat conversations scoped by user and company.';
COMMENT ON TABLE conversation_messages IS 'Full message records including tool calls, results, artifacts, and token counts.';
