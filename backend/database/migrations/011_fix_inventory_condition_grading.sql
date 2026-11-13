-- Migration: Fix inventory condition system to use A-D grading
-- Replace custom condition fields with a single condition grade field

-- Remove the old condition fields
ALTER TABLE inventory_items
DROP COLUMN IF EXISTS condition_a_name,
DROP COLUMN IF EXISTS condition_a_value,
DROP COLUMN IF EXISTS condition_b_name,
DROP COLUMN IF EXISTS condition_b_value,
DROP COLUMN IF EXISTS condition_c_name,
DROP COLUMN IF EXISTS condition_c_value,
DROP COLUMN IF EXISTS condition_d_name,
DROP COLUMN IF EXISTS condition_d_value;

-- Add new condition grade field
ALTER TABLE inventory_items
ADD COLUMN IF NOT EXISTS condition_grade VARCHAR(1) CHECK (condition_grade IN ('A', 'B', 'C', 'D')),
ADD COLUMN IF NOT EXISTS condition_notes TEXT;

-- Create index for condition grade
CREATE INDEX IF NOT EXISTS idx_inventory_items_condition_grade ON inventory_items(condition_grade);

-- Add comments for the new condition system
COMMENT ON COLUMN inventory_items.condition_grade IS 'Item condition grade: A (Excellent/New), B (Good), C (Fair), D (Poor)';
COMMENT ON COLUMN inventory_items.condition_notes IS 'Additional notes about the item condition';

-- Set default condition grade for existing items (if any)
UPDATE inventory_items 
SET condition_grade = 'A' 
WHERE condition_grade IS NULL;

-- Print success message
DO $$
BEGIN
    RAISE NOTICE 'Migration completed successfully. Inventory items now use A-D condition grading system.';
    RAISE NOTICE 'A = Excellent/New, B = Good, C = Fair, D = Poor';
END $$;