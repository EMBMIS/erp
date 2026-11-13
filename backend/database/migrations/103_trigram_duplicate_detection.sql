-- 103 — Trigram indexes for AI duplicate detection.
--
-- Duplicate master data (the same supplier entered twice under slightly
-- different names) is a real source of duplicate payments. Detecting it by
-- comparing every row against every other row is O(n²) and does not survive a
-- realistic customer count, so candidate generation is pushed into Postgres via
-- pg_trgm and only the shortlist is scored precisely in JS.
--
-- Idempotent: extension and indexes are all IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Master-data name matching.
CREATE INDEX IF NOT EXISTS idx_customers_name_trgm
  ON customers USING gin (customer_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_customers_legal_name_trgm
  ON customers USING gin (legal_entity_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_suppliers_legal_name_trgm
  ON suppliers USING gin (legal_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_suppliers_trade_name_trgm
  ON suppliers USING gin (trade_name gin_trgm_ops);

-- Duplicate-invoice detection leans on (supplier, amount, date) rather than
-- name similarity, but the supplier reference and date are the selective part.
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_dupe_scan
  ON supplier_invoices (supplier_id, total_amount, invoice_date)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_customer_invoices_dupe_scan
  ON customer_invoices (customer_id, total_amount, invoice_date)
  WHERE deleted_at IS NULL;
