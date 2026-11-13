-- 093 — GR/IR (Goods Received / Invoice Received) clearing account.
--
-- Introduces proper received-not-invoiced accounting for Procure-to-Pay:
--   * Goods receipt:     Dr Inventory (1130) / Cr GR/IR clearing (2115)
--   * Supplier invoice:  Dr GR/IR (2115) + Dr Input VAT (1160) / Cr AP (2110)
-- The GR/IR account nets to zero once everything received has been invoiced; a
-- residual credit = received-not-invoiced, a residual debit = invoiced-not-received.
-- Idempotent.

INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level, is_header, normal_balance, status, created_by, allow_manual_posting, balance_sheet_section)
SELECT '2115', 'GR/IR Clearing (Goods Received Not Invoiced)', 'LIABILITY', 'ACCRUED_EXPENSES', 3, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'CURRENT_LIABILITIES'
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_code = '2115');
