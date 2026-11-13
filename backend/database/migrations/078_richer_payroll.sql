-- Richer payroll:
--  * Employee monthly allowances (housing/transport/other) added to gross pay.
--  * Salaries Payable (2125) and Payroll Tax Payable (2126) so payroll accrues
--    on posting and is settled by a separate payment (accrue-then-pay), and
--    withholdings sit in a real tax-payable account.
--  * payroll_runs gains a PAID status for the settlement step.
-- Idempotent.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS housing_allowance   DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS transport_allowance DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS other_allowance     DECIMAL(15,2) NOT NULL DEFAULT 0;

INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level, is_header, normal_balance, status, created_by, allow_manual_posting, balance_sheet_section)
SELECT '2125', 'Salaries Payable', 'LIABILITY', 'ACCRUED_EXPENSES', 3, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'CURRENT_LIABILITIES'
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_code = '2125');

INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, account_subtype, account_level, is_header, normal_balance, status, created_by, allow_manual_posting, balance_sheet_section)
SELECT '2126', 'Payroll Tax Payable', 'LIABILITY', 'ACCRUED_EXPENSES', 3, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'CURRENT_LIABILITIES'
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_code = '2126');

ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS chk_payroll_run_status;
ALTER TABLE payroll_runs ADD CONSTRAINT chk_payroll_run_status
CHECK (status IN ('DRAFT', 'PROCESSED', 'POSTED', 'PAID'));
