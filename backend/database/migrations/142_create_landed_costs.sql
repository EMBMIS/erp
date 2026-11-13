-- Migration 142: Create Landed Cost Allocation Tables
CREATE TABLE IF NOT EXISTS landed_cost_vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_number VARCHAR(50) UNIQUE NOT NULL,
  posting_date DATE NOT NULL,
  total_landed_cost NUMERIC(15, 2) NOT NULL,
  allocation_method VARCHAR(20) DEFAULT 'VALUE' CHECK (allocation_method IN ('VALUE', 'WEIGHT', 'VOLUME', 'EQUAL')),
  status VARCHAR(20) DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED')),
  notes TEXT,
  journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS landed_cost_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id UUID NOT NULL REFERENCES landed_cost_vouchers(id) ON DELETE CASCADE,
  goods_receipt_id UUID REFERENCES goods_receipts(id) ON DELETE SET NULL,
  inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
  allocated_amount NUMERIC(15, 2) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_landed_cost_vouchers_status ON landed_cost_vouchers(status);
