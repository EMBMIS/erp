-- Add delivery workflow statuses and tracking to purchase orders
-- Migration: 027_add_po_delivery_workflow.sql

-- Add new delivery workflow statuses
-- Current: DRAFT, PENDING_APPROVAL, APPROVED, SENT_TO_SUPPLIER, CONFIRMED, CANCELLED
-- New: PREPARING_DELIVERY, IN_TRANSIT, DELIVERED, VERIFIED, GOODS_RECEIPT, COMPLETED

-- Drop existing constraint
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;

-- Add updated status constraint with new delivery workflow states
ALTER TABLE purchase_orders 
ADD CONSTRAINT purchase_orders_status_check 
CHECK (status IN (
  'DRAFT', 
  'PENDING_APPROVAL', 
  'APPROVED', 
  'SENT_TO_SUPPLIER', 
  'CONFIRMED',
  'PREPARING_DELIVERY',
  'IN_TRANSIT', 
  'DELIVERED',
  'VERIFIED',
  'GOODS_RECEIPT',
  'COMPLETED',
  'CANCELLED'
));

-- Add supplier delivery tracking fields
ALTER TABLE purchase_orders 
ADD COLUMN supplier_delivery_token VARCHAR(255) UNIQUE,
ADD COLUMN supplier_delivery_due TIMESTAMP,
ADD COLUMN delivery_confirmed_at TIMESTAMP,
ADD COLUMN delivery_confirmed_by UUID REFERENCES users(id),
ADD COLUMN delivery_notes TEXT,
ADD COLUMN verification_notes TEXT,
ADD COLUMN verified_at TIMESTAMP,
ADD COLUMN verified_by UUID REFERENCES users(id);

-- Add indexes for delivery tracking
CREATE INDEX idx_purchase_orders_delivery_token ON purchase_orders(supplier_delivery_token);
CREATE INDEX idx_purchase_orders_delivery_status ON purchase_orders(status) WHERE status IN (
  'SENT_TO_SUPPLIER', 'CONFIRMED', 'PREPARING_DELIVERY', 'IN_TRANSIT', 'DELIVERED', 'VERIFIED'
);

-- Comments for new fields
COMMENT ON COLUMN purchase_orders.supplier_delivery_token IS 'Secure token for supplier delivery status portal access';
COMMENT ON COLUMN purchase_orders.supplier_delivery_due IS 'Expected delivery completion date';
COMMENT ON COLUMN purchase_orders.delivery_confirmed_at IS 'When supplier confirmed delivery completion';
COMMENT ON COLUMN purchase_orders.delivery_confirmed_by IS 'User who confirmed the delivery receipt';
COMMENT ON COLUMN purchase_orders.delivery_notes IS 'Supplier notes about delivery process';
COMMENT ON COLUMN purchase_orders.verification_notes IS 'DoA verification notes after delivery';
COMMENT ON COLUMN purchase_orders.verified_at IS 'When DoA verified the delivery';
COMMENT ON COLUMN purchase_orders.verified_by IS 'DoA user who verified the delivery';