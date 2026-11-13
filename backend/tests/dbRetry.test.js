/**
 * Regression tests for services/dbRetry.js — the per-item in-process write
 * queue, the sorted advisory-lock ordering helper, and the deadlock retry that
 * keep concurrent writers to the same stock row from deadlocking. When a
 * deadlock still slips through (cross-process, or a path that bypasses the
 * queue), the retry turns it into a transparent success instead of a 500.
 *
 * The DB integration case reproduces the original complaint exactly: 5+
 * truly-simultaneous writers to one inventory row. Half go through the public
 * create() (in-process queue), half call the transaction body directly to
 * simulate a second process with its own queue — the DB-level advisory locks
 * and deadlock retry must serialize the two groups with no deadlock surfacing.
 */

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { withDeadlockRetry, serializeInventoryItemWrite } = require('../services/dbRetry');
const { pool } = require('../config/database');

// Diagnostic: if a deadlock rejection ever escapes the queue/retry layers, log
// the full lock graph and the promise chain that leaked it.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason && reason.code, reason && reason.message);
  if (reason && reason.detail) console.error('DETAIL:', reason.detail);
  if (reason && reason.stack) console.error('STACK:', reason.stack);
});

let dbAvailable = false;
let userId = null;
const created = { itemIds: [], inventoryItemIds: [], warehouseTransactionIds: [] };

before(async () => {
  try {
    await pool.query('SELECT 1');
    const { rows } = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!rows.length) throw new Error('no users');
    userId = rows[0].id;
    dbAvailable = true;
  } catch (err) {
    console.error('dbRetry test setup failed:', err.message);
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.warehouseTransactionIds) {
      await pool.query('DELETE FROM warehouse_transaction_audit_log WHERE warehouse_transaction_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM warehouse_transaction_items WHERE warehouse_transaction_id = $1', [id]).catch(() => {});
      await pool.query(
        `DELETE FROM journal_entry_items WHERE journal_entry_id IN
           (SELECT id FROM journal_entries WHERE source_type = 'GOODS_ISSUE' AND source_id = $1)`, [id]).catch(() => {});
      await pool.query(
        `DELETE FROM journal_entries WHERE source_type = 'GOODS_ISSUE' AND source_id = $1`, [id]).catch(() => {});
      await pool.query('DELETE FROM warehouse_transactions WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.inventoryItemIds) {
      await pool.query('DELETE FROM cost_layers WHERE inventory_item_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM inventory_storage_mappings WHERE inventory_item_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM inventory_items WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.itemIds) {
      await pool.query('DELETE FROM items WHERE id = $1', [id]).catch(() => {});
    }
  }
  await pool.end();
});

// ---------------------------------------------------------------------------
// Unit level — queue semantics and retry behaviour (no database)
// ---------------------------------------------------------------------------

test('per-item queue serializes concurrent writes to the same key', async () => {
  let active = 0;
  let maxActive = 0;
  const work = () => serializeInventoryItemWrite('item-1', async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
  });
  await Promise.all(Array.from({ length: 25 }, work));
  assert.equal(maxActive, 1, 'writes to the same item must never overlap in-process');
});

test('multi-item acquisition in opposite orders never deadlocks', async () => {
  const done = [];
  await Promise.all([
    serializeInventoryItemWrite(['a', 'b'], async () => { await new Promise((r) => setTimeout(r, 10)); done.push('ab'); }),
    serializeInventoryItemWrite(['b', 'a'], async () => { await new Promise((r) => setTimeout(r, 10)); done.push('ba'); }),
  ]);
  assert.equal(done.length, 2);
  assert.deepEqual([...done].sort(), ['ab', 'ba']);
});

test('serializeInventoryItemWrite passes through with no ids and accepts a single id', async () => {
  let ran = false;
  await serializeInventoryItemWrite([], async () => { ran = true; });
  assert.equal(ran, true, 'empty key set must call through immediately');
  ran = false;
  await serializeInventoryItemWrite('single-item', async () => { ran = true; });
  assert.equal(ran, true, 'a single string id must be treated as a one-key queue');
});

test('withDeadlockRetry transparently retries 40P01 and succeeds', async () => {
  let calls = 0;
  const result = await withDeadlockRetry(async () => {
    calls += 1;
    if (calls < 3) { const e = new Error('deadlock detected'); e.code = '40P01'; throw e; }
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withDeadlockRetry rethrows non-retryable errors without retrying', async () => {
  let calls = 0;
  await assert.rejects(
    withDeadlockRetry(async () => {
      calls += 1;
      const e = new Error('unique violation'); e.code = '23505'; throw e;
    }),
    /unique violation/
  );
  assert.equal(calls, 1);
});

test('withDeadlockRetry gives up after the retry budget and rethrows', async () => {
  let calls = 0;
  await assert.rejects(
    withDeadlockRetry(async () => {
      calls += 1;
      const e = new Error('still deadlocked'); e.code = '40P01'; throw e;
    }, { retries: 2, baseDelayMs: 1 }),
    /still deadlocked/
  );
  assert.equal(calls, 3, 'initial attempt + 2 retries, then the error surfaces');
});

// ---------------------------------------------------------------------------
// Integration — 5+ truly-simultaneous writers to the SAME stock row
// ---------------------------------------------------------------------------

test('6 simultaneous writers (4 queued + 2 cross-process) to one inventory row all succeed with no lost updates', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const WarehouseTransaction = require('../models/WarehouseTransaction');

  // Self-heal: purge any residue a previous crashed run of this test left
  // behind (ids are only tracked after a writer settles, so an aborted run
  // orphans its committed transactions). Reruns must be safe.
  const residue = `notes LIKE 'dbRetry concurrency%'`;
  await pool.query(
    `DELETE FROM warehouse_transaction_audit_log WHERE warehouse_transaction_id IN (SELECT id FROM warehouse_transactions WHERE ${residue})`
  ).catch(() => {});
  await pool.query(
    `DELETE FROM warehouse_transaction_items WHERE warehouse_transaction_id IN (SELECT id FROM warehouse_transactions WHERE ${residue})`
  ).catch(() => {});
  await pool.query(
    `DELETE FROM journal_entry_items WHERE journal_entry_id IN
       (SELECT id FROM journal_entries WHERE source_type = 'GOODS_ISSUE' AND source_id IN
          (SELECT id FROM warehouse_transactions WHERE ${residue}))`
  ).catch(() => {});
  await pool.query(
    `DELETE FROM journal_entries WHERE source_type = 'GOODS_ISSUE' AND source_id IN
       (SELECT id FROM warehouse_transactions WHERE ${residue})`
  ).catch(() => {});
  await pool.query(`DELETE FROM warehouse_transactions WHERE ${residue}`).catch(() => {});
  await pool.query(
    `DELETE FROM cost_layers WHERE inventory_item_id IN
       (SELECT ii.id FROM inventory_items ii JOIN items i ON i.id = ii.item_master_id WHERE i.name LIKE 'dbRetry concurrent item%')`
  ).catch(() => {});
  await pool.query(
    `DELETE FROM inventory_storage_mappings WHERE inventory_item_id IN
       (SELECT ii.id FROM inventory_items ii JOIN items i ON i.id = ii.item_master_id WHERE i.name LIKE 'dbRetry concurrent item%')`
  ).catch(() => {});
  await pool.query(
    `DELETE FROM inventory_items WHERE item_master_id IN (SELECT id FROM items WHERE name LIKE 'dbRetry concurrent item%')`
  ).catch(() => {});
  await pool.query(`DELETE FROM items WHERE name LIKE 'dbRetry concurrent item%'`).catch(() => {});

  const itemId = randomUUID();
  const tag = `DBRETRY-${Date.now()}`;
  await pool.query(
    `INSERT INTO items (id, item_code, name, stock_code, status) VALUES ($1, $2, $3, 'ST1', 'APPROVED')`,
    [itemId, tag, `dbRetry concurrent item ${tag}`]
  );
  created.itemIds.push(itemId);

  // 100 units on the books @ 10 = $1000 book value, with a cost layer to feed COGS.
  const invId = randomUUID();
  await pool.query(
    `INSERT INTO inventory_items (id, item_master_id, current_stock_quantity, unit_price, currency, status, user_id)
     VALUES ($1, $2, 100, 10, 'USD', 'APPROVED', $3)`,
    [invId, itemId, userId]
  );
  created.inventoryItemIds.push(invId);

  await pool.query(
    `INSERT INTO cost_layers (inventory_item_id, quantity, unit_cost, remaining_quantity, receipt_type)
     VALUES ($1, 100, 10, 100, 'INITIAL')`,
    [invId]
  );

  const txnData = (type) => ({
    transaction_type: type,
    created_by: userId,
    processed_by: userId,
    notes: `dbRetry concurrency ${type}`,
  });
  const txnItems = (qty) => [{
    inventory_item_id: invId,
    item_name: tag,
    quantity: qty,
    unit_of_measure: 'PCS',
    unit_cost: 10,
    reason_code: 'TEST', // warehouse_transaction_items.reason_code is NOT NULL
  }];

  // 4 goods issues through the public API (in-process queue serializes them).
  // The queue makes same-process contention impossible, so these never deadlock.
  const queued = Array.from({ length: 4 }, () => {
    const p = WarehouseTransaction.create(txnData('GI'), txnItems(1));
    p.catch(() => {}); // defensive: never allow a stray rejection from the harness
    return p;
  });

  // 2 more writers (1 issue + 1 receipt) that simulate a SECOND Node process:
  // it has its own in-process queue, so the only thing shared with the queued
  // group is the database — the sorted advisory locks plus withDeadlockRetry
  // (exactly what create() does). Cross-process contention CAN still form a
  // row-lock/advisory cycle (e.g. the journal-number unique index); the retry
  // is what turns that into a transparent success instead of a 500.
  let absorbedDeadlocks = 0;
  const runUnqueued = (type) => {
    const attempt = () => {
      const p = WarehouseTransaction._createOnce(txnData(type), txnItems(1));
      p.catch((e) => { if (e && e.code === '40P01') absorbedDeadlocks += 1; });
      return p;
    };
    const p = withDeadlockRetry(attempt);
    p.catch(() => {}); // defensive: never allow a stray rejection from the harness
    return p;
  };
  const unqueued = [runUnqueued('GI'), runUnqueued('GR')];

  // allSettled so committed writers are tracked (and cleaned up) even if one
  // rejects — an assertion failure must not orphan the successful writers.
  const queuedSettled = await Promise.allSettled(queued);
  const queuedFailed = queuedSettled.filter((s) => s.status === 'rejected');
  assert.equal(
    queuedFailed.length,
    0,
    `the in-process queue must eliminate same-process deadlocks entirely: ${queuedFailed.map((f) => f.reason && f.reason.message).join('; ')}`
  );
  for (const s of queuedSettled) created.warehouseTransactionIds.push(s.value.id);

  const unqueuedSettled = await Promise.allSettled(unqueued);
  const unqueuedFailed = unqueuedSettled.filter((s) => s.status === 'rejected');
  assert.equal(
    unqueuedFailed.length,
    0,
    `cross-process-style writers must all succeed after retry: ${unqueuedFailed.map((f) => f.reason && f.reason.message).join('; ')}`
  );
  for (const s of unqueuedSettled) created.warehouseTransactionIds.push(s.value.id);

  const txns = [...queuedSettled, ...unqueuedSettled].map((s) => s.value);
  console.log(
    `dbRetry integration: ${absorbedDeadlocks} deadlock(s) absorbed by retry across the cross-process group (designed grace path)`
  );

  assert.equal(txns.length, 6);
  assert.ok(txns.every((txn) => txn && txn.status === 'POSTED'), 'every writer must auto-post');

  const inv = await pool.query('SELECT current_stock_quantity FROM inventory_items WHERE id = $1', [invId]);
  assert.equal(
    Number(inv.rows[0].current_stock_quantity),
    96,
    '100 - 5 issues + 1 receipt = 96; any lost update or double-apply breaks this'
  );

  // Grace drain: let any final deadlock detection land while the test is still
  // alive, so a straggler rejection can never fire after the test context ends.
  await new Promise((r) => setTimeout(r, 300));
});
