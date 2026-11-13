-- Migration 139: Create Unit of Measure (UoM) Conversions Table
CREATE TABLE IF NOT EXISTS uom_conversions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID REFERENCES inventory_items(id) ON DELETE CASCADE,
  from_uom VARCHAR(50) NOT NULL,
  to_uom VARCHAR(50) NOT NULL,
  conversion_factor NUMERIC(15, 6) NOT NULL CHECK (conversion_factor > 0),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_item_uom_pair UNIQUE (item_id, from_uom, to_uom)
);

CREATE INDEX IF NOT EXISTS idx_uom_conversions_item ON uom_conversions(item_id);
