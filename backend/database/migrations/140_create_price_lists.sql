-- Migration 140: Create Customer Price Lists & Tiered Pricing Tables
CREATE TABLE IF NOT EXISTS price_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  code VARCHAR(50) UNIQUE NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS price_list_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  price_list_id UUID NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  min_quantity NUMERIC(15, 4) DEFAULT 1.0,
  unit_price NUMERIC(15, 4) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_price_list_item_tier UNIQUE (price_list_id, item_id, min_quantity)
);

CREATE INDEX IF NOT EXISTS idx_price_lists_customer ON price_lists(customer_id);
CREATE INDEX IF NOT EXISTS idx_price_list_items_lookup ON price_list_items(price_list_id, item_id);
