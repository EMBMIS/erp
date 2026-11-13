-- Multi-currency posting support.
--  * exchange_rate / base_amount columns record the rate used to convert a
--    document to the base currency and the resulting base-currency total.
--  * FX gain/loss accounts recognize realized foreign-exchange differences when
--    a foreign-currency invoice/bill is settled at a different rate.
-- Idempotent: only adds columns/accounts that are missing.

ALTER TABLE customer_invoices  ADD COLUMN IF NOT EXISTS exchange_rate DECIMAL(18,8) NOT NULL DEFAULT 1;
ALTER TABLE customer_invoices  ADD COLUMN IF NOT EXISTS base_amount   DECIMAL(15,2);
ALTER TABLE customer_payments  ADD COLUMN IF NOT EXISTS base_amount   DECIMAL(15,2);
ALTER TABLE supplier_invoices  ADD COLUMN IF NOT EXISTS exchange_rate DECIMAL(18,8) NOT NULL DEFAULT 1;
ALTER TABLE supplier_invoices  ADD COLUMN IF NOT EXISTS base_amount   DECIMAL(15,2);
ALTER TABLE supplier_payments  ADD COLUMN IF NOT EXISTS base_amount   DECIMAL(15,2);

-- FX gain (revenue) and FX loss (expense) accounts.
INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level, is_header, normal_balance, status, created_by, allow_manual_posting, balance_sheet_section)
SELECT '4910', 'Foreign Exchange Gain', 'REVENUE', 'OTHER_INCOME', 3, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'REVENUE'
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_code = '4910');

INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level, is_header, normal_balance, status, created_by, allow_manual_posting, balance_sheet_section)
SELECT '5910', 'Foreign Exchange Loss', 'EXPENSE', 'OTHER_EXPENSE', 3, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'OPERATING_EXPENSES'
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_code = '5910');
