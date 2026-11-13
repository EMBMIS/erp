-- 202609010200 — Per-user recovery email.
--
-- The address an account was originally created with (e.g. a personal Gmail)
-- can stay attached as a recovery address even after the login email changes
-- to a company address. Password-reset emails are sent to BOTH the account
-- email and recovery_email when one is set, so a user who signed up with a
-- personal address is never locked out of password recovery by a mailbox
-- they no longer use.

ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_email TEXT;

COMMENT ON COLUMN users.recovery_email IS
  'Optional secondary address for password-recovery mail; the reset link is sent here in addition to users.email when set.';
