-- Migration: Add Mass per UoM and Volume per UoM fields to items
-- Add mass_per_uom and volume_per_uom fields for more accurate inventory calculations

-- Add mass per UoM and volume per UoM columns to items table
ALTER TABLE items 
ADD COLUMN IF NOT EXISTS mass_per_uom DECIMAL(10,6),
ADD COLUMN IF NOT EXISTS volume_per_uom DECIMAL(10,6);

-- Create indexes for the new fields
CREATE INDEX IF NOT EXISTS idx_items_mass_per_uom ON items(mass_per_uom);
CREATE INDEX IF NOT EXISTS idx_items_volume_per_uom ON items(volume_per_uom);

-- Add validation constraints for positive values
DO $$
BEGIN
    -- Add validation constraint for positive mass per UoM
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_positive_mass_per_uom_check') THEN
        ALTER TABLE items ADD CONSTRAINT items_positive_mass_per_uom_check CHECK (mass_per_uom IS NULL OR mass_per_uom > 0);
    END IF;

    -- Add validation constraint for positive volume per UoM
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_positive_volume_per_uom_check') THEN
        ALTER TABLE items ADD CONSTRAINT items_positive_volume_per_uom_check CHECK (volume_per_uom IS NULL OR volume_per_uom > 0);
    END IF;
END $$;

-- Add comments for documentation
COMMENT ON COLUMN items.mass_per_uom IS 'Mass per unit of measure in kilograms (kg) - used for accurate inventory calculations';
COMMENT ON COLUMN items.volume_per_uom IS 'Volume per unit of measure in cubic meters (m³) - used for accurate inventory calculations';

-- Update existing items to copy values from mass/volume to mass_per_uom/volume_per_uom if they exist
-- This assumes the existing mass/volume were already per unit
UPDATE items 
SET mass_per_uom = mass, volume_per_uom = volume
WHERE mass IS NOT NULL OR volume IS NOT NULL;