-- Resolving a portal session before the company is known.
--
-- ===========================================================================
-- THE CHICKEN AND THE EGG
-- ===========================================================================
-- Row-level security answers "may this request see this row?" using the
-- session's company. A portal request has no company yet: working out which
-- company it belongs to IS what resolving the session does. So the lookup that
-- establishes the company cannot itself be subject to the policy that needs it
-- — every read of app_portal_sessions without a company set returns nothing,
-- and the portal can never log anyone in.
--
-- EMBMIS already had this problem and already solved it, for the supplier
-- confirmation links: migration 202608120700 added portal_company_for_token(),
-- a SECURITY DEFINER function that resolves a token to a company and returns
-- NOTHING else. This is the same pattern for the same reason.
--
-- WHY THIS IS NARROW ENOUGH TO BE SAFE
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER means the function runs with the owner's rights, so it is
-- the one place in the platform that reads past a policy. Everything about it
-- is therefore deliberately minimal:
--
--   • It takes a HASH, not a token. A caller must already hold the secret.
--   • It returns a single uuid — the company. Not the identity, not the
--     session, not the email. Nothing that would be useful to someone
--     guessing.
--   • It filters on revoked_at and expires_at, so a revoked session resolves
--     to nothing at all rather than to a company whose data the caller would
--     then be refused one query later.
--   • Its search_path is pinned, so it cannot be redirected at a table an
--     attacker controls.
--
-- After it returns, the request establishes that company as its context and
-- every subsequent read — including the identity row itself — goes through the
-- ordinary policy like anyone else's.

CREATE OR REPLACE FUNCTION public.app_portal_session_company(p_token_hash TEXT)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.company_id
    FROM app_portal_sessions s
    JOIN app_external_identities i ON i.id = s.external_identity_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > CURRENT_TIMESTAMP
     AND i.status = 'active'
   LIMIT 1
$$;

-- The same problem for the invitation link, which arrives by email with no
-- company context at all.
CREATE OR REPLACE FUNCTION public.app_portal_invite_company(p_token_hash TEXT)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.company_id
    FROM app_external_identities i
   WHERE i.invite_token_hash = p_token_hash
     AND i.invite_expires_at > CURRENT_TIMESTAMP
     AND i.status <> 'revoked'
   LIMIT 1
$$;

-- And for the login form, which knows a company code and an email but has no
-- session yet. Returns only the company id for an ACTIVE company — the same
-- information a customer already has from the letterhead of any document the
-- company sent them.
CREATE OR REPLACE FUNCTION public.app_portal_company_by_code(p_code TEXT)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id FROM companies c
   WHERE c.company_code = p_code AND c.deleted_at IS NULL AND c.status = 'ACTIVE'
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.app_portal_session_company(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_portal_invite_company(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_portal_company_by_code(TEXT) FROM PUBLIC;

DO $$
DECLARE app_role NAME;
BEGIN
  SELECT application_role INTO app_role FROM company_isolation_config WHERE id;
  IF app_role IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.app_portal_session_company(TEXT) TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.app_portal_invite_company(TEXT) TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.app_portal_company_by_code(TEXT) TO %I', app_role);
  END IF;
END $$;

COMMENT ON FUNCTION public.app_portal_session_company(TEXT) IS
  'Resolves a portal session token hash to its company, and nothing else. SECURITY DEFINER because establishing the company is what makes row-level security applicable in the first place.';
