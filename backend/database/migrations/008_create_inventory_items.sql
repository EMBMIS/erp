-- Migration: Create inventory_items table and storage mappings
-- Create inventory items system that extends approved item masters with inventory-specific fields

-- Create inventory_items table
CREATE TABLE IF NOT EXISTS inventory_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    item_master_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    
    -- Stock Information
    current_stock_quantity DECIMAL(12,4) DEFAULT 0 NOT NULL,
    
    -- Reorder & Stock Control (requires approval)
    minimum_stock_level DECIMAL(12,4),
    maximum_stock_level DECIMAL(12,4),
    reorder_point DECIMAL(12,4),
    
    -- Cost Information
    unit_price DECIMAL(12,2),
    currency VARCHAR(3) DEFAULT 'USD',
    
    -- System fields
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create inventory_storage_mappings table (many-to-many for items and storage locations)
CREATE TABLE IF NOT EXISTS inventory_storage_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    storage_location_id UUID NOT NULL REFERENCES storage_locations(id) ON DELETE CASCADE,
    bin_id UUID REFERENCES bins(id) ON DELETE SET NULL,
    
    -- Quantity in this specific location/bin
    quantity_in_location DECIMAL(12,4) DEFAULT 0 NOT NULL,
    
    -- System fields
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_inventory_items_item_master_id ON inventory_items(item_master_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_user_id ON inventory_items(user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_current_stock ON inventory_items(current_stock_quantity);
CREATE INDEX IF NOT EXISTS idx_inventory_items_reorder_point ON inventory_items(reorder_point);

CREATE INDEX IF NOT EXISTS idx_inventory_storage_mappings_inventory_item_id ON inventory_storage_mappings(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_storage_mappings_storage_location_id ON inventory_storage_mappings(storage_location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_storage_mappings_bin_id ON inventory_storage_mappings(bin_id);
CREATE INDEX IF NOT EXISTS idx_inventory_storage_mappings_user_id ON inventory_storage_mappings(user_id);

-- Add constraints
DO $$
BEGIN
    -- Note: We'll enforce approved-only constraint in application logic rather than database
    -- since PostgreSQL doesn't allow subqueries in CHECK constraints
    
    -- Ensure positive stock quantities
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_positive_stock_check') THEN
        ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_positive_stock_check 
        CHECK (current_stock_quantity >= 0);
    END IF;
    
    -- Ensure positive reorder levels when specified
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_positive_reorder_check') THEN
        ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_positive_reorder_check 
        CHECK (minimum_stock_level IS NULL OR minimum_stock_level >= 0);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_positive_max_stock_check') THEN
        ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_positive_max_stock_check 
        CHECK (maximum_stock_level IS NULL OR maximum_stock_level >= 0);
    END IF;
    
    -- Ensure logical stock level relationships
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_stock_level_logic_check') THEN
        ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_stock_level_logic_check 
        CHECK (minimum_stock_level IS NULL OR maximum_stock_level IS NULL OR minimum_stock_level <= maximum_stock_level);
    END IF;
    
    -- Ensure positive unit prices when specified
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_positive_price_check') THEN
        ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_positive_price_check 
        CHECK (unit_price IS NULL OR unit_price > 0);
    END IF;
    
    -- Ensure positive quantities in storage mappings
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_storage_mappings_positive_quantity_check') THEN
        ALTER TABLE inventory_storage_mappings ADD CONSTRAINT inventory_storage_mappings_positive_quantity_check 
        CHECK (quantity_in_location >= 0);
    END IF;
    
    -- Ensure unique item per user (each user can only have one inventory record per item master)
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_unique_item_per_user') THEN
        ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_unique_item_per_user 
        UNIQUE (item_master_id, user_id);
    END IF;
END $$;

-- Create triggers for updated_at
DROP TRIGGER IF EXISTS update_inventory_items_updated_at ON inventory_items;
CREATE TRIGGER update_inventory_items_updated_at 
    BEFORE UPDATE ON inventory_items
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_inventory_storage_mappings_updated_at ON inventory_storage_mappings;
CREATE TRIGGER update_inventory_storage_mappings_updated_at 
    BEFORE UPDATE ON inventory_storage_mappings
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Add comments for documentation
COMMENT ON TABLE inventory_items IS 'Inventory items extending approved item masters with inventory-specific data';
COMMENT ON COLUMN inventory_items.item_master_id IS 'Reference to approved item master record';
COMMENT ON COLUMN inventory_items.current_stock_quantity IS 'Current stock quantity - updated only via stock transactions';
COMMENT ON COLUMN inventory_items.minimum_stock_level IS 'Minimum stock level that triggers alerts (requires approval)';
COMMENT ON COLUMN inventory_items.maximum_stock_level IS 'Maximum stock level for inventory planning (requires approval)';
COMMENT ON COLUMN inventory_items.reorder_point IS 'Stock quantity that triggers replenishment orders';
COMMENT ON COLUMN inventory_items.unit_price IS 'Unit price for this inventory item';
COMMENT ON COLUMN inventory_items.currency IS 'Currency for unit price (e.g., USD, EUR)';

COMMENT ON TABLE inventory_storage_mappings IS 'Many-to-many mapping of inventory items to storage locations and bins';
COMMENT ON COLUMN inventory_storage_mappings.inventory_item_id IS 'Reference to inventory item';
COMMENT ON COLUMN inventory_storage_mappings.storage_location_id IS 'Reference to storage location';
COMMENT ON COLUMN inventory_storage_mappings.bin_id IS 'Optional reference to specific bin within location';
COMMENT ON COLUMN inventory_storage_mappings.quantity_in_location IS 'Quantity stored in this specific location/bin';