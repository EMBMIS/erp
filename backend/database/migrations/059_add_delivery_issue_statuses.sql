-- Add delivery issue statuses to sales orders and purchase orders
-- DELIVERY_ISSUE_REPORTED status is used when customer reports delivery problems

-- Update sales orders constraint
ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_status_check;

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
  'DELIVERY_ISSUE_REPORTED',
  'COMPLETED',
  'CANCELLED',
  'REJECTED'
));

-- Update purchase orders constraint  
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;

ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check 
CHECK (status IN (
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENT_TO_SUPPLIER',
  'CONFIRMED',
  'PREPARING_DELIVERY',
  'IN_TRANSIT',
  'DELIVERED',
  'GOODS_READY_FOR_RECEIPT',
  'READY_FOR_CUSTOMER_DELIVERY',
  'DELIVERED_TO_CUSTOMER',
  'CUSTOMER_CONFIRMED',
  'DELIVERY_ISSUE_REPORTED',
  'PARTIALLY_RECEIVED',
  'FULLY_RECEIVED',
  'COMPLETED',
  'CANCELLED',
  'REJECTED'
));

-- Add columns for customer delivery tracking if they don't exist
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customer_delivery_token VARCHAR(255);
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customer_delivery_confirmed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customer_delivery_issue_reported_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customer_delivery_notes TEXT;

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS customer_confirmation_notes TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS handover_notes TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS handover_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS handover_by UUID REFERENCES users(id);