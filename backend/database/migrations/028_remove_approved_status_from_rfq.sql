-- Remove APPROVED status from RFQ workflow
-- Migration 028: Simplify RFQ workflow by removing APPROVED status

-- Drop the existing constraint
ALTER TABLE request_for_quotations DROP CONSTRAINT request_for_quotations_status_check;

-- Add the new constraint without APPROVED status
ALTER TABLE request_for_quotations ADD CONSTRAINT request_for_quotations_status_check 
    CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'SENT', 'RESPONSES_RECEIVED', 'EVALUATED', 'SUPPLIER_SELECTED', 'CLOSED'));

-- Update comment to document the simplified status workflow
COMMENT ON COLUMN request_for_quotations.status IS 'RFQ Status: DRAFT -> PENDING_APPROVAL -> SENT -> RESPONSES_RECEIVED -> EVALUATED -> SUPPLIER_SELECTED -> CLOSED';