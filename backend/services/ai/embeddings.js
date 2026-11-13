/**
 * Embedding generation for the record-level similarity search endpoints
 * (GET /api/purchase-orders/similar, /api/sales-orders/similar,
 * /api/inventory-items/similar) — see migration 202608070200 for the
 * `embedding vector(384)` columns and their HNSW indexes, searched with
 * pgvector's `<=>` operator.
 *
 * Embeddings run locally (services/ai/localEmbeddings.js, all-MiniLM-L6-v2 via
 * @xenova/transformers) — no external API, no key. Same model
 * services/ai/documentSearch.js uses for document_embeddings.
 *
 * Distinct from documentSearch.js, which chunks and embeds long free text
 * (contract terms, generated documents). These callers embed one short,
 * structured text summary per record — a PO, a sales order, a stocked item —
 * so there is no chunking here, one embedding call per document.
 */

const { pool } = require('../../config/database');
const localEmbeddings = require('./localEmbeddings');

/** Embed one string and return the raw float vector (384-dim). */
async function generateEmbedding(text) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('generateEmbedding requires non-empty text.');

  const vector = await localEmbeddings.embed(clean);
  if (!vector || !vector.length) throw new Error('Local embedding model returned no vector.');
  return vector;
}

/**
 * JS number array -> pgvector's text input format, e.g. "[0.1,0.2,0.3]".
 * A raw array parameter would otherwise be sent as a Postgres array literal
 * ("{0.1,0.2}"), which `vector` columns do not accept.
 */
function toVectorLiteral(vector) {
  return `[${vector.join(',')}]`;
}

// ---------------------------------------------------------------------------
// Text representations — what actually gets embedded for each record type.
// ---------------------------------------------------------------------------

const DOCUMENT_BUILDERS = {
  purchase_order: async (id) => {
    const { rows } = await pool.query(
      `SELECT po.po_number, po.status, po.currency, po.total_amount, po.payment_terms,
              po.incoterms, po.delivery_address, s.legal_name AS supplier_name, s.trade_name
         FROM purchase_orders po
         LEFT JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.id = $1`,
      [id]
    );
    const po = rows[0];
    if (!po) return null;

    const { rows: lines } = await pool.query(
      `SELECT item_description, quantity, unit_of_measure FROM purchase_order_line_items WHERE po_id = $1`,
      [id]
    );

    return [
      po.po_number,
      po.supplier_name || po.trade_name,
      po.status,
      `${po.total_amount || ''} ${po.currency || ''}`.trim(),
      po.payment_terms,
      po.incoterms,
      po.delivery_address,
      ...lines.map((l) => `${l.item_description || ''} x${l.quantity || ''} ${l.unit_of_measure || ''}`.trim()),
    ].filter(Boolean).join(' | ');
  },

  sales_order: async (id) => {
    const { rows } = await pool.query(
      `SELECT so_number, customer_name, status, priority, currency, total_amount,
              notes, delivery_address, shipping_method, payment_terms
         FROM sales_orders WHERE id = $1`,
      [id]
    );
    const so = rows[0];
    if (!so) return null;

    const { rows: lines } = await pool.query(
      `SELECT item_name, item_description, quantity, unit_of_measure FROM sales_order_items WHERE sales_order_id = $1`,
      [id]
    );

    return [
      so.so_number,
      so.customer_name,
      so.status,
      so.priority,
      `${so.total_amount || ''} ${so.currency || ''}`.trim(),
      so.payment_terms,
      so.shipping_method,
      so.delivery_address,
      so.notes,
      ...lines.map((l) => `${l.item_name || ''} ${l.item_description || ''} x${l.quantity || ''} ${l.unit_of_measure || ''}`.trim()),
    ].filter(Boolean).join(' | ');
  },

  inventory_item: async (id) => {
    const { rows } = await pool.query(
      `SELECT ii.status, ii.condition_grade, ii.condition_notes, ii.current_stock_quantity,
              ii.unit_price, ii.currency,
              im.item_code, im.name, im.description, im.category, im.item_category,
              im.manufacturer, im.manufacturer_part_number, im.unit_of_measure
         FROM inventory_items ii
         LEFT JOIN items im ON im.id = ii.item_master_id
        WHERE ii.id = $1`,
      [id]
    );
    const item = rows[0];
    if (!item) return null;

    return [
      item.item_code,
      item.name,
      item.description,
      item.category || item.item_category,
      item.manufacturer,
      item.manufacturer_part_number,
      item.status,
      item.condition_grade,
      item.condition_notes,
      `qty ${item.current_stock_quantity ?? ''} ${item.unit_of_measure || ''}`.trim(),
    ].filter(Boolean).join(' | ');
  },
};

/**
 * Build the text representation for a document and embed it.
 * `doc` is { type: 'purchase_order' | 'sales_order' | 'inventory_item', id }.
 * Returns null (not an error) if the record itself has nothing worth embedding
 * (e.g. deleted between query and call) rather than embedding an empty string.
 */
async function generateEmbeddingForDocument(doc) {
  const builder = DOCUMENT_BUILDERS[doc?.type];
  if (!builder) throw new Error(`generateEmbeddingForDocument: unknown document type "${doc?.type}".`);

  const text = await builder(doc.id);
  if (!text) return null;

  return generateEmbedding(text);
}

const TABLE_BY_TYPE = {
  purchase_order: 'purchase_orders',
  sales_order: 'sales_orders',
  inventory_item: 'inventory_items',
};

/**
 * Ensure a single record has a current embedding, writing it to the row.
 * Cached: skips the embeddings call entirely if embedding_generated_at is
 * already at or after updated_at — an unchanged record is not re-embedded.
 * Returns 'skipped' | 'embedded' | 'empty'.
 */
async function ensureEmbedding(type, id) {
  const table = TABLE_BY_TYPE[type];
  if (!table) throw new Error(`ensureEmbedding: unknown document type "${type}".`);

  const { rows } = await pool.query(
    `SELECT embedding, embedding_generated_at, updated_at FROM ${table} WHERE id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return 'not_found';

  if (row.embedding && row.embedding_generated_at && row.updated_at
      && row.embedding_generated_at >= row.updated_at) {
    return 'skipped';
  }

  const vector = await generateEmbeddingForDocument({ type, id });
  if (!vector) return 'empty';

  await pool.query(
    `UPDATE ${table} SET embedding = $1::vector, embedding_generated_at = NOW() WHERE id = $2`,
    [toVectorLiteral(vector), id]
  );
  return 'embedded';
}

module.exports = {
  generateEmbedding,
  generateEmbeddingForDocument,
  ensureEmbedding,
  toVectorLiteral,
  DOCUMENT_BUILDERS,
  TABLE_BY_TYPE,
};
