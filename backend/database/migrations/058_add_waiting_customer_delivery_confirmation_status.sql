-- Add WAITING_CUSTOMER_DELIVERY_CONFIRMATION status to sales orders
-- This status is used when a PO has been delivered to customer but awaiting customer confirmation

-- Drop the existing constraint
ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_status_check;

-- Add the new constraint with the additional status
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_status_check 
CHECK (status IN (
  'DRAFT',
  'PENDING_APPROVAL', 
  'APPROVED',
  'SENT_TO_CUSTOMER',
  'CONFIRMED',
  'CUSTOMER_ACCEPTED',
  'CUSTOMER_REJECTED',
  'IN_PRODUCTION',
  'READY_FOR_DELIVERY',
  'SHIPPED',
  'DELIVERED',
  'WAITING_CUSTOMER_DELIVERY_CONFIRMATION',
  'COMPLETED',
  'CANCELLED',
  'REJECTED'
));