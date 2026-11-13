-- Migration: Increase volume precision for accurate capacity tracking
-- Description: Update volume columns to support higher precision measurements (6 decimal places)

-- Update bins table volume columns
ALTER TABLE bins ALTER COLUMN max_volume_capacity TYPE DECIMAL(12,6);
ALTER TABLE bins ALTER COLUMN current_volume_used TYPE DECIMAL(12,6);
ALTER TABLE bins ALTER COLUMN current_volume TYPE DECIMAL(12,6);

-- Update storage_locations table volume columns
ALTER TABLE storage_locations ALTER COLUMN max_volume_capacity TYPE DECIMAL(15,6);
ALTER TABLE storage_locations ALTER COLUMN current_volume_used TYPE DECIMAL(15,6);

-- Update items table volume columns
ALTER TABLE items ALTER COLUMN volume_per_uom TYPE DECIMAL(10,6);
ALTER TABLE items ALTER COLUMN volume TYPE DECIMAL(12,6);

-- Update inventory_storage_mappings volume tracking if exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_storage_mappings' AND column_name = 'volume_stored') THEN
        ALTER TABLE inventory_storage_mappings ALTER COLUMN volume_stored TYPE DECIMAL(12,6);
    END IF;
END $$;

-- Recreate triggers with updated precision
DROP TRIGGER IF EXISTS trigger_update_storage_capacity ON inventory_storage_mappings;
DROP TRIGGER IF EXISTS trigger_update_storage_capacity_delete ON inventory_storage_mappings;

-- Recreate function with higher precision
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

-- Recreate triggers
CREATE TRIGGER trigger_update_storage_capacity
    AFTER INSERT OR UPDATE ON inventory_storage_mappings
    FOR EACH ROW
    EXECUTE FUNCTION update_storage_capacity();

CREATE TRIGGER trigger_update_storage_capacity_delete
    AFTER DELETE ON inventory_storage_mappings
    FOR EACH ROW
    EXECUTE FUNCTION update_storage_capacity_on_delete();

-- Update comments
COMMENT ON COLUMN bins.max_volume_capacity IS 'Maximum volume capacity in cubic meters (6 decimal precision)';
COMMENT ON COLUMN bins.current_volume_used IS 'Current volume utilization in cubic meters (6 decimal precision)';

COMMENT ON COLUMN storage_locations.max_volume_capacity IS 'Maximum volume capacity in cubic meters (6 decimal precision)';
COMMENT ON COLUMN storage_locations.current_volume_used IS 'Current volume utilization in cubic meters (6 decimal precision)';

COMMENT ON COLUMN items.volume_per_uom IS 'Volume per unit of measure in cubic meters (6 decimal precision)';
COMMENT ON COLUMN items.volume IS 'Total volume in cubic meters (6 decimal precision)';