-- Cost centers and budgets (budget vs actual).
-- Budget lines target a GL account (and optionally a cost center) for a fiscal
-- year. Actuals are derived from posted journal entries for that account.

CREATE TABLE IF NOT EXISTS cost_centers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(20) UNIQUE NOT NULL,          -- CC-####
    name VARCHAR(255) NOT NULL,
    description TEXT,
    manager_id UUID REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE, INACTIVE
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS budgets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    fiscal_year INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',   -- DRAFT, APPROVED, CLOSED
    notes TEXT,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS budget_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    budget_id UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
    cost_center_id UUID REFERENCES cost_centers(id),
    annual_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cost_centers_status ON cost_centers(status);
CREATE INDEX IF NOT EXISTS idx_budgets_year ON budgets(fiscal_year);
CREATE INDEX IF NOT EXISTS idx_budget_lines_budget ON budget_lines(budget_id);
CREATE INDEX IF NOT EXISTS idx_budget_lines_account ON budget_lines(account_id);

ALTER TABLE cost_centers DROP CONSTRAINT IF EXISTS chk_cost_center_status;
ALTER TABLE cost_centers ADD CONSTRAINT chk_cost_center_status CHECK (status IN ('ACTIVE', 'INACTIVE'));

ALTER TABLE budgets DROP CONSTRAINT IF EXISTS chk_budget_status;
ALTER TABLE budgets ADD CONSTRAINT chk_budget_status CHECK (status IN ('DRAFT', 'APPROVED', 'CLOSED'));

CREATE OR REPLACE FUNCTION generate_cost_center_code() RETURNS TEXT AS $$
DECLARE
    next_number INTEGER;
BEGIN
    SELECT COALESCE(MAX(
        CASE WHEN code ~ '^CC-[0-9]+$' THEN SUBSTRING(code FROM '\-([0-9]+)$')::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM cost_centers;
    RETURN 'CC-' || LPAD(next_number::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cost_centers_updated_at ON cost_centers;
CREATE TRIGGER cost_centers_updated_at
    BEFORE UPDATE ON cost_centers
    FOR EACH ROW EXECUTE FUNCTION update_sales_order_timestamp();

DROP TRIGGER IF EXISTS budgets_updated_at ON budgets;
CREATE TRIGGER budgets_updated_at
    BEFORE UPDATE ON budgets
    FOR EACH ROW EXECUTE FUNCTION update_sales_order_timestamp();

COMMENT ON TABLE cost_centers IS 'Cost centers for expense allocation and budgeting';
COMMENT ON TABLE budgets IS 'Annual budgets; lines target GL accounts and optionally cost centers';
