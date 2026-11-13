-- Add missing DoA authority types
-- Migration 026: Add PURCHASE_REQUISITIONS and CONTRACTS to delegation of authority

-- Update the applies_to constraint to include new authority types
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
  'CERTIFICATION'           -- For supplier certification via DoA
));

-- Insert some sample DoA authorities for testing
-- (You may want to adjust these based on your user setup)
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
  'PURCHASE_REQUISITIONS' as applies_to,
  true as is_active,
  id as created_by
FROM users 
WHERE role IN ('ADMIN', 'MANAGER')
ON CONFLICT DO NOTHING;

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
  'CONTRACTS' as applies_to,
  true as is_active,
  id as created_by
FROM users 
WHERE role IN ('ADMIN', 'MANAGER')
ON CONFLICT DO NOTHING;

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
  'SUPPLIERS' as applies_to,
  true as is_active,
  id as created_by
FROM users 
WHERE role IN ('ADMIN', 'MANAGER')
ON CONFLICT DO NOTHING;

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
  'CERTIFICATION' as applies_to,
  true as is_active,
  id as created_by
FROM users 
WHERE role IN ('ADMIN', 'MANAGER')
ON CONFLICT DO NOTHING;

COMMENT ON CONSTRAINT delegation_of_authority_applies_to_check ON delegation_of_authority IS 'Updated to include PURCHASE_REQUISITIONS, CONTRACTS, SUPPLIERS, and CERTIFICATION approval types for DoA workflow';