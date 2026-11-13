-- Add PENDING_APPROVAL status to contracts table
-- Migration 023: Update contracts status constraint to include PENDING_APPROVAL

-- First, update any existing PENDING_DOA_APPROVAL records to PENDING_APPROVAL
UPDATE contracts SET status = 'PENDING_APPROVAL' WHERE status = 'PENDING_DOA_APPROVAL';

-- Drop the existing constraint
ALTER TABLE contracts DROP CONSTRAINT contracts_status_check;

-- Add the updated constraint with PENDING_APPROVAL
ALTER TABLE contracts ADD CONSTRAINT contracts_status_check 
CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'SENT_TO_SUPPLIER', 'UNDER_REVIEW', 'ACTIVE', 'EXPIRED', 'TERMINATED'));