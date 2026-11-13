-- Sales Orders Table
CREATE TABLE sales_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    so_number VARCHAR(50) UNIQUE NOT NULL, -- Auto-generated SO number
    
    -- Customer Information
    customer_id UUID NOT NULL REFERENCES customers(id),
    customer_name VARCHAR(255) NOT NULL, -- Denormalized for reporting
    
    -- Order Details
    order_date DATE NOT NULL DEFAULT CURRENT_DATE,
    delivery_date DATE,
    reference_number VARCHAR(100), -- Customer reference
    
    -- Financial Information
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    subtotal DECIMAL(15,2) DEFAULT 0,
    tax_amount DECIMAL(15,2) DEFAULT 0,
    discount_amount DECIMAL(15,2) DEFAULT 0,
    total_amount DECIMAL(15,2) DEFAULT 0,
    
    -- Status and Workflow
    status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
    -- DRAFT, PENDING_APPROVAL, CONFIRMED, PARTIALLY_DELIVERED, DELIVERED, INVOICED, CANCELLED
    
    priority VARCHAR(20) DEFAULT 'NORMAL',
    -- LOW, NORMAL, HIGH, URGENT
    
    -- Approval Information
    requires_approval BOOLEAN DEFAULT FALSE,
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    approval_notes TEXT,
    
    -- Delivery Information
    delivery_address TEXT,
    delivery_instructions TEXT,
    shipping_method VARCHAR(100),
    
    -- Additional Information
    notes TEXT,
    internal_notes TEXT,
    
    -- Terms and Conditions
    payment_terms VARCHAR(100),
    delivery_terms VARCHAR(100),
    
    -- Audit Fields
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ -- Soft delete
);

-- Sales Order Items Table
CREATE TABLE sales_order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_order_id UUID NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
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
    requested_delivery_date DATE,
    promised_delivery_date DATE,
    
    -- Status Tracking
    quantity_reserved DECIMAL(15,3) DEFAULT 0,
    quantity_delivered DECIMAL(15,3) DEFAULT 0,
    quantity_invoiced DECIMAL(15,3) DEFAULT 0,
    
    -- Additional Information
    notes TEXT,
    
    -- Audit Fields
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Sales Order Status History Table
CREATE TABLE sales_order_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_order_id UUID NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
    
    from_status VARCHAR(50),
    to_status VARCHAR(50) NOT NULL,
    status_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    changed_by UUID NOT NULL REFERENCES users(id),
    reason TEXT,
    notes TEXT,
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for Performance
CREATE INDEX idx_sales_orders_customer ON sales_orders(customer_id);
CREATE INDEX idx_sales_orders_status ON sales_orders(status);
CREATE INDEX idx_sales_orders_date ON sales_orders(order_date);
CREATE INDEX idx_sales_orders_so_number ON sales_orders(so_number);
CREATE INDEX idx_sales_orders_created_by ON sales_orders(created_by);
CREATE INDEX idx_sales_orders_deleted_at ON sales_orders(deleted_at);

CREATE INDEX idx_sales_order_items_so ON sales_order_items(sales_order_id);
CREATE INDEX idx_sales_order_items_item ON sales_order_items(inventory_item_id);
CREATE INDEX idx_sales_order_items_line ON sales_order_items(sales_order_id, line_number);

CREATE INDEX idx_so_status_history_so ON sales_order_status_history(sales_order_id);
CREATE INDEX idx_so_status_history_date ON sales_order_status_history(status_date);

-- Add constraints
ALTER TABLE sales_order_items ADD CONSTRAINT chk_quantity_positive CHECK (quantity > 0);
ALTER TABLE sales_order_items ADD CONSTRAINT chk_unit_price_positive CHECK (unit_price >= 0);
ALTER TABLE sales_order_items ADD CONSTRAINT unique_so_line_number UNIQUE (sales_order_id, line_number);

-- Comments for documentation
COMMENT ON TABLE sales_orders IS 'Sales Orders - formal agreements to supply goods or services to customers';
COMMENT ON TABLE sales_order_items IS 'Individual line items within sales orders';
COMMENT ON TABLE sales_order_status_history IS 'Audit trail for sales order status changes';

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_sales_order_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sales_orders_updated_at
    BEFORE UPDATE ON sales_orders
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();

CREATE TRIGGER sales_order_items_updated_at
    BEFORE UPDATE ON sales_order_items
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();