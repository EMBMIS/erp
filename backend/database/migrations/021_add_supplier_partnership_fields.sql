-- Add supplier partnership and PO response fields
-- Migration 021: Add supplier partnership tracking and purchase order response fields

-- Add partnership fields to suppliers table
ALTER TABLE suppliers 
ADD COLUMN partnership_status VARCHAR(50) DEFAULT 'PENDING' CHECK (partnership_status IN ('PENDING', 'ACCEPTED', 'DECLINED')),
ADD COLUMN partnership_accepted_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN partnership_declined_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN decline_reason TEXT;

-- Add PO response fields to purchase_orders table  
ALTER TABLE purchase_orders
ADD COLUMN supplier_confirmed_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN supplier_rejected_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN rejection_reason TEXT;

-- Update purchase order status constraint to include supplier response statuses
ALTER TABLE purchase_orders 
DROP CONSTRAINT IF EXISTS purchase_orders_status_check;

ALTER TABLE purchase_orders 
ADD CONSTRAINT purchase_orders_status_check CHECK (
  status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT_TO_SUPPLIER', 'CONFIRMED', 'REJECTED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CANCELLED')
);

-- Add new notification types for supplier partnership and PO responses
ALTER TABLE notifications 
DROP CONSTRAINT notifications_type_check;

ALTER TABLE notifications 
ADD CONSTRAINT notifications_type_check CHECK (
  type IN (
    -- Legacy types
    'ITEM_APPROVED',
    'ITEM_DECLINED',
    'GENERAL',
    'approval',
    'decline',
    'approval_request',
    
    -- Item Master notifications
    'item_master_submitted',
    'item_master_approved',
    'item_master_declined',
    
    -- Inventory Item notifications
    'inventory_item_submitted',
    'inventory_item_approved',
    'inventory_item_declined',
    
    -- Storage Assignment notifications
    'storage_assignment_submitted',
    'storage_assignment_approved',
    'storage_assignment_declined',
    
    -- Storage Location notifications
    'storage_location_submitted',
    'storage_location_approved',
    'storage_location_declined',
    
    -- Bin notifications
    'bin_submitted',
    'bin_approved',
    'bin_declined',
    
    -- Procurement notifications
    -- Supplier notifications
    'supplier_submitted',
    'supplier_approved',
    'supplier_declined',
    'supplier_certified',
    'supplier_decertified',
    'supplier_partnership_accepted',
    'supplier_partnership_declined',
    
    -- Purchase Requisition notifications
    'pr_submitted',
    'pr_approved',
    'pr_declined',
    
    -- Request for Quotation notifications
    'rfq_sent',
    'rfq_response_received',
    'rfq_supplier_selected',
    
    -- Purchase Order notifications
    'po_submitted',
    'po_approved',
    'po_sent_to_supplier',
    'po_confirmed',
    'po_items_received',
    'po_supplier_confirmed',
    'po_supplier_rejected',
    
    -- Contract notifications
    'contract_created',
    'contract_sent_to_supplier',
    'contract_activated',
    'contract_expiring'
  )
);

-- Add comments for documentation
COMMENT ON COLUMN suppliers.partnership_status IS 'Supplier partnership acceptance status (PENDING, ACCEPTED, DECLINED)';
COMMENT ON COLUMN suppliers.partnership_accepted_at IS 'Timestamp when supplier accepted partnership';
COMMENT ON COLUMN suppliers.partnership_declined_at IS 'Timestamp when supplier declined partnership';
COMMENT ON COLUMN suppliers.decline_reason IS 'Reason provided by supplier for declining partnership';

COMMENT ON COLUMN purchase_orders.supplier_confirmed_at IS 'Timestamp when supplier confirmed the purchase order';
COMMENT ON COLUMN purchase_orders.supplier_rejected_at IS 'Timestamp when supplier rejected the purchase order';
COMMENT ON COLUMN purchase_orders.rejection_reason IS 'Reason provided by supplier for rejecting the purchase order';

-- Update constraint comment
COMMENT ON CONSTRAINT notifications_type_check ON notifications IS 'Allowed notification types for inventory management, procurement workflows, and supplier communications';