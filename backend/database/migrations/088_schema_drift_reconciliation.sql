-- 088 — Schema-drift reconciliation + concurrency-safe journal numbering.
--
-- Background (from the independent audit): several earlier migrations use
-- CREATE TABLE IF NOT EXISTS, which silently no-ops when an older version of the
-- table already exists — so columns added in later revisions never landed on
-- databases that pre-dated them. This migration re-asserts the columns the
-- models actually require, using ADD COLUMN IF NOT EXISTS so it is safe on both
-- fresh and drifted databases. It also re-applies the journal-number function
-- (fixing the ambiguous-column bug) and hardens it against concurrent posting.
--
-- Fully idempotent: safe to run any number of times.

-- ---------------------------------------------------------------------------
-- B5: supplier_invoices missing columns (purchase_order_id was the live break)
-- ---------------------------------------------------------------------------
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS purchase_order_id UUID REFERENCES purchase_orders(id);
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS journal_entry_id UUID REFERENCES journal_entries(id);
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS supplier_invoice_number VARCHAR(100);
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(100);

-- ---------------------------------------------------------------------------
-- B5: employees allowance columns (richer payroll, migration 078) — re-assert
-- ---------------------------------------------------------------------------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS housing_allowance   DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS transport_allowance DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS other_allowance     DECIMAL(15,2) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Missing GL accounts referenced by code but absent from some charts:
--   5900 Loss on Disposal of Assets (FixedAsset.dispose)
-- ---------------------------------------------------------------------------
INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level, is_header, normal_balance, status, created_by, allow_manual_posting, balance_sheet_section)
SELECT '5900', 'Loss on Disposal of Assets', 'EXPENSE', 'OPERATING_EXPENSE', 3, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, NULL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_code = '5900');

INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level, is_header, normal_balance, status, created_by, allow_manual_posting, balance_sheet_section)
SELECT '4900', 'Gain on Disposal of Assets', 'REVENUE', 'OTHER_INCOME', 3, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, NULL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_code = '4900');

-- ---------------------------------------------------------------------------
-- B3 + B9: journal-number generation.
--   * B3: local variable renamed away from the journal_number column (ambiguity).
--   * B9: transaction-level advisory lock serializes the MAX()+1 read so two
--     concurrent postings can never compute the same number (which otherwise
--     surfaces as a user-facing 500 on the UNIQUE constraint under load).
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- B7: allow dedicated finance roles to actually be assigned. The route layer
-- already recognizes FINANCE_USER / FINANCE_MANAGER (and treats MANAGER/ADMIN as
-- carrying finance authority); this widens the users.role CHECK so those roles
-- can be stored. Existing ADMIN/MANAGER/USER values remain valid.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('ADMIN', 'MANAGER', 'USER', 'FINANCE_MANAGER', 'FINANCE_USER'));
EXCEPTION WHEN others THEN
  RAISE NOTICE 'users_role_check not updated: %', SQLERRM;
END $$;

CREATE OR REPLACE FUNCTION generate_journal_entry_number()
RETURNS VARCHAR(50) AS $$
DECLARE
    next_number INTEGER;
    year_suffix VARCHAR(4);
    v_journal_number VARCHAR(50);
BEGIN
    -- Serialize concurrent number generation within their transactions.
    PERFORM pg_advisory_xact_lock(hashtext('generate_journal_entry_number'));

    year_suffix := TO_CHAR(CURRENT_DATE, 'YYYY');

    SELECT COALESCE(MAX(CAST(SUBSTRING(je.journal_number FROM 'JE-' || year_suffix || '-(\d+)') AS INTEGER)), 0) + 1
    INTO next_number
    FROM journal_entries je
    WHERE je.journal_number LIKE 'JE-' || year_suffix || '-%';

    v_journal_number := 'JE-' || year_suffix || '-' || LPAD(next_number::TEXT, 6, '0');

    RETURN v_journal_number;
END;
$$ LANGUAGE plpgsql;
