/**
 * Knowledge base document CRUD + ingestion.
 *
 * A kb_document (migration 202608062100) is company-uploaded free text — a
 * policy, a procedure, an SOP — that should be available to the AI chat as
 * background knowledge without anyone having to ask it to "search documents".
 * This module owns getting a document's plain text ready for that pipeline
 * and keeping kb_documents.status honest about whether indexing succeeded;
 * documentSearch.js still owns the actual chunking, embedding and storage
 * (document_embeddings, source_type = 'kb_document') — reused rather than
 * duplicated, same as it already is for sales_contract/generated_document.
 *
 * Embedding happens fire-and-forget after the row is written, mirroring
 * documentStore.saveDocument's existing auto-index hook: a slow or
 * misconfigured embeddings call must never fail the upload itself. The
 * status column is what lets the UI show the outcome without blocking on it.
 */

const { pool } = require('../../config/database');
const documentSearch = require('./documentSearch');

// ---------------------------------------------------------------------------
// Text extraction — HTML/Markdown/plain text handled inline; PDF via
// pdf-parse (already a dependency, see package.json).
// ---------------------------------------------------------------------------

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdfText(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    let text = String(result?.text || '').trim();

    // Pages without a text layer are scans. Transcribe them with the vision
    // model (embedded page image → OCR) and append the result, so a scanned
    // document reads like a text document instead of ending "mid-sentence" at
    // the last OCR'd page. Pages OCR cannot read are named in a note rather
    // than silently dropped.
    const totalPages = result?.total || 0;
    const pageTexts = (result?.pages || []).map((p) => ({ num: p.num, text: String(p.text || '').trim() }));
    const textLessPages = pageTexts.filter((p) => !p.text).map((p) => p.num);
    // A single-page scan has totalPages === 1 and an empty text layer — the
    // most common scanned upload of all. The guard is text-less pages, not
    // page count.
    if (textLessPages.length) {
      const patched = await require('./visionOcr').appendPdfOcr({
        pdfBuffer: buffer,
        text,
        totalPages,
        textLessPages,
        textPages: pageTexts.length - textLessPages.length,
      });
      return patched.text + patched.note;
    }
    return text;
  } finally {
    await parser.destroy();
  }
}

/**
 * Normalise raw uploaded content into plain text for chunking/embedding.
 * `format`: 'text' | 'markdown' | 'html' | 'pdf'. Markdown is left mostly
 * as-is — its structure (headings, lists) reads fine as plain text, and
 * stripping it would lose the section boundaries that make for better chunks.
 */
async function extractText({ format, content, buffer }) {
  if (format === 'pdf') {
    if (!buffer) throw new Error('A PDF upload requires file bytes.');
    return extractPdfText(buffer);
  }
  if (format === 'image') {
    if (!buffer) throw new Error('An image upload requires file bytes.');
    // A photo or scan: transcribe with the vision model. Returns '' when the
    // image has no readable text, which the caller reports as unreadable.
    return (await require('./visionOcr').ocrImageBuffer(buffer)) || '';
  }
  if (format === 'html') return stripHtml(content);
  return String(content || '').trim();
}

// ---------------------------------------------------------------------------
// Indexing — chunk + embed via documentSearch.indexDocument, then reflect the
// outcome back onto kb_documents.status so the UI never has to poll
// document_embeddings directly.
// ---------------------------------------------------------------------------

async function indexKbDocument(id) {
  const { rows } = await pool.query('SELECT id, title, body FROM kb_documents WHERE id = $1', [id]);
  const doc = rows[0];
  if (!doc) return;

  try {
    const text = `${doc.title}\n\n${doc.body}`.trim();
    const result = await documentSearch.indexDocument({ source_type: 'kb_document', source_id: doc.id, text });
    await pool.query(
      `UPDATE kb_documents
          SET status = $2, chunk_count = $3, error_message = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [id, result.indexed ? 'indexed' : 'failed', result.chunks || 0]
    );
  } catch (err) {
    await pool.query(
      `UPDATE kb_documents
          SET status = 'failed', error_message = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [id, String(err.message || 'Indexing failed').slice(0, 500)]
    ).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function createDocument({ title, format, content, buffer, fileName, userId }) {
  const text = await extractText({ format, content, buffer });
  if (!text) throw new Error('No text could be extracted from this document.');

  const { rows } = await pool.query(
    `INSERT INTO kb_documents (title, file_name, source_format, body, status, uploaded_by)
     VALUES ($1,$2,$3,$4,'pending',$5) RETURNING *`,
    [String(title || fileName || 'Untitled document').slice(0, 255), fileName || null, format || 'text', text, userId || null]
  );
  const doc = rows[0];

  indexKbDocument(doc.id).catch((err) => console.error('indexKbDocument failed:', err.message));

  return doc;
}

async function listDocuments() {
  const { rows } = await pool.query(
    `SELECT kb.id, kb.title, kb.file_name, kb.source_format, kb.status, kb.chunk_count,
            kb.error_message, kb.created_at, kb.updated_at,
            u.first_name || ' ' || u.last_name AS uploaded_by_name
       FROM kb_documents kb LEFT JOIN users u ON u.id = kb.uploaded_by
      ORDER BY kb.created_at DESC`
  );
  return rows;
}

async function getDocument(id) {
  const { rows } = await pool.query('SELECT * FROM kb_documents WHERE id = $1', [id]);
  return rows[0] || null;
}

async function deleteDocument(id) {
  const existing = await getDocument(id);
  if (!existing) throw new Error('Knowledge base document not found.');
  await pool.query('DELETE FROM document_embeddings WHERE source_type = $1 AND source_id = $2', ['kb_document', id]);
  await pool.query('DELETE FROM kb_documents WHERE id = $1', [id]);
  return { deleted: id };
}

/** Re-embed every document that isn't currently 'indexed' — used by the manual reindex endpoint and the backfill script. */
async function indexPending({ limit = 500 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const { rows } = await pool.query(
    `SELECT id FROM kb_documents WHERE status IN ('pending', 'failed') ORDER BY created_at ASC LIMIT $1`,
    [cap]
  );

  let indexed = 0;
  let failed = 0;
  for (const row of rows) {
    await indexKbDocument(row.id);
    const { rows: check } = await pool.query('SELECT status FROM kb_documents WHERE id = $1', [row.id]);
    if (check[0]?.status === 'indexed') indexed += 1; else failed += 1;
  }
  return { source_type: 'kb_document', total: rows.length, indexed, skipped: failed };
}

module.exports = {
  createDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  indexKbDocument,
  indexPending,
  extractText,
  stripHtml,
};
