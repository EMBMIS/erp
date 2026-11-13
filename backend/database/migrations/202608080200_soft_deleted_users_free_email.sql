-- users_email_key was a plain table-wide UNIQUE constraint on email, but
-- User.findByEmail() (models/User.js) — the "is this email already taken?"
-- check used by /register, /register-company and POST /users/invite — has
-- always excluded soft-deleted rows (WHERE deleted_at IS NULL), matching the
-- softDelete() comment's intent: "the account can never log in or be looked
-- up again". Those two didn't agree: findByEmail said an email was free once
-- its user was deleted, but the constraint still held it forever, so the app
-- let a request past the "already exists" guard and then blew up on the
-- INSERT itself with a raw 23505 instead of a clean error. Hit for real
-- inviting an existing user's address, previously soft-deleted.
--
-- Replacing the constraint with a partial unique index (active rows only)
-- makes the database agree with what the application already believes: a
-- deleted account's email becomes available again for a fresh signup or
-- invite.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_key ON users (email) WHERE deleted_at IS NULL;
