-- 140 — The write path: make company_id correct on INSERT, everywhere.
--
-- ===========================================================================
-- WHAT MIGRATION 110 LEFT UNFINISHED
-- ===========================================================================
-- 110 added company_id to 54 tables, defaulted it, made it NOT NULL, and wrote
-- the RLS policy. Its comment says:
--
--     "When multi-company is switched on, the application context supplies the
--      value explicitly and this default stops being reached."
--
-- The application does not. Two of 43 models mention company_id at all. So the
-- default IS reached, on every insert — and it is a hardcoded literal of the
-- DEFAULT company:
--
--     ALTER TABLE customers ALTER COLUMN company_id SET DEFAULT '<default-uuid>'
--
-- Under isolation that is not a mis-assignment, it is a hard failure: the RLS
-- policy carries WITH CHECK (company_id = current_company_id()), so a second
-- tenant inserting a customer writes the *first* tenant's id and is rejected.
-- Every create, in every module, for every tenant but one.
--
-- Fail-safe rather than leaky, which is the right way round. But it means
-- multi-company could never actually be switched on.
--
-- THE FIX: A DYNAMIC DEFAULT
-- ---------------------------------------------------------------------------
--     DEFAULT COALESCE(public.current_company_id(), '<default-uuid>')
--
-- The session already carries the company — config/database.js applies
-- `SET LOCAL app.current_company_id` to every statement and every transaction.
-- So the database can fill the column itself, correctly, without any of the
-- ~500 INSERT statements naming it.
--
-- The COALESCE fallback is what keeps single-company installations byte-for-byte
-- unchanged: no ambient company, so the default company is used, exactly as
-- before. Editing 43 models to thread a company id through every insert would
-- be the same change, done 500 times, with the guarantee resting on nobody ever
-- forgetting.
--
-- ===========================================================================
-- TWO MORE THINGS THAT WOULD HAVE BROKEN MULTI-TENANCY
-- ===========================================================================
--
-- 1. UNSCOPED TABLES HOLDING TENANT SECRETS AND CONTENT
--
--    110's list predates the AI platform. These were never scoped:
--      ai_credentials, agent_credentials, mcp_connections, connectors
--        — third-party API keys and OAuth tokens, per tenant
--      document_embeddings — the text of tenants' contracts and reports
--      ai_tools, agent_definitions, agent_blueprints — tenant-authored code
--      ai_findings, ai_audit_log, notifications — tenant business data
--
--    Unscoped means one tenant reads another's stored credentials. Everything
--    else in this migration is correctness; this part is a breach.
--
-- 2. GLOBAL UNIQUE CONSTRAINTS ON NATURAL KEYS
--
--    ai_tools.name, agent_definitions.agent_key, pdf_templates.key,
--    mcp_connections.slug and the ai_findings dedup index are unique across the
--    WHOLE table. Under multi-tenancy that means the second tenant to name a
--    tool "reorder-check" is refused — and because RLS hides the row that
--    conflicts, the error names a record they cannot see and cannot delete.
--    Support cannot explain it and the user cannot work around it.
--
--    Each becomes unique per company instead.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- 1. Scope the tables 110 missed.
--
-- Root tables only — line-item children still reach their company through
-- their parent, per 110's reasoning, which stands. A column on the child is a
-- column that can disagree with its header.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t          TEXT;
  default_id UUID;
  newly_scoped TEXT[] := ARRAY[
    -- AI platform: credentials, tenant-authored tools, tenant content
    'ai_credentials','mcp_connections','connectors','document_embeddings',
    'ai_tools','ai_tool_versions','ai_tool_settings','agent_definitions',
    'agent_blueprints','agent_runs','agent_escalations','agent_memory',
    'background_tasks','agent_paused_runs','chat_memory','ai_findings',
    'ai_audit_log','ai_feedback','mcp_oauth_grants',
    -- Business roots added after 110
    'work_centers','leads','stocktake_sheets','sales_credit_notes',
    'supplier_debit_notes','notifications','pdf_templates',
    'webhook_subscriptions','supplier_items','time_entries'
  ];
BEGIN
  SELECT id INTO default_id FROM companies WHERE is_default = true;

  FOREACH t IN ARRAY newly_scoped LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = t) THEN
      RAISE NOTICE 'skipping %, table does not exist', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS company_id UUID', t);
    EXECUTE format('UPDATE %I SET company_id = %L WHERE company_id IS NULL', t, default_id);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN company_id SET NOT NULL', t);

    BEGIN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (company_id) REFERENCES companies(id)',
        t, 'fk_' || t || '_company');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (company_id)',
                   'idx_' || t || '_company', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Dynamic default on EVERY scoped table, old and new.
--
-- Applied by scanning for the column rather than from a hardcoded list, so a
-- table scoped by any future migration picks this up automatically and cannot
-- be forgotten.
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
       AND tb.table_type = 'BASE TABLE'
       -- user_companies is the mapping table itself: its company_id names the
       -- company being granted, not the company that owns the row. Defaulting
       -- it to the caller's own company would silently grant access to the
       -- wrong tenant.
       AND c.table_name NOT IN ('user_companies')
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
      t, default_id);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Natural keys become unique PER COMPANY.
--
-- Dropped and rebuilt individually rather than in a loop: each has a different
-- shape, and a partial index (ai_findings) or a named constraint versus a bare
-- index needs different DDL. Guessing wrong here silently drops a uniqueness
-- guarantee, so each is spelled out.
-- ---------------------------------------------------------------------------

-- ai_tools.name
ALTER TABLE ai_tools DROP CONSTRAINT IF EXISTS ai_tools_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_tools_company_name
  ON ai_tools (company_id, name);

-- agent_definitions.agent_key
ALTER TABLE agent_definitions DROP CONSTRAINT IF EXISTS agent_definitions_agent_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_definitions_company_key
  ON agent_definitions (company_id, agent_key);

-- pdf_templates.key
ALTER TABLE pdf_templates DROP CONSTRAINT IF EXISTS pdf_templates_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pdf_templates_company_key
  ON pdf_templates (company_id, key);

-- mcp_connections.slug (was partial on slug IS NOT NULL; stays partial)
DROP INDEX IF EXISTS idx_mcp_connections_slug;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_connections_company_slug
  ON mcp_connections (company_id, slug) WHERE slug IS NOT NULL;

-- ai_findings open-finding dedup. Without company_id, one tenant's open
-- finding suppresses the identical finding for every other tenant — the
-- scan runs, decides it is a duplicate, and reports nothing.
DROP INDEX IF EXISTS idx_ai_findings_dedup_open;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_findings_dedup_open
  ON ai_findings (company_id, finding_type, entity_type, entity_id)
  WHERE status = 'OPEN';

-- ---------------------------------------------------------------------------
-- 4. ai_settings: one row per company instead of one row, full stop.
--
-- It is a singleton (`id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id)`), and
-- services/ai/settings.js reads it with `WHERE id = true`. Making company_id
-- the primary key while LEAVING `id` in place keeps that query working
-- untouched: every row still has id = true, and RLS narrows the result to the
-- caller's own row. Per-tenant AI configuration, no application change.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  default_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'ai_settings' AND column_name = 'company_id') THEN
    RAISE NOTICE 'ai_settings already scoped';
  ELSE
    SELECT id INTO default_id FROM companies WHERE is_default = true;

    ALTER TABLE ai_settings ADD COLUMN company_id UUID;
    EXECUTE format('UPDATE ai_settings SET company_id = %L', default_id);
    ALTER TABLE ai_settings ALTER COLUMN company_id SET NOT NULL;
    ALTER TABLE ai_settings DROP CONSTRAINT ai_settings_pkey;
    ALTER TABLE ai_settings ADD PRIMARY KEY (company_id);
    ALTER TABLE ai_settings ADD CONSTRAINT fk_ai_settings_company
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
    -- A DEFAULT cannot contain a subquery, so the fallback company is baked in
    -- as a literal here, exactly as it is for every other scoped table above.
    EXECUTE format(
      'ALTER TABLE ai_settings ALTER COLUMN company_id '
      || 'SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)', default_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. agent_credentials: the grant is per company too.
--
-- PK was (agent_key, credential_id). `agent_key` is a per-tenant name, so two
-- tenants granting their own agent the same key would collide. credentialVault
-- queries by (agent_key, credential_id) and RLS narrows them, so no
-- application change is needed once company_id is in the key.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'agent_credentials' AND column_name = 'company_id') THEN
    ALTER TABLE agent_credentials DROP CONSTRAINT IF EXISTS agent_credentials_pkey;
    ALTER TABLE agent_credentials ADD PRIMARY KEY (company_id, agent_key, credential_id);
  END IF;
EXCEPTION WHEN invalid_table_definition THEN
  RAISE NOTICE 'agent_credentials primary key already includes company_id';
END $$;

-- ---------------------------------------------------------------------------
-- 6. Refresh the register of scoped tables, which enable_multi_company() reads
--    to decide what to protect.
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
