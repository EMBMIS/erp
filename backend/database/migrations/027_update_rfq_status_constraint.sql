-- Update RFQ status constraint to include DoA workflow statuses
-- Migration 027: Add PENDING_APPROVAL and APPROVED statuses to RFQ

-- Drop the existing constraint
ALTER TABLE request_for_quotations DROP CONSTRAINT request_for_quotations_status_check;

-- Add the new constraint with additional statuses
ALTER TABLE request_for_quotations ADD CONSTRAINT request_for_quotations_status_check 
    CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'RESPONSES_RECEIVED', 'EVALUATED', 'SUPPLIER_SELECTED', 'CLOSED'));

-- Add comment to document the status workflow
COMMENT ON COLUMN request_for_quotations.status IS 'RFQ Status: DRAFT -> PENDING_APPROVAL -> APPROVED -> SENT -> RESPONSES_RECEIVED -> EVALUATED -> SUPPLIER_SELECTED -> CLOSED';