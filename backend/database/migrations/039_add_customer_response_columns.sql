-- Add customer response tracking columns to sales_quotations table
-- Migration: 039_add_customer_response_columns

-- Add customer response columns
ALTER TABLE sales_quotations 
ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS customer_response_notes TEXT;

-- Create index for customer response tracking
CREATE INDEX IF NOT EXISTS idx_sales_quotations_customer_response ON sales_quotations(accepted_at, rejected_at) WHERE accepted_at IS NOT NULL OR rejected_at IS NOT NULL;

-- Add comment
COMMENT ON COLUMN sales_quotations.accepted_at IS 'Timestamp when customer accepted the quotation';
COMMENT ON COLUMN sales_quotations.rejected_at IS 'Timestamp when customer rejected the quotation';
COMMENT ON COLUMN sales_quotations.customer_response_notes IS 'Customer notes when accepting/rejecting quotation';