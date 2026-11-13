-- 113 — Bind API keys to a company.
--
-- Migration 110 added a company dimension to the business tables but not to
-- api_keys, so a key belonged to no company. That left the integration surface
-- in the one state multi-company is supposed to make impossible: with isolation
-- off a key is implicitly unscoped, and with isolation on it resolves to no
-- company at all and every request sees zero rows.
--
-- The failure was already visible in the logs before isolation was ever enabled.
-- API-key auth sets req.user.id to the string `api-key-<uuid>`, which
-- primaryCompanyFor() compared against user_companies.user_id (a uuid column),
-- throwing "invalid input syntax for type uuid" on every single API-key request.
-- The error was caught and the request continued with no company context.
--
-- A key is issued by someone, for one company's data, so company_id is the
-- correct home for that scope — not user_companies, which is about people.
--
-- Idempotent.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- Backfill existing keys to the default company: they were created when only one
-- company existed, so that is where their data lives.
UPDATE api_keys
   SET company_id = (SELECT id FROM companies WHERE is_default = true LIMIT 1)
 WHERE company_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_company ON api_keys (company_id);
