-- Add supplier certification notification types to existing constraint
-- Migration 020: Add supplier certification notification types

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
    
    -- Contract notifications
    'contract_created',
    'contract_sent_to_supplier',
    'contract_activated',
    'contract_expiring'
  )
);

-- Update comment for documentation
COMMENT ON CONSTRAINT notifications_type_check ON notifications IS 'Allowed notification types for inventory management and procurement workflows including supplier certification';