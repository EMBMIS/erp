/**
 * Lightweight semantic search over free text — contract terms and generated
 * documents — that query_erp_data cannot answer because it only speaks SQL
 * over structured tables (see services/ai/nlQuery.js).
 *
 * pgvector, via a real `vector(384)` column (migration 202608070100). This
 * deployment runs Postgres from docker-compose's pgvector/pgvector image
 * specifically so this doesn't have to assume the extension is missing —
 * ranking is pushed into SQL (`ORDER BY embedding <=> $1`) rather than pulled
 * into a bounded JS candidate set, which was migration 126's original
 * approach for an environment that couldn't assume pgvector was installed.
 *
 * Embeddings are generated locally (services/ai/localEmbeddings.js,
 * all-MiniLM-L6-v2 via @xenova/transformers) rather than through an external
 * API — this ERP's chat model is DeepSeek, which has no embeddings endpoint,
 * so there was no existing API key this could ride on, and running a small
 * model in-process needs none.
 *
 * Indexing is automatic on write: SalesContract.create/update
 * (models/SalesContract.js) and documentStore.saveDocument
 * (services/pdf/documentStore.js) both call indexDocument() after their
 * transaction commits, fire-and-forget so an embeddings failure never fails
 * the underlying save. The manual reindex route in routes/ai-tools.js still
 * exists for backfilling records written before this hook existed, or after a
 * bulk import that bypassed these write paths.
 */

const { pool } = require('../../config/database');
const localEmbeddings = require('./localEmbeddings');

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 1500;

/**
 * Split text into ~CHUNK_SIZE-character pieces, preferring paragraph
 * boundaries so a chunk reads as a coherent unit rather than an arbitrary
 * slice. Paragraphs longer than CHUNK_SIZE on their own are hard-split — V1
 * does not attempt sentence-aware splitting for that case.
 */
function chunkText(text, maxLen = CHUNK_SIZE) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  // No paragraph breaks at all (e.g. one long line) — treat the whole thing as
  // a single "paragraph" so it still goes through the hard-split path below.
  const units = paragraphs.length ? paragraphs : [clean];

  const chunks = [];
  let current = '';
  for (const para of units) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= maxLen) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (para.length <= maxLen) {
      current = para;
    } else {
      for (let i = 0; i < para.length; i += maxLen) {
        chunks.push(para.slice(i, i + maxLen));
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

/**
 * Chunk `text` and embed every chunk with the local model.
 * Returns [{ chunk_index, chunk_text, embedding }], or [] for empty input.
 *
 * Runs in-process (no network call, no API key) — embedding only ever
 * happens here, during indexing or a search query; nothing on the chat path
 * calls this per turn.
 */
async function embed(text) {
  const chunks = chunkText(text);
  if (!chunks.length) return [];

  const vectors = await localEmbeddings.embedBatch(chunks);

  return chunks.map((chunk_text, i) => ({
    chunk_index: i,
    chunk_text,
    embedding: vectors[i] || [],
  }));
}

/** JS number array -> pgvector's text input format, e.g. "[0.1,0.2,0.3]". */
function toVectorLiteral(vector) {
  return `[${vector.join(',')}]`;
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/**
 * Chunk + embed `text` and replace this document's rows in document_embeddings.
 * Delete-then-insert rather than a diff: re-indexing is rare (manual trigger,
 * see routes/ai-tools.js), so correctness is worth more here than avoiding a
 * handful of extra writes, and it means a document that got shorter does not
 * leave stale trailing chunks behind.
 */
async function indexDocument({ source_type, source_id, text }) {
  if (!source_type || !source_id) {
    throw new Error('indexDocument requires source_type and source_id.');
  }
  const clean = String(text || '').trim();
  if (!clean) return { indexed: false, chunks: 0, reason: 'empty text' };

  const chunks = await embed(clean);
  if (!chunks.length) return { indexed: false, chunks: 0, reason: 'nothing to embed' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM document_embeddings WHERE source_type = $1 AND source_id = $2',
      [String(source_type), String(source_id)]
    );
    for (const c of chunks) {
      await client.query(
        `INSERT INTO document_embeddings (source_type, source_id, chunk_index, chunk_text, embedding)
         VALUES ($1,$2,$3,$4,$5::vector)`,
        [String(source_type), String(source_id), c.chunk_index, c.chunk_text, toVectorLiteral(c.embedding)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { indexed: true, chunks: chunks.length };
}

/**
 * Index every sales contract's terms/conditions text. Contracts with no
 * meaningful text (both fields blank) are counted as skipped, not failed —
 * a great many DRAFT contracts genuinely have nothing written yet.
 */
async function indexSalesContracts({ limit = 500 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const { rows } = await pool.query(
    `SELECT id, contract_number, contract_name, terms_and_conditions, special_conditions
       FROM sales_contracts
      WHERE deleted_at IS NULL
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT $1`,
    [cap]
  );

  let indexed = 0;
  let skipped = 0;
  for (const row of rows) {
    const body = [row.terms_and_conditions, row.special_conditions].filter(Boolean).join('\n\n').trim();
    if (!body) { skipped += 1; continue; }
    const text = `${row.contract_number || ''} ${row.contract_name || ''}\n\n${body}`.trim();
    try {
      const result = await indexDocument({ source_type: 'sales_contract', source_id: row.id, text });
      if (result.indexed) indexed += 1; else skipped += 1;
    } catch (err) {
      skipped += 1;
      console.error(`indexSalesContracts: failed to index contract ${row.id}:`, err.message);
    }
  }
  return { source_type: 'sales_contract', total: rows.length, indexed, skipped };
}

/**
 * Index generated documents that carry recoverable text.
 *
 * generated_documents (services/pdf/documentStore.js) stores rendered PDF
 * bytes on disk, not the plain text that produced them — there is no
 * PDF-text-extraction step in this codebase, and adding one (a new dependency)
 * is out of scope here. Instead, generate_pdf_report and generate_custom_pdf
 * (services/ai/pdfTools.js) now stash the flattened section text they rendered
 * from into metadata.indexable_text at generation time, which is exactly the
 * text a document search should match against. Older documents generated
 * before that, plus invoice/LaTeX documents (no section text to flatten), have
 * no metadata.indexable_text and are honestly counted as skipped rather than
 * indexed from a stand-in like the title alone.
 */
async function indexGeneratedDocuments({ limit = 500 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const { rows } = await pool.query(
    `SELECT id, title, metadata
       FROM generated_documents
      WHERE metadata ? 'indexable_text'
      ORDER BY created_at DESC
      LIMIT $1`,
    [cap]
  );

  let indexed = 0;
  let skipped = 0;
  for (const row of rows) {
    const body = String(row.metadata?.indexable_text || '').trim();
    if (!body) { skipped += 1; continue; }
    const text = `${row.title || ''}\n\n${body}`.trim();
    try {
      const result = await indexDocument({ source_type: 'generated_document', source_id: row.id, text });
      if (result.indexed) indexed += 1; else skipped += 1;
    } catch (err) {
      skipped += 1;
      console.error(`indexGeneratedDocuments: failed to index document ${row.id}:`, err.message);
    }
  }
  return { source_type: 'generated_document', total: rows.length, indexed, skipped };
}

/**
 * Index existing chat history. New messages are indexed as they're written
 * (services/conversationService.js#addMessage, fire-and-forget); this covers
 * messages written before that hook existed, or a bulk backfill after
 * changing how messages are embedded.
 *
 * Only user/assistant turns with actual text — tool-call-only assistant
 * turns and raw tool-result rows are not conversational prose worth
 * embedding, and 'system' messages are the same boilerplate on every turn.
 */
async function indexConversationMessages({ limit = 500 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const { rows } = await pool.query(
    `SELECT id, content
       FROM conversation_messages
      WHERE role IN ('user', 'assistant') AND content IS NOT NULL AND content != ''
      ORDER BY created_at DESC
      LIMIT $1`,
    [cap]
  );

  let indexed = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      const result = await indexDocument({ source_type: 'chat_message', source_id: row.id, text: row.content });
      if (result.indexed) indexed += 1; else skipped += 1;
    } catch (err) {
      skipped += 1;
      console.error(`indexConversationMessages: failed to index message ${row.id}:`, err.message);
    }
  }
  return { source_type: 'chat_message', total: rows.length, indexed, skipped };
}

/**
 * Index supplier invoices so the AI chat's RAG retrieval (and document
 * search) can find them by vector similarity. Each bill's searchable text is
 * the supplier name, bill/invoice number, PO reference, dates and line-item
 * descriptions — the tokens someone would ask about in chat.
 */
async function indexSupplierInvoices({ limit = 500 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const { rows } = await pool.query(
    `SELECT si.id,
            COALESCE(s.legal_name, s.name) AS supplier_name,
            si.bill_number, si.supplier_invoice_number,
            si.purchase_order_id, po.po_number,
            si.invoice_date, si.due_date, si.total_amount, si.notes,
            (SELECT string_agg(COALESCE(item_description, description), '; ')
               FROM supplier_invoice_items WHERE bill_id = si.id) AS line_items
       FROM supplier_invoices si
       LEFT JOIN suppliers s ON s.id = si.supplier_id
       LEFT JOIN purchase_orders po ON po.id = si.purchase_order_id
      WHERE si.deleted_at IS NULL
      ORDER BY si.created_at DESC
      LIMIT $1`,
    [cap]
  );

  let indexed = 0;
  let skipped = 0;
  for (const row of rows) {
    const parts = [
      row.supplier_name,
      row.bill_number ? `Bill ${row.bill_number}` : null,
      row.supplier_invoice_number ? `Invoice ${row.supplier_invoice_number}` : null,
      row.po_number ? `PO ${row.po_number}` : null,
      row.invoice_date ? `Invoice date ${row.invoice_date}` : null,
      row.due_date ? `Due ${row.due_date}` : null,
      row.total_amount != null ? `Total ${row.total_amount}` : null,
      row.line_items,
      String(row.notes || '').trim(),
    ].filter(Boolean).join('\n').trim();
    if (!parts) { skipped += 1; continue; }
    try {
      const result = await indexDocument({ source_type: 'supplier_invoice', source_id: row.id, text: parts });
      if (result.indexed) indexed += 1; else skipped += 1;
    } catch (err) {
      skipped += 1;
      console.error(`indexSupplierInvoices: failed to index bill ${row.id}:`, err.message);
    }
  }
  return { source_type: 'supplier_invoice', total: rows.length, indexed, skipped };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// Kept for vectorSearchService.js, which still ranks a small in-memory set
// (one company's item/supplier catalogue) in JS rather than per-query SQL —
// document_embeddings.embedding now comes back as a real number[] either way
// (see the pgvector type parser in config/database.js), so this still works
// unchanged regardless of which path populated it.
function cosineSimilarity(a, b) {
  const len = Math.min(a.length, b.length);
  if (!len) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Semantic search over indexed contract text and generated documents.
 *
 * Ranking runs in SQL via pgvector's `<=>` cosine-distance operator, backed
 * by the HNSW index on document_embeddings.embedding (migration
 * 202608070100) — no candidate cap needed, the index scales to the whole
 * table.
 *
 * Honest about emptiness: if document_embeddings has no rows (nothing has
 * ever been indexed, or none matching source_type), this returns
 * `indexed: false` with an explanatory note rather than quietly running a
 * real search over zero candidates and returning an empty result that looks
 * the same as "searched everything, found nothing".
 */
async function search(query, { limit = 8, source_type } = {}) {
  const q = String(query || '').trim();
  if (!q) return { indexed: false, results: [], note: 'No query text was provided.' };

  const countParams = source_type ? [String(source_type)] : [];
  const countSql = source_type
    ? 'SELECT COUNT(*)::int AS n FROM document_embeddings WHERE source_type = $1'
    : 'SELECT COUNT(*)::int AS n FROM document_embeddings';
  const countResult = await pool.query(countSql, countParams);
  const total = countResult.rows[0]?.n || 0;

  if (!total) {
    return {
      indexed: false,
      results: [],
      note: source_type
        ? `No documents of type "${source_type}" have been indexed yet. An administrator needs to run POST /api/ai-tools/reindex-documents first.`
        : 'Nothing has been indexed yet. An administrator needs to run POST /api/ai-tools/reindex-documents before document search can return real results.',
    };
  }

  const [queryChunk] = await embed(q);
  if (!queryChunk) return { indexed: true, results: [], note: 'Could not embed the query.' };

  const cappedLimit = Math.min(Math.max(Number(limit) || 8, 1), 50);
  const queryVector = toVectorLiteral(queryChunk.embedding);

  const params = [queryVector];
  let where = '';
  if (source_type) { params.push(String(source_type)); where = 'WHERE source_type = $2'; }
  params.push(cappedLimit);

  const { rows } = await pool.query(
    `SELECT source_type, source_id, chunk_index, chunk_text,
            1 - (embedding <=> $1::vector) AS score
       FROM document_embeddings
       ${where}
      ORDER BY embedding <=> $1::vector ASC
      LIMIT $${params.length}`,
    params
  );

  return {
    indexed: true,
    query: q,
    total_indexed: total,
    results: rows.map((r) => ({
      source_type: r.source_type,
      source_id: r.source_id,
      chunk_index: r.chunk_index,
      chunk_text: r.chunk_text,
      score: Number(r.score),
    })),
  };
}

module.exports = {
  chunkText,
  embed,
  indexDocument,
  indexSalesContracts,
  indexGeneratedDocuments,
  indexConversationMessages,
  indexSupplierInvoices,
  search,
  cosineSimilarity,
  CHUNK_SIZE,
};
