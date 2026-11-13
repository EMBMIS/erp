-- What each person keeps on their rail.
--
-- ===========================================================================
-- WHY A ROW MEANS "DECIDED", NOT "PINNED"
-- ===========================================================================
-- Three states have to be distinguishable and only two are obvious:
--
--   never touched it       show the defaults — the core applications, which
--                          is what almost everybody wants and nobody should
--                          have to configure.
--   pinned some things     show exactly those.
--   pinned NOTHING         show nothing, and mean it.
--
-- The third is the one that breaks a naive design. If pins were rows in a
-- join table, "no rows" would mean both "new user" and "deliberately empty
-- rail", and one of those two people would get a rail they explicitly did not
-- ask for. So the row records the DECISION, and `pinned` inside it records the
-- outcome — an empty array is a real answer.
--
-- Per user AND per company: the same person can run procurement for one
-- company and finance for another, and a rail that followed them across would
-- be wrong in one of the two.

CREATE TABLE IF NOT EXISTS user_shell_preferences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Application keys, in the order they appear. Keys rather than foreign keys
  -- because a pin may name a core application, which has no `applications`
  -- row — see services/platform/native/manifests.js. A pin to something that
  -- no longer exists is dropped when the rail is read rather than constrained
  -- here, so switching an application off never fails somebody's login.
  pinned      JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_user_shell_prefs UNIQUE (user_id, company_id),
  CONSTRAINT chk_user_shell_pinned_array CHECK (jsonb_typeof(pinned) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_user_shell_prefs_company
  ON user_shell_preferences (company_id, user_id);

-- Company-scoped, so it is governed by the same isolation policy as
-- everything else and a person's rail in one company is invisible in another.
INSERT INTO company_scoped_tables (table_name)
VALUES ('user_shell_preferences')
ON CONFLICT (table_name) DO NOTHING;

-- The policy is applied here rather than by calling enable_multi_company(),
-- which takes the application ROLE and re-policies every registered table.
-- That role's name differs per deployment, so a migration cannot name it — and
-- re-policying a hundred tables to add one is a lot of blast radius for a
-- preference. Same policy text, same FORCE, applied to this table only.
ALTER TABLE user_shell_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_shell_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON user_shell_preferences;
CREATE POLICY company_isolation ON user_shell_preferences
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());

DO $$
DECLARE
  default_id UUID;
  role_name  TEXT;
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;
  EXECUTE format(
    'ALTER TABLE user_shell_preferences ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );

  -- Whoever may write the platform's other company-scoped tables may write
  -- this one. Derived rather than named, because the application role is
  -- called something different in every deployment.
  FOR role_name IN
    SELECT DISTINCT g.grantee FROM information_schema.role_table_grants g
     WHERE g.table_name = 'app_notifications' AND g.privilege_type = 'INSERT'
       AND g.grantee <> 'PUBLIC'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON user_shell_preferences TO %I', role_name);
  END LOOP;
END $$;
