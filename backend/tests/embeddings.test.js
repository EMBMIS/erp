// Record-level embeddings (services/ai/embeddings.js) — the PO/SO/inventory
// item text builders and the vector(384) write path, distinct from
// services/ai/documentSearch.js's chunked free-text embedding.
//
// Run on its own: node --test tests/embeddings.test.js

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  generateEmbedding,
  generateEmbeddingForDocument,
  ensureEmbedding,
  toVectorLiteral,
  DOCUMENT_BUILDERS,
  TABLE_BY_TYPE,
} = require('../services/ai/embeddings');
const { pool } = require('../config/database');

// Without this, the process hangs after the last test rather than exiting —
// the pool's min:2 local-dev connections (config/database.js) stay open and
// nothing else in this file ever calls pool.end().
after(() => pool.end());

test('generateEmbedding() rejects empty text rather than embedding nothing', async () => {
  await assert.rejects(() => generateEmbedding(''), /non-empty text/);
  await assert.rejects(() => generateEmbedding('   '), /non-empty text/);
});

test('generateEmbedding() returns a real 384-dim vector for real text', async () => {
  const vector = await generateEmbedding('PO-2026-0001 | Acme Supplier | APPROVED | 500.00 USD');
  assert.equal(vector.length, 384);
});

test('toVectorLiteral() formats a JS number array as pgvector input syntax', () => {
  assert.equal(toVectorLiteral([0.1, -0.2, 3]), '[0.1,-0.2,3]');
  assert.equal(toVectorLiteral([]), '[]');
});

test('TABLE_BY_TYPE covers exactly the three record types this module embeds', () => {
  assert.deepEqual(Object.keys(TABLE_BY_TYPE).sort(), ['inventory_item', 'purchase_order', 'sales_order']);
  assert.equal(TABLE_BY_TYPE.purchase_order, 'purchase_orders');
  assert.equal(TABLE_BY_TYPE.sales_order, 'sales_orders');
  assert.equal(TABLE_BY_TYPE.inventory_item, 'inventory_items');
});

test('generateEmbeddingForDocument() throws on an unknown document type', async () => {
  await assert.rejects(
    () => generateEmbeddingForDocument({ type: 'not_a_real_type', id: 'x' }),
    /unknown document type/
  );
});

test('generateEmbeddingForDocument() returns null (not an error) for a record that does not exist', async () => {
  const result = await generateEmbeddingForDocument({ type: 'purchase_order', id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(result, null);
});

test('DOCUMENT_BUILDERS.purchase_order returns null for a nonexistent PO', async () => {
  const text = await DOCUMENT_BUILDERS.purchase_order('00000000-0000-0000-0000-000000000000');
  assert.equal(text, null);
});

test('DOCUMENT_BUILDERS.purchase_order composes a real PO into a non-empty description', async () => {
  const { rows } = await pool.query('SELECT id FROM purchase_orders LIMIT 1');
  if (!rows.length) return; // no fixture data in this environment — nothing to assert against
  const text = await DOCUMENT_BUILDERS.purchase_order(rows[0].id);
  assert.ok(typeof text === 'string' && text.length > 0);
});

test('ensureEmbedding() reports not_found for an unknown record rather than throwing', async () => {
  const result = await ensureEmbedding('purchase_order', '00000000-0000-0000-0000-000000000000');
  assert.equal(result, 'not_found');
});

test('ensureEmbedding() throws on an unknown document type', async () => {
  await assert.rejects(() => ensureEmbedding('not_a_real_type', 'x'), /unknown document type/);
});
