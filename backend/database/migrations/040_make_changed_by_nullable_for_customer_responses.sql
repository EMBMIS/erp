-- Make changed_by nullable for customer responses in sales_quotation_status_history
-- Migration: 040_make_changed_by_nullable_for_customer_responses

-- Make changed_by nullable to allow customer responses
ALTER TABLE sales_quotation_status_history 
ALTER COLUMN changed_by DROP NOT NULL;

-- Add comment to clarify when changed_by can be null
COMMENT ON COLUMN sales_quotation_status_history.changed_by IS 'User who made the status change. NULL for customer responses.';