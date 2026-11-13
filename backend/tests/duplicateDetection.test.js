// Embedding-based PO/SO duplicate detection (services/ai/duplicateDetection.js)
// — the pgvector nearest-neighbour scan added alongside migration
// 202608070200, and the create-time hook (models/PurchaseOrder.js,
// models/SalesOrder.js) that calls it. Real embedding calls throughout (no
// mocked model), so this seeds two genuinely near-identical purchase orders
// and asserts the system actually finds them similar.
//
// Run on its own: node --test tests/duplicateDetection.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const duplicateDetection = require('../services/ai/duplicateDetection');
const PurchaseOrder = require('../models/PurchaseOrder');
const { pool } = require('../config/database');

let supplierId;
let userId;
let po1;
let po2;

before(async () => {
  const { rows: suppliers } = await pool.query('SELECT id FROM suppliers LIMIT 1');
  const { rows: users } = await pool.query('SELECT id FROM users LIMIT 1');
  if (!suppliers.length || !users.length) return; // no fixture data — tests below self-skip
  supplierId = suppliers[0].id;
  userId = users[0].id;

  const poData = {
    supplier_id: supplierId,
    delivery_date: '2026-09-01',
    payment_terms: 'NET-30',
    incoterms: 'FOB',
    delivery_address: 'duplicateDetection.test.js fixture warehouse',
    line_items: [{
      item_description: 'duplicateDetection.test.js fixture: aerospace titanium fasteners M8x40',
      quantity: 500, unit_price: 2.5, unit_of_measure: 'EA',
    }],
  };
  po1 = await PurchaseOrder.create(poData, userId);
  // Give PO1's fire-and-forget embedding (scheduleDuplicateCheck) time to
  // finish before PO2 exists, so PO2's own check has something to find.
  await new Promise((r) => setTimeout(r, 6000));
  po2 = await PurchaseOrder.create(poData, userId);
  await new Promise((r) => setTimeout(r, 8000));
});

after(async () => {
  const ids = [po1?.id, po2?.id].filter(Boolean);
  if (ids.length) {
    await pool.query('DELETE FROM ai_findings WHERE entity_id = ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM purchase_order_line_items WHERE po_id = ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1::uuid[])', [ids]);
  }
  await pool.end();
});

test('checkRecordForDuplicate finds no match for a record with nothing similar', async () => {
  const { rows } = await pool.query('SELECT id FROM purchase_orders WHERE embedding IS NOT NULL LIMIT 1');
  if (!rows.length) return;
  // A near-impossible threshold (>1.0) can never be met — proves the
  // function returns null rather than always finding *something*.
  const match = await duplicateDetection.checkRecordForDuplicate('purchase_order', rows[0].id, { threshold: 1.01 });
  assert.equal(match, null);
});

test('two near-identical purchase orders score as duplicates of each other', async (t) => {
  if (!po1 || !po2) return t.skip('no supplier/user fixture data in this environment');

  const match = await duplicateDetection.checkRecordForDuplicate('purchase_order', po2.id, { threshold: 0.9 });
  assert.ok(match, 'expected a near-duplicate match');
  assert.equal(match.id, po1.id);
  assert.ok(match.score >= 0.9, `expected score >= 0.9, got ${match.score}`);
});

test('the scheduled-sweep scan (findDuplicatePurchaseOrders) also surfaces the pair', async (t) => {
  if (!po1 || !po2) return t.skip('no supplier/user fixture data in this environment');

  const result = await duplicateDetection.findDuplicatePurchaseOrders({ threshold: 0.9 });
  const found = result.pairs.find((p) =>
    [p.records[0].id, p.records[1].id].includes(po1.id) &&
    [p.records[0].id, p.records[1].id].includes(po2.id)
  );
  assert.ok(found, 'expected the seeded pair in the sweep results');
});

test('the create-time hook raised an ai_findings entry for the duplicate', async (t) => {
  if (!po1 || !po2) return t.skip('no supplier/user fixture data in this environment');

  const { rows } = await pool.query(
    `SELECT finding_type, severity FROM ai_findings WHERE entity_id = $1 AND finding_type = 'DUPLICATE_PURCHASE_ORDER'`,
    [po2.id]
  );
  assert.equal(rows.length, 1, 'expected exactly one finding from PurchaseOrder.create\'s fire-and-forget check');
  assert.equal(rows[0].severity, 'HIGH');
});

test('checkNewRecordForDuplicate is idempotent — re-running it does not create a second finding', async (t) => {
  if (!po1 || !po2) return t.skip('no supplier/user fixture data in this environment');

  await duplicateDetection.checkNewRecordForDuplicate('purchase_order', po2.id);
  const { rows } = await pool.query(
    `SELECT id FROM ai_findings WHERE entity_id = $1 AND finding_type = 'DUPLICATE_PURCHASE_ORDER'`,
    [po2.id]
  );
  assert.equal(rows.length, 1, 'ai_findings\' partial unique index on OPEN findings should have deduped this');
});
