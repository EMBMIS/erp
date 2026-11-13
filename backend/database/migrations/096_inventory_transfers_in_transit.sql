-- 096 — Multi-warehouse transfers with in-transit tracking (ERP-Roadmap P3 #13).
--
-- The existing Goods Transfer (GT) warehouse-transaction type moves stock
-- between storage_locations atomically — quantity leaves the source and lands
-- at the destination in the same instant, with no "on the truck" state. This
-- table adds a genuine two-phase transfer: dispatch immediately removes stock
-- from the source (it is no longer available to sell/issue there) but does NOT
-- add it to the destination until someone actually confirms receipt there.
-- Idempotent.

CREATE TABLE IF NOT EXISTS inventory_transfers (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_number             VARCHAR(50) UNIQUE NOT NULL,
  inventory_item_id           UUID NOT NULL REFERENCES inventory_items(id),
  quantity                    DECIMAL(15,4) NOT NULL CHECK (quantity > 0),
  source_storage_location_id      UUID NOT NULL REFERENCES storage_locations(id),
  source_bin_id                    UUID REFERENCES bins(id),
  destination_storage_location_id  UUID NOT NULL REFERENCES storage_locations(id),
  destination_bin_id               UUID REFERENCES bins(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'IN_TRANSIT'
                CHECK (status IN ('IN_TRANSIT', 'RECEIVED', 'CANCELLED')),
  notes         TEXT,
  dispatched_by UUID REFERENCES users(id),
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  received_by   UUID REFERENCES users(id),
  received_at   TIMESTAMPTZ,
  cancelled_by  UUID REFERENCES users(id),
  cancelled_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inventory_transfers_status ON inventory_transfers(status);
CREATE INDEX IF NOT EXISTS idx_inventory_transfers_item ON inventory_transfers(inventory_item_id);

CREATE OR REPLACE FUNCTION generate_transfer_number() RETURNS TEXT AS $$
DECLARE
    year_part TEXT;
    next_number INTEGER;
BEGIN
    year_part := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
    PERFORM pg_advisory_xact_lock(hashtext('generate_transfer_number'));
    SELECT COALESCE(MAX(
        CASE WHEN transfer_number ~ ('^XFER-' || year_part || '-[0-9]+$')
             THEN SUBSTRING(transfer_number FROM ('\-([0-9]+)$'))::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM inventory_transfers;
    RETURN 'XFER-' || year_part || '-' || LPAD(next_number::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;
