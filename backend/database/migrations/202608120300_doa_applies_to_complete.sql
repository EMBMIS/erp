-- Complete the delegation_of_authority.applies_to value set.
--
-- History: every migration that touched this constraint (018 → 026 → 035 →
-- 052 → 202608120200) replaced the CHECK with a hand-written list, and every
-- replacement drifted from what the product actually offers. Migration
-- 202608120200 restored 'ALL' (the column default, the UI label, and the
-- documented blanket-grant use case) but still left six transaction types
-- advertised by backend/config/doaConfig.js and sent by the DoA creation form
-- blocked by the constraint:
--
--   PURCHASE_ORDERS, RFQ, SALES, INVENTORY_ITEMS, STORAGE_LOCATIONS,
--   WAREHOUSE_TRANSACTIONS
--
-- Every attempt to create a DoA grant for those types failed with a
-- check-constraint violation, so the approval queues backed by them
-- (items, storage locations, warehouse transactions, RFQs, blanket sales
-- authority) could never be delegated to anyone.
--
-- This migration replaces the constraint with the union of everything that
-- is legitimately possible to store, so it can never reject a write the
-- product produces and never orphan a row an older revision stored:
--
--   1. every value ever permitted by 018/026/035/052/202608120200 (existing
--      rows must keep validating — live rows include legacy values like 'PO',
--      'PR', 'CONTRACT' and the cross-department dual-approval types), and
--   2. every transaction type advertised in backend/config/doaConfig.js.
--
-- The drift test backend/tests/doaAppliesTo.test.js asserts that the config
-- and the code-referenced literals stay a subset of this list, so the two can
-- never silently diverge again without a failing test.

ALTER TABLE delegation_of_authority
  DROP CONSTRAINT IF EXISTS delegation_of_authority_applies_to_check;

ALTER TABLE delegation_of_authority
  ADD CONSTRAINT delegation_of_authority_applies_to_check
  CHECK (applies_to IN (
    -- General / blanket (column default; wildcard in loadDoaDefinitions)
    'ALL',
    -- Procurement
    'SUPPLIERS', 'SUPPLIER_APPROVAL', 'SUPPLIER_CERTIFICATION',
    'CERTIFICATION',
    'PURCHASE_REQUISITIONS', 'PURCHASE_REQUISITION', 'PR',
    'PURCHASE_ORDERS', 'PURCHASE_ORDER', 'PO',
    'CONTRACTS', 'CONTRACT', 'CONTRACT_APPROVAL',
    'RFQ', 'RFQ_APPROVAL',
    -- Sales
    'SALES',
    'SALES_QUOTATION', 'SALES_CONTRACT', 'SALES_ORDER', 'SALES_RFQ',
    -- Cross-department dual approval (legacy 052 types)
    'SALES_RFQ_SALES_APPROVAL', 'SALES_RFQ_PROCUREMENT_APPROVAL',
    'PURCHASE_ORDER_SALES_APPROVAL', 'PURCHASE_ORDER_PROCUREMENT_APPROVAL',
    -- Delivery
    'DELIVERY_SCHEDULING', 'DELIVERY_POSTPONEMENT', 'DROPSHIP_AUTHORIZATION',
    -- Inventory
    'INVENTORY_ITEMS', 'STORAGE_LOCATIONS', 'WAREHOUSE_TRANSACTIONS'
  ));
