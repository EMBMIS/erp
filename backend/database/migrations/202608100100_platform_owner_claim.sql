-- Platform ownership, claimed once by the first account to sign up.
--
-- Ownership is NOT a tenant role. Every customer company has an ADMIN, and
-- each is entitled to administer their own data; the App Statistics screen
-- reports instance-wide figures (request volume, database size, table sizes)
-- that belong to no single tenant. So it needs a holder that is not expressible
-- as a role, and that a tenant admin cannot grant themselves.
--
-- Recorded on `users` rather than in a settings table so the flag travels with
-- the account and disappears with it.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_platform_owner BOOLEAN NOT NULL DEFAULT false;

-- At most one owner, enforced by the database rather than by the code that
-- happens to set it. A partial unique index over a constant-true predicate is
-- the standard way to say "at most one row may have this": a second claim fails
-- with a unique violation instead of quietly producing two owners, which is the
-- failure mode that matters — an application-level check has a race between its
-- SELECT and its UPDATE, and signup is exactly the endpoint where two requests
-- can arrive together.
CREATE UNIQUE INDEX IF NOT EXISTS users_single_platform_owner
  ON users (is_platform_owner)
  WHERE is_platform_owner;

COMMENT ON COLUMN users.is_platform_owner IS
  'Claimed once, by the first account to sign up while no owner exists. Grants the instance-wide App Statistics screen. PLATFORM_OWNER_EMAIL in the server environment overrides this if set, which is the recovery path if the claim lands on the wrong account.';
