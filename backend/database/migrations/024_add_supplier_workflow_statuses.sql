-- Add supplier workflow statuses to contracts table
-- Migration 024: Extend contract status constraint for supplier acceptance workflow

-- Drop the existing constraint
ALTER TABLE contracts DROP CONSTRAINT contracts_status_check;

-- Add the updated constraint with supplier workflow statuses
ALTER TABLE contracts ADD CONSTRAINT contracts_status_check 
CHECK (status IN (
  'DRAFT', 
  'PENDING_APPROVAL', 
  'SENT_TO_SUPPLIER', 
  'SUPPLIER_ACCEPTED', 
  'SUPPLIER_DECLINED',
  'EXPIRED',
  'UNDER_REVIEW', 
  'SIGNED',
  'ACTIVE', 
  'TERMINATED'
));

-- Add fields for supplier workflow tracking
ALTER TABLE contracts 
ADD COLUMN IF NOT EXISTS sent_to_supplier_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS supplier_response_due TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS supplier_accepted_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS supplier_declined_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS supplier_response_token VARCHAR(255),
ADD COLUMN IF NOT EXISTS procurement_validation_notes TEXT,
ADD COLUMN IF NOT EXISTS signed_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS signed_by UUID REFERENCES users(id),
ADD COLUMN IF NOT EXISTS final_approved_at TIMESTAMP WITH TIME ZONE;

-- Add index for supplier response tokens
CREATE INDEX IF NOT EXISTS idx_contracts_supplier_token ON contracts(supplier_response_token);
CREATE INDEX IF NOT EXISTS idx_contracts_supplier_response_due ON contracts(supplier_response_due);
CREATE INDEX IF NOT EXISTS idx_contracts_status_sent_supplier ON contracts(status, sent_to_supplier_at);