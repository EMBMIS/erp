-- Close two gaps found in the P2P audit:
--
-- 1. purchase_orders.status CHECK is missing 'DELIVERY_REJECTED', which
--    PurchaseOrder.verifyDelivery sets when a customer rejects delivery —
--    the UPDATE fails the constraint on every rejection.
-- 2. The status-history tables referenced by statusTransitionService and
--    auditTrailService for PO/PR (and most other entities) were never created:
--    their migrations (066 et al.) were adopted via the baseline manifest
--    without running. Every history INSERT would hit a missing table.
--    Create all of them, modeled on sales_order_status_history.

ALTER TABLE purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_status_check;

ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN (
    'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT_TO_SUPPLIER', 'CONFIRMED',
    'PREPARING_DELIVERY', 'IN_TRANSIT', 'DELIVERED', 'GOODS_READY_FOR_RECEIPT',
    'READY_FOR_CUSTOMER_DELIVERY', 'DELIVERED_TO_CUSTOMER',
    'WAITING_CUSTOMER_DELIVERY_CONFIRMATION', 'CUSTOMER_CONFIRMED',
    'DELIVERY_ISSUE_REPORTED', 'DELIVERY_REJECTED',
    'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'COMPLETED', 'CANCELLED', 'REJECTED'
  ));

-- Generic status-history table shape, mirroring sales_order_status_history.
-- Column id is the parent's id column per ENTITY_TABLE_MAP / auditTrailService.
CREATE OR REPLACE FUNCTION create_status_history_table(tab TEXT, id_col TEXT)
RETURNS void AS $$
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I (
       id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       %I            uuid NOT NULL,
       from_status   varchar(50),
       to_status     varchar(50) NOT NULL,
       status_date   timestamptz DEFAULT CURRENT_TIMESTAMP,
       changed_by    uuid,
       reason        text,
       notes         text,
       created_at    timestamptz DEFAULT CURRENT_TIMESTAMP
     )', tab, id_col);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (%I)', tab || '_idx_parent', tab, id_col);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (status_date)', tab || '_idx_date', tab);
END $$ LANGUAGE plpgsql;

SELECT create_status_history_table('purchase_order_status_history',        'purchase_order_id');
SELECT create_status_history_table('purchase_requisition_status_history',  'requisition_id');
SELECT create_status_history_table('contract_status_history',              'contract_id');
SELECT create_status_history_table('credit_note_status_history',           'credit_note_id');
SELECT create_status_history_table('payroll_run_status_history',           'payroll_run_id');
SELECT create_status_history_table('fixed_asset_status_history',           'asset_id');
SELECT create_status_history_table('warehouse_transaction_status_history', 'transaction_id');
SELECT create_status_history_table('work_order_status_history',            'work_order_id');
SELECT create_status_history_table('budget_status_history',                'budget_id');
SELECT create_status_history_table('supplier_invoice_status_history',      'bill_id');
SELECT create_status_history_table('supplier_payment_status_history',      'payment_id');

DROP FUNCTION create_status_history_table(text, text);
