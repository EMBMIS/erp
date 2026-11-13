-- Make changed_by nullable in sales_contract_status_history for customer responses
ALTER TABLE sales_contract_status_history 
ALTER COLUMN changed_by DROP NOT NULL;