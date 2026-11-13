-- Migration 202609021200: AI-generated mail branding, one design per company.
--
-- A company hands Simeli a photo of its logo; a vision model reads the
-- logo's colors and produces an HTML email template built around them
-- (header band, footer, a {{SUBJECT}}/{{BODY}} slot for the actual message).
-- From then on, every mail a mailbox in that company sends is wrapped in
-- this template before delivery — see mailboxOutboundService.sendFromMailbox
-- and services/mailBrandingService.js.
--
-- One row per company (company_id is the primary key, not a separate id +
-- unique constraint) because there is exactly one active design at a time —
-- generating a new one replaces the old, it does not add a second row to
-- choose between.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS mail_branding (
  company_id      UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,

  logo_r2_key     TEXT NOT NULL,
  logo_content_type TEXT NOT NULL,

  -- Hex swatches the vision model read off the logo — kept alongside the
  -- template mainly so the settings page can show "here is what we saw"
  -- without re-parsing the HTML.
  palette         JSONB NOT NULL DEFAULT '{}',

  -- Full HTML document. Contains the literal placeholders {{SUBJECT}} and
  -- {{BODY}} (replaced at send time) and references the logo as
  -- cid:company-logo (the logo is attached inline to every outbound message,
  -- same mechanism as an inline image in mailbox_attachments.content_id).
  html_template   TEXT NOT NULL,

  generated_by    UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
DECLARE
  default_id UUID;
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;

  EXECUTE format(
    'ALTER TABLE mail_branding ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );
END $$;

INSERT INTO company_scoped_tables (table_name)
VALUES ('mail_branding')
ON CONFLICT (table_name) DO NOTHING;

COMMENT ON TABLE mail_branding IS
  'One AI-generated email design per company, built from a logo photo by a vision model. Wraps every outbound mailbox message once set — see mailBrandingService.js.';
