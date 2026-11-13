-- Add rejection audit columns to purchase_orders for the PO reject flow.
-- The 'REJECTED' status value and rejection_reason column already exist
-- (migration 021_add_supplier_partnership_fields.sql); this adds the
-- manager/admin rejection audit trail used by PurchaseOrder.reject().
-- Migration: 202608021300_po_reject_audit_columns.sql

ALTER TABLE purchase_orders
ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id),
ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN purchase_orders.rejected_by IS 'Manager/Admin user who rejected the purchase order during approval';
COMMENT ON COLUMN purchase_orders.rejected_at IS 'When the purchase order was rejected';
