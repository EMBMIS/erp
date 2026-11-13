-- Real US federal payroll withholding, replacing PayrollRun.createAndProcess's
-- single flat "deduction_rate percent of gross" with actual statutory
-- calculation: federal income tax (IRS Pub 15-T percentage method) plus FICA
-- (Social Security + Medicare, both halves — employee withheld, employer
-- matched). Jurisdiction scope is deliberately US-federal only for this
-- pass — state/local withholding varies too much by state to seed honestly
-- without picking specific states, matching how tax_jurisdictions
-- (migration 202608090300) scoped VAT/GST/sales-tax rather than guessing at
-- every jurisdiction on earth.
--
-- Idempotent.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS filing_status TEXT NOT NULL DEFAULT 'SINGLE'
  CHECK (filing_status IN ('SINGLE', 'MARRIED_JOINT', 'HEAD_OF_HOUSEHOLD'));
COMMENT ON COLUMN employees.filing_status IS 'W-4 filing status, drives federal withholding bracket selection (services/payrollTaxService.js).';

-- payroll_items.deductions stays as the total (existing callers read it), but
-- the statutory pieces that make it up are now itemized rather than one
-- opaque "deduction_rate% of gross" number nobody could audit or reconcile
-- against an actual W-2 / employer tax filing.
ALTER TABLE payroll_items ADD COLUMN IF NOT EXISTS federal_tax_withheld NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_items ADD COLUMN IF NOT EXISTS social_security_employee NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_items ADD COLUMN IF NOT EXISTS medicare_employee NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_items ADD COLUMN IF NOT EXISTS social_security_employer NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_items ADD COLUMN IF NOT EXISTS medicare_employer NUMERIC(15,2) NOT NULL DEFAULT 0;
COMMENT ON COLUMN payroll_items.social_security_employer IS 'Employer-matched portion — a real cost to the company, not withheld from the employee, but not part of net pay either. Posted to its own payroll tax expense/payable line.';
-- payroll_runs.employer_payroll_tax is added in 202608090401 (this file was
-- already applied by the time that column was needed).
