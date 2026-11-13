-- Migration 202609021100: Drafts and Archive folders.
--
-- The mailbox only ever had Inbox/Sent/Trash — no way to save a message
-- without sending it, and no way to file something away without deleting
-- it. Both are ordinary mail-client folders, not new concepts; this widens
-- the existing folder CHECK constraint to allow them.
--
-- Idempotent: DROP/ADD CONSTRAINT IF NOT EXISTS isn't a thing in Postgres
-- for CHECK constraints, so this drops by the name Postgres itself assigned
-- (the default naming for an unnamed inline CHECK -- <table>_<column>_check)
-- and re-adds unconditionally; running this twice just replaces the same
-- constraint with itself.

ALTER TABLE mailbox_messages DROP CONSTRAINT IF EXISTS mailbox_messages_folder_check;
ALTER TABLE mailbox_messages ADD CONSTRAINT mailbox_messages_folder_check
  CHECK (folder IN ('INBOX', 'SENT', 'TRASH', 'DRAFTS', 'ARCHIVE'));
