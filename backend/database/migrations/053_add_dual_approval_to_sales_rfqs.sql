-- Add dual approval system to sales_rfqs table

-- Add sales approval columns
ALTER TABLE sales_rfqs ADD COLUMN sales_approval_status VARCHAR(20) DEFAULT 'PENDING';
ALTER TABLE sales_rfqs ADD COLUMN sales_approved_by UUID REFERENCES users(id);
ALTER TABLE sales_rfqs ADD COLUMN sales_approved_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE sales_rfqs ADD COLUMN sales_approval_notes TEXT;

-- Add procurement approval columns  
ALTER TABLE sales_rfqs ADD COLUMN procurement_approval_status VARCHAR(20) DEFAULT 'PENDING';
ALTER TABLE sales_rfqs ADD COLUMN procurement_approved_by UUID REFERENCES users(id);
ALTER TABLE sales_rfqs ADD COLUMN procurement_approved_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE sales_rfqs ADD COLUMN procurement_approval_notes TEXT;

-- Add overall approval status
ALTER TABLE sales_rfqs ADD COLUMN overall_approval_status VARCHAR(20) DEFAULT 'PENDING';

-- Add approval status constraints
ALTER TABLE sales_rfqs ADD CONSTRAINT sales_rfqs_sales_approval_status_check 
CHECK (sales_approval_status IN ('PENDING', 'APPROVED', 'REJECTED'));

ALTER TABLE sales_rfqs ADD CONSTRAINT sales_rfqs_procurement_approval_status_check 
CHECK (procurement_approval_status IN ('PENDING', 'APPROVED', 'REJECTED'));

ALTER TABLE sales_rfqs ADD CONSTRAINT sales_rfqs_overall_approval_status_check 
CHECK (overall_approval_status IN ('PENDING', 'SALES_APPROVED', 'PROCUREMENT_APPROVED', 'FULLY_APPROVED', 'REJECTED'));

-- Update existing status constraint to include new approval-related statuses
ALTER TABLE sales_rfqs DROP CONSTRAINT IF EXISTS sales_rfqs_status_check;
ALTER TABLE sales_rfqs ADD CONSTRAINT sales_rfqs_status_check 
CHECK (status IN (
  'DRAFT', 
  'PENDING_SALES_APPROVAL',     -- New: Waiting for sales approval
  'PENDING_PROCUREMENT_APPROVAL', -- New: Waiting for procurement approval  
  'PENDING_DUAL_APPROVAL',      -- New: Waiting for both approvals
  'APPROVED',                   -- Both departments approved
  'SENT', 
  'RESPONDED', 
  'PARTIALLY_RESPONDED', 
  'COMPLETED', 
  'CANCELLED',
  'REJECTED'                    -- Either department rejected
));

-- Add indexes for performance
CREATE INDEX idx_sales_rfqs_sales_approval ON sales_rfqs(sales_approval_status, sales_approved_by);
CREATE INDEX idx_sales_rfqs_procurement_approval ON sales_rfqs(procurement_approval_status, procurement_approved_by);
CREATE INDEX idx_sales_rfqs_overall_approval ON sales_rfqs(overall_approval_status);

-- Add notification types for dual approval workflow
ALTER TABLE notifications 
DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications 
ADD CONSTRAINT notifications_type_check 
CHECK (type IN (
  -- Existing types (keeping all previous ones)
  'INVENTORY_ITEM_APPROVED', 'INVENTORY_ITEM_REJECTED', 'INVENTORY_ITEM_UPDATED',
  'INVENTORY_ITEM_PENDING_APPROVAL', 'INVENTORY_ITEM_ASSIGNED_TO_LOCATION',
  'INVENTORY_ITEM_LOW_STOCK', 'INVENTORY_ITEM_OUT_OF_STOCK', 'INVENTORY_ITEM_EXPIRING',
  'SUPPLIER_APPROVED', 'SUPPLIER_REJECTED', 'SUPPLIER_CERTIFICATION_APPROVED', 
  'SUPPLIER_CERTIFICATION_REJECTED', 'CONTRACT_APPROVED', 'CONTRACT_REJECTED',
  'PURCHASE_REQUISITION_APPROVED', 'PURCHASE_REQUISITION_REJECTED',
  'RFQ_APPROVED', 'RFQ_REJECTED', 'PURCHASE_ORDER_APPROVED', 'PURCHASE_ORDER_REJECTED',
  'PROCUREMENT_CONTRACT_PENDING_APPROVAL', 'PROCUREMENT_CONTRACT_APPROVED', 
  'PROCUREMENT_CONTRACT_REJECTED', 'PROCUREMENT_CONTRACT_CUSTOMER_ACCEPTED', 
  'PROCUREMENT_CONTRACT_CUSTOMER_REJECTED',
  'SALES_QUOTATION_PENDING_APPROVAL', 'SALES_QUOTATION_APPROVED', 'SALES_QUOTATION_REJECTED',
  'SALES_QUOTATION_SUBMITTED', 'SALES_QUOTATION_SENT_TO_CUSTOMER', 
  'SALES_QUOTATION_CUSTOMER_ACCEPTED', 'SALES_QUOTATION_CUSTOMER_REJECTED',
  'sales_quotation_approved', 'sales_quotation_submitted',
  'SALES_CONTRACT_PENDING_APPROVAL', 'SALES_CONTRACT_APPROVED', 'SALES_CONTRACT_REJECTED',
  'SALES_CONTRACT_SENT_TO_CUSTOMER', 'SALES_CONTRACT_CUSTOMER_ACCEPTED', 
  'SALES_CONTRACT_CUSTOMER_REJECTED', 'SALES_CONTRACT_SUBMITTED',
  'SALES_ORDER_PENDING_APPROVAL', 'SALES_ORDER_APPROVED', 'SALES_ORDER_REJECTED',
  'SALES_ORDER_SENT_TO_CUSTOMER', 'SALES_ORDER_CUSTOMER_CONFIRMED', 
  'SALES_ORDER_CUSTOMER_CANCELLED', 'SALES_ORDER_DELIVERED', 'SALES_ORDER_COMPLETED',
  -- New Sales RFQ dual approval notification types
  'SALES_RFQ_SUBMITTED_FOR_SALES_APPROVAL',
  'SALES_RFQ_SUBMITTED_FOR_PROCUREMENT_APPROVAL', 
  'SALES_RFQ_SALES_APPROVED',
  'SALES_RFQ_SALES_REJECTED',
  'SALES_RFQ_PROCUREMENT_APPROVED',
  'SALES_RFQ_PROCUREMENT_REJECTED',
  'SALES_RFQ_FULLY_APPROVED',
  'SALES_RFQ_SENT_TO_SUPPLIER',
  'SALES_RFQ_SUPPLIER_RESPONDED',
  -- General types
  'GENERAL_NOTIFICATION', 'SYSTEM_ALERT', 'USER_MENTION'
));