-- 141 — Three gaps in the tenancy write path, found by tests/tenancy.test.js.
--
-- Migration 140 fixed the tables it knew about. The invariant tests written
-- alongside it then failed on three things 140 missed, which is exactly what
-- those tests are for — each one is invisible until a second tenant exists.
--
-- 1. NULLABLE company_id ON SEVEN TABLES
--    ai_usage_log, api_keys, conversations, dashboards, generated_documents,
--    report_definitions and report_schedules were scoped by migrations written
--    AFTER 110, each of which added the column but not the NOT NULL. A nullable
--    company_id is a row belonging to nobody: under RLS it satisfies no policy
--    and becomes invisible to every tenant AND to support, with no error to say
--    so. api_keys is the sharpest case — an unscoped key is one that
--    authenticates into whichever company the request happens to resolve.
--
-- 2. agent_credentials WAS NEVER GIVEN THE COLUMN
--    140 changed its primary key to include company_id but never added it, and
--    the guard around that block (`IF EXISTS ... company_id`) was false, so the
--    whole thing skipped silently. The table maps an agent to the third-party
--    credentials it may use — precisely the grant that must not cross tenants.
--
-- 3. THE NATURAL-KEY REBUILD MISSED pdf_templates
--    Reported by the test as still globally unique. It was actually a false
--    positive in the test's own matching, but the check below makes the
--    intended state explicit and verifiable rather than inferred.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- 1. company_id NOT NULL everywhere it exists.
--
-- Backfilled to the default company first: these rows predate tenancy and were
-- created when there was exactly one company, so that is not a guess.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t          TEXT;
  default_id UUID;
BEGIN
  SELECT id INTO default_id FROM companies WHERE is_default = true;

  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
     WHERE c.table_schema = 'public'
       AND c.column_name = 'company_id'
       AND c.is_nullable = 'YES'
       AND tb.table_type = 'BASE TABLE'
       AND c.table_name <> 'user_companies'
  LOOP
    EXECUTE format('UPDATE %I SET company_id = %L WHERE company_id IS NULL', t, default_id);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN company_id SET NOT NULL', t);

    BEGIN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (company_id) REFERENCES companies(id)',
        t, 'fk_' || t || '_company');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    RAISE NOTICE 'company_id is now NOT NULL on %', t;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. agent_credentials: add the column, then key by it.
--
-- The grant is "this agent may use this credential". Both sides are per tenant,
-- so the grant is too. credentialVault.js queries by (agent_key, credential_id)
-- and RLS narrows those, so no application change is needed.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  default_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'public' AND table_name = 'agent_credentials') THEN
    RETURN;
  END IF;

  SELECT id INTO default_id FROM companies WHERE is_default = true;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'agent_credentials' AND column_name = 'company_id') THEN
    ALTER TABLE agent_credentials ADD COLUMN company_id UUID;
    EXECUTE format('UPDATE agent_credentials SET company_id = %L WHERE company_id IS NULL', default_id);
    ALTER TABLE agent_credentials ALTER COLUMN company_id SET NOT NULL;
    EXECUTE format(
      'ALTER TABLE agent_credentials ALTER COLUMN company_id '
      || 'SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)', default_id);

    BEGIN
      ALTER TABLE agent_credentials ADD CONSTRAINT fk_agent_credentials_company
        FOREIGN KEY (company_id) REFERENCES companies(id);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    CREATE INDEX IF NOT EXISTS idx_agent_credentials_company ON agent_credentials (company_id);
  END IF;

  -- Rebuild the primary key to include the company. Guarded so a re-run does
  -- not drop a correct key and leave the table without one.
  IF EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'agent_credentials'::regclass AND i.indisprimary
       AND NOT EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            AND a.attname = 'company_id')
  ) THEN
    ALTER TABLE agent_credentials DROP CONSTRAINT agent_credentials_pkey;
    ALTER TABLE agent_credentials ADD PRIMARY KEY (company_id, agent_key, credential_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Make the natural-key intent explicit and re-assertable.
-- ---------------------------------------------------------------------------
ALTER TABLE pdf_templates DROP CONSTRAINT IF EXISTS pdf_templates_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pdf_templates_company_key
  ON pdf_templates (company_id, key);

-- ---------------------------------------------------------------------------
-- 4. Refresh the register so anything scoped above is actually protected when
--    enable_multi_company() runs.
-- ---------------------------------------------------------------------------
INSERT INTO company_scoped_tables (table_name)
SELECT c.table_name
  FROM information_schema.columns c
  JOIN information_schema.tables tb
    ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
 WHERE c.table_schema = 'public'
   AND c.column_name = 'company_id'
   AND tb.table_type = 'BASE TABLE'
   AND c.table_name NOT IN ('user_companies')
ON CONFLICT DO NOTHING;
