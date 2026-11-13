-- 101 — Allow 'AI_FINDING' as a notification type.
--
-- The scheduled AI findings scan (migration 100) notifies managers when it
-- detects a HIGH-severity issue (e.g. a possible duplicate invoice), but
-- notifications.type is a rigid CHECK-constraint allowlist that didn't
-- anticipate this new notification source. Widen it. Idempotent.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
CHECK (type::text = ANY (ARRAY[
  'item_master_submitted','item_master_approved','item_master_declined',
  'inventory_item_submitted','inventory_item_approved','inventory_item_declined',
  'storage_assignment_submitted','storage_assignment_approved','storage_assignment_declined',
  'storage_location_submitted','storage_location_approved','storage_location_declined',
  'bin_submitted','bin_approved','bin_declined',
  'supplier_submitted','supplier_approved','supplier_declined','supplier_certified','supplier_decertified',
  'supplier_partnership_accepted','supplier_partnership_declined',
  'pr_submitted','pr_approved','pr_declined',
  'rfq_sent','rfq_response_received','rfq_supplier_selected',
  'po_submitted','po_approved','po_sent_to_supplier','po_confirmed','po_supplier_confirmed',
  'po_supplier_rejected','po_items_received','po_delivery_verified','po_delivery_issue',
  'po_delivered_to_customer','po_customer_confirmed',
  'contract_created','contract_sent_to_supplier','contract_activated','contract_expiring',
  'sales_quotation_submitted','sales_quotation_approved',
  'SALES_CONTRACT_SUBMITTED','SALES_ORDER_APPROVED','SALES_ORDER_CUSTOMER_CONFIRMED',
  'SALES_RFQ_PROCUREMENT_APPROVED','SALES_RFQ_SALES_APPROVED','SALES_RFQ_SENT_TO_SUPPLIER',
  'AI_FINDING'
]::text[]));
