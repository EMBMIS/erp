-- Add GOODS_ISSUED workflow status to delivery schedules

ALTER TABLE delivery_schedules DROP CONSTRAINT IF EXISTS delivery_schedules_workflow_status_check;

ALTER TABLE delivery_schedules ADD CONSTRAINT delivery_schedules_workflow_status_check 
CHECK (workflow_status IN (
  'PLANNING', 
  'PO_CREATED', 
  'INVENTORY_RESERVED', 
  'GOODS_ISSUED',
  'READY_TO_SHIP', 
  'SHIPPED', 
  'DELIVERED', 
  'COMPLETED'
));