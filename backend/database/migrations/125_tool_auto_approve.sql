-- 125 — Remember that a tool was approved.
--
-- Tools from outside this ERP (MCP servers, connected apps) always stop and ask
-- before running, in every autonomy mode. That is right the first time and
-- wrong the tenth: being asked to re-approve the same Google Drive search on
-- every message is not a safety control, it is noise, and noise is what trains
-- people to click Allow without reading.
--
-- So the decision is remembered instead. "Allow once" runs it now and asks
-- again next time; "Always allow" records it here and stops asking for that
-- specific tool. The grant is per tool, not per server and not global, so
-- approving a file search never quietly approves sending mail.
--
-- Revoking is just setting this back to false, from the tool library.
--
-- Idempotent.

ALTER TABLE ai_tool_settings
  ADD COLUMN IF NOT EXISTS auto_approve BOOLEAN NOT NULL DEFAULT false;
