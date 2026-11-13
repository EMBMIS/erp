-- Update notifications type constraint to include all new notification types
ALTER TABLE notifications 
DROP CONSTRAINT notifications_type_check;

ALTER TABLE notifications 
ADD CONSTRAINT notifications_type_check CHECK (
  type IN (
    -- Legacy types
    'ITEM_APPROVED',
    'ITEM_DECLINED',
    'GENERAL',
    'approval',
    'decline',
    'approval_request',
    
    -- Item Master notifications
    'item_master_submitted',
    'item_master_approved',
    'item_master_declined',
    
    -- Inventory Item notifications
    'inventory_item_submitted',
    'inventory_item_approved',
    'inventory_item_declined',
    
    -- Storage Assignment notifications
    'storage_assignment_submitted',
    'storage_assignment_approved',
    'storage_assignment_declined',
    
    -- Storage Location notifications
    'storage_location_submitted',
    'storage_location_approved',
    'storage_location_declined',
    
    -- Bin notifications
    'bin_submitted',
    'bin_approved',
    'bin_declined'
  )
);

-- Add comment for documentation
COMMENT ON CONSTRAINT notifications_type_check ON notifications IS 'Allowed notification types for inventory management approval workflows';