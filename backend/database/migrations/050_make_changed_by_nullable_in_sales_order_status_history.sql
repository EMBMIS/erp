-- Make changed_by nullable in sales_order_status_history for customer responses
ALTER TABLE sales_order_status_history 
ALTER COLUMN changed_by DROP NOT NULL;