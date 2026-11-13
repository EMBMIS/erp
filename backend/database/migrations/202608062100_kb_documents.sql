-- Migration 202608062100: knowledge base documents.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- document_embeddings (migration 126) already stores chunk text + embeddings
-- for two source types: 'sales_contract' and 'generated_document'. Neither is
-- what a "knowledge base" needs: a company wants to upload a standalone
-- policy or procedure (a plain-text/markdown/HTML/PDF file, not a contract or
-- an AI-generated report) and have it become part of what the assistant
-- knows. There was no table anywhere for that document's title, source
-- format, or indexing status — this migration adds one.
--
-- kb_documents holds the metadata + extracted plain text; the chunk/embedding
-- rows for a document still live in document_embeddings under
-- source_type = 'kb_document', source_id = kb_documents.id — reusing the
-- existing chunk+embed+search machinery in services/ai/documentSearch.js
-- rather than duplicating it.
--
-- `status` lets the upload UI show indexed / pending / failed without polling
-- document_embeddings directly, and `error_message` carries a specific reason
-- forward (e.g. "no embeddings key configured") instead of a bare failure.
--
-- Scoped from the start, same as ai_learned_preferences (202608021200): a
-- policy document is one company's content.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS kb_documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  title          VARCHAR(255) NOT NULL,
  file_name      TEXT,
  -- What the upload originally was; body is always plain text regardless.
  source_format  TEXT NOT NULL DEFAULT 'text' CHECK (source_format IN ('text', 'markdown', 'html', 'pdf')),
  body           TEXT NOT NULL,

  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'indexed', 'failed')),
  error_message  TEXT,
  chunk_count    INTEGER NOT NULL DEFAULT 0,

  uploaded_by    UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_kb_documents_company ON kb_documents (company_id);
CREATE INDEX IF NOT EXISTS idx_kb_documents_status ON kb_documents (status);

DO $$
DECLARE
  default_id UUID;
BEGIN
  SELECT id INTO default_id FROM companies ORDER BY created_at ASC LIMIT 1;
  IF default_id IS NULL THEN
    default_id := '11111111-1111-1111-1111-111111111111'::uuid;
  END IF;

  EXECUTE format(
    'ALTER TABLE kb_documents ALTER COLUMN company_id SET DEFAULT COALESCE(public.current_company_id(), %L::uuid)',
    default_id
  );
END $$;

INSERT INTO company_scoped_tables (table_name)
VALUES ('kb_documents')
ON CONFLICT (table_name) DO NOTHING;

COMMENT ON TABLE kb_documents IS
  'Company-uploaded knowledge base documents (policies, procedures) — metadata + extracted plain text. Chunks/embeddings live in document_embeddings under source_type = ''kb_document''. See services/ai/knowledgeBase.js.';
