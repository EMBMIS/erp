-- Migration: Add missing inventory status and condition columns
-- This consolidates migrations 009, 010, and 011 that may not have been applied

-- First, check if columns already exist and add them if missing
DO $$
BEGIN
    -- Add approval workflow columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_items' AND column_name = 'status') THEN
        ALTER TABLE inventory_items
        ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'PENDING_APPROVAL' 
            CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'DECLINED'));
        
        RAISE NOTICE 'Added status column to inventory_items';
    ELSE
        RAISE NOTICE 'Status column already exists in inventory_items';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_items' AND column_name = 'approved_by') THEN
        ALTER TABLE inventory_items
        ADD COLUMN approved_by UUID REFERENCES users(id) ON DELETE SET NULL;
        
        RAISE NOTICE 'Added approved_by column to inventory_items';
    ELSE
        RAISE NOTICE 'Approved_by column already exists in inventory_items';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_items' AND column_name = 'approved_at') THEN
        ALTER TABLE inventory_items
        ADD COLUMN approved_at TIMESTAMP WITH TIME ZONE;
        
        RAISE NOTICE 'Added approved_at column to inventory_items';
    ELSE
        RAISE NOTICE 'Approved_at column already exists in inventory_items';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_items' AND column_name = 'decline_reason') THEN
        ALTER TABLE inventory_items
        ADD COLUMN decline_reason TEXT;
        
        RAISE NOTICE 'Added decline_reason column to inventory_items';
    ELSE
        RAISE NOTICE 'Decline_reason column already exists in inventory_items';
    END IF;

    -- Add condition grading columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_items' AND column_name = 'condition_grade') THEN
        ALTER TABLE inventory_items
        ADD COLUMN condition_grade VARCHAR(1) CHECK (condition_grade IN ('A', 'B', 'C', 'D'));
        
        RAISE NOTICE 'Added condition_grade column to inventory_items';
    ELSE
        RAISE NOTICE 'Condition_grade column already exists in inventory_items';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_items' AND column_name = 'condition_notes') THEN
        ALTER TABLE inventory_items
        ADD COLUMN condition_notes TEXT;
        
        RAISE NOTICE 'Added condition_notes column to inventory_items';
    ELSE
        RAISE NOTICE 'Condition_notes column already exists in inventory_items';
    END IF;
END $$;

-- Create indexes for performance (only if they don't exist)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_inventory_items_status') THEN
        CREATE INDEX idx_inventory_items_status ON inventory_items(status);
        RAISE NOTICE 'Created index on inventory_items.status';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_inventory_items_approved_by') THEN
        CREATE INDEX idx_inventory_items_approved_by ON inventory_items(approved_by);
        RAISE NOTICE 'Created index on inventory_items.approved_by';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_inventory_items_condition_grade') THEN
        CREATE INDEX idx_inventory_items_condition_grade ON inventory_items(condition_grade);
        RAISE NOTICE 'Created index on inventory_items.condition_grade';
    END IF;
END $$;

-- Update existing inventory items to be approved (for backwards compatibility)
-- Only if there are items without status
DO $$
DECLARE
    item_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO item_count FROM inventory_items WHERE status = 'PENDING_APPROVAL';
    
    IF item_count > 0 THEN
        UPDATE inventory_items 
        SET status = 'APPROVED', 
            approved_at = CURRENT_TIMESTAMP,
            condition_grade = COALESCE(condition_grade, 'A')
        WHERE status = 'PENDING_APPROVAL';
        
        RAISE NOTICE 'Updated % existing inventory items to APPROVED status', item_count;
    ELSE
        RAISE NOTICE 'No pending approval inventory items found';
    END IF;
END $$;

-- Add comments for documentation
COMMENT ON COLUMN inventory_items.status IS 'Approval status: PENDING_APPROVAL, APPROVED, DECLINED';
COMMENT ON COLUMN inventory_items.approved_by IS 'Manager who approved/declined the inventory item';
COMMENT ON COLUMN inventory_items.approved_at IS 'Timestamp when the inventory item was approved';
COMMENT ON COLUMN inventory_items.decline_reason IS 'Reason for declining the inventory item';
COMMENT ON COLUMN inventory_items.condition_grade IS 'Item condition grade: A=Excellent, B=Good, C=Fair, D=Poor';
COMMENT ON COLUMN inventory_items.condition_notes IS 'Additional notes about item condition';

-- Final success message
DO $$
BEGIN
    RAISE NOTICE 'Migration 012 completed successfully. Inventory approval workflow and condition grading are now available.';
END $$;