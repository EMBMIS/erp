-- Create goods receipts table for inventory integration
-- Migration 020: Goods receipt functionality for procurement-inventory integration

-- Create goods receipts table
CREATE TABLE goods_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_id UUID REFERENCES purchase_orders(id) ON DELETE CASCADE,
    po_line_item_id UUID REFERENCES purchase_order_line_items(id) ON DELETE CASCADE,
    
    -- Receipt details
    quantity_received DECIMAL(12,4) NOT NULL,
    condition_grade VARCHAR(50) DEFAULT 'NEW',
    batch_lot_number VARCHAR(100),
    serial_numbers JSONB DEFAULT '[]',
    expiry_date DATE,
    received_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Storage assignment
    storage_location_id UUID REFERENCES storage_locations(id),
    bin_id UUID REFERENCES bins(id),
    
    -- Additional info
    notes TEXT,
    received_by UUID REFERENCES users(id),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX idx_goods_receipts_po_id ON goods_receipts(po_id);
CREATE INDEX idx_goods_receipts_line_item_id ON goods_receipts(po_line_item_id);
CREATE INDEX idx_goods_receipts_received_date ON goods_receipts(received_date);
CREATE INDEX idx_goods_receipts_storage_location ON goods_receipts(storage_location_id);
CREATE INDEX idx_goods_receipts_bin ON goods_receipts(bin_id);
CREATE INDEX idx_goods_receipts_received_by ON goods_receipts(received_by);

-- Add constraints
ALTER TABLE goods_receipts
ADD CONSTRAINT goods_receipts_quantity_positive CHECK (quantity_received > 0);

ALTER TABLE goods_receipts
ADD CONSTRAINT goods_receipts_condition_grade_check CHECK (
    condition_grade IN ('NEW', 'USED', 'REFURBISHED', 'DAMAGED')
);

-- Add comments for documentation
COMMENT ON TABLE goods_receipts IS 'Records of goods received against purchase orders with inventory integration';
COMMENT ON COLUMN goods_receipts.quantity_received IS 'Quantity of goods received for this receipt';
COMMENT ON COLUMN goods_receipts.condition_grade IS 'Physical condition of received goods (NEW, USED, REFURBISHED, DAMAGED)';
COMMENT ON COLUMN goods_receipts.batch_lot_number IS 'Manufacturer batch or lot number for traceability';
COMMENT ON COLUMN goods_receipts.serial_numbers IS 'Array of serial numbers for serialized items';
COMMENT ON COLUMN goods_receipts.expiry_date IS 'Expiration date for perishable goods';
COMMENT ON COLUMN goods_receipts.storage_location_id IS 'Where the goods were stored upon receipt';
COMMENT ON COLUMN goods_receipts.bin_id IS 'Specific bin where goods were placed';
COMMENT ON COLUMN goods_receipts.notes IS 'Additional notes about the receipt (damage, discrepancies, etc.)';
COMMENT ON COLUMN goods_receipts.received_by IS 'User who received and processed the goods';