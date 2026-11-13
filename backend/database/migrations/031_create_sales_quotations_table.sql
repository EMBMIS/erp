-- Sales Quotations Table
CREATE TABLE sales_quotations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quotation_number VARCHAR(50) UNIQUE NOT NULL, -- Auto-generated quotation number
    
    -- Customer Information
    customer_id UUID NOT NULL REFERENCES customers(id),
    customer_name VARCHAR(255) NOT NULL, -- Denormalized for reporting
    
    -- Quotation Details
    quotation_date DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_until DATE NOT NULL, -- Quotation expiry date
    reference_number VARCHAR(100), -- Customer reference
    
    -- Financial Information
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    subtotal DECIMAL(15,2) DEFAULT 0,
    tax_amount DECIMAL(15,2) DEFAULT 0,
    discount_amount DECIMAL(15,2) DEFAULT 0,
    total_amount DECIMAL(15,2) DEFAULT 0,
    
    -- Status and Workflow
    status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
    -- DRAFT, SENT, ACCEPTED, REJECTED, EXPIRED, CANCELLED
    
    priority VARCHAR(20) DEFAULT 'NORMAL',
    -- LOW, NORMAL, HIGH, URGENT
    
    -- Conversion Information
    converted_to_so BOOLEAN DEFAULT FALSE,
    sales_order_id UUID REFERENCES sales_orders(id),
    converted_at TIMESTAMPTZ,
    converted_by UUID REFERENCES users(id),
    
    -- Delivery Information
    delivery_address TEXT,
    delivery_terms VARCHAR(100),
    estimated_delivery_days INTEGER,
    
    -- Additional Information
    notes TEXT,
    internal_notes TEXT,
    terms_and_conditions TEXT,
    
    -- Payment Terms
    payment_terms VARCHAR(100),
    
    -- Audit Fields
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ -- Soft delete
);

-- Sales Quotation Items Table
CREATE TABLE sales_quotation_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_quotation_id UUID NOT NULL REFERENCES sales_quotations(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    
    -- Item Information
    inventory_item_id UUID REFERENCES inventory_items(id),
    item_code VARCHAR(100),
    item_name VARCHAR(255) NOT NULL,
    item_description TEXT,
    
    -- Quantity and Units
    quantity DECIMAL(15,3) NOT NULL,
    unit_of_measure VARCHAR(20) NOT NULL,
    
    -- Pricing
    unit_price DECIMAL(15,4) NOT NULL,
    discount_percentage DECIMAL(5,2) DEFAULT 0,
    discount_amount DECIMAL(15,2) DEFAULT 0,
    line_total DECIMAL(15,2) NOT NULL,
    
    -- Delivery Information
    estimated_delivery_date DATE,
    
    -- Additional Information
    notes TEXT,
    
    -- Audit Fields
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Sales Quotation Status History Table
CREATE TABLE sales_quotation_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_quotation_id UUID NOT NULL REFERENCES sales_quotations(id) ON DELETE CASCADE,
    
    from_status VARCHAR(50),
    to_status VARCHAR(50) NOT NULL,
    status_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    changed_by UUID NOT NULL REFERENCES users(id),
    reason TEXT,
    notes TEXT,
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for Performance
CREATE INDEX idx_sales_quotations_customer ON sales_quotations(customer_id);
CREATE INDEX idx_sales_quotations_status ON sales_quotations(status);
CREATE INDEX idx_sales_quotations_date ON sales_quotations(quotation_date);
CREATE INDEX idx_sales_quotations_valid_until ON sales_quotations(valid_until);
CREATE INDEX idx_sales_quotations_quotation_number ON sales_quotations(quotation_number);
CREATE INDEX idx_sales_quotations_created_by ON sales_quotations(created_by);
CREATE INDEX idx_sales_quotations_deleted_at ON sales_quotations(deleted_at);
CREATE INDEX idx_sales_quotations_sales_order ON sales_quotations(sales_order_id);

CREATE INDEX idx_sales_quotation_items_quotation ON sales_quotation_items(sales_quotation_id);
CREATE INDEX idx_sales_quotation_items_item ON sales_quotation_items(inventory_item_id);
CREATE INDEX idx_sales_quotation_items_line ON sales_quotation_items(sales_quotation_id, line_number);

CREATE INDEX idx_sq_status_history_quotation ON sales_quotation_status_history(sales_quotation_id);
CREATE INDEX idx_sq_status_history_date ON sales_quotation_status_history(status_date);

-- Add constraints
ALTER TABLE sales_quotation_items ADD CONSTRAINT chk_sq_quantity_positive CHECK (quantity > 0);
ALTER TABLE sales_quotation_items ADD CONSTRAINT chk_sq_unit_price_positive CHECK (unit_price >= 0);
ALTER TABLE sales_quotation_items ADD CONSTRAINT unique_sq_line_number UNIQUE (sales_quotation_id, line_number);
ALTER TABLE sales_quotations ADD CONSTRAINT chk_valid_until_after_quotation_date CHECK (valid_until >= quotation_date);

-- Comments for documentation
COMMENT ON TABLE sales_quotations IS 'Sales Quotations - formal offers to customers with prices, delivery dates, and terms';
COMMENT ON TABLE sales_quotation_items IS 'Individual line items within sales quotations';
COMMENT ON TABLE sales_quotation_status_history IS 'Audit trail for sales quotation status changes';

-- Trigger to update updated_at timestamp
CREATE TRIGGER sales_quotations_updated_at
    BEFORE UPDATE ON sales_quotations
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();

CREATE TRIGGER sales_quotation_items_updated_at
    BEFORE UPDATE ON sales_quotation_items
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();