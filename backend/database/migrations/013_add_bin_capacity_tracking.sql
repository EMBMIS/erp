-- Migration: Add bin capacity tracking for mass and volume
-- Description: Add capacity fields to bins table for warehouse management

-- Add capacity fields to bins table
DO $$ 
BEGIN
    -- Add max capacity fields
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bins' AND column_name = 'max_mass_capacity') THEN
        ALTER TABLE bins ADD COLUMN max_mass_capacity DECIMAL(10,3) DEFAULT NULL;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bins' AND column_name = 'max_volume_capacity') THEN
        ALTER TABLE bins ADD COLUMN max_volume_capacity DECIMAL(10,3) DEFAULT NULL;
    END IF;
    
    -- Add current utilization fields (calculated from assigned items)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bins' AND column_name = 'current_mass_used') THEN
        ALTER TABLE bins ADD COLUMN current_mass_used DECIMAL(10,3) DEFAULT 0 NOT NULL;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bins' AND column_name = 'current_volume_used') THEN
        ALTER TABLE bins ADD COLUMN current_volume_used DECIMAL(10,3) DEFAULT 0 NOT NULL;
    END IF;
    
    -- Add capacity tracking fields to storage locations as well
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'storage_locations' AND column_name = 'max_mass_capacity') THEN
        ALTER TABLE storage_locations ADD COLUMN max_mass_capacity DECIMAL(12,3) DEFAULT NULL;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'storage_locations' AND column_name = 'max_volume_capacity') THEN
        ALTER TABLE storage_locations ADD COLUMN max_volume_capacity DECIMAL(12,3) DEFAULT NULL;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'storage_locations' AND column_name = 'current_mass_used') THEN
        ALTER TABLE storage_locations ADD COLUMN current_mass_used DECIMAL(12,3) DEFAULT 0 NOT NULL;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'storage_locations' AND column_name = 'current_volume_used') THEN
        ALTER TABLE storage_locations ADD COLUMN current_volume_used DECIMAL(12,3) DEFAULT 0 NOT NULL;
    END IF;
END $$;

-- Create function to update capacity utilization when items are assigned/removed
CREATE OR REPLACE FUNCTION update_storage_capacity() 
RETURNS TRIGGER AS $$
BEGIN
    -- Update bin capacity if bin_id is specified
    IF NEW.bin_id IS NOT NULL THEN
        UPDATE bins 
        SET 
            current_mass_used = COALESCE((
                SELECT SUM(ism.quantity_in_location * COALESCE(i.mass_per_uom, 0))
                FROM inventory_storage_mappings ism
                JOIN inventory_items ii ON ism.inventory_item_id = ii.id
                JOIN items i ON ii.item_master_id = i.id
                WHERE ism.bin_id = NEW.bin_id
            ), 0),
            current_volume_used = COALESCE((
                SELECT SUM(ism.quantity_in_location * COALESCE(i.volume_per_uom, 0))
                FROM inventory_storage_mappings ism
                JOIN inventory_items ii ON ism.inventory_item_id = ii.id
                JOIN items i ON ii.item_master_id = i.id
                WHERE ism.bin_id = NEW.bin_id
            ), 0)
        WHERE id = NEW.bin_id;
    END IF;
    
    -- Update storage location capacity
    UPDATE storage_locations 
    SET 
        current_mass_used = COALESCE((
            SELECT SUM(ism.quantity_in_location * COALESCE(i.mass_per_uom, 0))
            FROM inventory_storage_mappings ism
            JOIN inventory_items ii ON ism.inventory_item_id = ii.id
            JOIN items i ON ii.item_master_id = i.id
            WHERE ism.storage_location_id = NEW.storage_location_id
        ), 0),
        current_volume_used = COALESCE((
            SELECT SUM(ism.quantity_in_location * COALESCE(i.volume_per_uom, 0))
            FROM inventory_storage_mappings ism
            JOIN inventory_items ii ON ism.inventory_item_id = ii.id
            JOIN items i ON ii.item_master_id = i.id
            WHERE ism.storage_location_id = NEW.storage_location_id
        ), 0)
    WHERE id = NEW.storage_location_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create function to handle deletions
CREATE OR REPLACE FUNCTION update_storage_capacity_on_delete() 
RETURNS TRIGGER AS $$
BEGIN
    -- Update bin capacity if bin_id was specified
    IF OLD.bin_id IS NOT NULL THEN
        UPDATE bins 
        SET 
            current_mass_used = COALESCE((
                SELECT SUM(ism.quantity_in_location * COALESCE(i.mass_per_uom, 0))
                FROM inventory_storage_mappings ism
                JOIN inventory_items ii ON ism.inventory_item_id = ii.id
                JOIN items i ON ii.item_master_id = i.id
                WHERE ism.bin_id = OLD.bin_id
            ), 0),
            current_volume_used = COALESCE((
                SELECT SUM(ism.quantity_in_location * COALESCE(i.volume_per_uom, 0))
                FROM inventory_storage_mappings ism
                JOIN inventory_items ii ON ism.inventory_item_id = ii.id
                JOIN items i ON ii.item_master_id = i.id
                WHERE ism.bin_id = OLD.bin_id
            ), 0)
        WHERE id = OLD.bin_id;
    END IF;
    
    -- Update storage location capacity
    UPDATE storage_locations 
    SET 
        current_mass_used = COALESCE((
            SELECT SUM(ism.quantity_in_location * COALESCE(i.mass_per_uom, 0))
            FROM inventory_storage_mappings ism
            JOIN inventory_items ii ON ism.inventory_item_id = ii.id
            JOIN items i ON ii.item_master_id = i.id
            WHERE ism.storage_location_id = OLD.storage_location_id
        ), 0),
        current_volume_used = COALESCE((
            SELECT SUM(ism.quantity_in_location * COALESCE(i.volume_per_uom, 0))
            FROM inventory_storage_mappings ism
            JOIN inventory_items ii ON ism.inventory_item_id = ii.id
            JOIN items i ON ii.item_master_id = i.id
            WHERE ism.storage_location_id = OLD.storage_location_id
        ), 0)
    WHERE id = OLD.storage_location_id;
    
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Drop existing triggers if they exist
DROP TRIGGER IF EXISTS trigger_update_storage_capacity ON inventory_storage_mappings;
DROP TRIGGER IF EXISTS trigger_update_storage_capacity_delete ON inventory_storage_mappings;

-- Create triggers to automatically update capacity when items are assigned/removed
CREATE TRIGGER trigger_update_storage_capacity
    AFTER INSERT OR UPDATE ON inventory_storage_mappings
    FOR EACH ROW
    EXECUTE FUNCTION update_storage_capacity();

CREATE TRIGGER trigger_update_storage_capacity_delete
    AFTER DELETE ON inventory_storage_mappings
    FOR EACH ROW
    EXECUTE FUNCTION update_storage_capacity_on_delete();

-- Add comments
COMMENT ON COLUMN bins.max_mass_capacity IS 'Maximum mass capacity in kilograms';
COMMENT ON COLUMN bins.max_volume_capacity IS 'Maximum volume capacity in cubic meters';
COMMENT ON COLUMN bins.current_mass_used IS 'Current mass utilization in kilograms';
COMMENT ON COLUMN bins.current_volume_used IS 'Current volume utilization in cubic meters';

COMMENT ON COLUMN storage_locations.max_mass_capacity IS 'Maximum mass capacity in kilograms';
COMMENT ON COLUMN storage_locations.max_volume_capacity IS 'Maximum volume capacity in cubic meters';
COMMENT ON COLUMN storage_locations.current_mass_used IS 'Current mass utilization in kilograms';
COMMENT ON COLUMN storage_locations.current_volume_used IS 'Current volume utilization in cubic meters';