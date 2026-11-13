-- Update supplier status constraint to include PENDING_SUPPLIER_CONFIRMATION
-- Migration 022: Add new supplier status for two-step approval process

-- Drop existing status constraint
ALTER TABLE suppliers 
DROP CONSTRAINT IF EXISTS suppliers_status_check;

-- Add new constraint with PENDING_SUPPLIER_CONFIRMATION status
ALTER TABLE suppliers 
ADD CONSTRAINT suppliers_status_check CHECK (
  status IN ('DRAFT', 'PENDING_APPROVAL', 'PENDING_SUPPLIER_CONFIRMATION', 'ACTIVE', 'INACTIVE', 'DECLINED')
);

-- Add comment for the new status
COMMENT ON CONSTRAINT suppliers_status_check ON suppliers IS 'Allowed supplier statuses including two-step approval process';

-- Update any existing data if needed (optional - depends on current data state)
-- This ensures consistency if any suppliers are in incorrect states
UPDATE suppliers 
SET status = 'PENDING_SUPPLIER_CONFIRMATION' 
WHERE status = 'ACTIVE' 
AND partnership_status = 'PENDING'
AND approved_by IS NOT NULL;