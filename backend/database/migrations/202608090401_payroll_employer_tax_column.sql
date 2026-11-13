-- Split out from 202608090400 (already applied before this column was added
-- to that file) — same change, its own migration so it actually runs.
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS employer_payroll_tax NUMERIC(15,2) NOT NULL DEFAULT 0;
COMMENT ON COLUMN payroll_runs.employer_payroll_tax IS 'Sum of employer-matched FICA across the run — a real additional expense to the company, posted as its own journal entry line by PayrollRun.post(), separate from gross wages.';
