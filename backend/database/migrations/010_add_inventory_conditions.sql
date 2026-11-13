-- Migration: Add condition fields to inventory items
-- Add condition A through D with custom naming support

-- Add condition fields to inventory_items table
ALTER TABLE inventory_items
ADD COLUMN IF NOT EXISTS condition_a_name VARCHAR(100),
ADD COLUMN IF NOT EXISTS condition_a_value VARCHAR(255),
ADD COLUMN IF NOT EXISTS condition_b_name VARCHAR(100),
ADD COLUMN IF NOT EXISTS condition_b_value VARCHAR(255),
ADD COLUMN IF NOT EXISTS condition_c_name VARCHAR(100),
ADD COLUMN IF NOT EXISTS condition_c_value VARCHAR(255),
ADD COLUMN IF NOT EXISTS condition_d_name VARCHAR(100),
ADD COLUMN IF NOT EXISTS condition_d_value VARCHAR(255);

-- Create indexes for condition searches
CREATE INDEX IF NOT EXISTS idx_inventory_items_condition_a_value ON inventory_items(condition_a_value);
CREATE INDEX IF NOT EXISTS idx_inventory_items_condition_b_value ON inventory_items(condition_b_value);
CREATE INDEX IF NOT EXISTS idx_inventory_items_condition_c_value ON inventory_items(condition_c_value);
CREATE INDEX IF NOT EXISTS idx_inventory_items_condition_d_value ON inventory_items(condition_d_value);

-- Add comments for the new condition fields
COMMENT ON COLUMN inventory_items.condition_a_name IS 'Custom name for condition A (e.g., Quality Grade, Serial Batch, etc.)';
COMMENT ON COLUMN inventory_items.condition_a_value IS 'Value for condition A';
COMMENT ON COLUMN inventory_items.condition_b_name IS 'Custom name for condition B (e.g., Manufacturing Date, Location, etc.)';
COMMENT ON COLUMN inventory_items.condition_b_value IS 'Value for condition B';
COMMENT ON COLUMN inventory_items.condition_c_name IS 'Custom name for condition C (e.g., Supplier, Temperature, etc.)';
COMMENT ON COLUMN inventory_items.condition_c_value IS 'Value for condition C';
COMMENT ON COLUMN inventory_items.condition_d_name IS 'Custom name for condition D (e.g., Warranty, Expiry Date, etc.)';
COMMENT ON COLUMN inventory_items.condition_d_value IS 'Value for condition D';

-- Print success message
DO $$
BEGIN
    RAISE NOTICE 'Migration completed successfully. Condition fields (A-D) with custom naming have been added to inventory items.';
END $$;