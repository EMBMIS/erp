-- 128 — Generalize generated_documents into a generic artifact store.
--
-- Every AI-produced deliverable so far has been a PDF (generate_pdf_report,
-- generate_invoice_pdf, latex_to_pdf), so `generated_documents` only ever
-- stored PDF bytes at `<id>.pdf` — a hardcoded assumption baked into
-- services/pdf/documentStore.js. The assistant should be able to produce
-- other kinds of artifact too — an HTML page, an SVG diagram, a Markdown
-- writeup, a code snippet — the way Claude's own artifacts work, each
-- rendered appropriately (HTML/SVG get a sandboxed live preview; Markdown and
-- code get syntax-aware display) rather than forced through a PDF renderer.
--
-- `content_type` distinguishes them; existing rows default to 'pdf' so every
-- tool and every stored row created before this migration keeps working
-- unchanged. The file extension on disk is derived from content_type (see
-- documentStore.js#extensionFor) rather than always assuming .pdf.
--
-- Idempotent.

ALTER TABLE generated_documents
  ADD COLUMN IF NOT EXISTS content_type VARCHAR(20) NOT NULL DEFAULT 'pdf';

-- 'code' artifacts carry a language so the frontend can syntax-highlight and
-- pick a sane download extension (.py, .js, ...); irrelevant for other types.
ALTER TABLE generated_documents
  ADD COLUMN IF NOT EXISTS language VARCHAR(40);

COMMENT ON COLUMN generated_documents.content_type IS
  'pdf | html | svg | markdown | code — what kind of artifact this row is. Existing rows are all pdf.';
