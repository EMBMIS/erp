-- Seed the general ledger and finance master data for the deployment's
-- DEFAULT company (the row flagged is_default = true; otherwise the oldest
-- company; otherwise the owner UUID the original migrations targeted).
--
-- WHY: migrations 063/067/074/077/093/202608090402 are RECORDED as applied on
-- this database (baseline manifest adoption) but their seed INSERTs never ran,
-- so chart_of_accounts / accounting_periods / cost_centers are empty and every
-- GL posting (goods receipt, invoices, payments, credit notes, payroll) fails
-- with "Required accounts not found". This re-seeds the same accounts the
-- original migrations defined, scoped to the default company, idempotently.
--
-- The account list is generated from the original seed migrations, so it
-- matches the chart the code expects (1110/1120/1130/1160/2110/2115/2140/3200/
-- 4100/4910/5100/5210/5211/5910, headers, sections). ON CONFLICT (company_id,
-- account_code) keeps it safe to re-run.
--
-- Company resolution is DYNAMIC, not a hardcoded UUID: the first cut pinned
-- '18575681-4f4d-4034-b403-bb26a766e301', a UUID that only exists in the
-- database where the migration was authored. On any other deployment that
-- insert violates fk_chart_of_accounts_company and the whole migration fails.
-- (Same class of bug as the dead company_id column defaults fixed in 0400.)
-- is_default -> oldest company -> the original owner UUID (only if it exists),
-- so this seeds the right tenant on every deployment and no-ops on a fresh
-- database that has no companies yet (the first signup creates them).

-- Resolve the seed target: prefer the flagged default company.
CREATE TEMP TABLE seed_target_company AS
  SELECT id FROM companies WHERE is_default = true ORDER BY created_at LIMIT 1;

-- Fallback: any company (a deployment that never flags one).
INSERT INTO seed_target_company
SELECT id FROM companies
WHERE NOT EXISTS (SELECT 1 FROM seed_target_company)
ORDER BY created_at LIMIT 1;

-- Last resort: the original owner UUID, only when that row actually exists.
INSERT INTO seed_target_company
SELECT '18575681-4f4d-4034-b403-bb26a766e301'::uuid
WHERE NOT EXISTS (SELECT 1 FROM seed_target_company)
  AND EXISTS (SELECT 1 FROM companies WHERE id = '18575681-4f4d-4034-b403-bb26a766e301');

-- On a fresh database there are no companies yet; the first signup creates
-- them and the app seeds on that path. Report and skip, like migration 0400.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM seed_target_company) THEN
    RAISE NOTICE 'No companies exist — GL seed deferred to first signup (fresh database).';
  END IF;
END $$;

WITH seeds(account_code, account_name, account_type, account_subtype, account_level,
           is_header, normal_balance, status, allow_manual_posting, balance_sheet_section) AS (
  VALUES
    ('1000', 'ASSETS', 'ASSET', 'HEADER', 1, true, 'DEBIT', 'ACTIVE', false, 'ASSETS'),
    ('1100', 'Current Assets', 'ASSET', 'CURRENT_ASSET', 2, true, 'DEBIT', 'ACTIVE', false, 'CURRENT_ASSETS'),
    ('1110', 'Cash and Cash Equivalents', 'ASSET', 'CASH', 3, false, 'DEBIT', 'ACTIVE', true, 'CURRENT_ASSETS'),
    ('1120', 'Accounts Receivable', 'ASSET', 'ACCOUNTS_RECEIVABLE', 3, false, 'DEBIT', 'ACTIVE', true, 'CURRENT_ASSETS'),
    ('1130', 'Inventory', 'ASSET', 'INVENTORY', 3, false, 'DEBIT', 'ACTIVE', true, 'CURRENT_ASSETS'),
    ('1140', 'Prepaid Expenses', 'ASSET', 'PREPAID', 3, false, 'DEBIT', 'ACTIVE', true, 'CURRENT_ASSETS'),
    ('1160', 'Input VAT (VAT Receivable)', 'ASSET', 'VAT_RECEIVABLE', 3, false, 'DEBIT', 'ACTIVE', true, 'CURRENT_ASSETS'),
    ('1200', 'Fixed Assets', 'ASSET', 'FIXED_ASSET', 2, true, 'DEBIT', 'ACTIVE', false, 'FIXED_ASSETS'),
    ('1210', 'Property, Plant & Equipment', 'ASSET', 'PPE', 3, false, 'DEBIT', 'ACTIVE', true, 'FIXED_ASSETS'),
    ('1220', 'Accumulated Depreciation', 'ASSET', 'ACCUMULATED_DEPRECIATION', 3, false, 'CREDIT', 'ACTIVE', true, 'FIXED_ASSETS'),
    ('2000', 'LIABILITIES', 'LIABILITY', 'HEADER', 1, true, 'CREDIT', 'ACTIVE', false, 'LIABILITIES'),
    ('2100', 'Current Liabilities', 'LIABILITY', 'CURRENT_LIABILITY', 2, true, 'CREDIT', 'ACTIVE', false, 'CURRENT_LIABILITIES'),
    ('2110', 'Accounts Payable', 'LIABILITY', 'ACCOUNTS_PAYABLE', 3, false, 'CREDIT', 'ACTIVE', true, 'CURRENT_LIABILITIES'),
    ('2115', 'GR/IR Clearing (Goods Received Not Invoiced)', 'LIABILITY', 'ACCRUED_EXPENSES', 3, false, 'CREDIT', 'ACTIVE', true, 'CURRENT_LIABILITIES'),
    ('2120', 'Accrued Expenses', 'LIABILITY', 'ACCRUED_EXPENSES', 3, false, 'CREDIT', 'ACTIVE', true, 'CURRENT_LIABILITIES'),
    ('2130', 'Short-term Debt', 'LIABILITY', 'SHORT_TERM_DEBT', 3, false, 'CREDIT', 'ACTIVE', true, 'CURRENT_LIABILITIES'),
    ('2140', 'Output VAT (VAT Payable)', 'LIABILITY', 'VAT_PAYABLE', 3, false, 'CREDIT', 'ACTIVE', true, 'CURRENT_LIABILITIES'),
    ('2200', 'Long-term Liabilities', 'LIABILITY', 'LONG_TERM_LIABILITY', 2, true, 'CREDIT', 'ACTIVE', false, 'LONG_TERM_LIABILITIES'),
    ('2210', 'Long-term Debt', 'LIABILITY', 'LONG_TERM_DEBT', 3, false, 'CREDIT', 'ACTIVE', true, 'LONG_TERM_LIABILITIES'),
    ('3000', 'EQUITY', 'EQUITY', 'HEADER', 1, true, 'CREDIT', 'ACTIVE', false, 'EQUITY'),
    ('3100', 'Share Capital', 'EQUITY', 'SHARE_CAPITAL', 2, false, 'CREDIT', 'ACTIVE', true, 'EQUITY'),
    ('3200', 'Retained Earnings', 'EQUITY', 'RETAINED_EARNINGS', 2, false, 'CREDIT', 'ACTIVE', true, 'EQUITY'),
    ('4000', 'REVENUE', 'REVENUE', 'HEADER', 1, true, 'CREDIT', 'ACTIVE', false, 'REVENUE'),
    ('4100', 'Sales Revenue', 'REVENUE', 'SALES_REVENUE', 2, false, 'CREDIT', 'ACTIVE', true, 'REVENUE'),
    ('4200', 'Service Revenue', 'REVENUE', 'SERVICE_REVENUE', 2, false, 'CREDIT', 'ACTIVE', true, 'REVENUE'),
    ('4900', 'Other Revenue', 'REVENUE', 'OTHER_REVENUE', 2, false, 'CREDIT', 'ACTIVE', true, 'REVENUE'),
    ('4910', 'Foreign Exchange Gain', 'REVENUE', 'OTHER_INCOME', 3, false, 'CREDIT', 'ACTIVE', true, 'REVENUE'),
    ('5000', 'EXPENSES', 'EXPENSE', 'HEADER', 1, true, 'DEBIT', 'ACTIVE', false, 'EXPENSES'),
    ('5100', 'Cost of Goods Sold', 'EXPENSE', 'COGS', 2, false, 'DEBIT', 'ACTIVE', true, 'EXPENSES'),
    ('5200', 'Operating Expenses', 'EXPENSE', 'OPERATING_EXPENSE', 2, true, 'DEBIT', 'ACTIVE', false, 'OPERATING_EXPENSES'),
    ('5210', 'Salaries and Wages', 'EXPENSE', 'PAYROLL', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'),
    ('5211', 'Payroll Tax Expense (Employer)', 'EXPENSE', 'OPERATING_EXPENSE', 3, false, 'DEBIT', 'ACTIVE', true, 'OTHER'),
    ('5220', 'Rent Expense', 'EXPENSE', 'RENT', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'),
    ('5230', 'Utilities Expense', 'EXPENSE', 'UTILITIES', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'),
    ('5240', 'Office Supplies', 'EXPENSE', 'SUPPLIES', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'),
    ('5250', 'Professional Services', 'EXPENSE', 'PROFESSIONAL_SERVICES', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'),
    ('5260', 'Depreciation Expense', 'EXPENSE', 'DEPRECIATION', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'),
    ('5900', 'Loss on Asset Disposal', 'EXPENSE', 'OTHER_EXPENSE', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'),
    ('5910', 'Foreign Exchange Loss', 'EXPENSE', 'OTHER_EXPENSE', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES')
)
INSERT INTO chart_of_accounts (account_code, account_name, account_type, account_subtype, account_level,
                               is_header, normal_balance, status, created_by, allow_manual_posting,
                               balance_sheet_section, company_id)
SELECT account_code, account_name, account_type, account_subtype, account_level,
       is_header, normal_balance, status,
       (SELECT id FROM users ORDER BY created_at LIMIT 1),
       allow_manual_posting, balance_sheet_section,
       (SELECT id FROM seed_target_company)
FROM seeds
WHERE EXISTS (SELECT 1 FROM seed_target_company)
ON CONFLICT (company_id, account_code) DO NOTHING;

-- Cost centers the DoA form and budget screens expect.
INSERT INTO cost_centers (company_id, code, name, status, created_by)
SELECT (SELECT id FROM seed_target_company), v.code, v.name, 'ACTIVE',
       (SELECT id FROM users ORDER BY created_at LIMIT 1)
FROM (VALUES
    ('SALES',       'Sales Department'),
    ('PROCUREMENT', 'Procurement Department'),
    ('OPERATIONS',  'Operations Department'),
    ('FINANCE',     'Finance Department'),
    ('IT',          'IT Department'),
    ('HR',          'Human Resources'),
    ('WAREHOUSE',   'Warehouse & Logistics')
) AS v(code, name)
WHERE EXISTS (SELECT 1 FROM seed_target_company)
ON CONFLICT (company_id, code) DO NOTHING;

-- Open accounting periods so the period-close machinery has real rows.
-- NOTE: accounting_periods is globally unique on (period_year, period_month)
-- while company-scoped under RLS — a known multi-company wart, acceptable for
-- the single-tenant demo, listed in ERP-Ready-Roadmap §1.
INSERT INTO accounting_periods (company_id, period_year, period_month, status)
SELECT (SELECT id FROM seed_target_company), y, m, 'OPEN'
  FROM generate_series(2025, 2027) AS y,
       generate_series(1, 12) AS m
WHERE EXISTS (SELECT 1 FROM seed_target_company)
ON CONFLICT (period_year, period_month) DO NOTHING;
