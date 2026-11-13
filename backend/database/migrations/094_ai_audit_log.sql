-- 094 — AI audit log.
--
-- Every action taken by an AI agent (chat, function-calling agent, or MCP client)
-- is recorded here: which tool was called, with what arguments, by/for whom, and
-- the outcome. This is a hard design rule for AI writes — nothing the AI does is
-- invisible. Read-only tool calls are logged too (light rows) for traceability.
-- Idempotent.

CREATE TABLE IF NOT EXISTS ai_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor        VARCHAR(50)  NOT NULL DEFAULT 'ai-agent',  -- 'ai-agent' | 'mcp' | 'ai-chat'
  user_id      UUID REFERENCES users(id),                 -- the human on whose behalf it ran
  tool_name    VARCHAR(100) NOT NULL,
  arguments    JSONB,
  read_only    BOOLEAN NOT NULL DEFAULT true,
  success      BOOLEAN NOT NULL DEFAULT true,
  result_summary TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_audit_log_created  ON ai_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_audit_log_tool     ON ai_audit_log(tool_name);
CREATE INDEX IF NOT EXISTS idx_ai_audit_log_user     ON ai_audit_log(user_id);
