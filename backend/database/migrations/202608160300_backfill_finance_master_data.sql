-- Backfill finance master data, GL control mappings and the DoA starter
-- grant for EVERY company that predates the provisioning that now runs at
-- signup.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- routes/auth.js's register-company path today seeds a new tenant with the
-- standard chart of accounts, cost centers, open accounting periods, and a
-- system-issued delegation-of-authority grant for the founding admin (so
-- DoA-gated approval queues like supplier approval and purchase requisitions
-- are usable by a single-admin company). Companies created before those
-- pieces existed (2026-08-12 and earlier signups; admin-created companies;
-- companies whose seed failed partway) have some, none, or a broken subset:
--
--   • chart_of_accounts empty (or only the 3210/5850 backfill rows) — the
--     journal entry account dropdown is empty and GL postings fail with
--     "Required accounts not found".
--   • cost_centers empty — the DoA form and budget screens expect them.
--   • accounting_periods empty — period-close machinery has no rows, and
--     journal entries cannot be dated into a period.
--   • company_gl_mappings empty — period close / FX revaluation / revenue
--     recognition refuse to run ("AR control account is not mapped").
--   • delegation_of_authority empty — pending-suppliers, PR approval, sales
--     approval queues all answer "No supplier approval authority" for a
--     single-admin company, with no way to create the first grant through
--     the product (POST /delegation-of-authority enforces four-eyes).
--
-- The register-company seed runs through models/ChartOfAccounts.js
-- (seedFinanceMasterData). This migration mirrors that JS seed in SQL so it
-- also applies to existing tenants, and deliberately uses account codes that
-- match the CURRENT standard chart (1120 Accounts Receivable, 2110 Accounts
-- Payable, 1130 Inventory, 2126 AI Reconciliation Suspense) — the Aug-2
-- period-close migration's AR_CONTROL mapping pointed at 1200, which has been
-- the Fixed Assets header since the chart renumbering, so copying it would
-- seed a wrong control account.
--
-- All statements are idempotent (ON CONFLICT DO NOTHING) and no-op cleanly
-- on a fresh database with no companies yet.

-- ---------------------------------------------------------------------------
-- 1. Standard chart of accounts for every company missing accounts.
--    (202608120500 seeded one company; 202608160100 added 3210/5850 to all.)
-- ---------------------------------------------------------------------------
INSERT INTO chart_of_accounts
  (company_id, account_code, account_name, account_type, account_subtype,
   account_level, is_header, normal_balance, status, created_by,
   allow_manual_posting, balance_sheet_section)
SELECT c.id, v.account_code, v.account_name, v.account_type, v.account_subtype,
       v.account_level, v.is_header, v.normal_balance, v.status,
       COALESCE((SELECT uc.user_id FROM user_companies uc
                  WHERE uc.company_id = c.id AND uc.is_primary
                  ORDER BY uc.created_at LIMIT 1),
                (SELECT id FROM users ORDER BY created_at LIMIT 1)),
       v.allow_manual_posting, v.balance_sheet_section
  FROM companies c
 CROSS JOIN (VALUES
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
    ('2126', 'AI Reconciliation Suspense', 'LIABILITY', 'CURRENT_LIABILITY', 3, false, 'CREDIT', 'ACTIVE', true, 'CURRENT_LIABILITIES'),
    ('2130', 'Short-term Debt', 'LIABILITY', 'SHORT_TERM_DEBT', 3, false, 'CREDIT', 'ACTIVE', true, 'CURRENT_LIABILITIES'),
    ('2140', 'Output VAT (VAT Payable)', 'LIABILITY', 'VAT_PAYABLE', 3, false, 'CREDIT', 'ACTIVE', true, 'CURRENT_LIABILITIES'),
    ('2200', 'Long-term Liabilities', 'LIABILITY', 'LONG_TERM_LIABILITY', 2, true, 'CREDIT', 'ACTIVE', false, 'LONG_TERM_LIABILITIES'),
    ('2210', 'Long-term Debt', 'LIABILITY', 'LONG_TERM_DEBT', 3, false, 'CREDIT', 'ACTIVE', true, 'LONG_TERM_LIABILITIES'),
    ('3000', 'EQUITY', 'EQUITY', 'HEADER', 1, true, 'CREDIT', 'ACTIVE', false, 'EQUITY'),
    ('3100', 'Share Capital', 'EQUITY', 'SHARE_CAPITAL', 2, false, 'CREDIT', 'ACTIVE', true, 'EQUITY'),
    ('3200', 'Retained Earnings', 'EQUITY', 'RETAINED_EARNINGS', 2, false, 'CREDIT', 'ACTIVE', true, 'EQUITY'),
    ('3210', 'Revaluation Surplus', 'EQUITY', 'RESERVES', 3, false, 'CREDIT', 'ACTIVE', true, 'EQUITY'),
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
    ('5850', 'Impairment Loss on Assets', 'EXPENSE', 'OPERATING_EXPENSE', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'),
    ('5900', 'Loss on Asset Disposal', 'EXPENSE', 'OTHER_EXPENSE', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'),
    ('5910', 'Foreign Exchange Loss', 'EXPENSE', 'OTHER_EXPENSE', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES')
 ) AS v(account_code, account_name, account_type, account_subtype, account_level,
        is_header, normal_balance, status, allow_manual_posting, balance_sheet_section)
 WHERE c.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM users)
ON CONFLICT (company_id, account_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Standard cost centers for every company (the DoA form and budget
--    screens expect them).
-- ---------------------------------------------------------------------------
INSERT INTO cost_centers (company_id, code, name, status, created_by)
SELECT c.id, v.code, v.name, 'ACTIVE',
       COALESCE((SELECT uc.user_id FROM user_companies uc
                  WHERE uc.company_id = c.id AND uc.is_primary
                  ORDER BY uc.created_at LIMIT 1),
                (SELECT id FROM users ORDER BY created_at LIMIT 1))
  FROM companies c
 CROSS JOIN (VALUES
    ('SALES',       'Sales Department'),
    ('PROCUREMENT', 'Procurement Department'),
    ('OPERATIONS',  'Operations Department'),
    ('FINANCE',     'Finance Department'),
    ('IT',          'IT Department'),
    ('HR',          'Human Resources'),
    ('WAREHOUSE',   'Warehouse & Logistics')
 ) AS v(code, name)
 WHERE c.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM users)
ON CONFLICT (company_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Open accounting periods: previous, current and next year for every
--    company (same window models/ChartOfAccounts.js seeds at signup; the
--    per-company unique key comes from migration 202608130100).
-- ---------------------------------------------------------------------------
INSERT INTO accounting_periods (company_id, period_year, period_month, status)
SELECT c.id, y, m, 'OPEN'
  FROM companies c
 CROSS JOIN generate_series(EXTRACT(YEAR FROM CURRENT_DATE)::int - 1,
                            EXTRACT(YEAR FROM CURRENT_DATE)::int + 1) AS y
 CROSS JOIN generate_series(1, 12) AS m
 WHERE c.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Default GL control mappings for every company (period close, FX
--    revaluation and revenue recognition all refuse to run without them).
--    Codes match the current standard chart; ON CONFLICT never overwrites
--    explicit configuration an admin has set.
-- ---------------------------------------------------------------------------
INSERT INTO company_gl_mappings (company_id, purpose, account_code)
SELECT c.id, m.purpose, m.account_code
  FROM companies c
 CROSS JOIN (VALUES ('AR_CONTROL', '1120'),
                    ('AP_CONTROL', '2110'),
                    ('INVENTORY_CONTROL', '1130'),
                    ('RECON_SUSPENSE', '2126')) AS m(purpose, account_code)
 WHERE c.deleted_at IS NULL
ON CONFLICT (company_id, purpose) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. DoA starter grant: every primary user of a company that has no DoA rows
--    at all gets the same system-issued grant the signup path gives a new
--    founding admin ('ALL' cost center, unbounded amount, all transaction
--    types). Without it a single-admin company can never approve anything
--    through a DoA-gated queue, and four-eyes blocks creating the first
--    grant through the product. Only fires for companies with zero grants,
--    so existing governance setups are untouched.
-- ---------------------------------------------------------------------------
INSERT INTO delegation_of_authority
  (company_id, cost_center, user_id, min_amount, max_amount, applies_to,
   effective_from, created_by)
SELECT uc.company_id, 'ALL', uc.user_id, 0, 999999999999.99, 'ALL',
       CURRENT_DATE, uc.user_id
  FROM user_companies uc
 WHERE uc.is_primary = true
   AND NOT EXISTS (
     SELECT 1 FROM delegation_of_authority d
      WHERE d.company_id = uc.company_id AND d.user_id = uc.user_id)
   AND NOT EXISTS (
     SELECT 1 FROM delegation_of_authority d2
      WHERE d2.company_id = uc.company_id)
ON CONFLICT DO NOTHING;
