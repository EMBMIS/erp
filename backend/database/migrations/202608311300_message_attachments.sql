-- 202608311300 — Which files a message was sent with.
--
-- Attachments are conversation-scoped (they stay in the composer and stay
-- readable by later turns), but a sent message should also show which files
-- came with it — the modern chat look. This snapshot is captured at send
-- time, so the bubble keeps the files even if the attachment is removed from
-- the conversation afterwards. It is UI data; the agent's context line still
-- comes from the conversation's live attachment list.

ALTER TABLE conversation_messages
  ADD COLUMN IF NOT EXISTS attachment_info JSONB;

COMMENT ON COLUMN conversation_messages.attachment_info IS
  '[{id, name, format}] captured when the message was sent, for rendering the files on the message bubble.';
