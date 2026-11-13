-- Migration 202608070200: record-level embeddings (purchase_orders,
-- sales_orders, inventory_items) move to real pgvector columns.
--
-- Same move as 202608070100 did for document_embeddings, applied to the three
-- record-level `embedding FLOAT4[]` columns added by migration
-- 202608061900 (and the `cosine_similarity()` SQL function those routes
-- called): real `vector(384)` columns, HNSW-indexed, searched with the `<=>`
-- operator instead.
--
-- Old vectors were 1536-dimensional (OpenAI text-embedding-3-small).
-- services/ai/embeddings.js now embeds locally via
-- services/ai/localEmbeddings.js (all-MiniLM-L6-v2, 384-dimensional) — a
-- different model in a different vector space, not just a different array
-- size, so this is a hard cutover: existing values are cleared here and
-- expected to be re-embedded (backend/scripts/backfill-embeddings.js).
--
-- cosine_similarity(FLOAT4[], FLOAT4[]) (202608061900) had exactly these
-- three tables as its only callers (routes/purchase-orders.js,
-- routes/sales-orders.js, routes/inventory-items.js, services/ai/toolRegistry.js
-- — all updated in this same change to use `<=>` instead), so it is dropped
-- here rather than left behind as dead SQL.
--
-- Idempotent.

CREATE EXTENSION IF NOT EXISTS vector;

-- Old vectors are a different model at a different dimension — not
-- convertible, not worth keeping. See above.
ALTER TABLE purchase_orders
  ALTER COLUMN embedding TYPE vector(384) USING NULL;
UPDATE purchase_orders SET embedding_generated_at = NULL WHERE embedding_generated_at IS NOT NULL;

ALTER TABLE sales_orders
  ALTER COLUMN embedding TYPE vector(384) USING NULL;
UPDATE sales_orders SET embedding_generated_at = NULL WHERE embedding_generated_at IS NOT NULL;

ALTER TABLE inventory_items
  ALTER COLUMN embedding TYPE vector(384) USING NULL;
UPDATE inventory_items SET embedding_generated_at = NULL WHERE embedding_generated_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_embedding
  ON purchase_orders USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_sales_orders_embedding
  ON sales_orders USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_inventory_items_embedding
  ON inventory_items USING hnsw (embedding vector_cosine_ops);

COMMENT ON COLUMN purchase_orders.embedding IS
  'pgvector(384) — all-MiniLM-L6-v2 via services/ai/localEmbeddings.js, run in-process (no external API). Searched with the <=> cosine-distance operator. NULL until backfilled — see backend/scripts/backfill-embeddings.js.';
COMMENT ON COLUMN sales_orders.embedding IS
  'pgvector(384) — all-MiniLM-L6-v2 via services/ai/localEmbeddings.js, run in-process (no external API). Searched with the <=> cosine-distance operator. NULL until backfilled.';
COMMENT ON COLUMN inventory_items.embedding IS
  'pgvector(384) — all-MiniLM-L6-v2 via services/ai/localEmbeddings.js, run in-process (no external API). Searched with the <=> cosine-distance operator. NULL until backfilled.';

DROP FUNCTION IF EXISTS cosine_similarity(FLOAT4[], FLOAT4[]);
