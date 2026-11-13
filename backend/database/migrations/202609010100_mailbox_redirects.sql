-- 202609010100 — Inbound mailbox redirects.
--
-- Mail to a deprecated address is stored in another mailbox's inbox instead
-- of bouncing: the inbound webhook looks the recipient up in `mailboxes`
-- first, and when that misses, consults this map. Reply-sensitive flows —
-- old addresses printed on contracts or in past emails — keep working while
-- the operator consolidates onto one canonical address.
--
-- `source_address` is stored lowercased because the webhook lowercases
-- X-Envelope-To before any lookup. `target_mailbox_id` points at the
-- mailbox row, so the destination survives a later rename of that address.

CREATE TABLE IF NOT EXISTS mailbox_redirects (
  source_address    TEXT PRIMARY KEY,
  target_mailbox_id UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by        UUID
);

COMMENT ON TABLE mailbox_redirects IS
  'Inbound-only: mail to source_address is delivered into target_mailbox_id''s mailbox.';
