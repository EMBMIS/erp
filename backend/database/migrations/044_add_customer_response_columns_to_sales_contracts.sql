-- Add customer response tracking columns to sales_contracts table
ALTER TABLE sales_contracts 
ADD COLUMN customer_response_date TIMESTAMP,
ADD COLUMN customer_response_action VARCHAR(20),
ADD COLUMN customer_response_comments TEXT,
ADD COLUMN customer_response_name VARCHAR(255),
ADD COLUMN customer_response_email VARCHAR(255);

-- Add constraint for customer_response_action
ALTER TABLE sales_contracts 
ADD CONSTRAINT sales_contracts_customer_response_action_check 
CHECK (customer_response_action IN ('ACCEPT', 'REJECT') OR customer_response_action IS NULL);