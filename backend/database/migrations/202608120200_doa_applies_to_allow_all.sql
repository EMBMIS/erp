-- delegation_of_authority.applies_to defaults to 'ALL' (see the column
-- default) and doaConfig.js's transaction_types list advertises 'ALL' as
-- "All Transactions" in the DoA form — but the CHECK constraint never
-- actually included 'ALL' among the permitted values. Every attempt to
-- create a blanket authority grant (the documented, UI-offered, and
-- column-defaulted use case) has always failed with a check-constraint
-- violation. loadDoaDefinitions() and getUserAuthority() both already treat
-- applies_to = 'ALL' as a wildcard match against any transaction type, so
-- the read side has understood 'ALL' correctly the whole time; only the
-- write side rejected it.
ALTER TABLE delegation_of_authority DROP CONSTRAINT IF EXISTS delegation_of_authority_applies_to_check;
ALTER TABLE delegation_of_authority ADD CONSTRAINT delegation_of_authority_applies_to_check
  CHECK (applies_to::text = ANY (ARRAY[
    'ALL', 'SALES_CONTRACT', 'CONTRACTS', 'CERTIFICATION', 'SALES_RFQ', 'SALES_QUOTATION',
    'SALES_ORDER', 'PURCHASE_REQUISITIONS', 'PO', 'SUPPLIERS', 'SUPPLIER_APPROVAL',
    'SUPPLIER_CERTIFICATION', 'CONTRACT_APPROVAL', 'PURCHASE_REQUISITION', 'RFQ_APPROVAL',
    'PURCHASE_ORDER', 'SALES_RFQ_SALES_APPROVAL', 'SALES_RFQ_PROCUREMENT_APPROVAL',
    'PURCHASE_ORDER_SALES_APPROVAL', 'PURCHASE_ORDER_PROCUREMENT_APPROVAL', 'DELIVERY_SCHEDULING',
    'DELIVERY_POSTPONEMENT', 'DROPSHIP_AUTHORIZATION'
  ]::character varying[]));
