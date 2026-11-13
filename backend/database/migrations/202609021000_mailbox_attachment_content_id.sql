-- Migration 202609021000: Content-ID on mailbox_attachments, for inline images.
--
-- An email composed in Outlook/Gmail with a pasted screenshot does not send
-- that image as a plain attachment referenced by a link — it sends it as an
-- attachment with a Content-ID header, and the HTML body embeds it with
-- <img src="cid:that-content-id">. Without anywhere to record which
-- attachment a given Content-ID belongs to, the mailbox UI had no way to
-- turn "cid:xxxx" back into real image bytes, so every such image rendered
-- as a broken-image icon — which is what "attached images can't be seen"
-- actually was, not a download-button problem.
--
-- Idempotent.

ALTER TABLE mailbox_attachments
  ADD COLUMN IF NOT EXISTS content_id TEXT;

CREATE INDEX IF NOT EXISTS idx_mailbox_attachments_content_id ON mailbox_attachments (message_id, content_id) WHERE content_id IS NOT NULL;

COMMENT ON COLUMN mailbox_attachments.content_id IS 'RFC 2392 Content-ID (no angle brackets), when this attachment is referenced inline in the message body as cid:<content_id> rather than shown as a plain attachment. NULL for an ordinary (non-inline) attachment.';
