-- 134 — Credit notes and returns (RMA).
--
-- Sales credit notes: issued against a customer invoice, reduce AR and
-- reverse revenue. If stock is returned, the return flow puts items back
-- into inventory and reverses COGS through cost layers.
--
-- Supplier debit notes: issued against a supplier invoice, reduce AP.
-- Mirror of the sales credit note for the procurement side.
--
-- Both route through the existing DOA approval machinery.

-- -------------------------------------------------------------------
-- Sales credit notes (credit memo against a customer invoice)
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_credit_notes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_number TEXT NOT NULL UNIQUE,
  customer_invoice_id UUID NOT NULL REFERENCES customer_invoices(id),
  customer_id       UUID NOT NULL REFERENCES customers(id),
  credit_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  reason            TEXT NOT NULL,           -- e.g. 'RETURN', 'DAMAGE', 'PRICE_ADJUSTMENT', 'GOODWILL'
  return_type       TEXT CHECK (return_type IN ('STOCK_RETURN', 'CREDIT_ONLY')),
  subtotal          DECIMAL(15,2) NOT NULL DEFAULT 0,
  tax_amount        DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_amount      DECIMAL(15,2) NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','POSTED','CANCELLED')),
  notes             TEXT,
  approved_by       UUID REFERENCES users(id),
  posted_by         UUID REFERENCES users(id),
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sales_credit_note_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id      UUID NOT NULL REFERENCES sales_credit_notes(id) ON DELETE CASCADE,
  customer_invoice_item_id UUID REFERENCES customer_invoice_items(id),
  inventory_item_id   UUID REFERENCES inventory_items(id),
  item_code           TEXT,
  item_name           TEXT NOT NULL,
  quantity            DECIMAL(12,4) NOT NULL DEFAULT 1,
  unit_price          DECIMAL(15,2) NOT NULL DEFAULT 0,
  line_total          DECIMAL(15,2) NOT NULL DEFAULT 0,
  return_to_stock     BOOLEAN NOT NULL DEFAULT false,  -- if true, put back into inventory
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------------
-- Supplier debit notes (debit memo against a supplier invoice)
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplier_debit_notes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debit_note_number TEXT NOT NULL UNIQUE,
  supplier_invoice_id UUID NOT NULL REFERENCES supplier_invoices(id),
  supplier_id       UUID NOT NULL REFERENCES suppliers(id),
  debit_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  reason            TEXT NOT NULL,
  return_type       TEXT CHECK (return_type IN ('STOCK_RETURN', 'DEBIT_ONLY')),
  subtotal          DECIMAL(15,2) NOT NULL DEFAULT 0,
  tax_amount        DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_amount      DECIMAL(15,2) NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','POSTED','CANCELLED')),
  notes             TEXT,
  approved_by       UUID REFERENCES users(id),
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS supplier_debit_note_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debit_note_id       UUID NOT NULL REFERENCES supplier_debit_notes(id) ON DELETE CASCADE,
  supplier_invoice_item_id UUID REFERENCES supplier_invoice_items(id),
  inventory_item_id   UUID REFERENCES inventory_items(id),
  item_code           TEXT,
  item_name           TEXT NOT NULL,
  quantity            DECIMAL(12,4) NOT NULL DEFAULT 1,
  unit_price          DECIMAL(15,2) NOT NULL DEFAULT 0,
  line_total          DECIMAL(15,2) NOT NULL DEFAULT 0,
  return_to_supplier  BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scn_invoice ON sales_credit_notes (customer_invoice_id);
CREATE INDEX IF NOT EXISTS idx_scn_status ON sales_credit_notes (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sdn_invoice ON supplier_debit_notes (supplier_invoice_id);
CREATE INDEX IF NOT EXISTS idx_sdn_status ON supplier_debit_notes (status) WHERE deleted_at IS NULL;

COMMENT ON TABLE sales_credit_notes IS
  'Credit memos against customer invoices — returns, adjustments, goodwill. Stock returns reverse COGS through cost layers.';
COMMENT ON TABLE supplier_debit_notes IS
  'Debit memos against supplier invoices — returns, price adjustments. Mirror of sales credit notes for AP side.';
