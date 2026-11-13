-- Enhance sales contracts with full DOA approval workflow
-- Migration: 042_enhance_sales_contracts_approval_workflow

-- Add DOA workflow columns to sales_contracts table
ALTER TABLE sales_contracts 
ADD COLUMN IF NOT EXISTS submitted_for_approval_by UUID REFERENCES users(id),
ADD COLUMN IF NOT EXISTS submitted_for_approval_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS approval_notes TEXT,
ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id),
ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS sent_to_customer_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS sent_by UUID REFERENCES users(id),
ADD COLUMN IF NOT EXISTS customer_response_token VARCHAR(255),
ADD COLUMN IF NOT EXISTS customer_signed_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS customer_signature_data TEXT,
ADD COLUMN IF NOT EXISTS fully_executed_at TIMESTAMP;

-- Update status constraint to include all workflow statuses
ALTER TABLE sales_contracts 
DROP CONSTRAINT IF EXISTS sales_contracts_status_check;

ALTER TABLE sales_contracts 
ADD CONSTRAINT sales_contracts_status_check 
CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT_TO_CUSTOMER', 'CUSTOMER_SIGNED', 'FULLY_EXECUTED', 'REJECTED', 'CANCELLED', 'EXPIRED'));

-- Update approval_status constraint  
ALTER TABLE sales_contracts 
DROP CONSTRAINT IF EXISTS sales_contracts_approval_status_check;

ALTER TABLE sales_contracts 
ADD CONSTRAINT sales_contracts_approval_status_check 
CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED'));

-- Create contract status history table
CREATE TABLE IF NOT EXISTS sales_contract_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_contract_id UUID NOT NULL REFERENCES sales_contracts(id) ON DELETE CASCADE,
  from_status VARCHAR(50),
  to_status VARCHAR(50) NOT NULL,
  status_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  changed_by UUID REFERENCES users(id),
  reason TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_sales_contracts_approval_status ON sales_contracts(approval_status) WHERE approval_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_contracts_status ON sales_contracts(status);
CREATE INDEX IF NOT EXISTS idx_sales_contracts_submitted_approval ON sales_contracts(submitted_for_approval_at) WHERE submitted_for_approval_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_contracts_approved_at ON sales_contracts(approved_at) WHERE approved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_contracts_customer_response_token ON sales_contracts(customer_response_token) WHERE customer_response_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_contract_status_history_contract_id ON sales_contract_status_history(sales_contract_id);
CREATE INDEX IF NOT EXISTS idx_sales_contract_status_history_status_date ON sales_contract_status_history(status_date);

-- Add comments
COMMENT ON COLUMN sales_contracts.submitted_for_approval_by IS 'User who submitted contract for approval';
COMMENT ON COLUMN sales_contracts.submitted_for_approval_at IS 'Timestamp when contract was submitted for approval';
COMMENT ON COLUMN sales_contracts.approval_notes IS 'Notes added during approval process';
COMMENT ON COLUMN sales_contracts.rejection_reason IS 'Reason for contract rejection';
COMMENT ON COLUMN sales_contracts.rejected_by IS 'User who rejected the contract';
COMMENT ON COLUMN sales_contracts.rejected_at IS 'Timestamp when contract was rejected';
COMMENT ON COLUMN sales_contracts.sent_to_customer_at IS 'Timestamp when contract was sent to customer';
COMMENT ON COLUMN sales_contracts.sent_by IS 'User who sent contract to customer';
COMMENT ON COLUMN sales_contracts.customer_response_token IS 'Token for customer contract signing';
COMMENT ON COLUMN sales_contracts.customer_signed_at IS 'Timestamp when customer signed the contract';
COMMENT ON COLUMN sales_contracts.customer_signature_data IS 'Customer signature data (base64 or signature info)';
COMMENT ON COLUMN sales_contracts.fully_executed_at IS 'Timestamp when contract became fully executed';

COMMENT ON TABLE sales_contract_status_history IS 'Tracks status changes for sales contracts';