-- Migration 143: Create Shipping & Logistics Tables (Shipments & Packing Lists)
CREATE TABLE IF NOT EXISTS shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_number VARCHAR(50) UNIQUE NOT NULL,
  sales_order_id UUID REFERENCES sales_orders(id) ON DELETE CASCADE,
  carrier_name VARCHAR(100),
  tracking_number VARCHAR(100),
  shipping_status VARCHAR(30) DEFAULT 'PREPARING' CHECK (shipping_status IN ('PREPARING', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'RETURNED')),
  ship_date DATE,
  delivery_date DATE,
  proof_of_delivery TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS packing_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  quantity_packed NUMERIC(15, 4) NOT NULL,
  box_number INT DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(shipping_status);
