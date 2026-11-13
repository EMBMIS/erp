-- HR & Payroll: employees, payroll runs and per-employee payroll items.
-- A payroll run posts Dr Salaries Expense (5210) / Cr Cash (1110) for net pay /
-- Cr Accrued Expenses (2120) for deductions.

CREATE TABLE IF NOT EXISTS employees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_number VARCHAR(20) UNIQUE NOT NULL,   -- EMP-####
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    department VARCHAR(100),
    position VARCHAR(100),
    cost_center_id UUID REFERENCES cost_centers(id),
    hire_date DATE,
    base_salary DECIMAL(15,2) NOT NULL DEFAULT 0,  -- annual base salary
    currency VARCHAR(3) DEFAULT 'USD',
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE, ON_LEAVE, TERMINATED
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS payroll_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_number VARCHAR(30) UNIQUE NOT NULL,        -- PR-YYYY-MM
    period_year INTEGER NOT NULL,
    period_month INTEGER NOT NULL,                 -- 1-12
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',   -- DRAFT, PROCESSED, POSTED
    total_gross DECIMAL(15,2) NOT NULL DEFAULT 0,
    total_deductions DECIMAL(15,2) NOT NULL DEFAULT 0,
    total_net DECIMAL(15,2) NOT NULL DEFAULT 0,
    journal_entry_id UUID REFERENCES journal_entries(id),
    notes TEXT,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS payroll_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payroll_run_id UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES employees(id),
    employee_name VARCHAR(255),
    gross_salary DECIMAL(15,2) NOT NULL DEFAULT 0,
    deductions DECIMAL(15,2) NOT NULL DEFAULT 0,
    net_salary DECIMAL(15,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_period ON payroll_runs(period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_payroll_items_run ON payroll_items(payroll_run_id);

ALTER TABLE employees DROP CONSTRAINT IF EXISTS chk_employee_status;
ALTER TABLE employees ADD CONSTRAINT chk_employee_status CHECK (status IN ('ACTIVE', 'ON_LEAVE', 'TERMINATED'));

ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS chk_payroll_run_status;
ALTER TABLE payroll_runs ADD CONSTRAINT chk_payroll_run_status CHECK (status IN ('DRAFT', 'PROCESSED', 'POSTED'));

ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS chk_payroll_month;
ALTER TABLE payroll_runs ADD CONSTRAINT chk_payroll_month CHECK (period_month BETWEEN 1 AND 12);

CREATE OR REPLACE FUNCTION generate_employee_number() RETURNS TEXT AS $$
DECLARE
    next_number INTEGER;
BEGIN
    SELECT COALESCE(MAX(
        CASE WHEN employee_number ~ '^EMP-[0-9]+$' THEN SUBSTRING(employee_number FROM '\-([0-9]+)$')::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM employees;
    RETURN 'EMP-' || LPAD(next_number::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employees_updated_at ON employees;
CREATE TRIGGER employees_updated_at
    BEFORE UPDATE ON employees
    FOR EACH ROW EXECUTE FUNCTION update_sales_order_timestamp();

DROP TRIGGER IF EXISTS payroll_runs_updated_at ON payroll_runs;
CREATE TRIGGER payroll_runs_updated_at
    BEFORE UPDATE ON payroll_runs
    FOR EACH ROW EXECUTE FUNCTION update_sales_order_timestamp();

COMMENT ON TABLE employees IS 'Employee master for HR and payroll';
COMMENT ON TABLE payroll_runs IS 'Monthly payroll runs posted to the GL';
