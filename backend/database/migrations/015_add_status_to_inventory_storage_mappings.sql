-- Add status column to inventory_storage_mappings table
ALTER TABLE inventory_storage_mappings 
ADD COLUMN status VARCHAR(50) DEFAULT 'PENDING_APPROVAL';

-- Update existing records to have APPROVED status (assuming they were previously approved)
UPDATE inventory_storage_mappings 
SET status = 'APPROVED' 
WHERE status IS NULL;

-- Add index for better query performance
CREATE INDEX idx_inventory_storage_mappings_status ON inventory_storage_mappings(status);

-- Add comment for documentation
COMMENT ON COLUMN inventory_storage_mappings.status IS 'Status of the storage assignment: PENDING_APPROVAL, APPROVED, DECLINED';