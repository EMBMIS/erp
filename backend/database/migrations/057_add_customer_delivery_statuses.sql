-- Add customer delivery statuses for sales order fulfillment POs
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;

ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check 
CHECK (status IN (
  'DRAFT',
  'PENDING_APPROVAL', 
  'APPROVED',
  'SENT_TO_SUPPLIER',
  'CONFIRMED',
  'PARTIALLY_RECEIVED',
  'FULLY_RECEIVED',
  'CANCELLED',
  'PREPARING_DELIVERY',
  'IN_TRANSIT',
  'DELIVERED',
  'GOODS_READY_FOR_RECEIPT',
  'READY_FOR_CUSTOMER_DELIVERY',
  'DELIVERED_TO_CUSTOMER',
  'CUSTOMER_CONFIRMED',
  'DELIVERY_REJECTED'
));

-- Add source_type column to track PO source
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS source_type VARCHAR(50);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS sales_order_id UUID;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS sales_rfq_id INTEGER;

-- Add foreign key constraints if tables exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sales_orders') THEN
    ALTER TABLE purchase_orders ADD CONSTRAINT fk_po_sales_order 
    FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id);
  END IF;
  
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sales_rfqs') THEN
    ALTER TABLE purchase_orders ADD CONSTRAINT fk_po_sales_rfq 
    FOREIGN KEY (sales_rfq_id) REFERENCES sales_rfqs(id);
  END IF;
END
$$;

-- Add notification types for customer delivery
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
  'po_delivery_issue',
  'po_ready_for_customer_delivery',
  'po_delivered_to_customer',
  'po_customer_confirmed'
));