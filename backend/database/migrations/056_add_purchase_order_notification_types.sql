-- Add missing purchase order notification types
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications ADD CONSTRAINT notifications_type_check 
CHECK (type IN (
  'SALES_CONTRACT_SUBMITTED',
  'SALES_ORDER_APPROVED', 
  'SALES_ORDER_CUSTOMER_CONFIRMED',
  'sales_quotation_approved',
  'sales_quotation_submitted',
  'SALES_RFQ_PROCUREMENT_APPROVED',
  'SALES_RFQ_SALES_APPROVED',
  'SALES_RFQ_SENT_TO_SUPPLIER',
  'SALES_RFQ_SUPPLIER_RESPONDED',
  'po_approved',
  'po_submitted',
  'po_rejected',
  'po_delivery_verified',
  'po_delivery_issue'
));