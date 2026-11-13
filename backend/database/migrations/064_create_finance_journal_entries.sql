-- Journal Entries Table
CREATE TABLE journal_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_number VARCHAR(50) UNIQUE NOT NULL,
    
    -- Entry Information
    entry_date DATE NOT NULL,
    posting_date DATE NOT NULL,
    period_year INTEGER NOT NULL,
    period_month INTEGER NOT NULL,
    
    -- Source Information
    source_type VARCHAR(100) NOT NULL,
    -- MANUAL, SALES_ORDER, PURCHASE_ORDER, INVENTORY_ADJUSTMENT, DEPRECIATION, PAYROLL, BANK_TRANSACTION
    
    source_id UUID,
    source_document VARCHAR(100),
    
    -- Entry Details
    description TEXT NOT NULL,
    reference VARCHAR(255),
    
    -- Totals (must balance)
    total_debit DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    total_credit DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    
    -- Status and Workflow
    status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
    -- DRAFT, PENDING_APPROVAL, APPROVED, POSTED, REJECTED, REVERSED
    
    requires_approval BOOLEAN DEFAULT false,
    is_reversing_entry BOOLEAN DEFAULT false,
    original_entry_id UUID REFERENCES journal_entries(id),
    
    -- Currency
    currency VARCHAR(3) DEFAULT 'USD',
    exchange_rate DECIMAL(10,6) DEFAULT 1.000000,
    
    -- Additional Information
    batch_id VARCHAR(100),
    external_reference VARCHAR(255),
    notes TEXT,
    
    -- Audit Fields
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    posted_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    posted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ
);

-- Journal Entry Items Table
CREATE TABLE journal_entry_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    
    -- Account Information
    account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
    account_code VARCHAR(20) NOT NULL,
    account_name VARCHAR(255) NOT NULL,
    
    -- Amount Information
    debit_amount DECIMAL(15,2) DEFAULT 0.00,
    credit_amount DECIMAL(15,2) DEFAULT 0.00,
    
    -- Dimensional Information
    department_id UUID,
    project_id UUID,
    cost_center_id UUID,
    
    -- Additional Information
    description TEXT,
    reference VARCHAR(255),
    
    -- Currency (for multi-currency)
    currency VARCHAR(3) DEFAULT 'USD',
    exchange_rate DECIMAL(10,6) DEFAULT 1.000000,
    original_amount DECIMAL(15,2),
    original_currency VARCHAR(3),
    
    -- Allocation Information
    allocation_percentage DECIMAL(5,2),
    allocation_basis VARCHAR(100),
    
    -- Audit Fields
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Journal Entry Status History Table
CREATE TABLE journal_entry_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    
    from_status VARCHAR(50),
    to_status VARCHAR(50) NOT NULL,
    status_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    changed_by UUID REFERENCES users(id),
    reason TEXT,
    notes TEXT,
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for Performance
CREATE INDEX idx_journal_entries_number ON journal_entries(journal_number);
CREATE INDEX idx_journal_entries_date ON journal_entries(entry_date);
CREATE INDEX idx_journal_entries_posting_date ON journal_entries(posting_date);
CREATE INDEX idx_journal_entries_period ON journal_entries(period_year, period_month);
CREATE INDEX idx_journal_entries_source ON journal_entries(source_type, source_id);
CREATE INDEX idx_journal_entries_status ON journal_entries(status);
CREATE INDEX idx_journal_entries_created_by ON journal_entries(created_by);
CREATE INDEX idx_journal_entries_deleted_at ON journal_entries(deleted_at);
CREATE INDEX idx_journal_entries_batch ON journal_entries(batch_id);

CREATE INDEX idx_journal_entry_items_entry ON journal_entry_items(journal_entry_id);
CREATE INDEX idx_journal_entry_items_account ON journal_entry_items(account_id);
CREATE INDEX idx_journal_entry_items_line ON journal_entry_items(journal_entry_id, line_number);
CREATE INDEX idx_journal_entry_items_department ON journal_entry_items(department_id);
CREATE INDEX idx_journal_entry_items_project ON journal_entry_items(project_id);
CREATE INDEX idx_journal_entry_items_cost_center ON journal_entry_items(cost_center_id);

CREATE INDEX idx_journal_status_history_entry ON journal_entry_status_history(journal_entry_id);
CREATE INDEX idx_journal_status_history_date ON journal_entry_status_history(status_date);

-- Constraints
ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_period_year_valid 
CHECK (period_year >= 2020 AND period_year <= 2100);

ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_period_month_valid 
CHECK (period_month >= 1 AND period_month <= 12);

ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_status_valid 
CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'REJECTED', 'REVERSED'));

ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_source_type_valid 
CHECK (source_type IN ('MANUAL', 'SALES_ORDER', 'PURCHASE_ORDER', 'INVENTORY_ADJUSTMENT', 'DEPRECIATION', 'PAYROLL', 'BANK_TRANSACTION', 'AUTOMATED'));

ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_currency_valid 
CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_exchange_rate_positive 
CHECK (exchange_rate > 0);

-- Journal must balance (debits = credits)
ALTER TABLE journal_entries ADD CONSTRAINT chk_journal_balance 
CHECK (total_debit = total_credit);

ALTER TABLE journal_entry_items ADD CONSTRAINT chk_journal_item_line_positive 
CHECK (line_number > 0);

ALTER TABLE journal_entry_items ADD CONSTRAINT chk_journal_item_amounts_valid 
CHECK ((debit_amount > 0 AND credit_amount = 0) OR (credit_amount > 0 AND debit_amount = 0));

ALTER TABLE journal_entry_items ADD CONSTRAINT chk_journal_item_allocation_valid 
CHECK (allocation_percentage IS NULL OR (allocation_percentage > 0 AND allocation_percentage <= 100));

-- Unique line numbers within journal entry
ALTER TABLE journal_entry_items ADD CONSTRAINT unique_journal_entry_line 
UNIQUE (journal_entry_id, line_number);

-- Comments for documentation
COMMENT ON TABLE journal_entries IS 'General ledger journal entries with approval workflow and automated posting';
COMMENT ON TABLE journal_entry_items IS 'Individual line items within journal entries with dimensional analysis';
COMMENT ON TABLE journal_entry_status_history IS 'Audit trail for journal entry status changes';

-- Triggers
CREATE TRIGGER journal_entries_updated_at
    BEFORE UPDATE ON journal_entries
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();

CREATE TRIGGER journal_entry_items_updated_at
    BEFORE UPDATE ON journal_entry_items
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();

-- Function to generate journal entry numbers
CREATE OR REPLACE FUNCTION generate_journal_entry_number()
RETURNS VARCHAR(50) AS $$
DECLARE
    next_number INTEGER;
    year_suffix VARCHAR(4);
    journal_number VARCHAR(50);
BEGIN
    year_suffix := TO_CHAR(CURRENT_DATE, 'YYYY');
    
    SELECT COALESCE(MAX(CAST(SUBSTRING(journal_number FROM 'JE-' || year_suffix || '-(\d+)') AS INTEGER)), 0) + 1
    INTO next_number
    FROM journal_entries
    WHERE journal_number LIKE 'JE-' || year_suffix || '-%';
    
    journal_number := 'JE-' || year_suffix || '-' || LPAD(next_number::TEXT, 6, '0');
    
    RETURN journal_number;
END;
$$ LANGUAGE plpgsql;