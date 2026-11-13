-- Tracks whether a user is still on the temporary password an admin's
-- invite generated for them (models/User.js's createWithTempPassword).
-- Surfaced at login so the frontend can prompt them to set their own
-- password instead of silently leaving them on one an admin has seen.
-- Cleared whenever the user actually sets a password of their own choosing
-- (changePassword's current-password flow, or setPassword's reset-token
-- flow) — both are "the user now controls this password", just via
-- different proof of identity.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
