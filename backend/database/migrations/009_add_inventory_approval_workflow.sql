-- Migration: Add inventory item approval workflow
-- Add approval status and allow managers to set min/max/reorder points during approval

-- Add approval fields to inventory_items table
ALTER TABLE inventory_items
ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'PENDING_APPROVAL' 
    CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'DECLINED')),
ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS decline_reason TEXT;

-- Create index for inventory item status
CREATE INDEX IF NOT EXISTS idx_inventory_items_status ON inventory_items(status);
CREATE INDEX IF NOT EXISTS idx_inventory_items_approved_by ON inventory_items(approved_by);

-- Update existing inventory items to be approved (for backwards compatibility)
UPDATE inventory_items 
SET status = 'APPROVED', 
    approved_at = CURRENT_TIMESTAMP 
WHERE status = 'PENDING_APPROVAL';

-- Add comment for the new approval workflow
COMMENT ON COLUMN inventory_items.status IS 'Approval status: PENDING_APPROVAL, APPROVED, DECLINED';
COMMENT ON COLUMN inventory_items.approved_by IS 'Manager who approved/declined the inventory item';
COMMENT ON COLUMN inventory_items.approved_at IS 'Timestamp when the inventory item was approved';
COMMENT ON COLUMN inventory_items.decline_reason IS 'Reason for declining the inventory item';

-- Print success message
DO $$
BEGIN
    RAISE NOTICE 'Migration completed successfully. Inventory item approval workflow has been added.';
END $$;