-- Serial/lot traceability — GR capture -> issue -> recall report.
--
-- goods_receipts already captures batch_lot_number and serial_numbers (JSONB)
-- per receipt, and warehouse_transaction_items already has batch_number and
-- serial_number columns on goods-issue lines. But nothing ever connected the
-- two: a serial typed in at receipt and a serial typed in at issue were both
-- free text, never checked against each other, and there was no way to ask
-- "which receipts and which issues touched serial X" — no recall report,
-- because there was nothing to query. This adds the missing ledger:
--
--   serial_lot_units      one row per traceable unit (a single serial, or an
--                          un-serialised batch/lot quantity) created at
--                          receipt time, decremented as it is issued.
--   serial_lot_movements  one row per issue drawn from a unit, so a recall
--                          can walk forward from a receipt to every place a
--                          unit went, or backward from an issue to its origin.
--
-- Same pattern as cost_layers (migration 130): a company-scoped table
-- (inventory_items) owns these child rows, so they are not independently
-- registered in company_scoped_tables — isolation follows the parent via the
-- inventory_item_id / warehouse_transaction_id foreign keys, exactly like
-- cost_layers.warehouse_transaction_id already does.

CREATE TABLE IF NOT EXISTS serial_lot_units (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id   UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  goods_receipt_id    UUID REFERENCES goods_receipts(id) ON DELETE SET NULL,

  -- Exactly one of these identifies the unit: a discrete serial (quantity
  -- always 1) or an un-serialised batch/lot (quantity = the received amount,
  -- drawn down as it is issued).
  serial_number       TEXT,
  batch_lot_number    TEXT,

  quantity            DECIMAL(15,4) NOT NULL CHECK (quantity > 0),
  remaining_quantity  DECIMAL(15,4) NOT NULL CHECK (remaining_quantity >= 0),
  status              TEXT NOT NULL DEFAULT 'IN_STOCK'
                      CHECK (status IN ('IN_STOCK', 'PARTIALLY_ISSUED', 'ISSUED')),

  received_date       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expiry_date         DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by          UUID REFERENCES users(id),

  CONSTRAINT serial_lot_units_identity_check
    CHECK (serial_number IS NOT NULL OR batch_lot_number IS NOT NULL)
);

-- A given serial number can only be received once per item — the traceability
-- guarantee this whole feature exists for depends on a serial uniquely
-- identifying one physical unit.
CREATE UNIQUE INDEX IF NOT EXISTS serial_lot_units_serial_unique
  ON serial_lot_units (inventory_item_id, serial_number)
  WHERE serial_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS serial_lot_units_item_idx
  ON serial_lot_units (inventory_item_id) WHERE remaining_quantity > 0;
CREATE INDEX IF NOT EXISTS serial_lot_units_serial_idx
  ON serial_lot_units (serial_number) WHERE serial_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS serial_lot_units_batch_idx
  ON serial_lot_units (batch_lot_number) WHERE batch_lot_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS serial_lot_units_receipt_idx
  ON serial_lot_units (goods_receipt_id);

CREATE TABLE IF NOT EXISTS serial_lot_movements (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id                   UUID NOT NULL REFERENCES serial_lot_units(id) ON DELETE CASCADE,
  warehouse_transaction_id  UUID REFERENCES warehouse_transactions(id) ON DELETE SET NULL,
  quantity                  DECIMAL(15,4) NOT NULL CHECK (quantity > 0),
  reference_type            TEXT,
  reference_id              UUID,
  issued_date               TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by                UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS serial_lot_movements_unit_idx
  ON serial_lot_movements (unit_id);
CREATE INDEX IF NOT EXISTS serial_lot_movements_txn_idx
  ON serial_lot_movements (warehouse_transaction_id);

COMMENT ON TABLE serial_lot_units IS
  'One row per traceable receipt unit (a serial, or a batch/lot quantity), decremented on issue';
COMMENT ON TABLE serial_lot_movements IS
  'One row per issue drawn from a serial_lot_units row — the forward half of a recall trail';
