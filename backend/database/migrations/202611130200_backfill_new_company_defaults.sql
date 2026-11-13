-- 202611130200 — The finance defaults every company needs, for companies created
-- after the migrations that seeded them.
--
-- Three migrations gave the companies that existed when they ran something
-- the signup seed (ChartOfAccounts.seedFinanceMasterData) did not: 202608120100
-- the default approval chains, 202608160300 the GL control mappings and the
-- 2126 suspense account, 202608200100 the manufacturing accounts. A company
-- that signed up later had none of them:
--   * no JOURNAL_ENTRY template: JournalEntry.create fails closed to
--     PENDING_APPROVAL with no chain to approve through, so the general ledger
--     was frozen from the first entry;
--   * no control mappings: period close, FX revaluation, revenue recognition
--     and continuous close refuse to run.
-- seedFinanceMasterData now seeds all of it for new companies; this gives the
-- same defaults to the ones in between. Idempotent; nothing a company set up
-- itself is changed: an account or mapping that exists is left alone, a
-- template is added only for a document type the company has none for (active
-- or not), and steps only to the templates added here. Runs on the owner
-- connection (scripts/db-migrate.js), so company_id is always explicit.

-- Accounts the defaults point at (same rows as models/ChartOfAccounts.js).
INSERT INTO chart_of_accounts
  (company_id, account_code, account_name, account_type, account_subtype,
   account_level, is_header, normal_balance, status, created_by,
   allow_manual_posting, balance_sheet_section)
SELECT c.id, v.account_code, v.account_name, v.account_type, v.account_subtype,
       v.account_level, v.is_header, v.normal_balance, 'ACTIVE', owner.user_id,
       true, v.balance_sheet_section
  FROM companies c
  JOIN LATERAL (
    SELECT COALESCE(
      (SELECT uc.user_id FROM user_companies uc WHERE uc.company_id = c.id AND uc.is_primary
        ORDER BY uc.created_at LIMIT 1),
      (SELECT created_by FROM chart_of_accounts WHERE company_id = c.id AND created_by IS NOT NULL LIMIT 1)) AS user_id
  ) owner ON owner.user_id IS NOT NULL
 CROSS JOIN (VALUES
    ('1135', 'Work In Progress', 'ASSET', 'CURRENT_ASSET', 3, false, 'DEBIT', 'CURRENT_ASSETS'),
    ('2126', 'AI Reconciliation Suspense', 'LIABILITY', 'CURRENT_LIABILITY', 3, false, 'CREDIT', 'CURRENT_LIABILITIES'),
    ('5150', 'Manufacturing Variance', 'EXPENSE', 'COST_OF_SALES', 3, false, 'DEBIT', 'EXPENSES')
 ) AS v(account_code, account_name, account_type, account_subtype, account_level, is_header,
        normal_balance, balance_sheet_section)
 WHERE c.deleted_at IS NULL
   -- Only companies that have a chart at all: one without is not set up, and
   -- giving it three stray accounts would not make it usable.
   AND EXISTS (SELECT 1 FROM chart_of_accounts x WHERE x.company_id = c.id)
ON CONFLICT (company_id, account_code) DO NOTHING;

-- GL control mappings.
INSERT INTO company_gl_mappings (company_id, purpose, account_code)
SELECT c.id, m.purpose, m.account_code
  FROM companies c
 CROSS JOIN (VALUES ('AR_CONTROL', '1120'),
                    ('AP_CONTROL', '2110'),
                    ('INVENTORY_CONTROL', '1130'),
                    ('RECON_SUSPENSE', '2126')) AS m(purpose, account_code)
 WHERE c.deleted_at IS NULL
ON CONFLICT (company_id, purpose) DO NOTHING;

-- Approval chains.
CREATE TEMP TABLE backfilled_chain_templates (id UUID, document_type TEXT) ON COMMIT DROP;

WITH doc_types (document_type, name) AS (
  VALUES ('JOURNAL_ENTRY',    'Journal Entry Approval'),
         ('PURCHASE_ORDER',   'Purchase Order Approval'),
         ('SALES_ORDER',      'Sales Order Approval'),
         ('SUPPLIER_INVOICE', 'Supplier Invoice Approval'),
         ('CUSTOMER_PAYMENT', 'Customer Payment Approval'),
         ('SUPPLIER_PAYMENT', 'Supplier Payment Approval'),
         ('CREDIT_NOTE',      'Credit Note Approval'),
         ('PAYROLL_RUN',      'Payroll Run Approval')
), inserted AS (
  INSERT INTO approval_chain_templates (name, document_type, is_active, created_by, company_id)
  SELECT d.name, d.document_type, true, NULL, c.id
    FROM companies c CROSS JOIN doc_types d
   WHERE c.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM approval_chain_templates t
                      WHERE t.company_id = c.id AND t.document_type = d.document_type)
  RETURNING id, document_type
)
INSERT INTO backfilled_chain_templates SELECT id, document_type FROM inserted;

INSERT INTO approval_chain_steps (template_id, step_number, min_amount, approver_role)
SELECT b.id, v.step_number, v.min_amount, v.approver_role
  FROM backfilled_chain_templates b
  JOIN (VALUES
    ('JOURNAL_ENTRY',    1, 1000::DECIMAL,   'FINANCE_MANAGER'),
    ('JOURNAL_ENTRY',    2, 25000::DECIMAL,  'ADMIN'),
    ('PURCHASE_ORDER',   1, 1000::DECIMAL,   'MANAGER'),
    ('PURCHASE_ORDER',   2, 25000::DECIMAL,  'ADMIN'),
    ('SALES_ORDER',      1, 5000::DECIMAL,   'MANAGER'),
    ('SALES_ORDER',      2, 50000::DECIMAL,  'ADMIN'),
    ('SUPPLIER_INVOICE', 1, 1000::DECIMAL,   'FINANCE_MANAGER'),
    ('SUPPLIER_INVOICE', 2, 25000::DECIMAL,  'ADMIN'),
    ('CUSTOMER_PAYMENT', 1, 5000::DECIMAL,   'FINANCE_MANAGER'),
    ('CUSTOMER_PAYMENT', 2, 50000::DECIMAL,  'ADMIN'),
    ('SUPPLIER_PAYMENT', 1, 5000::DECIMAL,   'FINANCE_MANAGER'),
    ('SUPPLIER_PAYMENT', 2, 50000::DECIMAL,  'ADMIN'),
    ('CREDIT_NOTE',      1, 500::DECIMAL,    'FINANCE_MANAGER'),
    ('CREDIT_NOTE',      2, 10000::DECIMAL,  'ADMIN'),
    ('PAYROLL_RUN',      1, 0::DECIMAL,      'FINANCE_MANAGER'),
    ('PAYROLL_RUN',      2, 100000::DECIMAL, 'ADMIN')
  ) AS v(document_type, step_number, min_amount, approver_role)
    ON v.document_type = b.document_type;
