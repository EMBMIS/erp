-- 202608071700 — Email verification for signup.
--
-- Mirrors password_reset_tokens exactly (same hash-the-token-not-the-value,
-- expiry, single-use shape) — this is the same problem (prove control of an
-- email address via a time-limited link) with a different trigger.
--
-- email_verified defaults to true for every EXISTING user: this is a new
-- requirement being added after the fact, and retroactively locking out
-- accounts that were never asked to verify anything would be a self-inflicted
-- outage, not a security improvement. Only accounts created after this
-- migration start unverified.
--
-- Idempotent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT false;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_hash ON email_verification_tokens (token_hash);

COMMENT ON COLUMN users.email_verified IS 'True for every account that existed before migration 202608071700 (grandfathered); new signups start false until they click the verification link.';
