-- Seeds the account PayrollRun.post() looks for when posting employer-
-- matched FICA (migration 202608090400/401's statutory withholding). Only
-- for the pre-existing default company — self-service signups build their
-- own chart of accounts and would add this the same way they add any other
-- account. Idempotent (ON CONFLICT DO NOTHING on the account_code unique
-- index — see 202608090200).
INSERT INTO chart_of_accounts (
  company_id, account_code, account_name, account_type, account_subtype, account_level,
  is_header, normal_balance, status, created_by, allow_manual_posting, balance_sheet_section
)
SELECT c.id, '5211', 'Payroll Tax Expense (Employer)', 'EXPENSE', 'OPERATING_EXPENSE', 3,
       false, 'DEBIT', 'ACTIVE', u.id, true, 'OTHER'
  FROM companies c
  JOIN users u ON u.role = 'ADMIN' AND u.deleted_at IS NULL
 WHERE c.is_default = true AND c.deleted_at IS NULL
 ORDER BY u.created_at ASC
 LIMIT 1
ON CONFLICT (company_id, account_code) DO NOTHING;
