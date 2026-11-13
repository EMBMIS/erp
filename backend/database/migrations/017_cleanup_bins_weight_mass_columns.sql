-- Clean up bins table weight/mass column inconsistency
-- The model uses max_mass_capacity but database has max_weight_capacity as not null

-- First, copy any data from max_weight_capacity to max_mass_capacity where needed
UPDATE bins 
SET max_mass_capacity = max_weight_capacity 
WHERE max_mass_capacity IS NULL AND max_weight_capacity IS NOT NULL;

-- Make max_mass_capacity not null (set default if still null)
UPDATE bins 
SET max_mass_capacity = 100.0 
WHERE max_mass_capacity IS NULL;

-- Alter the column to be not null
ALTER TABLE bins 
ALTER COLUMN max_mass_capacity SET NOT NULL;

-- Drop the old max_weight_capacity column
ALTER TABLE bins 
DROP COLUMN max_weight_capacity;

-- Also clean up current_weight vs current_mass_used
-- The model expects current_mass_used to be not null
UPDATE bins 
SET current_mass_used = COALESCE(current_weight, 0.0);

-- Drop the old current_weight column if it exists
ALTER TABLE bins 
DROP COLUMN IF EXISTS current_weight;

-- Ensure current_volume_used uses current_volume data if needed
UPDATE bins 
SET current_volume_used = COALESCE(current_volume, 0.0);

-- Drop the old current_volume column if it exists  
ALTER TABLE bins 
DROP COLUMN IF EXISTS current_volume;

-- Add comment for clarity
COMMENT ON COLUMN bins.max_mass_capacity IS 'Maximum mass capacity in kg';
COMMENT ON COLUMN bins.max_volume_capacity IS 'Maximum volume capacity in m³';
COMMENT ON COLUMN bins.current_mass_used IS 'Current mass used in kg';
COMMENT ON COLUMN bins.current_volume_used IS 'Current volume used in m³';