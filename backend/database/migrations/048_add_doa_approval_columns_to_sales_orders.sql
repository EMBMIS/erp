-- Add DOA approval workflow columns to sales_orders table
ALTER TABLE sales_orders 
ADD COLUMN approval_status VARCHAR(50) DEFAULT 'PENDING_APPROVAL',
ADD COLUMN approval_required_amount DECIMAL(12,2),
ADD COLUMN approval_requested_by UUID REFERENCES users(id),
ADD COLUMN approval_requested_at TIMESTAMP,
ADD COLUMN rejected_by UUID REFERENCES users(id),
ADD COLUMN rejected_at TIMESTAMP,
ADD COLUMN rejection_reason TEXT,
ADD COLUMN customer_response_token VARCHAR(255),
ADD COLUMN customer_response_date TIMESTAMP,
ADD COLUMN customer_response_action VARCHAR(20),
ADD COLUMN customer_response_comments TEXT,
ADD COLUMN customer_response_name VARCHAR(255),
ADD COLUMN customer_response_email VARCHAR(255);

-- Add constraints for approval_status
ALTER TABLE sales_orders 
ADD CONSTRAINT sales_orders_approval_status_check 
CHECK (approval_status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED'));

-- Add constraint for customer_response_action
ALTER TABLE sales_orders 
ADD CONSTRAINT sales_orders_customer_response_action_check 
CHECK (customer_response_action IN ('ACCEPT', 'REJECT') OR customer_response_action IS NULL);

-- Update status constraint to include new statuses
ALTER TABLE sales_orders 
DROP CONSTRAINT IF EXISTS sales_orders_status_check;

ALTER TABLE sales_orders 
ADD CONSTRAINT sales_orders_status_check 
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
  'COMPLETED',
  'CANCELLED',
  'REJECTED'
));

-- Create index for better query performance
CREATE INDEX idx_sales_orders_approval_status ON sales_orders(approval_status);
CREATE INDEX idx_sales_orders_customer_response_token ON sales_orders(customer_response_token);