-- Migration: Add new fields to existing items table
-- This script safely adds new columns if they don't exist

-- Add new boolean fields for stock classification
DO $$ 
BEGIN
    BEGIN
        ALTER TABLE items ADD COLUMN is_stock_item BOOLEAN NOT NULL DEFAULT TRUE;
    EXCEPTION
        WHEN duplicate_column THEN RAISE NOTICE 'Column is_stock_item already exists';
    END;
    
    BEGIN
        ALTER TABLE items ADD COLUMN planned_stock BOOLEAN NOT NULL DEFAULT FALSE;
    EXCEPTION
        WHEN duplicate_column THEN RAISE NOTICE 'Column planned_stock already exists';
    END;
END $$;

-- Add manufacturer fields
DO $$ 
BEGIN
    BEGIN
        ALTER TABLE items ADD COLUMN manufacturer VARCHAR(255);
    EXCEPTION
        WHEN duplicate_column THEN RAISE NOTICE 'Column manufacturer already exists';
    END;
    
    BEGIN
        ALTER TABLE items ADD COLUMN manufacturer_part_number VARCHAR(100);
    EXCEPTION
        WHEN duplicate_column THEN RAISE NOTICE 'Column manufacturer_part_number already exists';
    END;
END $$;

-- Add additional identification fields
DO $$ 
BEGIN
    BEGIN
        ALTER TABLE items ADD COLUMN item_category VARCHAR(100);
    EXCEPTION
        WHEN duplicate_column THEN RAISE NOTICE 'Column item_category already exists';
    END;
    
    BEGIN
        ALTER TABLE items ADD COLUMN serial_number VARCHAR(100);
    EXCEPTION
        WHEN duplicate_column THEN RAISE NOTICE 'Column serial_number already exists';
    END;
    
    BEGIN
        ALTER TABLE items ADD COLUMN equipment_tag VARCHAR(50);
    EXCEPTION
        WHEN duplicate_column THEN RAISE NOTICE 'Column equipment_tag already exists';
    END;
END $$;

-- Add contract fields
DO $$ 
BEGIN
    BEGIN
        ALTER TABLE items ADD COLUMN has_contract BOOLEAN DEFAULT FALSE;
    EXCEPTION
        WHEN duplicate_column THEN RAISE NOTICE 'Column has_contract already exists';
    END;
    
    BEGIN
        ALTER TABLE items ADD COLUMN contract_number VARCHAR(50);
    EXCEPTION
        WHEN duplicate_column THEN RAISE NOTICE 'Column contract_number already exists';
    END;
END $$;

-- Add barcode fields
DO $$ 
BEGIN
    BEGIN
        ALTER TABLE items ADD COLUMN has_barcode BOOLEAN DEFAULT FALSE;
    EXCEPTION
        WHEN duplicate_column THEN RAISE NOTICE 'Column has_barcode already exists';
    END;
    
    BEGIN
        ALTER TABLE items ADD COLUMN barcode VARCHAR(100);
    EXCEPTION
        WHEN duplicate_column THEN RAISE NOTICE 'Column barcode already exists';
    END;
END $$;

-- Update stock_code logic for existing records based on new boolean fields
-- This will auto-generate stock codes for existing records
UPDATE items 
SET stock_code = CASE 
    WHEN NOT is_stock_item THEN 'NS3'
    WHEN is_stock_item AND planned_stock THEN 'ST2' 
    ELSE 'ST1'
END
WHERE stock_code IS NULL OR stock_code NOT IN ('ST1', 'ST2', 'NS3');

-- Add indexes for new fields if they don't exist
DO $$ 
BEGIN
    BEGIN
        CREATE INDEX idx_items_is_stock_item ON items(is_stock_item);
    EXCEPTION
        WHEN duplicate_table THEN RAISE NOTICE 'Index idx_items_is_stock_item already exists';
    END;
    
    BEGIN
        CREATE INDEX idx_items_planned_stock ON items(planned_stock);
    EXCEPTION
        WHEN duplicate_table THEN RAISE NOTICE 'Index idx_items_planned_stock already exists';
    END;
    
    BEGIN
        CREATE INDEX idx_items_manufacturer ON items(manufacturer);
    EXCEPTION
        WHEN duplicate_table THEN RAISE NOTICE 'Index idx_items_manufacturer already exists';
    END;
    
    BEGIN
        CREATE INDEX idx_items_manufacturer_part_number ON items(manufacturer_part_number);
    EXCEPTION
        WHEN duplicate_table THEN RAISE NOTICE 'Index idx_items_manufacturer_part_number already exists';
    END;
    
    BEGIN
        CREATE INDEX idx_items_item_category ON items(item_category);
    EXCEPTION
        WHEN duplicate_table THEN RAISE NOTICE 'Index idx_items_item_category already exists';
    END;
    
    BEGIN
        CREATE INDEX idx_items_serial_number ON items(serial_number);
    EXCEPTION
        WHEN duplicate_table THEN RAISE NOTICE 'Index idx_items_serial_number already exists';
    END;
    
    BEGIN
        CREATE INDEX idx_items_equipment_tag ON items(equipment_tag);
    EXCEPTION
        WHEN duplicate_table THEN RAISE NOTICE 'Index idx_items_equipment_tag already exists';
    END;
    
    BEGIN
        CREATE INDEX idx_items_contract_number ON items(contract_number);
    EXCEPTION
        WHEN duplicate_table THEN RAISE NOTICE 'Index idx_items_contract_number already exists';
    END;
    
    BEGIN
        CREATE INDEX idx_items_barcode ON items(barcode);
    EXCEPTION
        WHEN duplicate_table THEN RAISE NOTICE 'Index idx_items_barcode already exists';
    END;
END $$;

-- Print success message
DO $$
BEGIN
    RAISE NOTICE 'Migration completed successfully. All new fields and indexes have been added.';
END $$;