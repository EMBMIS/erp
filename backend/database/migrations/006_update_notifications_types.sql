-- Migration: Update notification types
-- Update notification type constraint to support new approval workflow types

-- Drop the old constraint
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

-- Add the updated constraint with all necessary notification types
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check 
CHECK (type IN (
  'ITEM_APPROVED', 
  'ITEM_DECLINED', 
  'GENERAL',
  'approval',
  'decline', 
  'approval_request'
));

-- Update existing records if any have old types (just in case)
UPDATE notifications 
SET type = 'approval' 
WHERE type = 'ITEM_APPROVED';

UPDATE notifications 
SET type = 'decline' 
WHERE type = 'ITEM_DECLINED';

-- Add comment
COMMENT ON COLUMN notifications.type IS 'Type of notification (approval, decline, approval_request, GENERAL)';