-- Migration: Add approval features
-- Add decline reason and inventory code sequence

-- Add decline_reason column to items table
ALTER TABLE items 
ADD COLUMN decline_reason TEXT,
ADD COLUMN approved_item_code VARCHAR(50);

-- Create sequence for inventory codes starting from 1 
-- This will generate codes like INV-00000001, INV-00000002, etc.
CREATE SEQUENCE inventory_code_seq 
    START WITH 1
    INCREMENT BY 1
    MINVALUE 1
    NO MAXVALUE
    CACHE 1;

-- Create function to generate inventory codes
CREATE OR REPLACE FUNCTION generate_inventory_code()
RETURNS VARCHAR(50) AS $$
DECLARE
    next_number BIGINT;
    code_length INTEGER;
    formatted_number VARCHAR(50);
BEGIN
    -- Get next sequence value
    SELECT nextval('inventory_code_seq') INTO next_number;
    
    -- Determine required padding based on number size
    IF next_number <= 99999999 THEN
        code_length := 8;
    ELSIF next_number <= 999999999 THEN
        code_length := 9;
    ELSIF next_number <= 9999999999 THEN
        code_length := 10;
    ELSIF next_number <= 99999999999 THEN
        code_length := 11;
    ELSE
        code_length := 12; -- Support up to 12 digits
    END IF;
    
    -- Format number with leading zeros
    formatted_number := LPAD(next_number::TEXT, code_length, '0');
    
    -- Return INV- prefix with formatted number
    RETURN 'INV-' || formatted_number;
END;
$$ LANGUAGE plpgsql;

-- Create indexes for new fields
CREATE INDEX idx_items_decline_reason ON items(decline_reason) WHERE decline_reason IS NOT NULL;
CREATE INDEX idx_items_approved_item_code ON items(approved_item_code) WHERE approved_item_code IS NOT NULL;

-- Add comment
COMMENT ON COLUMN items.decline_reason IS 'Reason for declining the item master during approval process';
COMMENT ON COLUMN items.approved_item_code IS 'Final inventory code assigned after approval (INV-XXXXXXXX format)';
COMMENT ON SEQUENCE inventory_code_seq IS 'Sequence for generating unique inventory codes';
COMMENT ON FUNCTION generate_inventory_code() IS 'Function to generate INV-XXXXXXXX codes with auto-expanding length';