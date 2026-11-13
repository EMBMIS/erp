-- 202608311400 — "Sign in with Google" support.
--
-- A Google-only account has no password to hash: verifying a Google ID token
-- is signature-based (Google's own JWKS), there is never a password the user
-- chose. password_hash was NOT NULL, which made that account impossible to
-- create at all — dropping the constraint is what makes createFromGoogle
-- (models/User.js) and the authenticate() null-hash guard it pairs with
-- actually work, rather than every Google-only signup failing the insert.
--
-- google_id links a Google account to a users row (routes/auth.js POST
-- /google): matched by email against an existing local account when one
-- exists, or a brand-new row when it doesn't. Unique so one Google identity
-- can never end up linked to two different local accounts.

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE;

CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

COMMENT ON COLUMN users.google_id IS
  'Google account subject (sub claim) for "Sign in with Google". NULL for password-only accounts.';
