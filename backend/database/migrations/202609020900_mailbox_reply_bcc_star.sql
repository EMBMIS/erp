-- Migration 202609020900: reply threading, Bcc, and starring for mailbox_messages.
--
-- The mailbox UI could only send a brand-new message (To/Subject/Body) — no
-- Reply, Reply All, Forward, Bcc, star, or delete. Those need a place to
-- live: which message a message is replying to (for both the mail headers
-- Resend sends and for showing a thread in the UI), a Bcc list alongside the
-- Cc one already there, and a starred flag. Deletion needs no new column —
-- it reuses the existing folder='TRASH' move already defined by the CHECK
-- constraint in the base migration.
--
-- Idempotent.

ALTER TABLE mailbox_messages
  ADD COLUMN IF NOT EXISTS bcc_addresses JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS in_reply_to_id UUID REFERENCES mailbox_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_starred BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_in_reply_to ON mailbox_messages (in_reply_to_id) WHERE in_reply_to_id IS NOT NULL;

COMMENT ON COLUMN mailbox_messages.bcc_addresses IS 'Blind-copy recipients on an OUTBOUND message. Never populated for INBOUND — a Bcc header, by design, does not appear in the delivered copy.';
COMMENT ON COLUMN mailbox_messages.in_reply_to_id IS 'The mailbox_messages row this one replies to or forwards, if any — set by Reply/Reply All/Forward in the compose UI. Drives both the thread shown in the UI and the In-Reply-To/References headers on the outbound mail.';
COMMENT ON COLUMN mailbox_messages.is_starred IS 'User-set flag, independent of folder — a starred message can still be moved to TRASH.';
