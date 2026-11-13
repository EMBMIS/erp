-- Migration 202608280900: company and user mailboxes on embmis.com.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- Every company gets an auto-provisioned address (company-code@embmis.com)
-- the moment it's created; admins can also provision one per user
-- (firstname.company-code@embmis.com). Mail itself is not stored here —
-- message bodies and attachments live in Cloudflare R2 (see
-- backend/services/mailStorage.js); this only holds addresses, quota
-- counters, and message/attachment metadata (subject, from/to, size, and the
-- R2 object key to fetch the body).
--
-- 50MB per mailbox is enforced in application code (mailboxQuota.js) with a
-- row lock on mailboxes.used_bytes before accepting or sending a message —
-- not a CHECK constraint, because the check has to happen *before* the
-- message is stored (reject it), not after (which would mean storing it in
-- R2 first, then discovering it doesn't fit).
--
-- Scoped from the start, same as kb_documents (202608062100): a mailbox and
-- its mail is one company's data. All three tables carry company_id and are
-- registered in company_scoped_tables so they're covered whenever
-- enable_multi_company() next runs, same as every other table added this way.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS mailboxes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- NULL = the company-level mailbox (company-code@embmis.com). Set = a
  -- per-user mailbox (firstname.company-code@embmis.com) belonging to that
  -- user within this company.
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,

  address        TEXT NOT NULL,
  display_name   TEXT,

  quota_bytes    BIGINT NOT NULL DEFAULT 52428800, -- 50MB
  used_bytes     BIGINT NOT NULL DEFAULT 0,

  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),

  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at     TIMESTAMPTZ
);

-- Case-insensitive uniqueness on the address, but only while a mailbox is
-- live — a soft-deleted mailbox's address can be reissued (e.g. a user
-- re-invited after being removed) without a dangling unique-index conflict.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mailboxes_address_live
  ON mailboxes (lower(address)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mailboxes_company ON mailboxes (company_id);
CREATE INDEX IF NOT EXISTS idx_mailboxes_user ON mailboxes (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mailbox_messages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mailbox_id         UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,

  direction          TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  folder             TEXT NOT NULL DEFAULT 'INBOX' CHECK (folder IN ('INBOX', 'SENT', 'TRASH')),

  message_id_header  TEXT,
  from_address       TEXT NOT NULL,
  to_addresses       JSONB NOT NULL DEFAULT '[]',
  cc_addresses       JSONB NOT NULL DEFAULT '[]',
  subject            TEXT,
  body_text          TEXT,
  body_html          TEXT,

  -- Total size counted against the mailbox's quota: raw message + all
  -- attachments, matching what was actually written to R2.
  size_bytes         BIGINT NOT NULL DEFAULT 0,
  r2_object_key      TEXT, -- raw .eml, for full-fidelity re-read/export

  is_read            BOOLEAN NOT NULL DEFAULT false,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_company ON mailbox_messages (company_id);
CREATE INDEX IF NOT EXISTS idx_mailbox_messages_mailbox ON mailbox_messages (mailbox_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mailbox_attachments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  message_id     UUID NOT NULL REFERENCES mailbox_messages(id) ON DELETE CASCADE,

  filename       TEXT NOT NULL,
  content_type   TEXT,
  size_bytes     BIGINT NOT NULL DEFAULT 0,
  r2_object_key  TEXT NOT NULL,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mailbox_attachments_company ON mailbox_attachments (company_id);
CREATE INDEX IF NOT EXISTS idx_mailbox_attachments_message ON mailbox_attachments (message_id);

DO $$
DECLARE
  default_id UUID;
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;

  EXECUTE format(
    'ALTER TABLE mailboxes ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );
  EXECUTE format(
    'ALTER TABLE mailbox_messages ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );
  EXECUTE format(
    'ALTER TABLE mailbox_attachments ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );
END $$;

INSERT INTO company_scoped_tables (table_name)
VALUES ('mailboxes'), ('mailbox_messages'), ('mailbox_attachments')
ON CONFLICT (table_name) DO NOTHING;

COMMENT ON TABLE mailboxes IS
  'Company and per-user mailboxes on embmis.com. user_id NULL = the company-level mailbox. Bodies/attachments live in R2 (mailStorage.js); quota is enforced in mailboxQuota.js, not here.';
COMMENT ON TABLE mailbox_messages IS
  'Metadata for one inbound or outbound mail message. r2_object_key points at the raw .eml in R2. size_bytes is what counts against mailboxes.used_bytes.';
COMMENT ON TABLE mailbox_attachments IS
  'One attachment on a mailbox_messages row; bytes live in R2 at r2_object_key.';
