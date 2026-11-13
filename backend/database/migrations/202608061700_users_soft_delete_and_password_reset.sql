-- User administration (soft delete) and self-service password reset.
--
-- users.is_active and users.last_login already exist (003_create_users_and_auth.sql).
-- What's missing is a way to remove a user without destroying FK history
-- (deleted_at, matching the soft-delete pattern already used by customers,
-- sales_orders, chart_of_accounts, etc.) and a table to back forgot/reset
-- password tokens.

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);

COMMENT ON COLUMN users.deleted_at IS 'Soft delete marker — set instead of removing the row so history/FKs stay intact';

-- Reset tokens are stored hashed (sha256), never plaintext, so a database
-- dump does not itself hand out working reset links.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at);

COMMENT ON TABLE password_reset_tokens IS 'Single-use, expiring tokens for the forgot-password flow. token_hash is sha256(token); the plaintext token only ever exists in the emailed link.';
