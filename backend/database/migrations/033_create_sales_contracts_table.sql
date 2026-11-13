-- Sales Contracts Table
CREATE TABLE sales_contracts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_number VARCHAR(50) UNIQUE NOT NULL, -- Auto-generated contract number
    contract_name VARCHAR(255) NOT NULL,
    
    -- Parties
    customer_id UUID REFERENCES customers(id),
    customer_name VARCHAR(255), -- Denormalized for reporting
    supplier_id UUID REFERENCES suppliers(id),
    supplier_name VARCHAR(255), -- Denormalized for reporting
    
    -- Contract Type and Details
    contract_type VARCHAR(50) NOT NULL DEFAULT 'SALES',
    -- SALES (to customers), PURCHASE (from suppliers), FRAMEWORK, SERVICE
    
    -- Terms and Conditions
    contract_value DECIMAL(15,2),
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    payment_terms VARCHAR(100),
    incoterms VARCHAR(20),
    -- EXW, FCA, CIP, DDP, etc.
    
    -- Validity Period
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    auto_renewal BOOLEAN DEFAULT FALSE,
    renewal_period_months INTEGER DEFAULT 12,
    
    -- Default Lead Times and Delivery
    default_lead_time_days INTEGER,
    delivery_terms VARCHAR(255),
    delivery_location TEXT,
    
    -- Status and Workflow
    status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
    -- DRAFT, PENDING_APPROVAL, ACTIVE, EXPIRED, TERMINATED, SUSPENDED
    
    approval_status VARCHAR(50) DEFAULT 'PENDING',
    -- PENDING, APPROVED, REJECTED
    
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    
    -- Document Management
    signed_contract_url TEXT, -- URL to signed contract file
    contract_attachment_urls TEXT[], -- Array of attachment URLs
    
    -- Terms and Conditions
    terms_and_conditions TEXT,
    special_conditions TEXT,
    
    -- Notifications and Alerts
    expiry_notification_sent BOOLEAN DEFAULT FALSE,
    days_before_expiry_notification INTEGER DEFAULT 30,
    
    -- Integration Fields
    linked_rfq_id UUID, -- If contract originated from RFQ
    linked_quotation_id UUID, -- If contract originated from quotation
    
    -- Additional Information
    notes TEXT,
    internal_notes TEXT,
    
    -- Audit Fields
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ -- Soft delete
);

-- Sales Contract Items Table
CREATE TABLE sales_contract_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_contract_id UUID NOT NULL REFERENCES sales_contracts(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    
    -- Item Information
    inventory_item_id UUID REFERENCES inventory_items(id),
    item_code VARCHAR(100),
    item_name VARCHAR(255) NOT NULL,
    item_description TEXT,
    
    -- Pricing and Terms
    unit_price DECIMAL(15,4) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    unit_of_measure VARCHAR(20) NOT NULL,
    
    -- Quantity Limits (for framework contracts)
    minimum_quantity DECIMAL(15,3),
    maximum_quantity DECIMAL(15,3),
    annual_quantity_limit DECIMAL(15,3),
    
    -- Discounts and Pricing Rules
    volume_discount_tiers JSONB, -- JSON array of quantity/discount pairs
    price_escalation_clause TEXT,
    price_review_frequency_months INTEGER,
    
    -- Delivery Terms
    lead_time_days INTEGER,
    delivery_terms VARCHAR(255),
    
    -- Additional Information
    technical_specifications TEXT,
    quality_requirements TEXT,
    packaging_requirements TEXT,
    notes TEXT,
    
    -- Audit Fields
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Sales Contract Status History Table
CREATE TABLE sales_contract_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_contract_id UUID NOT NULL REFERENCES sales_contracts(id) ON DELETE CASCADE,
    
    from_status VARCHAR(50),
    to_status VARCHAR(50) NOT NULL,
    status_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    changed_by UUID NOT NULL REFERENCES users(id),
    reason TEXT,
    notes TEXT,
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Sales Contract Usage Tracking
CREATE TABLE sales_contract_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_contract_id UUID NOT NULL REFERENCES sales_contracts(id),
    sales_contract_item_id UUID NOT NULL REFERENCES sales_contract_items(id),
    
    -- Reference to source document
    reference_type VARCHAR(50) NOT NULL,
    -- QUOTATION, SALES_ORDER, INVOICE
    
    reference_id UUID NOT NULL,
    reference_number VARCHAR(100),
    
    -- Usage Details
    quantity_used DECIMAL(15,3) NOT NULL,
    unit_price_used DECIMAL(15,4) NOT NULL,
    total_value DECIMAL(15,2) NOT NULL,
    
    usage_date DATE NOT NULL,
    
    -- Audit Fields
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Sales Contract Renewals Table
CREATE TABLE sales_contract_renewals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_contract_id UUID NOT NULL REFERENCES sales_contracts(id),
    new_contract_id UUID REFERENCES sales_contracts(id),
    
    renewal_type VARCHAR(50) NOT NULL,
    -- AUTO, MANUAL, RENEGOTIATED
    
    renewal_date DATE NOT NULL,
    previous_end_date DATE NOT NULL,
    new_end_date DATE NOT NULL,
    
    price_adjustment_percentage DECIMAL(5,2) DEFAULT 0,
    terms_changed BOOLEAN DEFAULT FALSE,
    changes_description TEXT,
    
    -- Audit Fields
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for Performance
CREATE INDEX idx_sales_contracts_customer ON sales_contracts(customer_id);
CREATE INDEX idx_sales_contracts_supplier ON sales_contracts(supplier_id);
CREATE INDEX idx_sales_contracts_type ON sales_contracts(contract_type);
CREATE INDEX idx_sales_contracts_status ON sales_contracts(status);
CREATE INDEX idx_sales_contracts_approval_status ON sales_contracts(approval_status);
CREATE INDEX idx_sales_contracts_dates ON sales_contracts(start_date, end_date);
CREATE INDEX idx_sales_contracts_contract_number ON sales_contracts(contract_number);
CREATE INDEX idx_sales_contracts_created_by ON sales_contracts(created_by);
CREATE INDEX idx_sales_contracts_deleted_at ON sales_contracts(deleted_at);

CREATE INDEX idx_sales_contract_items_contract ON sales_contract_items(sales_contract_id);
CREATE INDEX idx_sales_contract_items_inventory ON sales_contract_items(inventory_item_id);
CREATE INDEX idx_sales_contract_items_line ON sales_contract_items(sales_contract_id, line_number);

CREATE INDEX idx_sc_status_history_contract ON sales_contract_status_history(sales_contract_id);
CREATE INDEX idx_sc_status_history_date ON sales_contract_status_history(status_date);

CREATE INDEX idx_sc_usage_contract ON sales_contract_usage(sales_contract_id);
CREATE INDEX idx_sc_usage_item ON sales_contract_usage(sales_contract_item_id);
CREATE INDEX idx_sc_usage_reference ON sales_contract_usage(reference_type, reference_id);
CREATE INDEX idx_sc_usage_date ON sales_contract_usage(usage_date);

CREATE INDEX idx_sc_renewals_original ON sales_contract_renewals(original_contract_id);
CREATE INDEX idx_sc_renewals_new ON sales_contract_renewals(new_contract_id);
CREATE INDEX idx_sc_renewals_date ON sales_contract_renewals(renewal_date);

-- Add constraints
ALTER TABLE sales_contract_items ADD CONSTRAINT chk_sc_unit_price_positive CHECK (unit_price >= 0);
ALTER TABLE sales_contract_items ADD CONSTRAINT chk_sc_min_max_quantity CHECK (minimum_quantity IS NULL OR maximum_quantity IS NULL OR minimum_quantity <= maximum_quantity);
ALTER TABLE sales_contract_items ADD CONSTRAINT unique_sc_line_number UNIQUE (sales_contract_id, line_number);
ALTER TABLE sales_contracts ADD CONSTRAINT chk_sc_contract_dates CHECK (end_date >= start_date);
ALTER TABLE sales_contract_usage ADD CONSTRAINT chk_sc_usage_quantity_positive CHECK (quantity_used > 0);
ALTER TABLE sales_contract_usage ADD CONSTRAINT chk_sc_usage_price_positive CHECK (unit_price_used >= 0);

-- Comments for documentation
COMMENT ON TABLE sales_contracts IS 'Sales contracts for long-term agreements with customers and suppliers';
COMMENT ON TABLE sales_contract_items IS 'Individual items and pricing within sales contracts';
COMMENT ON TABLE sales_contract_status_history IS 'Audit trail for sales contract status changes';
COMMENT ON TABLE sales_contract_usage IS 'Tracking of contract usage in quotations, sales orders, and invoices';
COMMENT ON TABLE sales_contract_renewals IS 'History of contract renewals and extensions';

-- Trigger to update updated_at timestamp
CREATE TRIGGER sales_contracts_updated_at
    BEFORE UPDATE ON sales_contracts
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();

CREATE TRIGGER sales_contract_items_updated_at
    BEFORE UPDATE ON sales_contract_items
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();