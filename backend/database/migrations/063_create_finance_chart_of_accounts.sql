-- Chart of Accounts Table
CREATE TABLE chart_of_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_code VARCHAR(20) UNIQUE NOT NULL,
    account_name VARCHAR(255) NOT NULL,
    account_type VARCHAR(50) NOT NULL,
    -- ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE
    
    account_subtype VARCHAR(100),
    -- CURRENT_ASSET, FIXED_ASSET, CURRENT_LIABILITY, LONG_TERM_LIABILITY, etc.
    
    parent_account_id UUID REFERENCES chart_of_accounts(id),
    account_level INTEGER NOT NULL DEFAULT 1,
    is_header BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    
    -- Balance Information
    normal_balance VARCHAR(10) NOT NULL,
    -- DEBIT, CREDIT
    
    current_balance DECIMAL(15,2) DEFAULT 0.00,
    beginning_balance DECIMAL(15,2) DEFAULT 0.00,
    
    -- Account Properties
    allow_manual_posting BOOLEAN DEFAULT true,
    require_department BOOLEAN DEFAULT false,
    require_project BOOLEAN DEFAULT false,
    require_cost_center BOOLEAN DEFAULT false,
    
    -- Financial Statement Mapping
    balance_sheet_section VARCHAR(100),
    income_statement_section VARCHAR(100),
    cash_flow_section VARCHAR(100),
    
    -- Additional Information
    description TEXT,
    tax_code VARCHAR(20),
    currency VARCHAR(3) DEFAULT 'USD',
    
    -- Bank Account Details (for cash accounts)
    bank_name VARCHAR(255),
    bank_account_number VARCHAR(100),
    bank_routing_number VARCHAR(50),
    
    -- Status and Workflow
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING_APPROVAL',
    -- PENDING_APPROVAL, APPROVED, ACTIVE, INACTIVE, CLOSED
    
    -- Audit Fields
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ
);

-- Account Status History Table
CREATE TABLE chart_of_accounts_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE CASCADE,
    
    from_status VARCHAR(50),
    to_status VARCHAR(50) NOT NULL,
    status_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    changed_by UUID REFERENCES users(id),
    reason TEXT,
    notes TEXT,
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for Performance
CREATE INDEX idx_chart_of_accounts_code ON chart_of_accounts(account_code);
CREATE INDEX idx_chart_of_accounts_type ON chart_of_accounts(account_type);
CREATE INDEX idx_chart_of_accounts_parent ON chart_of_accounts(parent_account_id);
CREATE INDEX idx_chart_of_accounts_level ON chart_of_accounts(account_level);
CREATE INDEX idx_chart_of_accounts_status ON chart_of_accounts(status);
CREATE INDEX idx_chart_of_accounts_active ON chart_of_accounts(is_active);
CREATE INDEX idx_chart_of_accounts_created_by ON chart_of_accounts(created_by);
CREATE INDEX idx_chart_of_accounts_deleted_at ON chart_of_accounts(deleted_at);

CREATE INDEX idx_chart_status_history_account ON chart_of_accounts_status_history(account_id);
CREATE INDEX idx_chart_status_history_date ON chart_of_accounts_status_history(status_date);

-- Constraints
ALTER TABLE chart_of_accounts ADD CONSTRAINT chk_account_code_format 
CHECK (account_code ~ '^[0-9A-Z]{3,20}$');

ALTER TABLE chart_of_accounts ADD CONSTRAINT chk_account_type_valid 
CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'));

ALTER TABLE chart_of_accounts ADD CONSTRAINT chk_normal_balance_valid 
CHECK (normal_balance IN ('DEBIT', 'CREDIT'));

ALTER TABLE chart_of_accounts ADD CONSTRAINT chk_account_level_positive 
CHECK (account_level > 0 AND account_level <= 10);

ALTER TABLE chart_of_accounts ADD CONSTRAINT chk_status_valid 
CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'INACTIVE', 'CLOSED'));

-- Hierarchical consistency check
ALTER TABLE chart_of_accounts ADD CONSTRAINT chk_parent_not_self 
CHECK (parent_account_id != id);

-- Header accounts cannot have transactions
ALTER TABLE chart_of_accounts ADD CONSTRAINT chk_header_no_manual_posting 
CHECK (NOT (is_header = true AND allow_manual_posting = true));

-- Comments for documentation
COMMENT ON TABLE chart_of_accounts IS 'Central chart of accounts for general ledger with hierarchical structure and approval workflow';
COMMENT ON TABLE chart_of_accounts_status_history IS 'Audit trail for chart of accounts status changes';

-- Trigger to update updated_at timestamp
CREATE TRIGGER chart_of_accounts_updated_at
    BEFORE UPDATE ON chart_of_accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();

CREATE TRIGGER chart_status_history_updated_at
    BEFORE UPDATE ON chart_of_accounts_status_history
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();

-- Insert default chart of accounts structure (using first available user)
INSERT INTO chart_of_accounts (account_code, account_name, account_type, account_subtype, account_level, is_header, normal_balance, status, created_by, allow_manual_posting, balance_sheet_section) VALUES
-- Assets
('1000', 'ASSETS', 'ASSET', 'HEADER', 1, true, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), false, 'ASSETS'),
('1100', 'Current Assets', 'ASSET', 'CURRENT_ASSET', 2, true, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), false, 'CURRENT_ASSETS'),
('1110', 'Cash and Cash Equivalents', 'ASSET', 'CASH', 3, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'CURRENT_ASSETS'),
('1120', 'Accounts Receivable', 'ASSET', 'ACCOUNTS_RECEIVABLE', 3, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'CURRENT_ASSETS'),
('1130', 'Inventory', 'ASSET', 'INVENTORY', 3, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'CURRENT_ASSETS'),
('1140', 'Prepaid Expenses', 'ASSET', 'PREPAID', 3, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'CURRENT_ASSETS'),

-- Fixed Assets
('1200', 'Fixed Assets', 'ASSET', 'FIXED_ASSET', 2, true, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), false, 'FIXED_ASSETS'),
('1210', 'Property, Plant & Equipment', 'ASSET', 'PPE', 3, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'FIXED_ASSETS'),
('1220', 'Accumulated Depreciation', 'ASSET', 'ACCUMULATED_DEPRECIATION', 3, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'FIXED_ASSETS'),

-- Liabilities
('2000', 'LIABILITIES', 'LIABILITY', 'HEADER', 1, true, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), false, 'LIABILITIES'),
('2100', 'Current Liabilities', 'LIABILITY', 'CURRENT_LIABILITY', 2, true, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), false, 'CURRENT_LIABILITIES'),
('2110', 'Accounts Payable', 'LIABILITY', 'ACCOUNTS_PAYABLE', 3, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'CURRENT_LIABILITIES'),
('2120', 'Accrued Expenses', 'LIABILITY', 'ACCRUED_EXPENSES', 3, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'CURRENT_LIABILITIES'),
('2130', 'Short-term Debt', 'LIABILITY', 'SHORT_TERM_DEBT', 3, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'CURRENT_LIABILITIES'),

-- Long-term Liabilities
('2200', 'Long-term Liabilities', 'LIABILITY', 'LONG_TERM_LIABILITY', 2, true, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), false, 'LONG_TERM_LIABILITIES'),
('2210', 'Long-term Debt', 'LIABILITY', 'LONG_TERM_DEBT', 3, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'LONG_TERM_LIABILITIES'),

-- Equity
('3000', 'EQUITY', 'EQUITY', 'HEADER', 1, true, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), false, 'EQUITY'),
('3100', 'Share Capital', 'EQUITY', 'SHARE_CAPITAL', 2, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'EQUITY'),
('3200', 'Retained Earnings', 'EQUITY', 'RETAINED_EARNINGS', 2, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'EQUITY'),

-- Revenue
('4000', 'REVENUE', 'REVENUE', 'HEADER', 1, true, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), false, 'REVENUE'),
('4100', 'Sales Revenue', 'REVENUE', 'SALES_REVENUE', 2, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'REVENUE'),
('4200', 'Service Revenue', 'REVENUE', 'SERVICE_REVENUE', 2, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'REVENUE'),
('4900', 'Other Revenue', 'REVENUE', 'OTHER_REVENUE', 2, false, 'CREDIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'REVENUE'),

-- Expenses
('5000', 'EXPENSES', 'EXPENSE', 'HEADER', 1, true, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), false, 'EXPENSES'),
('5100', 'Cost of Goods Sold', 'EXPENSE', 'COGS', 2, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'EXPENSES'),
('5200', 'Operating Expenses', 'EXPENSE', 'OPERATING_EXPENSE', 2, true, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), false, 'OPERATING_EXPENSES'),
('5210', 'Salaries and Wages', 'EXPENSE', 'PAYROLL', 3, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'OPERATING_EXPENSES'),
('5220', 'Rent Expense', 'EXPENSE', 'RENT', 3, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'OPERATING_EXPENSES'),
('5230', 'Utilities Expense', 'EXPENSE', 'UTILITIES', 3, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'OPERATING_EXPENSES'),
('5240', 'Office Supplies', 'EXPENSE', 'SUPPLIES', 3, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'OPERATING_EXPENSES'),
('5250', 'Professional Services', 'EXPENSE', 'PROFESSIONAL_SERVICES', 3, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'OPERATING_EXPENSES'),
('5260', 'Depreciation Expense', 'EXPENSE', 'DEPRECIATION', 3, false, 'DEBIT', 'ACTIVE', (SELECT id FROM users ORDER BY created_at LIMIT 1), true, 'OPERATING_EXPENSES');