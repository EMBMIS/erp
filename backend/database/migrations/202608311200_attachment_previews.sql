-- 202608311200 — Attachment previews (cover thumbnails for the chat UI).
--
-- The chat shows an attached file as a name chip. Modern chat apps show a
-- cover image or a file-type icon instead. The original bytes are NOT stored
-- for text/PDF uploads (only extracted text is), so a preview has to be
-- captured at upload time while the bytes are in hand:
--
--   • image uploads (png/jpg/jpeg/webp/bmp): the original bytes themselves,
--     bounded to PREVIEW_MAX_SIZE so a row stays small.
--   • scanned PDFs: the first embedded page image, extracted the same way
--     OCR extracts pages (see services/ai/visionOcr.js).
--   • everything else: NULL — the UI shows a file-type icon.
--
-- Idempotent, nullable, and never read into the model context — a preview is
-- for the person looking at the conversation, not for the LLM.

ALTER TABLE conversation_attachments
  ADD COLUMN IF NOT EXISTS preview      BYTEA,
  ADD COLUMN IF NOT EXISTS preview_mime TEXT;

COMMENT ON COLUMN conversation_attachments.preview IS
  'Cover image for the chat UI (original bytes for images, first page image for scanned PDFs). NULL when none is available.';
COMMENT ON COLUMN conversation_attachments.preview_mime IS
  'MIME type of the preview bytes (image/png, image/jpeg, ...).';
