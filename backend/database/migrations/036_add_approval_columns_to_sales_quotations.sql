-- Add approval tracking columns to sales_quotations table
-- Migration 036: Add approval tracking fields for sales quotations

-- Add approval tracking columns
ALTER TABLE sales_quotations 
ADD COLUMN approved_by uuid REFERENCES users(id),
ADD COLUMN approved_at timestamp with time zone,
ADD COLUMN rejected_by uuid REFERENCES users(id),
ADD COLUMN rejected_at timestamp with time zone,
ADD COLUMN rejection_reason text;

-- Add email sending approval tracking columns
ALTER TABLE sales_quotations
ADD COLUMN send_requested_by uuid REFERENCES users(id),
ADD COLUMN send_requested_at timestamp with time zone,
ADD COLUMN send_approved_by uuid REFERENCES users(id),
ADD COLUMN send_approved_at timestamp with time zone;

-- Add customer response tracking columns
ALTER TABLE sales_quotations
ADD COLUMN customer_response_token character varying(255) UNIQUE,
ADD COLUMN customer_responded_at timestamp with time zone,
ADD COLUMN customer_response_notes text;

-- Add email sent tracking
ALTER TABLE sales_quotations
ADD COLUMN sent_to_customer_at timestamp with time zone,
ADD COLUMN sent_by uuid REFERENCES users(id);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_sales_quotations_approved_by ON sales_quotations(approved_by);
CREATE INDEX IF NOT EXISTS idx_sales_quotations_rejected_by ON sales_quotations(rejected_by);
CREATE INDEX IF NOT EXISTS idx_sales_quotations_send_requested_by ON sales_quotations(send_requested_by);
CREATE INDEX IF NOT EXISTS idx_sales_quotations_send_approved_by ON sales_quotations(send_approved_by);
CREATE INDEX IF NOT EXISTS idx_sales_quotations_customer_response_token ON sales_quotations(customer_response_token);
CREATE INDEX IF NOT EXISTS idx_sales_quotations_sent_by ON sales_quotations(sent_by);

COMMENT ON COLUMN sales_quotations.approved_by IS 'User who approved the quotation';
COMMENT ON COLUMN sales_quotations.approved_at IS 'Timestamp when quotation was approved';
COMMENT ON COLUMN sales_quotations.rejected_by IS 'User who rejected the quotation';
COMMENT ON COLUMN sales_quotations.rejected_at IS 'Timestamp when quotation was rejected';
COMMENT ON COLUMN sales_quotations.rejection_reason IS 'Reason for quotation rejection';
COMMENT ON COLUMN sales_quotations.send_requested_by IS 'User who requested to send quotation to customer';
COMMENT ON COLUMN sales_quotations.send_requested_at IS 'Timestamp when send was requested';
COMMENT ON COLUMN sales_quotations.send_approved_by IS 'User who approved sending to customer';
COMMENT ON COLUMN sales_quotations.send_approved_at IS 'Timestamp when send was approved';
COMMENT ON COLUMN sales_quotations.customer_response_token IS 'Unique token for customer response';
COMMENT ON COLUMN sales_quotations.customer_responded_at IS 'Timestamp when customer responded';
COMMENT ON COLUMN sales_quotations.customer_response_notes IS 'Customer response notes';
COMMENT ON COLUMN sales_quotations.sent_to_customer_at IS 'Timestamp when quotation was sent to customer';
COMMENT ON COLUMN sales_quotations.sent_by IS 'User who sent quotation to customer';