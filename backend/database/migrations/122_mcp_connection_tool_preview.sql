-- 122 — Carry the category and tool preview onto a connection.
--
-- 121 recorded that a connection was made but not what it was for, so the
-- Connected tab had nothing to show beyond a name — no link a person could
-- follow, no sign of what "connecting" actually added. Discover already
-- knows the category and a preview of tool names for every candidate;
-- storing them on the row is what makes the Connected tab show something
-- real instead of a bare name and a toast.
--
-- Idempotent.

ALTER TABLE mcp_connections
  ADD COLUMN IF NOT EXISTS category VARCHAR(80),
  ADD COLUMN IF NOT EXISTS tools_preview JSONB NOT NULL DEFAULT '[]'::jsonb;
