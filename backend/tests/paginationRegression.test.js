// Regression test for server-side pagination + sorting on the list GET
// endpoints, and for the new goods-receipt history list:
//
//   • GET /items            → { success, data: rows, total, limit, offset }
//   • GET /fixed-assets     → same envelope
//   • GET /goods-receipts   → NEW history list, same envelope
//
// The response contract deliberately mirrors customer-invoices GET /
// (routes/customer-invoices.js + models/CustomerInvoice.js findAll), which is
// what the frontend useListControls hook consumes unchanged. The seeded rows
// use unique UUIDs and are removed in after() (reverse FK order).
//
// Real-DB suite: self-skips when no database is reachable, following
// tests/integration.test.js / tests/grRegression.test.js. Run on its own (it
// opens a pg pool and must not race other suites):
//   cd backend && node --test --test-concurrency=1 tests/paginationRegression.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../config/database');
const Item = require('../models/Item');
const itemsRouter = require('../routes/items');
const fixedAssetsRouter = require('../routes/fixed-assets');
const goodsReceiptsRouter = require('../routes/goods-receipts');

let dbAvailable = false;
let ready = false;
let skipReason = '';

let userId = null;
let supplier = null;
let token = null;
let server = null;
let baseUrl = null;

// Unique per-run tokens, so search filters match exactly our seed.
let unique = null;
let itemName0 = null;
let itemToken = null;
let assetToken = null;
let batchToken = null;
let poNumber = null;
let receiptId = null;

const SEED_ITEMS = 3;
const SEED_ASSETS = 3;

// Everything we create, so teardown can remove exactly it (unique UUIDs only).
const created = { itemIds: [], fixedAssetIds: [], purchaseOrderIds: [], lineItemIds: [], receiptIds: [] };

async function apiGet(path) {
  const res = await fetch(baseUrl + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body };
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const suppliers = await pool.query('SELECT id FROM suppliers LIMIT 1');

    // Prefer a user with no explicit user_companies membership: the auth
    // middleware then resolves company context to the default company — the
    // same one the withCompany hooks seed data under. Any active non-deleted
    // user works as a fallback (these tables are not company-scoped).
    let userRow = null;
    try {
      userRow = (await pool.query(
        `SELECT id, email, role FROM users u
           WHERE u.deleted_at IS NULL AND COALESCE(u.is_active, true) = true
             AND NOT EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = u.id)
           ORDER BY u.created_at LIMIT 1`
      )).rows[0] || null;
    } catch { /* user_companies may not exist pre-migration-110 */ }
    if (!userRow) {
      userRow = (await pool.query(
        'SELECT id, email, role FROM users WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true ORDER BY created_at LIMIT 1'
      )).rows[0] || null;
    }

    if (userRow && suppliers.rows.length) {
      userId = userRow.id;
      supplier = suppliers.rows[0];
      if (process.env.JWT_SECRET) {
        // Same payload shape the login route signs (models/User.js): the auth
        // middleware only reads decoded.id.
        token = jwt.sign(
          { id: userRow.id, email: userRow.email, role: userRow.role },
          process.env.JWT_SECRET,
          { expiresIn: '1h' }
        );
      }
      dbAvailable = true;
    }
  } catch (error) {
    console.error('[paginationRegression] before() failed:', error.message);
    dbAvailable = false;
  }

  if (!dbAvailable) { ready = false; skipReason = 'no database available'; return; }
  if (!token) { ready = false; skipReason = 'JWT_SECRET is not set — cannot mint a token for the real auth middleware'; return; }

  // ---- Seed ----
  unique = randomUUID();
  itemToken = `PA-REGRESSION-ITEM-${unique}`;
  assetToken = `PA-REGRESSION-ASSET-${unique}`;
  batchToken = `PA-BATCH-${unique}`;

  for (let i = 0; i < SEED_ITEMS; i++) {
    const item = await Item.create(
      { name: `${itemToken}-${i}`, description: 'created by paginationRegression.test.js', is_stock_item: true, unit_of_measure: 'pcs' },
      userId
    );
    created.itemIds.push(item.id);
  }
  itemName0 = `${itemToken}-0`;

  for (let i = 0; i < SEED_ASSETS; i++) {
    const ar = await pool.query(
      `INSERT INTO fixed_assets (asset_number, name, description, category, acquisition_cost, location, serial_number, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [`FA-PA-${unique}-${i}`, `${assetToken}-${i}`, 'created by paginationRegression.test.js', 'Test Equipment', 1000 + i, 'Test location', `SN-${unique}-${i}`, userId]
    );
    created.fixedAssetIds.push(ar.rows[0].id);
  }

  // A PO + line item + goods receipt so the GR history join is exercised.
  const poId = randomUUID();
  poNumber = `PA-PO-${unique}`;
  await pool.query(
    `INSERT INTO purchase_orders (id, po_number, supplier_id, po_date, currency, status, subtotal, tax_amount, total_amount, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE, 'USD', 'APPROVED', $4, 0, $4, $5)`,
    [poId, poNumber, supplier.id, 200, userId]
  );
  created.purchaseOrderIds.push(poId);

  const li = await pool.query(
    `INSERT INTO purchase_order_line_items (po_id, item_id, item_description, unit_of_measure, quantity, unit_price, quantity_received)
     VALUES ($1, $2, 'PA regression line', 'pcs', 10, 20, 0) RETURNING id`,
    [poId, created.itemIds[0]]
  );
  created.lineItemIds.push(li.rows[0].id);

  receiptId = randomUUID();
  await pool.query(
    `INSERT INTO goods_receipts (id, po_id, po_line_item_id, quantity_received, condition_grade, batch_lot_number, received_date, notes, received_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [receiptId, poId, li.rows[0].id, 3, 'NEW', batchToken, new Date().toISOString(), 'paginationRegression.test.js', userId]
  );
  created.receiptIds.push(receiptId);

  // ---- HTTP harness: the REAL routers + the REAL auth middleware ----
  const app = express();
  app.use(express.json());
  app.use('/api/items', itemsRouter);
  app.use('/api/fixed-assets', fixedAssetsRouter);
  app.use('/api/goods-receipts', goodsReceiptsRouter);
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  ready = true;
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.receiptIds) {
      await pool.query('DELETE FROM goods_receipts WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.lineItemIds) {
      await pool.query('DELETE FROM purchase_order_line_items WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.purchaseOrderIds) {
      await pool.query('DELETE FROM purchase_orders WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.fixedAssetIds) {
      await pool.query('DELETE FROM fixed_assets WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.itemIds) {
      await pool.query('DELETE FROM items WHERE id = $1', [id]).catch(() => {});
    }
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve)).catch(() => {});
  }
  await pool.end().catch(() => {});
});

test('items: GET /items returns a paginated envelope with total and limited rows', async (t) => {
  if (!ready) return t.skip(skipReason);

  const r1 = await apiGet('/items?limit=2&sort_by=created_at&sort_dir=desc');
  assert.equal(r1.status, 200, 'GET /items?limit=2 must return 200');
  assert.equal(r1.body.success, true);
  assert.ok(Array.isArray(r1.body.data), 'data must be an array (customer-invoices contract)');
  assert.ok(r1.body.data.length <= 2, `limit must cap the page size, got ${r1.body.data.length}`);
  assert.ok(Number.isInteger(r1.body.total) && r1.body.total >= SEED_ITEMS,
    `total must count all matching rows (>= ${SEED_ITEMS}), got ${r1.body.total}`);
  assert.equal(r1.body.limit, 2, 'envelope must echo the effective limit');
  assert.equal(r1.body.offset, 0, 'envelope must echo the effective offset');
  assert.equal(r1.body.count, r1.body.data.length, 'legacy count field must match the returned rows');

  // page=1 with the same limit behaves like offset=0.
  const r2 = await apiGet('/items?page=1&limit=2&sort_by=created_at&sort_dir=desc');
  assert.equal(r2.status, 200);
  assert.ok(r2.body.data.length <= 2);
  assert.equal(r2.body.offset, 0);

  // page=2 maps to offset=(page-1)*limit.
  const r3 = await apiGet('/items?page=2&limit=2&sort_by=created_at&sort_dir=asc');
  assert.equal(r3.status, 200);
  assert.equal(r3.body.offset, 2, 'offset must be (page-1)*limit when page is given');

  // All seeded items are visible (same owner) once the page is large enough.
  const rAll = await apiGet('/items?limit=200&sort_by=created_at&sort_dir=asc');
  assert.equal(rAll.status, 200);
  const ids = new Set(rAll.body.data.map((it) => it.id));
  for (const id of created.itemIds) {
    assert.ok(ids.has(id), `seeded item ${id} must appear in the full list`);
  }
});

test('items: filters (search/status) still compose with pagination', async (t) => {
  if (!ready) return t.skip(skipReason);

  // Unique search token + limit=1: total is computed BEFORE paging.
  const r1 = await apiGet(`/items?search=${encodeURIComponent(itemName0)}&limit=1&sort_by=created_at&sort_dir=desc`);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.total, 1, 'search must narrow total before paging');
  assert.equal(r1.body.data.length, 1);
  assert.equal(r1.body.data[0].id, created.itemIds[0]);

  // status filter + search + pagination together.
  const r2 = await apiGet(`/items?status=DRAFT&search=${encodeURIComponent(itemName0)}&limit=1`);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.total, 1, 'status filter must compose with search and pagination');
  assert.equal(r2.body.data[0].id, created.itemIds[0]);

  // validateFilters behavior is preserved: an unknown status still 400s.
  const r3 = await apiGet('/items?status=BOGUS&limit=1');
  assert.equal(r3.status, 400, 'invalid filter values must still be rejected');
  // The 400 body has always been an error/details object without a success key.
  assert.ok(r3.body.error, 'the 400 body must carry the validateFilters error');
});

test('items: GET /items/:id still resolves (the list route did not shadow it)', async (t) => {
  if (!ready) return t.skip(skipReason);

  const r = await apiGet(`/items/${created.itemIds[0]}`);
  assert.equal(r.status, 200, 'GET /items/:id must still resolve');
  assert.equal(r.body.success, true);
  assert.equal(r.body.data.id, created.itemIds[0]);
});

test('fixed-assets: GET /fixed-assets returns a paginated envelope', async (t) => {
  if (!ready) return t.skip(skipReason);

  const q = encodeURIComponent(assetToken);
  const r1 = await apiGet(`/fixed-assets?search=${q}&limit=2&sort_by=created_at&sort_dir=desc`);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.success, true);
  assert.ok(Array.isArray(r1.body.data));
  assert.ok(r1.body.data.length <= 2, `limit must cap the page size, got ${r1.body.data.length}`);
  assert.equal(r1.body.total, SEED_ASSETS, 'search must narrow total to the seeded assets');
  assert.equal(r1.body.limit, 2);
  assert.equal(r1.body.offset, 0);

  // offset-based paging — exactly what useListControls sends (limit + offset).
  const r2 = await apiGet(`/fixed-assets?search=${q}&offset=2&limit=2`);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.offset, 2);
  assert.ok(r2.body.data.length <= 2);

  // Sorting by a whitelisted column actually orders the rows.
  const r3 = await apiGet(`/fixed-assets?search=${q}&sort_by=name&sort_dir=asc&limit=200`);
  assert.equal(r3.status, 200);
  const names = r3.body.data.map((a) => a.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'sort_by=name must order rows by name');

  // No pagination params → every matching row (the pre-pagination contract),
  // with total/limit/offset still correct.
  const r4 = await apiGet(`/fixed-assets?search=${q}`);
  assert.equal(r4.status, 200);
  assert.equal(r4.body.data.length, SEED_ASSETS);
  assert.equal(r4.body.total, SEED_ASSETS);
  assert.equal(r4.body.limit, SEED_ASSETS);
  assert.equal(r4.body.offset, 0);
});

test('goods-receipts: GET / returns GR history rows with joins, paginated, without shadowing /po/:poId and /summary', async (t) => {
  if (!ready) return t.skip(skipReason);

  const r = await apiGet(`/goods-receipts?search=${encodeURIComponent(batchToken)}&limit=10&sort_by=received_date&sort_dir=desc`);
  assert.equal(r.status, 200, 'GET /goods-receipts must return 200');
  assert.equal(r.body.success, true);
  assert.ok(Array.isArray(r.body.data));
  assert.ok(r.body.total >= 1, 'total must include the seeded receipt');
  assert.ok(r.body.data.length >= 1);
  assert.equal(r.body.limit, 10);
  assert.equal(r.body.offset, 0);

  const row = r.body.data.find((x) => x.id === receiptId);
  assert.ok(row, 'seeded receipt must appear in GR history');
  assert.equal(row.po_number, poNumber, 'PO number must be joined');
  assert.ok(row.supplier_name, 'supplier name must be joined');
  assert.equal(row.item_description, 'PA regression line', 'line item info must be joined');
  assert.equal(Number(row.quantity_received), 3, 'quantity must be present');
  assert.equal(row.condition_grade, 'NEW', 'condition must be present');
  assert.ok(row.received_by_name, 'received_by name must be joined');
  assert.ok(row.received_date, 'received_date must be present');

  // Route ordering: the pre-existing routes must still resolve now that a bare
  // GET / was added before them.
  const po = await apiGet(`/goods-receipts/po/${created.purchaseOrderIds[0]}`);
  assert.equal(po.status, 200, 'GET /po/:poId must still resolve');
  assert.equal(po.body.success, true);

  const summary = await apiGet('/goods-receipts/summary');
  assert.equal(summary.status, 200, 'GET /summary must still resolve');
  assert.equal(summary.body.success, true);
});
