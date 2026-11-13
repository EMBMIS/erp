-- Add cross-department DoA authority types for Sales RFQs, Purchase Orders, and Delivery Scheduling

-- Add new transaction types to delegation_of_authority table constraint
ALTER TABLE delegation_of_authority 
DROP CONSTRAINT IF EXISTS delegation_of_authority_applies_to_check;

ALTER TABLE delegation_of_authority 
ADD CONSTRAINT delegation_of_authority_applies_to_check 
CHECK (applies_to IN (
  -- Existing values found in database
  'SALES_CONTRACT',
  'CONTRACTS', 
  'CERTIFICATION',
  'SALES_RFQ',
  'SALES_QUOTATION',
  'SALES_ORDER',
  'PURCHASE_REQUISITIONS',
  'PO',
  'SUPPLIERS',
  -- Standard procurement types
  'SUPPLIER_APPROVAL', 
  'SUPPLIER_CERTIFICATION', 
  'CONTRACT_APPROVAL', 
  'PURCHASE_REQUISITION', 
  'RFQ_APPROVAL', 
  'PURCHASE_ORDER',
  -- New cross-department types
  'SALES_RFQ_SALES_APPROVAL',      -- Sales RFQ approval by Sales team
  'SALES_RFQ_PROCUREMENT_APPROVAL', -- Sales RFQ approval by Procurement team
  'PURCHASE_ORDER_SALES_APPROVAL',  -- PO approval by Sales (for dropship/resale)
  'PURCHASE_ORDER_PROCUREMENT_APPROVAL', -- PO approval by Procurement
  'DELIVERY_SCHEDULING',            -- Authority to create/modify delivery schedules
  'DELIVERY_POSTPONEMENT',          -- Authority to postpone/reschedule deliveries
  'DROPSHIP_AUTHORIZATION'          -- Authority to authorize dropship deliveries
));

-- Insert default authority records for new transaction types  
-- Note: These should be configured by admin based on company structure

-- Only insert if we have users with appropriate roles
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE role IN ('SALES_MANAGER', 'PROCUREMENT_MANAGER', 'LOGISTICS_MANAGER', 'ADMIN')) THEN
    
    -- Sales RFQ authorities (dual approval)
    IF EXISTS (SELECT 1 FROM users WHERE role = 'SALES_MANAGER') AND 
       EXISTS (SELECT 1 FROM users WHERE role = 'ADMIN') THEN
      INSERT INTO delegation_of_authority (
        user_id, applies_to, min_amount, max_amount, 
        currency, is_active, created_by
      ) VALUES (
        (SELECT id FROM users WHERE role = 'SALES_MANAGER' LIMIT 1),
        'SALES_RFQ_SALES_APPROVAL', 0, 50000, 'USD', true,
        (SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1)
      ) ON CONFLICT DO NOTHING;
    END IF;

    -- Procurement team can approve Sales RFQs up to 100,000
    IF EXISTS (SELECT 1 FROM users WHERE role = 'PROCUREMENT_MANAGER') AND 
       EXISTS (SELECT 1 FROM users WHERE role = 'ADMIN') THEN
      INSERT INTO delegation_of_authority (
        user_id, applies_to, min_amount, max_amount, 
        currency, is_active, created_by
      ) VALUES (
        (SELECT id FROM users WHERE role = 'PROCUREMENT_MANAGER' LIMIT 1),
        'SALES_RFQ_PROCUREMENT_APPROVAL', 0, 100000, 'USD', true,
        (SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1)
      ) ON CONFLICT DO NOTHING;
    END IF;

    -- Cross-department PO authorities  
    IF EXISTS (SELECT 1 FROM users WHERE role = 'SALES_MANAGER') AND 
       EXISTS (SELECT 1 FROM users WHERE role = 'ADMIN') THEN
      INSERT INTO delegation_of_authority (
        user_id, applies_to, min_amount, max_amount, 
        currency, is_active, created_by
      ) VALUES (
        (SELECT id FROM users WHERE role = 'SALES_MANAGER' LIMIT 1),
        'PURCHASE_ORDER_SALES_APPROVAL', 0, 25000, 'USD', true,
        (SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1)
      ) ON CONFLICT DO NOTHING;
    END IF;

    IF EXISTS (SELECT 1 FROM users WHERE role = 'PROCUREMENT_MANAGER') AND 
       EXISTS (SELECT 1 FROM users WHERE role = 'ADMIN') THEN
      INSERT INTO delegation_of_authority (
        user_id, applies_to, min_amount, max_amount, 
        currency, is_active, created_by
      ) VALUES (
        (SELECT id FROM users WHERE role = 'PROCUREMENT_MANAGER' LIMIT 1),
        'PURCHASE_ORDER_PROCUREMENT_APPROVAL', 0, 100000, 'USD', true,
        (SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1)
      ) ON CONFLICT DO NOTHING;
    END IF;

  END IF;
END $$;