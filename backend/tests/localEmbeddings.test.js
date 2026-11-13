// Local embedding model (services/ai/localEmbeddings.js) — no external API,
// runs all-MiniLM-L6-v2 in-process via @xenova/transformers. These are real
// inference calls (no mocking the model), so the first one pays the one-time
// cost of loading the ONNX model into memory.
//
// Run on its own: node --test tests/localEmbeddings.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { embed, embedBatch, EMBEDDING_DIM, MODEL_NAME } = require('../services/ai/localEmbeddings');

test('EMBEDDING_DIM matches what migration 202608070100/202608070200 sized the vector columns to', () => {
  assert.equal(EMBEDDING_DIM, 384);
  assert.equal(MODEL_NAME, 'Xenova/all-MiniLM-L6-v2');
});

test('embed() returns a vector of the declared dimension', async () => {
  const vector = await embed('purchase order for steel fasteners from Acme Supplier');
  assert.ok(Array.isArray(vector));
  assert.equal(vector.length, EMBEDDING_DIM);
  assert.ok(vector.every((n) => typeof n === 'number' && Number.isFinite(n)));
});

test('embed() is deterministic — the same text embeds to the same vector', async () => {
  const a = await embed('recurring test phrase for determinism');
  const b = await embed('recurring test phrase for determinism');
  assert.deepEqual(a, b);
});

test('embed() of unrelated text produces a different vector than closely related text', async () => {
  const bolts = await embed('steel bolts and fasteners, industrial hardware');
  const unrelated = await embed('quarterly tax filing deadline reminder');
  assert.notDeepEqual(bolts, unrelated);
});

test('embedBatch() returns one vector per non-empty input, in order', async () => {
  const vectors = await embedBatch(['first item description', 'second item description']);
  assert.equal(vectors.length, 2);
  assert.equal(vectors[0].length, EMBEDDING_DIM);
  assert.equal(vectors[1].length, EMBEDDING_DIM);
  // Batch and single-call embedding must agree — embedBatch is not a
  // different code path with different pooling/normalization.
  const solo = await embed('first item description');
  assert.deepEqual(vectors[0], solo);
});

test('embedBatch() drops blank/whitespace-only entries rather than embedding nothing', async () => {
  const vectors = await embedBatch(['', '   ', 'real text here']);
  assert.equal(vectors.length, 1);
});

test('embedBatch() of an all-blank list returns an empty array without calling the model', async () => {
  const vectors = await embedBatch(['', '  ', '']);
  assert.deepEqual(vectors, []);
});

test('embed() of empty text returns an empty array rather than throwing', async () => {
  const vector = await embed('');
  assert.deepEqual(vector, []);
});
