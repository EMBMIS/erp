-- 202608061900 — Real cosine-similarity search over ERP records.
--
-- migration 126 gave document_embeddings a plain float4[] column (no pgvector
-- dependency) but nothing ever queried it for similarity in SQL — ranking was
-- done in application code, one row at a time, in services/ai/documentSearch.js.
-- This migration adds the missing piece: a SQL-level cosine_similarity(a, b)
-- function, plus embedding columns on the three record types that get their
-- own semantic "find similar" search (purchase orders, sales orders, inventory
-- items). Same no-pgvector constraint as 126: plain FLOAT4[], no extension.
--
-- embedding_generated_at lets the embedding backfill/refresh skip rows that
-- are already current (embedding_generated_at >= updated_at) instead of
-- re-embedding unchanged records on every run.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION cosine_similarity(a FLOAT4[], b FLOAT4[])
RETURNS FLOAT8
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  dot_product FLOAT8 := 0;
  norm_a FLOAT8 := 0;
  norm_b FLOAT8 := 0;
  i INT;
BEGIN
  IF array_length(a, 1) != array_length(b, 1) THEN
    RETURN 0;
  END IF;
  FOR i IN 1..array_length(a, 1) LOOP
    dot_product := dot_product + a[i] * b[i];
    norm_a := norm_a + a[i] * a[i];
    norm_b := norm_b + b[i] * b[i];
  END LOOP;
  IF norm_a = 0 OR norm_b = 0 THEN RETURN 0; END IF;
  RETURN dot_product / (sqrt(norm_a) * sqrt(norm_b));
END;
$$;

COMMENT ON FUNCTION cosine_similarity(FLOAT4[], FLOAT4[]) IS
  'Cosine similarity between two equal-length float4 vectors, in [-1, 1]. Returns 0 for mismatched lengths or a zero vector. No pgvector required.';

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS embedding FLOAT4[];
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS embedding_generated_at TIMESTAMPTZ;

ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS embedding FLOAT4[];
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS embedding_generated_at TIMESTAMPTZ;

ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS embedding FLOAT4[];
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS embedding_generated_at TIMESTAMPTZ;

COMMENT ON COLUMN purchase_orders.embedding IS
  'Semantic embedding of the PO (supplier, line items, terms), for GET /api/purchase-orders/similar. NULL until backfilled — see backend/scripts/backfill-embeddings.js.';
COMMENT ON COLUMN sales_orders.embedding IS
  'Semantic embedding of the sales order (customer, line items, notes), for GET /api/sales-orders/similar. NULL until backfilled.';
COMMENT ON COLUMN inventory_items.embedding IS
  'Semantic embedding of the stocked item (item master name/description/category, condition notes), for GET /api/inventory-items/similar. NULL until backfilled.';
