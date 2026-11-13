-- VAT / Tax control accounts for the tax engine.
--   1160  Input VAT (VAT Receivable)  — ASSET     — VAT paid on purchases
--   2140  Output VAT (VAT Payable)    — LIABILITY — VAT collected on sales
-- Net VAT due to the tax authority = Output VAT (2140) - Input VAT (1160).
-- Idempotent: only inserts accounts that are not already present.

INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level, is_header, normal_balance, status, created_by, allow_manual_posting, balance_sheet_section)
SELECT '1160', 'Input VAT (VAT Receivable)', 'ASSET', 'VAT_RECEIVABLE', 3, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'CURRENT_ASSETS'
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_code = '1160');

INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level, is_header, normal_balance, status, created_by, allow_manual_posting, balance_sheet_section)
SELECT '2140', 'Output VAT (VAT Payable)', 'LIABILITY', 'VAT_PAYABLE', 3, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'CURRENT_LIABILITIES'
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_code = '2140');
