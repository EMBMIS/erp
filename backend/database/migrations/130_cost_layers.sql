-- 130 — Cost Layers: per-receipt audit trail for inventory valuation.
--
-- Each goods receipt or stock-addition transaction creates one row in this
-- table recording the quantity and unit cost at receipt time. When goods are
-- issued, remaining_quantity is decremented (oldest layer first, FIFO order)
-- and the layer's cost provides traceable basis for COGS.
--
-- The weighted-average cost at any moment can be verified as:
--   SUM(remaining_quantity * unit_cost) / SUM(remaining_quantity)
-- This gives Finance a verifiable cost basis for every unit in stock.

CREATE TABLE IF NOT EXISTS cost_layers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The inventory_item whose cost this layer belongs to.
  inventory_item_id   UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,

  -- Optional link back to the receipt transaction that created this layer.
  receipt_id          UUID REFERENCES goods_receipts(id) ON DELETE SET NULL,
  warehouse_transaction_id UUID REFERENCES warehouse_transactions(id) ON DELETE SET NULL,

  -- What kind of receipt created this layer.
  receipt_type        TEXT NOT NULL DEFAULT 'GOODS_RECEIPT'
                      CHECK (receipt_type IN ('GOODS_RECEIPT', 'STOCK_ADJUSTMENT', 'INITIAL', 'TRANSFER_IN')),

  -- Layer details
  quantity            DECIMAL(15,4) NOT NULL CHECK (quantity > 0),
  unit_cost           DECIMAL(15,4) NOT NULL CHECK (unit_cost >= 0),
  remaining_quantity  DECIMAL(15,4) NOT NULL DEFAULT 0 CHECK (remaining_quantity >= 0),

  -- Metadata
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by          UUID REFERENCES users(id)
);

-- Index for fast layer consumption (FIFO order: oldest active layers first).
CREATE INDEX IF NOT EXISTS idx_cost_layers_inv_item_created
  ON cost_layers (inventory_item_id, created_at)
  WHERE remaining_quantity > 0;

-- Index for layer lookup by receipt.
CREATE INDEX IF NOT EXISTS idx_cost_layers_receipt
  ON cost_layers (receipt_id);

CREATE INDEX IF NOT EXISTS idx_cost_layers_warehouse_txn
  ON cost_layers (warehouse_transaction_id);

COMMENT ON TABLE cost_layers IS
  'Per-receipt cost layers enabling weighted-average cost calculation and COGS traceability';
COMMENT ON COLUMN cost_layers.remaining_quantity IS
  'Quantity from this layer still in stock (not yet issued/consumed). Decremented on goods issue in FIFO order.';
