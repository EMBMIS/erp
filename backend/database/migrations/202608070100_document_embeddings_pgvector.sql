-- Migration 202608070100: document_embeddings moves to a real pgvector column.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- Migration 126 deliberately avoided pgvector because it couldn't assume the
-- extension was installed, and ranked similarity in application code instead
-- (services/ai/documentSearch.js#search, over a bounded candidate set). That
-- tradeoff no longer holds here: this deployment now runs Postgres via
-- docker-compose's pgvector/pgvector image specifically so this column can be
-- a real `vector` type, with ranking pushed into SQL — see docker-compose.yml.
--
-- Separately, embedding generation moved off the OpenAI API onto a local,
-- in-process model (services/ai/localEmbeddings.js, all-MiniLM-L6-v2 via
-- @xenova/transformers) — this ERP's chat model is DeepSeek, which has no
-- embeddings endpoint, and requiring a second, unrelated OpenAI key just to
-- embed documents was an avoidable external dependency. That model produces
-- 384-dimensional vectors, not OpenAI's 1536, so this is a hard cutover: any
-- existing embedding rows are from a different model in a different vector
-- space and cannot be reinterpreted at the new dimension — they are cleared
-- here and expected to be re-embedded (backfill-document-embeddings.js, or
-- the automatic re-index on next document save).
--
-- HNSW is pgvector's current recommended index type for approximate nearest-
-- neighbour cosine search — see docker-compose.yml's own comment on the
-- pgvector image. At this ERP's actual chunk volumes (thousands, not
-- millions) it costs little and means search() no longer needs its own
-- MAX_CANDIDATES ceiling.
--
-- Idempotent.

CREATE EXTENSION IF NOT EXISTS vector;

-- Old vectors are a different model at a different dimension — not
-- convertible, not worth keeping. See above.
TRUNCATE document_embeddings;

ALTER TABLE document_embeddings
  ALTER COLUMN embedding TYPE vector(384) USING NULL;

DROP INDEX IF EXISTS idx_document_embeddings_source;
CREATE INDEX IF NOT EXISTS idx_document_embeddings_source
  ON document_embeddings (source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_document_embeddings_vector
  ON document_embeddings USING hnsw (embedding vector_cosine_ops);

COMMENT ON COLUMN document_embeddings.embedding IS
  'pgvector(384) — all-MiniLM-L6-v2 via services/ai/localEmbeddings.js, run in-process (no external API). Searched with the <=> cosine-distance operator; see services/ai/documentSearch.js#search.';
