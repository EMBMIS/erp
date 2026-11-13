-- 091 — Re-assert multi-currency columns (originally migration 077).
--
-- 077 was recorded as applied during brownfield baselining but its effects were
-- not actually present on this database — customer_invoices/supplier_invoices had
-- no exchange_rate/base_amount, which broke invoice generation. This re-applies
-- 077's schema idempotently so the multi-currency invoice/payment code works.
-- Idempotent.

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
