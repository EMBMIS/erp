-- Add delivery address and storage location fields to purchase orders
-- Migration: 026_add_delivery_fields_to_purchase_orders.sql

-- Add delivery address column
ALTER TABLE purchase_orders 
ADD COLUMN delivery_address TEXT;

-- Add storage location reference column
ALTER TABLE purchase_orders 
ADD COLUMN storage_location_id UUID REFERENCES storage_locations(id);

-- Add index for storage location lookups
CREATE INDEX idx_purchase_orders_storage_location ON purchase_orders(storage_location_id);

-- Update existing POs to have null values (no default needed)
COMMENT ON COLUMN purchase_orders.delivery_address IS 'Complete delivery address for supplier coordination';
COMMENT ON COLUMN purchase_orders.storage_location_id IS 'Reference to designated storage location for received goods';