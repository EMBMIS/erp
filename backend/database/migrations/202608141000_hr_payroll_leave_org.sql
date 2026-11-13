-- HR: 6 -> 10 (payroll approval gate, leave accrual + balance ledger, org
-- chart, job history, document vault).
--
-- Also closes a real cross-tenant leak found while reading this module for
-- this pass: leave_requests and attendance_records were never given a
-- company_id column, so they were never registered in company_scoped_tables
-- and therefore never protected by row-level security at all — any
-- authenticated user could read/write any company's leave requests and
-- clock-ins. Every other employee-linked table (employees, payroll_runs) was
-- already scoped; these two were the exception, not a deliberate design.
--
-- Idempotent.

-- ===========================================================================
-- 0. Close the leave_requests / attendance_records isolation gap
-- ===========================================================================
DO $$
DECLARE
  default_id UUID;
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leave_requests' AND column_name = 'company_id') THEN
    ALTER TABLE leave_requests ADD COLUMN company_id UUID REFERENCES companies(id);
    UPDATE leave_requests lr SET company_id = COALESCE(e.company_id, default_id)
      FROM employees e WHERE e.id = lr.employee_id AND lr.company_id IS NULL;
    UPDATE leave_requests SET company_id = default_id WHERE company_id IS NULL;
    ALTER TABLE leave_requests ALTER COLUMN company_id SET NOT NULL;
    EXECUTE format('ALTER TABLE leave_requests ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)', default_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance_records' AND column_name = 'company_id') THEN
    ALTER TABLE attendance_records ADD COLUMN company_id UUID REFERENCES companies(id);
    UPDATE attendance_records ar SET company_id = COALESCE(e.company_id, default_id)
      FROM employees e WHERE e.id = ar.employee_id AND ar.company_id IS NULL;
    UPDATE attendance_records SET company_id = default_id WHERE company_id IS NULL;
    ALTER TABLE attendance_records ALTER COLUMN company_id SET NOT NULL;
    EXECUTE format('ALTER TABLE attendance_records ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)', default_id);
  END IF;
END $$;

INSERT INTO company_scoped_tables (table_name) VALUES ('leave_requests'), ('attendance_records')
ON CONFLICT DO NOTHING;

-- ===========================================================================
-- 1. Payroll: real draft -> approved -> posted lifecycle
-- ===========================================================================
-- createAndProcess now creates a DRAFT run (computed, not yet authorized).
-- approve() is SoD-gated (creator cannot approve their own run, same
-- convention as credit notes / milestones) and moves DRAFT -> PROCESSED.
-- post() now requires PROCESSED — an unapproved run can no longer reach the GL.
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id);
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- ===========================================================================
-- 2. Leave: accrual policies + a real balance ledger
-- ===========================================================================
CREATE TABLE IF NOT EXISTS leave_accrual_policies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id),
  leave_type          TEXT NOT NULL CHECK (leave_type IN ('ANNUAL', 'SICK', 'UNPAID', 'MATERNITY', 'PATERNITY', 'OTHER')),
  monthly_accrual_days DECIMAL(6,2) NOT NULL CHECK (monthly_accrual_days >= 0),
  max_balance_days    DECIMAL(6,2),
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id, leave_type)
);

CREATE TABLE IF NOT EXISTS leave_balances (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id),
  employee_id   UUID NOT NULL REFERENCES employees(id),
  leave_type    TEXT NOT NULL CHECK (leave_type IN ('ANNUAL', 'SICK', 'UNPAID', 'MATERNITY', 'PATERNITY', 'OTHER')),
  balance_days  DECIMAL(8,2) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (employee_id, leave_type)
);

-- Every accrual/usage/adjustment is a ledger row, not just a mutated balance,
-- so "why is this employee's balance 4.5 days" has an answer. The partial
-- unique index makes a second accrual run for the same employee/type/period a
-- no-op instead of double-crediting days.
CREATE TABLE IF NOT EXISTS leave_balance_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id),
  employee_id       UUID NOT NULL REFERENCES employees(id),
  leave_type        TEXT NOT NULL,
  days              DECIMAL(8,2) NOT NULL,
  transaction_type  TEXT NOT NULL CHECK (transaction_type IN ('ACCRUAL', 'USAGE', 'RELEASE', 'ADJUSTMENT')),
  reference_id      UUID,
  period_year       INTEGER,
  period_month      INTEGER,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_accrual_once_per_period
  ON leave_balance_transactions (employee_id, leave_type, period_year, period_month)
  WHERE transaction_type = 'ACCRUAL';

CREATE INDEX IF NOT EXISTS idx_leave_balance_txn_employee ON leave_balance_transactions (employee_id, leave_type);

INSERT INTO company_scoped_tables (table_name)
VALUES ('leave_accrual_policies'), ('leave_balances'), ('leave_balance_transactions')
ON CONFLICT DO NOTHING;

-- ===========================================================================
-- 3. Org chart + job history
-- ===========================================================================
ALTER TABLE employees ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES employees(id);

CREATE TABLE IF NOT EXISTS employee_job_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id),
  employee_id   UUID NOT NULL REFERENCES employees(id),
  field_name    TEXT NOT NULL, -- department, position, base_salary, manager_id, cost_center_id, status
  old_value     TEXT,
  new_value     TEXT,
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  changed_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_employee_job_history_employee ON employee_job_history (employee_id, created_at);

INSERT INTO company_scoped_tables (table_name) VALUES ('employee_job_history')
ON CONFLICT DO NOTHING;

-- ===========================================================================
-- 4. Document vault
-- ===========================================================================
CREATE TABLE IF NOT EXISTS employee_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id),
  employee_id   UUID NOT NULL REFERENCES employees(id),
  category      TEXT NOT NULL DEFAULT 'OTHER' CHECK (category IN ('CONTRACT', 'ID', 'CERTIFICATE', 'PERFORMANCE', 'OTHER')),
  file_name     TEXT NOT NULL,
  mime_type     TEXT,
  file_size     INTEGER,
  file_data     BYTEA NOT NULL,
  uploaded_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_employee_documents_employee ON employee_documents (employee_id) WHERE deleted_at IS NULL;

INSERT INTO company_scoped_tables (table_name) VALUES ('employee_documents')
ON CONFLICT DO NOTHING;

-- ===========================================================================
-- 5. Apply RLS to the newly-scoped tables if isolation is already enabled on
--    this install. Registering in company_scoped_tables alone is not enough
--    once enable_multi_company() has already run once — it only iterates the
--    tables that were registered at the time it was called.
-- ===========================================================================
DO $$
DECLARE
  app_role NAME;
  t TEXT;
  tables TEXT[] := ARRAY[
    'leave_requests', 'attendance_records',
    'leave_accrual_policies', 'leave_balances', 'leave_balance_transactions',
    'employee_job_history', 'employee_documents'
  ];
BEGIN
  SELECT application_role INTO app_role FROM company_isolation_config WHERE id AND application_role IS NOT NULL;
  IF app_role IS NOT NULL THEN
    FOREACH t IN ARRAY tables LOOP
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS company_isolation ON %I', t);
      EXECUTE format($p$
        CREATE POLICY company_isolation ON %I
          USING (company_id = public.current_company_id())
          WITH CHECK (company_id = public.current_company_id())
      $p$, t);
    END LOOP;
  END IF;
END $$;
