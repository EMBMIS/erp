-- Gain/Loss on asset disposal accounts, used when a fixed asset is disposed.
--   4900  Gain on Asset Disposal  — REVENUE
--   5900  Loss on Asset Disposal  — EXPENSE
-- Idempotent: only inserts accounts that are not already present.

INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level, is_header, normal_balance, status, created_by, allow_manual_posting, balance_sheet_section)
SELECT '4900', 'Gain on Asset Disposal', 'REVENUE', 'OTHER_INCOME', 3, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'REVENUE'
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_code = '4900');

INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level, is_header, normal_balance, status, created_by, allow_manual_posting, balance_sheet_section)
SELECT '5900', 'Loss on Asset Disposal', 'EXPENSE', 'OTHER_EXPENSE', 3, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'OPERATING_EXPENSES'
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_code = '5900');
