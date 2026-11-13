-- 202608310100 — Persistent chat attachments.
--
-- A file attached to a Simeli conversation used to live in a process-local Map
-- (services/ai/attachments.js): extracted text keyed by session, wiped on any
-- restart. A restart is exactly what a deploy is on this stack, so a file
-- attached before one was gone when the person asked about it afterwards —
-- Simeli truthfully reported "the file is not available to me" for a file the
-- person had just attached.
--
-- The conversation itself was made durable the same way (migration 136
-- replaced an in-process Map with the conversations table), and attachments
-- deserve the same move: they are per-conversation data with the same lifetime
-- as the conversation. The extracted text is capped at the same 40,000
-- characters the old in-memory store applied, so a row is bounded and cheap.

CREATE TABLE IF NOT EXISTS conversation_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  format          TEXT NOT NULL,      -- pdf | text | markdown | html | ...
  bytes           BIGINT,             -- original upload size
  characters      INT,                -- extracted text length before truncation
  truncated       BOOLEAN NOT NULL DEFAULT FALSE,
  text            TEXT,               -- extracted text, capped at MAX_CHARS
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversation_attachments_conv
  ON conversation_attachments (conversation_id, created_at);

COMMENT ON TABLE conversation_attachments IS
  'Files attached to a Simeli conversation. Persisted so they survive restarts; scoped through the owning conversation.';
COMMENT ON COLUMN conversation_attachments.text IS
  'Extracted plain text, capped at 40k characters (services/ai/attachments.js MAX_CHARS).';
