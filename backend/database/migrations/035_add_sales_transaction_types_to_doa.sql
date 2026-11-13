-- Add Sales transaction types to delegation_of_authority constraint
-- Migration 035: Add SALES_QUOTATION, SALES_CONTRACT, SALES_ORDER, SALES_RFQ to delegation of authority

-- Update the applies_to constraint to include sales authority types
ALTER TABLE delegation_of_authority 
DROP CONSTRAINT delegation_of_authority_applies_to_check;

ALTER TABLE delegation_of_authority 
ADD CONSTRAINT delegation_of_authority_applies_to_check 
CHECK (applies_to IN (
  'ALL', 
  'PR', 
  'PO', 
  'CONTRACT',
  'PURCHASE_REQUISITIONS',  -- For PR approvals via DoA
  'CONTRACTS',              -- For contract approvals via DoA
  'SUPPLIERS',              -- For supplier approvals via DoA
  'CERTIFICATION',          -- For supplier certification via DoA
  'SALES_QUOTATION',        -- For sales quotation approvals via DoA
  'SALES_CONTRACT',         -- For sales contract approvals via DoA
  'SALES_ORDER',            -- For sales order approvals via DoA
  'SALES_RFQ'               -- For sales RFQ approvals via DoA
));

-- Insert sample DoA authorities for sales transactions
-- (You may want to adjust these based on your user setup)

-- Add SALES_QUOTATION authorities
INSERT INTO delegation_of_authority (
  cost_center, 
  user_id, 
  min_amount, 
  max_amount, 
  applies_to, 
  is_active,
  created_by
) 
SELECT 
  'ALL' as cost_center,
  id as user_id,
  0 as min_amount,
  100000 as max_amount,
  'SALES_QUOTATION' as applies_to,
  true as is_active,
  id as created_by
FROM users 
WHERE role IN ('ADMIN', 'MANAGER')
ON CONFLICT DO NOTHING;

-- Add SALES_CONTRACT authorities
INSERT INTO delegation_of_authority (
  cost_center, 
  user_id, 
  min_amount, 
  max_amount, 
  applies_to, 
  is_active,
  created_by
) 
SELECT 
  'ALL' as cost_center,
  id as user_id,
  0 as min_amount,
  100000 as max_amount,
  'SALES_CONTRACT' as applies_to,
  true as is_active,
  id as created_by
FROM users 
WHERE role IN ('ADMIN', 'MANAGER')
ON CONFLICT DO NOTHING;

-- Add SALES_ORDER authorities
INSERT INTO delegation_of_authority (
  cost_center, 
  user_id, 
  min_amount, 
  max_amount, 
  applies_to, 
  is_active,
  created_by
) 
SELECT 
  'ALL' as cost_center,
  id as user_id,
  0 as min_amount,
  100000 as max_amount,
  'SALES_ORDER' as applies_to,
  true as is_active,
  id as created_by
FROM users 
WHERE role IN ('ADMIN', 'MANAGER')
ON CONFLICT DO NOTHING;

-- Add SALES_RFQ authorities
INSERT INTO delegation_of_authority (
  cost_center, 
  user_id, 
  min_amount, 
  max_amount, 
  applies_to, 
  is_active,
  created_by
) 
SELECT 
  'ALL' as cost_center,
  id as user_id,
  0 as min_amount,
  100000 as max_amount,
  'SALES_RFQ' as applies_to,
  true as is_active,
  id as created_by
FROM users 
WHERE role IN ('ADMIN', 'MANAGER')
ON CONFLICT DO NOTHING;

COMMENT ON CONSTRAINT delegation_of_authority_applies_to_check ON delegation_of_authority IS 'Updated to include SALES transaction types: SALES_QUOTATION, SALES_CONTRACT, SALES_ORDER, SALES_RFQ for DoA workflow';