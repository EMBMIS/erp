-- Add sales contract notification types to notifications constraint
-- Migration: 043_add_sales_contract_notification_types

-- Update the notification type constraint to include sales contract types
ALTER TABLE notifications 
DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications 
ADD CONSTRAINT notifications_type_check 
CHECK (type IN (
  'WAREHOUSE_APPROVAL_REQUEST', 
  'WAREHOUSE_APPROVAL_APPROVED', 
  'WAREHOUSE_APPROVAL_REJECTED',
  'INVENTORY_APPROVAL_REQUEST',
  'INVENTORY_APPROVAL_APPROVED', 
  'INVENTORY_APPROVAL_REJECTED',
  'INVENTORY_LOW_STOCK',
  'INVENTORY_REORDER_POINT',
  'INVENTORY_EXPIRY_WARNING',
  'PROCUREMENT_PR_SUBMITTED',
  'PROCUREMENT_PR_APPROVED',
  'PROCUREMENT_PR_REJECTED',
  'PROCUREMENT_RFQ_SENT',
  'PROCUREMENT_RFQ_RESPONSE_RECEIVED',
  'PROCUREMENT_PO_APPROVED',
  'PROCUREMENT_PO_REJECTED',
  'PROCUREMENT_GOODS_RECEIPT_CREATED',
  'PROCUREMENT_SUPPLIER_APPROVED',
  'PROCUREMENT_SUPPLIER_REJECTED',
  'PROCUREMENT_CONTRACT_APPROVED',
  'PROCUREMENT_CONTRACT_REJECTED',
  'PROCUREMENT_DELIVERY_CONFIRMED',
  'SALES_QUOTATION_SUBMITTED',
  'SALES_QUOTATION_APPROVED',
  'SALES_QUOTATION_REJECTED',
  'SALES_QUOTATION_SENT_TO_CUSTOMER',
  'SALES_QUOTATION_CUSTOMER_ACCEPTED',
  'SALES_QUOTATION_CUSTOMER_REJECTED',
  'SALES_CONTRACT_SUBMITTED',
  'SALES_CONTRACT_APPROVED', 
  'SALES_CONTRACT_REJECTED',
  'SALES_CONTRACT_SENT_TO_CUSTOMER',
  'SALES_CONTRACT_CUSTOMER_SIGNED',
  'SALES_CONTRACT_FULLY_EXECUTED',
  'SALES_ORDER_SUBMITTED',
  'SALES_ORDER_APPROVED',
  'SALES_ORDER_REJECTED',
  -- Legacy lowercase formats (for existing notifications)
  'sales_quotation_submitted',
  'sales_quotation_approved',
  'sales_quotation_rejected',
  'sales_contract_submitted',
  'sales_contract_approved',
  'sales_contract_rejected'
));

-- Add comment
COMMENT ON CONSTRAINT notifications_type_check ON notifications IS 'Valid notification types including sales contract workflow notifications';