-- Add fulfillment types and auto PO creation to delivery schedules

-- Add fulfillment type to delivery schedules
ALTER TABLE delivery_schedules ADD COLUMN fulfillment_type VARCHAR(20) DEFAULT 'INVENTORY';
ALTER TABLE delivery_schedules ADD COLUMN supplier_id UUID REFERENCES suppliers(id);
ALTER TABLE delivery_schedules ADD COLUMN auto_purchase_order_id UUID REFERENCES purchase_orders(id);
ALTER TABLE delivery_schedules ADD COLUMN dropship_notes TEXT;
ALTER TABLE delivery_schedules ADD COLUMN estimated_supplier_delivery_date DATE;
ALTER TABLE delivery_schedules ADD COLUMN supplier_tracking_number VARCHAR(100);

-- Add constraint for fulfillment types
ALTER TABLE delivery_schedules ADD CONSTRAINT delivery_schedules_fulfillment_type_check 
CHECK (fulfillment_type IN ('INVENTORY', 'DROPSHIP', 'HYBRID'));

-- Add fulfillment method to individual delivery items
ALTER TABLE delivery_items ADD COLUMN fulfillment_method VARCHAR(20) DEFAULT 'INVENTORY';
ALTER TABLE delivery_items ADD COLUMN supplier_id UUID REFERENCES suppliers(id);
ALTER TABLE delivery_items ADD COLUMN purchase_order_item_id UUID;
ALTER TABLE delivery_items ADD COLUMN inventory_reserved_quantity NUMERIC(10,3) DEFAULT 0;
ALTER TABLE delivery_items ADD COLUMN dropship_quantity NUMERIC(10,3) DEFAULT 0;

-- Add constraint for fulfillment methods
ALTER TABLE delivery_items ADD CONSTRAINT delivery_items_fulfillment_method_check 
CHECK (fulfillment_method IN ('INVENTORY', 'DROPSHIP'));

-- Create table for tracking auto-created purchase orders
CREATE TABLE IF NOT EXISTS auto_purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id UUID NOT NULL REFERENCES sales_orders(id),
  delivery_schedule_id UUID REFERENCES delivery_schedules(id),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  created_reason VARCHAR(50) NOT NULL, -- 'DROPSHIP', 'STOCK_REPLENISHMENT', 'PARTIAL_FULFILLMENT'
  total_amount NUMERIC(12,2),
  currency VARCHAR(3) DEFAULT 'USD',
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add index for performance
CREATE INDEX idx_auto_purchase_orders_sales_order ON auto_purchase_orders(sales_order_id);
CREATE INDEX idx_auto_purchase_orders_delivery_schedule ON auto_purchase_orders(delivery_schedule_id);
CREATE INDEX idx_auto_purchase_orders_supplier ON auto_purchase_orders(supplier_id);

-- Add status for tracking delivery schedule workflow
ALTER TABLE delivery_schedules ADD COLUMN workflow_status VARCHAR(20) DEFAULT 'PLANNING';
ALTER TABLE delivery_schedules ADD CONSTRAINT delivery_schedules_workflow_status_check 
CHECK (workflow_status IN ('PLANNING', 'PO_CREATED', 'INVENTORY_RESERVED', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'COMPLETED'));

-- Add postponement tracking
ALTER TABLE delivery_schedules ADD COLUMN original_delivery_date DATE;
ALTER TABLE delivery_schedules ADD COLUMN postponement_count INTEGER DEFAULT 0;
ALTER TABLE delivery_schedules ADD COLUMN postponement_reason TEXT;
ALTER TABLE delivery_schedules ADD COLUMN postponed_by UUID REFERENCES users(id);
ALTER TABLE delivery_schedules ADD COLUMN postponed_at TIMESTAMP WITH TIME ZONE;