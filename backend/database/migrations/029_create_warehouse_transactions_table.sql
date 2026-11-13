-- Create warehouse_transactions table
CREATE TABLE IF NOT EXISTS warehouse_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_number VARCHAR(20) UNIQUE NOT NULL,
    transaction_type VARCHAR(10) NOT NULL CHECK (transaction_type IN ('GR', 'GI', 'GE', 'GT', 'SA')),
    transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
    
    -- Reference document information
    reference_document VARCHAR(50),
    reference_type VARCHAR(20) CHECK (reference_type IN ('PO', 'SO', 'WO', 'MANUAL')),
    reference_id UUID,
    
    -- Transaction-specific fields
    return_type VARCHAR(20) CHECK (return_type IN ('supplier', 'customer', 'internal')),
    transfer_type VARCHAR(20) CHECK (transfer_type IN ('intra-warehouse', 'inter-warehouse')),
    adjustment_type VARCHAR(50) CHECK (adjustment_type IN ('PHYSICAL_COUNT', 'DAMAGE', 'LOSS', 'FOUND', 'CORRECTION')),
    
    -- Cost center and job tracking
    cost_center VARCHAR(50),
    job_reference VARCHAR(100),
    
    -- Status and approval
    status VARCHAR(20) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT', 'POSTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED')),
    requires_approval BOOLEAN DEFAULT FALSE,
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP,
    
    -- Total values
    total_quantity DECIMAL(15,4) DEFAULT 0,
    total_value DECIMAL(15,2) DEFAULT 0,
    
    -- Audit fields
    notes TEXT,
    created_by UUID NOT NULL REFERENCES users(id),
    processed_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create warehouse_transaction_items table
CREATE TABLE IF NOT EXISTS warehouse_transaction_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    warehouse_transaction_id UUID NOT NULL REFERENCES warehouse_transactions(id) ON DELETE CASCADE,
    
    -- Item information
    inventory_item_id UUID REFERENCES inventory_items(id),
    item_name VARCHAR(255) NOT NULL,
    item_description TEXT,
    
    -- Quantities
    quantity DECIMAL(15,4) NOT NULL,
    received_quantity DECIMAL(15,4),
    issued_quantity DECIMAL(15,4),
    return_quantity DECIMAL(15,4),
    transfer_quantity DECIMAL(15,4),
    physical_quantity DECIMAL(15,4),
    adjustment_quantity DECIMAL(15,4),
    
    -- Unit information
    unit_of_measure VARCHAR(10) NOT NULL DEFAULT 'PCS',
    unit_cost DECIMAL(15,4) DEFAULT 0,
    total_cost DECIMAL(15,2) DEFAULT 0,
    
    -- Location information
    source_storage_location_id UUID REFERENCES storage_locations(id),
    source_bin_id UUID REFERENCES bins(id),
    destination_storage_location_id UUID REFERENCES storage_locations(id),
    destination_bin_id UUID REFERENCES bins(id),
    
    -- Condition and reason
    condition VARCHAR(20) CHECK (condition IN ('GOOD', 'DAMAGED', 'EXPIRED', 'DEFECTIVE')),
    reason_code VARCHAR(50) NOT NULL,
    
    -- Additional tracking
    batch_number VARCHAR(50),
    expiry_date DATE,
    serial_number VARCHAR(100),
    
    -- Item-specific notes
    notes TEXT,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create warehouse_transaction_audit_log table for comprehensive audit trail
CREATE TABLE IF NOT EXISTS warehouse_transaction_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    warehouse_transaction_id UUID NOT NULL REFERENCES warehouse_transactions(id) ON DELETE CASCADE,
    
    -- Action details
    action VARCHAR(50) NOT NULL, -- 'CREATED', 'UPDATED', 'APPROVED', 'REJECTED', 'CANCELLED', 'POSTED'
    previous_status VARCHAR(20),
    new_status VARCHAR(20),
    
    -- Change details
    field_changed VARCHAR(100),
    old_value TEXT,
    new_value TEXT,
    
    -- User and system info
    user_id UUID NOT NULL REFERENCES users(id),
    user_agent TEXT,
    ip_address INET,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_warehouse_transactions_type ON warehouse_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_warehouse_transactions_date ON warehouse_transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_warehouse_transactions_status ON warehouse_transactions(status);
CREATE INDEX IF NOT EXISTS idx_warehouse_transactions_reference ON warehouse_transactions(reference_document, reference_type);
CREATE INDEX IF NOT EXISTS idx_warehouse_transactions_created_by ON warehouse_transactions(created_by);

CREATE INDEX IF NOT EXISTS idx_warehouse_transaction_items_transaction ON warehouse_transaction_items(warehouse_transaction_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_transaction_items_inventory ON warehouse_transaction_items(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_transaction_items_source_location ON warehouse_transaction_items(source_storage_location_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_transaction_items_dest_location ON warehouse_transaction_items(destination_storage_location_id);

CREATE INDEX IF NOT EXISTS idx_warehouse_transaction_audit_transaction ON warehouse_transaction_audit_log(warehouse_transaction_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_transaction_audit_user ON warehouse_transaction_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_transaction_audit_created ON warehouse_transaction_audit_log(created_at);

-- Create sequence for transaction numbering
CREATE SEQUENCE IF NOT EXISTS warehouse_transaction_number_seq START 1;

-- Function to generate transaction numbers
CREATE OR REPLACE FUNCTION generate_warehouse_transaction_number(transaction_type VARCHAR)
RETURNS VARCHAR AS $$
DECLARE
    next_val INTEGER;
    year_part VARCHAR(4);
    type_prefix VARCHAR(2);
BEGIN
    -- Get next sequence value
    SELECT nextval('warehouse_transaction_number_seq') INTO next_val;
    
    -- Get current year
    SELECT EXTRACT(YEAR FROM CURRENT_DATE)::VARCHAR INTO year_part;
    
    -- Return formatted transaction number
    RETURN transaction_type || '-' || year_part || '-' || LPAD(next_val::VARCHAR, 6, '0');
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-generate transaction numbers
CREATE OR REPLACE FUNCTION set_warehouse_transaction_number()
RETURNS TRIGGER AS $$
BEGIN
    -- Only set transaction number if it's not already set
    IF NEW.transaction_number IS NULL OR NEW.transaction_number = '' THEN
        NEW.transaction_number := generate_warehouse_transaction_number(NEW.transaction_type);
    END IF;
    
    -- Update updated_at timestamp
    NEW.updated_at := CURRENT_TIMESTAMP;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for auto-generating transaction numbers
CREATE TRIGGER trigger_set_warehouse_transaction_number
    BEFORE INSERT OR UPDATE ON warehouse_transactions
    FOR EACH ROW
    EXECUTE FUNCTION set_warehouse_transaction_number();

-- Function to update item timestamps
CREATE OR REPLACE FUNCTION update_warehouse_transaction_item_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for updating item timestamps
CREATE TRIGGER trigger_update_warehouse_transaction_item_timestamp
    BEFORE UPDATE ON warehouse_transaction_items
    FOR EACH ROW
    EXECUTE FUNCTION update_warehouse_transaction_item_timestamp();