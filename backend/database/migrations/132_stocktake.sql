-- 132 — Stocktake / cycle counting module.
--
-- First-class stocktake documents with planned vs counted quantities,
-- variance tracking, and multi-step workflow (DRAFT → COUNTED → REVIEWED → POSTED).

CREATE TABLE IF NOT EXISTS stocktake_sheets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_number    TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT', 'IN_PROGRESS', 'COUNTED', 'REVIEWED', 'POSTED', 'CANCELLED')),
  location_id     UUID REFERENCES storage_locations(id) ON DELETE SET NULL,
  notes           TEXT,
  counted_by      UUID REFERENCES users(id),
  reviewed_by     UUID REFERENCES users(id),
  counted_at      TIMESTAMPTZ,
  posted_at       TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stocktake_sheet_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id          UUID NOT NULL REFERENCES stocktake_sheets(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  book_quantity     DECIMAL(15,4) NOT NULL DEFAULT 0,
  counted_quantity  DECIMAL(15,4),
  variance          DECIMAL(15,4) GENERATED ALWAYS AS
                    (COALESCE(counted_quantity, book_quantity) - book_quantity) STORED,
  unit_cost         DECIMAL(15,4) NOT NULL DEFAULT 0,
  variance_value    DECIMAL(15,2) GENERATED ALWAYS AS
                    ((COALESCE(counted_quantity, book_quantity) - book_quantity) * unit_cost) STORED,
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'COUNTED', 'ADJUSTED', 'SKIPPED')),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index for looking up items on a sheet
CREATE INDEX IF NOT EXISTS idx_stocktake_items_sheet
  ON stocktake_sheet_items (sheet_id);

-- Index for finding all sheets for a location
CREATE INDEX IF NOT EXISTS idx_stocktake_sheets_location
  ON stocktake_sheets (location_id) WHERE deleted_at IS NULL;

-- Unique: one row per item per sheet
CREATE UNIQUE INDEX IF NOT EXISTS idx_stocktake_items_unique
  ON stocktake_sheet_items (sheet_id, inventory_item_id);

COMMENT ON TABLE stocktake_sheets IS
  'Stocktake / cycle count documents with status workflow';
COMMENT ON TABLE stocktake_sheet_items IS
  'Per-item lines on a stocktake sheet — book quantity, counted quantity, and computed variance';
