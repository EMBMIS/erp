-- Update the status constraint to include ACTIVE and remove CUSTOMER_ACCEPTED
ALTER TABLE sales_contracts 
DROP CONSTRAINT IF EXISTS sales_contracts_status_check;

ALTER TABLE sales_contracts 
ADD CONSTRAINT sales_contracts_status_check 
CHECK (status IN (
  'DRAFT', 
  'PENDING_APPROVAL', 
  'APPROVED', 
  'SENT_TO_CUSTOMER', 
  'ACTIVE',
  'CUSTOMER_REJECTED', 
  'CUSTOMER_SIGNED', 
  'FULLY_EXECUTED', 
  'REJECTED', 
  'CANCELLED', 
  'EXPIRED'
));