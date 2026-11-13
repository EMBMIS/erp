-- 110 — Multi-company foundation: legal entities, company scoping, intercompany.
--
-- ===========================================================================
-- THE DANGEROUS PART, AND HOW THIS AVOIDS IT
-- ===========================================================================
--
-- Retrofitting a tenant boundary onto ~100 tables and several hundred existing
-- queries is the one change in this system where a partial job is worse than
-- no job at all. A `company_id` column that most queries filter on and a few
-- forget is not "80% multi-company" — it is a system that silently shows one
-- customer's ledger to another, and it does so only on the paths nobody tested.
--
-- So the boundary here is enforced by Postgres row-level security, not by
-- remembering to add a WHERE clause. A query that forgets to filter returns
-- nothing rather than everything, which fails safe.
--
-- RLS is created here but deliberately left DISABLED, and the system stays
-- single-company until an operator runs enable_multi_company(). That is not
-- timidity — with exactly one company, unfiltered queries are correct by
-- construction, so the current code keeps working unchanged and correctly.
--
-- The trap this closes is the in-between state. A trigger on `companies`
-- refuses to insert a second company while RLS is off. You therefore cannot
-- reach the configuration where multiple tenants share tables without
-- enforcement — the database will not let you.
--
-- Idempotent.

-- ===========================================================================
-- Companies
-- ===========================================================================

CREATE TABLE IF NOT EXISTS companies (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_code    VARCHAR(20)  NOT NULL UNIQUE,
  name            VARCHAR(200) NOT NULL,
  legal_name      VARCHAR(200),

  -- The currency this entity keeps its books in. Consolidation translates
  -- subsidiaries into the parent's currency; it does not restate their ledgers.
  base_currency   VARCHAR(3)   NOT NULL DEFAULT 'USD' REFERENCES currencies(code),

  tax_number      VARCHAR(60),
  registration_number VARCHAR(60),

  address_line1   VARCHAR(200),
  address_line2   VARCHAR(200),
  city            VARCHAR(100),
  state           VARCHAR(100),
  postal_code     VARCHAR(20),
  country_code    CHAR(2),

  -- Locale defaults for documents this entity issues. A German subsidiary
  -- invoices in German with European date order regardless of who is logged in.
  locale          VARCHAR(10)  NOT NULL DEFAULT 'en-US',
  timezone        VARCHAR(60)  NOT NULL DEFAULT 'UTC',

  -- Month (1-12) the financial year starts in. 1 = calendar year.
  fiscal_year_start_month SMALLINT NOT NULL DEFAULT 1
                  CHECK (fiscal_year_start_month BETWEEN 1 AND 12),

  -- The entity this one consolidates into. NULL for the top of the group.
  parent_company_id UUID REFERENCES companies(id),

  is_default      BOOLEAN NOT NULL DEFAULT false,
  status          VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE','INACTIVE')),

  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMPTZ
);

-- Exactly one default company: it is what every existing row is backfilled to
-- and what a request with no company context resolves to.
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_one_default
  ON companies ((is_default)) WHERE is_default = true;

-- The default company, created from whatever the books are already in.
INSERT INTO companies (company_code, name, legal_name, base_currency, is_default)
SELECT 'MAIN', 'Main Company', 'Main Company',
       COALESCE((SELECT code FROM currencies WHERE is_base = true LIMIT 1), 'USD'),
       true
WHERE NOT EXISTS (SELECT 1 FROM companies);

-- Which companies a user may act for. A user with no rows here can act for the
-- default company only, which is what keeps single-company installs working
-- without an administrator having to grant anything.
CREATE TABLE IF NOT EXISTS user_companies (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Overrides the user's global role within this company when set.
  role        VARCHAR(30),
  is_primary  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_user_companies_company ON user_companies (company_id);

-- ===========================================================================
-- Scope the tables
-- ===========================================================================
--
-- Only root tables — documents and masters — carry company_id. Line-item
-- children (sales_order_items, journal_entry_items, …) deliberately do not:
-- they reach their company through their parent, and a separate column on the
-- child is a column that can disagree with its header. There is no meaningful
-- reading of "this invoice line belongs to a different company than the
-- invoice", so the schema should not be able to express it.

DO $$
DECLARE
  t             TEXT;
  default_id    UUID;
  scoped_tables TEXT[] := ARRAY[
    -- Finance
    'chart_of_accounts','journal_entries','customer_invoices','customer_payments',
    'supplier_invoices','supplier_payments','bank_accounts','bank_transactions',
    'fixed_assets','budgets','cost_centers','accounting_periods',
    'recurring_invoice_schedules',
    -- Sales
    'customers','sales_orders','sales_quotations','sales_contracts','sales_rfqs',
    'delivery_schedules','delivery_routes',
    -- Procurement
    'suppliers','purchase_orders','purchase_requisitions','rfqs',
    'request_for_quotations','contracts','goods_receipts','auto_purchase_orders',
    -- Inventory
    'items','inventory_items','storage_locations','bins','warehouse_transactions',
    'inventory_transfers',
    -- Manufacturing
    'bills_of_material','work_orders','mrp_planned_orders',
    -- HR
    'employees','payroll_runs',
    -- CRM and projects
    'contacts','deals','activities','projects',
    -- Governance
    'approval_chain_templates','approval_requests','delegation_of_authority'
  ];
BEGIN
  SELECT id INTO default_id FROM companies WHERE is_default = true;

  FOREACH t IN ARRAY scoped_tables LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = t) THEN
      RAISE NOTICE 'skipping %, table does not exist', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS company_id UUID', t);

    -- Backfill before NOT NULL. Every row that exists today belongs to the
    -- company whose books they were kept in, which is the default one.
    EXECUTE format('UPDATE %I SET company_id = %L WHERE company_id IS NULL', t, default_id);

    -- Defaulting to the default company is what lets ~500 existing INSERT
    -- statements, none of which mention company_id, keep working. When
    -- multi-company is switched on, the application context supplies the value
    -- explicitly and this default stops being reached.
    EXECUTE format('ALTER TABLE %I ALTER COLUMN company_id SET DEFAULT %L', t, default_id);
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

-- Record of which tables are scoped, so enable_multi_company() and the
-- application agree on the boundary instead of each keeping its own list.
CREATE TABLE IF NOT EXISTS company_scoped_tables (
  table_name TEXT PRIMARY KEY
);

INSERT INTO company_scoped_tables (table_name)
SELECT c.table_name
  FROM information_schema.columns c
 WHERE c.table_schema = 'public'
   AND c.column_name = 'company_id'
   AND c.table_name <> 'user_companies'
ON CONFLICT DO NOTHING;

-- ===========================================================================
-- Row-level security — created now, switched on later
-- ===========================================================================
--
-- The policy reads the company from a session setting rather than a table, so
-- it costs nothing per row. `current_setting(..., true)` returns NULL rather
-- than erroring when unset; NULLIF maps the empty string to NULL too, so an
-- unset context matches no rows.
--
-- Failing closed is the whole point. A route that forgets to establish company
-- context returns an empty list — visibly broken, and safe. The alternative
-- default returns every company's data and looks like it works.

CREATE OR REPLACE FUNCTION public.current_company_id() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_company_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION public.enable_multi_company() RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  t TEXT;
  n INT := 0;
BEGIN
  FOR t IN SELECT table_name FROM company_scoped_tables ORDER BY table_name LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE applies the policy to the table owner too. Without it the
    -- application's own role — which usually owns these tables — bypasses RLS
    -- entirely and the boundary is decorative.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS company_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY company_isolation ON %I
        USING (company_id = public.current_company_id())
        WITH CHECK (company_id = public.current_company_id())
    $p$, t);
    n := n + 1;
  END LOOP;

  RETURN format('Row-level company isolation enabled on %s tables.', n);
END $$;

CREATE OR REPLACE FUNCTION public.disable_multi_company() RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  t TEXT;
  n INT := 0;
BEGIN
  IF (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL) > 1 THEN
    RAISE EXCEPTION 'Cannot disable company isolation while more than one company exists — doing so would expose every company''s data to every user.';
  END IF;

  FOR t IN SELECT table_name FROM company_scoped_tables ORDER BY table_name LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
    n := n + 1;
  END LOOP;

  RETURN format('Row-level company isolation disabled on %s tables.', n);
END $$;

CREATE OR REPLACE FUNCTION public.multi_company_enabled() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT bool_and(c.relrowsecurity)
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN (SELECT table_name FROM company_scoped_tables)),
    false);
$$;

-- The gate. This is what makes the in-between state unreachable: a second
-- company cannot exist unless the boundary that separates it is already live.
CREATE OR REPLACE FUNCTION public.guard_company_insert() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL) >= 1
     AND NOT public.multi_company_enabled() THEN
    RAISE EXCEPTION
      'Refusing to create a second company while row-level isolation is off. Run SELECT enable_multi_company(); first — without it both companies would share every table with nothing separating them.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_company_insert ON companies;
CREATE TRIGGER trg_guard_company_insert
  BEFORE INSERT ON companies
  FOR EACH ROW EXECUTE FUNCTION public.guard_company_insert();

-- ===========================================================================
-- Intercompany
-- ===========================================================================
--
-- When one entity transacts with another in the group, both sets of books must
-- move: a sale from A to B is revenue and a receivable in A, and cost and a
-- payable in B. Recording only one side is the classic intercompany error —
-- the group consolidates to a number that never balances.
--
-- This table is the join between the two journal entries, which is what makes
-- elimination on consolidation possible: without it there is no way to tell an
-- intercompany receivable from a real one.

CREATE TABLE IF NOT EXISTS intercompany_transactions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reference           VARCHAR(40) NOT NULL UNIQUE,

  from_company_id     UUID NOT NULL REFERENCES companies(id),
  to_company_id       UUID NOT NULL REFERENCES companies(id),
  CONSTRAINT chk_intercompany_distinct CHECK (from_company_id <> to_company_id),

  transaction_type    VARCHAR(30) NOT NULL DEFAULT 'TRANSFER'
                      CHECK (transaction_type IN ('TRANSFER','SALE','LOAN','RECHARGE','ALLOCATION')),

  amount              DECIMAL(15,2) NOT NULL CHECK (amount > 0),
  currency            VARCHAR(3) NOT NULL DEFAULT 'USD',
  exchange_rate       DECIMAL(18,8) NOT NULL DEFAULT 1,

  transaction_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  description         TEXT,

  -- Both legs. Nullable only between INSERT and the second posting inside the
  -- same transaction; a committed row always has both.
  from_journal_entry_id UUID REFERENCES journal_entries(id),
  to_journal_entry_id   UUID REFERENCES journal_entries(id),

  status              VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','POSTED','ELIMINATED','CANCELLED')),

  -- Set when consolidation cancels the pair out.
  eliminated_at       TIMESTAMPTZ,
  eliminated_in_period VARCHAR(7),

  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_intercompany_from ON intercompany_transactions (from_company_id, transaction_date);
CREATE INDEX IF NOT EXISTS idx_intercompany_to   ON intercompany_transactions (to_company_id, transaction_date);
CREATE INDEX IF NOT EXISTS idx_intercompany_open ON intercompany_transactions (status)
  WHERE status = 'POSTED';

-- A posted intercompany transaction must have both legs. Enforced rather than
-- documented, because a one-legged intercompany entry is invisible until the
-- group fails to consolidate months later.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_intercompany_both_legs') THEN
    ALTER TABLE intercompany_transactions
      ADD CONSTRAINT chk_intercompany_both_legs
      CHECK (status <> 'POSTED'
             OR (from_journal_entry_id IS NOT NULL AND to_journal_entry_id IS NOT NULL));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.generate_intercompany_reference()
 RETURNS text LANGUAGE plpgsql AS $function$
DECLARE next_number INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('generate_intercompany_reference'));
    SELECT COALESCE(MAX(
        CASE WHEN reference ~ '^IC-[0-9]+$'
             THEN SUBSTRING(reference FROM '\-([0-9]+)$')::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM intercompany_transactions;
    RETURN 'IC-' || LPAD(next_number::TEXT, 6, '0');
END;
$function$;

-- ---------------------------------------------------------------------------
-- Due to / due from accounts.
--
-- These are what carry an intercompany balance until it is settled or
-- eliminated. Kept as ordinary COA accounts so they appear on the balance
-- sheet like anything else, and flagged so consolidation can find them.
-- ---------------------------------------------------------------------------
ALTER TABLE chart_of_accounts
  ADD COLUMN IF NOT EXISTS is_intercompany BOOLEAN NOT NULL DEFAULT false;

INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level,
   is_header, normal_balance, status, created_by, allow_manual_posting,
   balance_sheet_section, is_intercompany)
SELECT v.code, v.name, v.type, v.subtype, 3, false, v.normal, 'ACTIVE',
       (SELECT id FROM users ORDER BY created_at LIMIT 1), false, v.section, true
  FROM (VALUES
    ('1190', 'Due from Group Companies', 'ASSET',     'CURRENT_ASSET',     'DEBIT',  'CURRENT_ASSETS'),
    ('2190', 'Due to Group Companies',   'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT', 'CURRENT_LIABILITIES')
  ) AS v(code, name, type, subtype, normal, section)
 WHERE EXISTS (SELECT 1 FROM users)
   AND NOT EXISTS (SELECT 1 FROM chart_of_accounts coa WHERE coa.account_code = v.code);

COMMENT ON TABLE companies IS
  'Legal entities. Multi-company isolation is enforced by row-level security and is off until enable_multi_company() is run; a trigger refuses to create a second company before then.';
COMMENT ON TABLE intercompany_transactions IS
  'Links the two journal entries of a transaction between group companies, so intercompany balances can be identified and eliminated on consolidation.';
