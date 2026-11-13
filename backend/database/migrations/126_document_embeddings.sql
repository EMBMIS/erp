-- 126 — Document embeddings for free-text search.
--
-- query_erp_data (see services/ai/nlQuery.js) answers ad-hoc questions over
-- structured tables, but has nothing to say about the free text sitting inside
-- contract terms, generated PDFs, or long notes fields. This table is the
-- storage half of a lightweight semantic-search layer over that text.
--
-- Deliberately NOT pgvector. This environment cannot assume that extension is
-- installed, and adding a hard dependency on it here would break every
-- deployment that lacks it. `embedding` is instead a plain `float4[]` — an
-- ordinary Postgres array, needing no extension at all. The tradeoff is that
-- similarity search cannot be pushed into SQL (no `<=>` operator without
-- pgvector); ranking is done in application code instead
-- (services/ai/documentSearch.js), over a bounded candidate set. That is the
-- right tradeoff for the volumes this ERP actually has — thousands of contract
-- and document chunks, not millions — and it can be swapped for a pgvector
-- column later without changing anything that calls search().
--
-- One row per chunk, not per document: a contract's terms_and_conditions or a
-- generated report can run to several thousand characters, past what a single
-- embedding call handles well, so long text is split into ~1500-character
-- chunks (see chunkText in documentSearch.js) and each chunk gets its own row
-- and its own embedding. `(source_type, source_id)` identifies the parent
-- document; re-indexing a document deletes its existing chunk rows first, so
-- there is never a stale chunk left over from a shorter previous version.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS document_embeddings (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- What this chunk came from. 'sales_contract' | 'generated_document' today;
  -- new sources are additive, not a schema change.
  source_type  TEXT NOT NULL,
  source_id    TEXT NOT NULL,

  -- Position of this chunk within its source document, so results can be
  -- related back to their neighbours (or the whole document re-fetched) even
  -- though only the chunk text is embedded and searched.
  chunk_index  INT NOT NULL DEFAULT 0,
  chunk_text   TEXT NOT NULL,

  -- Plain float array — no pgvector. Cosine similarity against a query vector
  -- is computed in JS (services/ai/documentSearch.js#search), not in SQL.
  embedding    FLOAT4[] NOT NULL,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The lookup this table exists to serve: "give me every chunk for this
-- document" (re-indexing) and "give me every chunk of this kind" (a
-- source_type-scoped search).
CREATE INDEX IF NOT EXISTS idx_document_embeddings_source
  ON document_embeddings (source_type, source_id);

COMMENT ON TABLE document_embeddings IS
  'Chunked text + embeddings for free-text search over contract terms and generated documents. No pgvector: embedding is a plain float4[], ranked in application code. See services/ai/documentSearch.js.';
