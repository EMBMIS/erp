// End-to-end money-path integration tests: Order-to-Cash and Procure-to-Pay.
//
// Unlike integration.test.js (which exercises the GL core), these drive the
// actual business flows through the model layer against a real DB:
//   • O2C: create a sales order → mark COMPLETED → assert a customer invoice and
//          a balanced revenue journal entry are produced (audit B4 + B11).
//   • P2P: generate a supplier bill from a completed purchase order → assert it
//          links to the PO and gets a generated bill number (audit B5).
//
// These POST to the GL, which mutates chart_of_accounts.current_balance, so the
// suite snapshots every account balance up front and restores it in teardown —
// the database is left exactly as it was found. Self-skips when no DB is present.
//
// Run on its own:  npm run test:integration:flows

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const { randomUUID } = require('node:crypto');
const SalesOrder = require('../models/SalesOrder');
const SupplierInvoice = require('../models/SupplierInvoice');
const PurchaseOrder = require('../models/PurchaseOrder');
const WarehouseTransaction = require('../models/WarehouseTransaction');

let dbAvailable = false;
let userId = null;
let customer = null;
let supplier = null;
let completedPo = null;
let balanceSnapshot = null;

// Track everything we create so teardown can remove it.
const created = { salesOrderIds: [], invoiceIds: [], journalEntryIds: [], billIds: [], purchaseOrderIds: [], inventoryItemIds: [], itemIds: [], requisitionIds: [], bankAccountIds: [], customerPaymentIds: [], warehouseTransactionIds: [], storageLocationIds: [], transferIds: [], recurringScheduleIds: [], apiKeyIds: [], webhookIds: [], approvalTemplateIds: [], approvalRequestIds: [], aiFindingIds: [] };

before(async () => {
  try {
    await pool.query('SELECT 1');
    // Actor resolution. "Oldest user" is a trap on any database whose original
    // admin has since been soft-deleted: resolveActor (statusTransitionService)
    // filters deleted_at IS NULL, so every status transition in this suite died
    // with "user record not found". Prefer the platform owner — these flows also
    // post their own GL entries, and Segregation of Duties only permits
    // self-posting for the owner — then fall back to any live user.
    // PLATFORM_OWNER_EMAIL wins over the is_platform_owner flag when set, the
    // same precedence services/platformOwner.js applies (tests/grRegression.js
    // resolves its actor the same way).
    const ownerEmail = (process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
    const liveUser = `SELECT id FROM users WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true`;
    let users = ownerEmail
      ? await pool.query(`${liveUser} AND lower(email) = $1 LIMIT 1`, [ownerEmail])
      : { rows: [] };
    if (!users.rows.length) users = await pool.query(`${liveUser} AND is_platform_owner = true LIMIT 1`);
    if (!users.rows.length) users = await pool.query(`${liveUser} ORDER BY created_at LIMIT 1`);
    const customers = await pool.query('SELECT id, customer_name FROM customers WHERE deleted_at IS NULL LIMIT 1');
    const suppliers = await pool.query('SELECT id, legal_name FROM suppliers LIMIT 1');
    const pos = await pool.query(
      "SELECT id, po_number FROM purchase_orders WHERE status IN ('COMPLETED','FULLY_RECEIVED') LIMIT 1"
    );
    if (users.rows.length && customers.rows.length) {
      userId = users.rows[0].id;
      customer = customers.rows[0];
      supplier = suppliers.rows[0] || null;
      completedPo = pos.rows[0] || null;
      // Snapshot all account balances so we can restore them after posting.
      balanceSnapshot = (await pool.query('SELECT id, current_balance FROM chart_of_accounts')).rows;
      dbAvailable = true;
    }
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.invoiceIds) {
      await pool.query('DELETE FROM customer_invoice_status_history WHERE invoice_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM customer_invoices WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.billIds) {
      await pool.query('DELETE FROM supplier_invoice_status_history WHERE bill_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM supplier_invoice_items WHERE bill_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM supplier_invoices WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.recurringScheduleIds) {
      await pool.query('DELETE FROM recurring_invoice_schedules WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.apiKeyIds) {
      await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.webhookIds) {
      await pool.query('DELETE FROM webhook_delivery_log WHERE subscription_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM webhook_subscriptions WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.approvalRequestIds) {
      await pool.query('DELETE FROM approval_request_steps WHERE request_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM approval_requests WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.approvalTemplateIds) {
      await pool.query('DELETE FROM approval_chain_steps WHERE template_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM approval_chain_templates WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.aiFindingIds) {
      await pool.query('DELETE FROM ai_findings WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.journalEntryIds) {
      await pool.query('DELETE FROM journal_entry_status_history WHERE journal_entry_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entries WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.salesOrderIds) {
      await pool.query('DELETE FROM sales_order_items WHERE sales_order_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM sales_order_status_history WHERE sales_order_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM sales_orders WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.purchaseOrderIds) {
      await pool.query('DELETE FROM purchase_order_line_items WHERE po_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM purchase_orders WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.transferIds) {
      await pool.query('DELETE FROM inventory_transfers WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.storageLocationIds) {
      await pool.query('DELETE FROM inventory_storage_mappings WHERE storage_location_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM storage_locations WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.inventoryItemIds) {
      await pool.query('DELETE FROM inventory_items WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.requisitionIds) {
      await pool.query('DELETE FROM purchase_requisitions WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.customerPaymentIds) {
      await pool.query('DELETE FROM customer_payments WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.bankAccountIds) {
      await pool.query('DELETE FROM bank_transactions WHERE bank_account_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM bank_accounts WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.warehouseTransactionIds) {
      await pool.query('DELETE FROM warehouse_transaction_audit_log WHERE warehouse_transaction_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM warehouse_transaction_items WHERE warehouse_transaction_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM warehouse_transactions WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.itemIds) {
      await pool.query('DELETE FROM items WHERE id = $1', [id]).catch(() => {});
    }
    // Restore account balances exactly as found.
    if (balanceSnapshot) {
      for (const row of balanceSnapshot) {
        await pool.query('UPDATE chart_of_accounts SET current_balance = $1 WHERE id = $2', [row.current_balance, row.id]).catch(() => {});
      }
    }
  }
  await pool.end().catch(() => {});
});

test('O2C: completing a sales order produces an invoice and a balanced revenue journal entry', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const so = await SalesOrder.create(
    {
      customer_id: customer.id,
      customer_name: customer.customer_name,
      order_date: new Date().toISOString().split('T')[0],
      currency: 'USD',
      subtotal: 1000,
      tax_amount: 0,
      total_amount: 1000,
      reference_number: 'ITEST-O2C',
      notes: 'integration test',
    },
    userId
  );
  created.salesOrderIds.push(so.id);

  // Drive to COMPLETED through the states the state machine actually allows —
  // an order reaches revenue recognition only after it has been confirmed,
  // delivered, and handed to the customer for confirmation. The final step is
  // what auto-creates the customer invoice and posts revenue.
  for (const step of ['CONFIRMED', 'WAITING_CUSTOMER_DELIVERY_CONFIRMATION', 'COMPLETED']) {
    await SalesOrder.updateStatus(so.id, step, userId, 'integration test');
  }

  const inv = await pool.query(
    'SELECT id, journal_entry_id, total_amount FROM customer_invoices WHERE sales_order_id = $1 AND deleted_at IS NULL',
    [so.id]
  );
  assert.equal(inv.rows.length, 1, 'a customer invoice should be created on completion');
  created.invoiceIds.push(inv.rows[0].id);

  const jeId = inv.rows[0].journal_entry_id;
  assert.ok(jeId, 'the invoice must be linked to a revenue journal entry (no silent GL skip)');
  created.journalEntryIds.push(jeId);

  const je = await pool.query('SELECT status, total_debit, total_credit FROM journal_entries WHERE id = $1', [jeId]);
  assert.equal(je.rows.length, 1);
  assert.equal(je.rows[0].status, 'POSTED', 'revenue entry should be posted');
  assert.ok(
    Math.abs(Number(je.rows[0].total_debit) - Number(je.rows[0].total_credit)) < 0.01,
    'the revenue journal entry must balance'
  );
});

test('P2P: a supplier bill can be generated from a completed purchase order', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!completedPo) return t.skip('no completed purchase order in this database');

  // Only clean up a bill if this test created it (createFromPurchaseOrder dedupes).
  const pre = await pool.query('SELECT id FROM supplier_invoices WHERE purchase_order_id = $1 AND deleted_at IS NULL', [completedPo.id]);
  const preExisted = pre.rows.length > 0;

  const bill = await SupplierInvoice.createFromPurchaseOrder(completedPo.id, {}, userId);

  assert.ok(bill, 'a bill should be returned');
  assert.equal(bill.purchase_order_id, completedPo.id, 'bill must link back to the PO (audit B5 column)');
  assert.match(bill.bill_number, /^BILL-\d{4}-\d{6}$/, 'a bill number should be generated');

  if (!preExisted) {
    created.billIds.push(bill.id);
    // GR/IR model: the invoice is the AP recognition point — it must post a
    // balanced entry crediting Accounts Payable.
    assert.ok(bill.journal_entry_id, 'supplier invoice must post an AP journal entry');
    created.journalEntryIds.push(bill.journal_entry_id);
    const je = await pool.query('SELECT status, total_debit, total_credit FROM journal_entries WHERE id = $1', [bill.journal_entry_id]);
    assert.equal(je.rows[0].status, 'POSTED');
    assert.ok(
      Math.abs(Number(je.rows[0].total_debit) - Number(je.rows[0].total_credit)) < 0.01,
      'the AP journal entry must balance'
    );
  }
});

test('P2P: completing a purchase order does NOT post AP (GR/IR model)', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!supplier) return t.skip('no supplier in this database');

  const poNo = `ITEST-PO-${Date.now()}`;
  const poRow = await pool.query(
    `INSERT INTO purchase_orders (po_number, supplier_id, status, subtotal, tax_amount, total_amount, created_by)
     VALUES ($1, $2, 'APPROVED', 500, 0, 500, $3) RETURNING id`,
    [poNo, supplier.id, userId]
  );
  const poId = poRow.rows[0].id;
  created.purchaseOrderIds.push(poId);

  await PurchaseOrder.updateStatus(poId, 'COMPLETED', userId, 'integration test');

  // Under GR/IR, completion is a status change only — inventory posts at receipt,
  // AP posts at the supplier invoice. No journal entry should exist yet.
  const je = await pool.query(
    "SELECT id FROM journal_entries WHERE source_type = 'PURCHASE_ORDER' AND source_id = $1 AND deleted_at IS NULL",
    [poId]
  );
  assert.equal(je.rows.length, 0, 'PO completion must not post a journal entry under GR/IR');
});

test('P2P: a goods receipt posts Dr Inventory / Cr GR/IR', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!supplier) return t.skip('no supplier in this database');

  // Seed a PO + one line item (item_id null → skip per-unit inventory creation).
  const poNo = `ITEST-GR-${Date.now()}`;
  const poRow = await pool.query(
    `INSERT INTO purchase_orders (po_number, supplier_id, status, subtotal, tax_amount, total_amount, created_by)
     VALUES ($1, $2, 'APPROVED', 50, 0, 50, $3) RETURNING id`,
    [poNo, supplier.id, userId]
  );
  const poId = poRow.rows[0].id;
  created.purchaseOrderIds.push(poId);

  const liRow = await pool.query(
    `INSERT INTO purchase_order_line_items (po_id, item_description, quantity, unit_price, quantity_received)
     VALUES ($1, 'GR test line', 5, 10, 0) RETURNING id`,
    [poId]
  );
  const lineItemId = liRow.rows[0].id;

  const GoodsReceiptService = require('../services/goodsReceiptService');
  await GoodsReceiptService.receiveGoods(
    { po_id: poId, line_item_id: lineItemId, quantity_received: 5 },
    userId
  );

  // Should post Dr Inventory (1130) 50 / Cr GR/IR (2115) 50.
  const je = await pool.query(
    "SELECT id, status, total_debit, total_credit FROM journal_entries WHERE source_type = 'GOODS_RECEIPT' AND reference = $1 AND deleted_at IS NULL",
    [poNo]
  );
  assert.equal(je.rows.length, 1, 'goods receipt must post one GR/IR journal entry');
  created.journalEntryIds.push(je.rows[0].id);
  assert.equal(je.rows[0].status, 'POSTED');
  assert.equal(Number(je.rows[0].total_debit), 50);
  assert.equal(Number(je.rows[0].total_credit), 50);

  // Cleanup the goods_receipts + line item rows created by the service.
  await pool.query('DELETE FROM goods_receipts WHERE po_id = $1', [poId]).catch(() => {});
  await pool.query('DELETE FROM purchase_order_line_items WHERE id = $1', [lineItemId]).catch(() => {});
});

test('Credit control: approving an order over the customer credit limit is blocked', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  // Temporarily give the test customer a tiny credit limit, then restore it.
  const snap = await pool.query('SELECT credit_limit, current_balance FROM customers WHERE id = $1', [customer.id]);
  await pool.query('UPDATE customers SET credit_limit = 1, current_balance = 0 WHERE id = $1', [customer.id]);

  try {
    const so = await SalesOrder.create(
      { customer_id: customer.id, customer_name: customer.customer_name, subtotal: 500, total_amount: 500, reference_number: 'ITEST-CREDIT' },
      userId
    );
    created.salesOrderIds.push(so.id);
    await pool.query("UPDATE sales_orders SET status = 'PENDING_APPROVAL' WHERE id = $1", [so.id]);

    await assert.rejects(
      () => SalesOrder.approveOrder(so.id, userId, 'integration test'),
      /credit limit exceeded/i,
      'approval must be blocked when the order exceeds the credit limit'
    );
  } finally {
    await pool.query('UPDATE customers SET credit_limit = $1, current_balance = $2 WHERE id = $3', [
      snap.rows[0].credit_limit, snap.rows[0].current_balance, customer.id,
    ]);
  }
});

test('Inventory: a goods issue posts COGS at weighted-average cost', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  // Seed a throwaway item master (unique per test to avoid the per-user constraint).
  const itemId = randomUUID();
  const tag = `ITEST-${Date.now()}`;
  await pool.query(
    `INSERT INTO items (id, item_code, name, stock_code, status) VALUES ($1, $2, $3, 'ST1', 'APPROVED')`,
    [itemId, tag, `COGS test item ${tag}`]
  );
  created.itemIds.push(itemId);

  // Seed an inventory item: 10 units @ moving-average cost 25.
  const invId = randomUUID();
  await pool.query(
    `INSERT INTO inventory_items (id, item_master_id, current_stock_quantity, unit_price, currency, status, user_id)
     VALUES ($1, $2, 10, 25, 'USD', 'APPROVED', $3)`,
    [invId, itemId, userId]
  );
  created.inventoryItemIds.push(invId);

  // Seed a cost layer so the goods-issue path can consume from it.
  await pool.query(
    `INSERT INTO cost_layers (inventory_item_id, quantity, unit_cost, remaining_quantity, receipt_type)
     VALUES ($1, 10, 25, 10, 'INITIAL')`,
    [invId]
  );

  // Issue 4 units through the real stock-movement path.
  const txnId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await WarehouseTransaction.handleExistingInventory(
      client,
      { inventory_item_id: invId, issued_quantity: 4 },
      'GI',
      txnId,
      userId
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  // Stock should drop to 6.
  const inv = await pool.query('SELECT current_stock_quantity FROM inventory_items WHERE id = $1', [invId]);
  assert.equal(Number(inv.rows[0].current_stock_quantity), 6);

  // A balanced COGS entry of 4 * 25 = 100 should be posted.
  const je = await pool.query(
    "SELECT id, status, total_debit, total_credit FROM journal_entries WHERE source_type = 'GOODS_ISSUE' AND source_id = $1 AND deleted_at IS NULL",
    [txnId]
  );
  assert.equal(je.rows.length, 1, 'goods issue must post a COGS journal entry');
  created.journalEntryIds.push(je.rows[0].id);
  assert.equal(je.rows[0].status, 'POSTED');
  assert.equal(Number(je.rows[0].total_debit), 100);
  assert.equal(Number(je.rows[0].total_credit), 100);
});

test('MRP-lite: reorder check drafts a PR for low stock, then dedupes on re-run', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const { runReorderCheck } = require('../services/reorderService');

  const itemId = randomUUID();
  const tag = `ITEST-REORDER-${Date.now()}`;
  await pool.query(
    `INSERT INTO items (id, item_code, name, stock_code, status) VALUES ($1, $2, $3, 'ST1', 'APPROVED')`,
    [itemId, tag, `Reorder test item ${tag}`]
  );
  created.itemIds.push(itemId);

  const invId = randomUUID();
  await pool.query(
    `INSERT INTO inventory_items (id, item_master_id, current_stock_quantity, reorder_point, maximum_stock_level, unit_price, status, user_id)
     VALUES ($1, $2, 2, 10, 50, 15, 'APPROVED', $3)`,
    [invId, itemId, userId]
  );
  created.inventoryItemIds.push(invId);

  // Dry run should preview the same item without creating anything.
  const dry = await runReorderCheck(userId, { dryRun: true });
  const previewed = dry.created.find((c) => c.item_name === `Reorder test item ${tag}`);
  assert.ok(previewed, 'dry run should preview the low-stock item');
  assert.equal(previewed.quantity, 48); // 50 max - 2 current

  const noPrYet = await pool.query('SELECT id FROM purchase_requisitions WHERE item_id = $1', [itemId]);
  assert.equal(noPrYet.rows.length, 0, 'dry run must not create a PR');

  // Real run creates a DRAFT PR.
  const real = await runReorderCheck(userId, {});
  const madePr = real.created.find((c) => c.item_name === `Reorder test item ${tag}`);
  assert.ok(madePr, 'real run should create a PR for the low-stock item');
  created.requisitionIds.push(madePr.pr_id);

  const pr = await pool.query('SELECT status, quantity, item_id FROM purchase_requisitions WHERE id = $1', [madePr.pr_id]);
  assert.equal(pr.rows[0].status, 'DRAFT', 'reorder PRs must be drafts, not auto-approved');
  assert.equal(Number(pr.rows[0].quantity), 48);

  // Re-running must skip the item (an open PR already exists) — no duplicate.
  const again = await runReorderCheck(userId, {});
  const skippedEntry = again.skipped.find((s) => s.item_name === `Reorder test item ${tag}`);
  assert.ok(skippedEntry, 're-running must skip an item with an already-open PR');
  const dupeCheck = await pool.query('SELECT id FROM purchase_requisitions WHERE item_id = $1', [itemId]);
  assert.equal(dupeCheck.rows.length, 1, 'must not create a second PR for the same item');
});

test('Bank: CSV statement import + auto-reconcile matches a real payment', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const { importStatement } = require('../services/bankStatementImport');
  const BankTransaction = require('../models/BankTransaction');

  const acctId = randomUUID();
  await pool.query(
    `INSERT INTO bank_accounts (id, account_name, bank_name, account_number, currency, opening_balance, status, created_by)
     VALUES ($1, 'ITEST Account', 'ITEST Bank', '999999', 'USD', 0, 'ACTIVE', $2)`,
    [acctId, userId]
  );
  created.bankAccountIds.push(acctId);

  // A real, matchable customer payment dated today.
  const payId = randomUUID();
  const payNo = `ITEST-PAY-${Date.now()}`;
  await pool.query(
    `INSERT INTO customer_payments (id, payment_number, customer_id, payment_method, payment_amount, payment_date, created_by)
     VALUES ($1, $2, $3, 'BANK_TRANSFER', 777.77, CURRENT_DATE, $4)`,
    [payId, payNo, customer.id, userId]
  );
  created.customerPaymentIds.push(payId);

  const today = new Date().toISOString().split('T')[0];
  // Deliberately exercises quoted-comma parsing and a signed Amount column.
  const csv = `Date,Description,Amount\n${today},"ITEST, wire 777.77",777.77\n`;
  const importResult = await importStatement(acctId, csv, userId);
  assert.equal(importResult.imported, 1, 'CSV import should load exactly one line');
  assert.equal(importResult.skipped, 0);

  const before = await BankTransaction.findAll(acctId, { reconciled: false });
  assert.equal(before.length, 1);
  assert.equal(before[0].description, 'ITEST, wire 777.77', 'quoted comma in description must survive CSV parsing');

  const auto = await BankTransaction.autoReconcile(acctId, userId);
  assert.equal(auto.reconciled, 1, 'the unique matching payment must be auto-reconciled');
  assert.equal(auto.ambiguous, 0);
  assert.equal(auto.unmatched, 0);

  const after = await BankTransaction.findAll(acctId, {});
  assert.equal(after[0].is_reconciled, true);
  assert.equal(after[0].matched_type, 'CUSTOMER_PAYMENT');
  assert.equal(after[0].matched_id, payId);
  assert.ok(after[0].reconciled_by, 'reconciled_by must be set (regression check for the uuid/text CASE bug)');
});

test('Stocktake: a stock-adjustment count posts a balanced GL variance and records the real quantity', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const WarehouseTransaction = require('../models/WarehouseTransaction');

  const itemId = randomUUID();
  const tag = `ITEST-STOCKTAKE-${Date.now()}`;
  await pool.query(
    `INSERT INTO items (id, item_code, name, stock_code, status) VALUES ($1, $2, $3, 'ST1', 'APPROVED')`,
    [itemId, tag, `Stocktake test item ${tag}`]
  );
  created.itemIds.push(itemId);

  // 10 units on the books @ moving-average cost 20 = $200 book value.
  const invId = randomUUID();
  await pool.query(
    `INSERT INTO inventory_items (id, item_master_id, current_stock_quantity, unit_price, currency, status, user_id)
     VALUES ($1, $2, 10, 20, 'USD', 'APPROVED', $3)`,
    [invId, itemId, userId]
  );
  created.inventoryItemIds.push(invId);

  // Seed a cost layer so the stocktake path has a cost basis for the variance posting.
  await pool.query(
    `INSERT INTO cost_layers (inventory_item_id, quantity, unit_cost, remaining_quantity, receipt_type)
     VALUES ($1, 10, 20, 10, 'INITIAL')`,
    [invId]
  );

  // Physical count finds 15 — a variance of +5 units, $100 (under the $1000
  // approval threshold, so it should auto-post immediately).
  const txn = await WarehouseTransaction.create(
    { transaction_type: 'SA', created_by: userId, processed_by: userId, notes: 'integration test stocktake' },
    [{ inventory_item_id: invId, item_name: `Stocktake test item ${tag}`, unit_of_measure: 'PCS', physical_quantity: 15, reason_code: 'CYCLE_COUNT' }]
  );
  created.warehouseTransactionIds.push(txn.id);

  // Regression check: the audit-trail item row must record the real counted
  // quantity (15), not 0 — physical_quantity was missing from the quantity
  // fallback chain until this was fixed.
  const itemRow = await pool.query('SELECT quantity, physical_quantity FROM warehouse_transaction_items WHERE warehouse_transaction_id = $1', [txn.id]);
  assert.equal(Number(itemRow.rows[0].quantity), 15, 'the recorded quantity must be the real physical count, not 0');

  const inv = await pool.query('SELECT current_stock_quantity FROM inventory_items WHERE id = $1', [invId]);
  assert.equal(Number(inv.rows[0].current_stock_quantity), 15, 'stock must be updated to the counted quantity');

  const je = await pool.query(
    "SELECT id, status, total_debit, total_credit FROM journal_entries WHERE source_type = 'INVENTORY_ADJUSTMENT' AND source_id = $1 AND deleted_at IS NULL",
    [invId]
  );
  assert.equal(je.rows.length, 1, 'a stocktake variance under the books must post exactly one GL entry');
  created.journalEntryIds.push(je.rows[0].id);
  assert.equal(je.rows[0].status, 'POSTED', 'small variances must auto-post (regression check for the postInventoryAdjustment dead-DRAFT bug)');
  assert.equal(Number(je.rows[0].total_debit), 100);
  assert.equal(Number(je.rows[0].total_credit), 100);
});

test('Inventory transfer: dispatch removes stock from source, receive lands it at destination, cancel returns it', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const InventoryTransfer = require('../models/InventoryTransfer');

  const itemId = randomUUID();
  const tag = `ITEST-XFER-${Date.now()}`;
  await pool.query(
    `INSERT INTO items (id, item_code, name, stock_code, status) VALUES ($1, $2, $3, 'ST1', 'APPROVED')`,
    [itemId, tag, `Transfer test item ${tag}`]
  );
  created.itemIds.push(itemId);

  const invId = randomUUID();
  await pool.query(
    `INSERT INTO inventory_items (id, item_master_id, current_stock_quantity, unit_price, currency, status, user_id)
     VALUES ($1, $2, 20, 10, 'USD', 'APPROVED', $3)`,
    [invId, itemId, userId]
  );
  created.inventoryItemIds.push(invId);

  const locA = randomUUID();
  const locB = randomUUID();
  const suffix = String(Date.now()).slice(-6);
  await pool.query(
    `INSERT INTO storage_locations (id, code, name, country, city, address, postal_code, status, user_id)
     VALUES ($1, $2, 'ITEST Warehouse A', 'US', 'NYC', '1 Main St', '10001', 'ACTIVE', $3)`,
    [locA, `TA${suffix}`, userId]
  );
  await pool.query(
    `INSERT INTO storage_locations (id, code, name, country, city, address, postal_code, status, user_id)
     VALUES ($1, $2, 'ITEST Warehouse B', 'US', 'LA', '2 Elm St', '90001', 'ACTIVE', $3)`,
    [locB, `TB${suffix}`, userId]
  );
  created.storageLocationIds.push(locA, locB);

  await pool.query(
    `INSERT INTO inventory_storage_mappings (inventory_item_id, storage_location_id, quantity_in_location, user_id)
     VALUES ($1, $2, 20, $3)`,
    [invId, locA, userId]
  );

  // Dispatch 8 units A -> B. Stock must leave A immediately and NOT yet exist at B.
  const transfer = await InventoryTransfer.dispatch(
    { inventory_item_id: invId, quantity: 8, source_storage_location_id: locA, destination_storage_location_id: locB },
    userId
  );
  created.transferIds.push(transfer.id);
  assert.equal(transfer.status, 'IN_TRANSIT');

  const midway = await pool.query('SELECT storage_location_id, quantity_in_location FROM inventory_storage_mappings WHERE inventory_item_id = $1', [invId]);
  assert.equal(midway.rows.length, 1, 'while in transit, stock must exist at exactly one location (the source, reduced)');
  assert.equal(midway.rows[0].storage_location_id, locA);
  assert.equal(Number(midway.rows[0].quantity_in_location), 12, 'source must be reduced by the transfer quantity immediately on dispatch');

  // Receive at B.
  const received = await InventoryTransfer.receive(transfer.id, userId);
  assert.equal(received.status, 'RECEIVED');

  const afterReceive = await pool.query(
    'SELECT storage_location_id, quantity_in_location FROM inventory_storage_mappings WHERE inventory_item_id = $1 ORDER BY storage_location_id',
    [invId]
  );
  const atA = afterReceive.rows.find((r) => r.storage_location_id === locA);
  const atB = afterReceive.rows.find((r) => r.storage_location_id === locB);
  assert.equal(Number(atA.quantity_in_location), 12);
  assert.equal(Number(atB.quantity_in_location), 8);

  // A second dispatch, then cancel it — quantity must return to the source.
  const transfer2 = await InventoryTransfer.dispatch(
    { inventory_item_id: invId, quantity: 5, source_storage_location_id: locA, destination_storage_location_id: locB },
    userId
  );
  created.transferIds.push(transfer2.id);
  const cancelled = await InventoryTransfer.cancel(transfer2.id, userId);
  assert.equal(cancelled.status, 'CANCELLED');

  const afterCancel = await pool.query(
    'SELECT storage_location_id, quantity_in_location FROM inventory_storage_mappings WHERE inventory_item_id = $1 ORDER BY storage_location_id',
    [invId]
  );
  const atA2 = afterCancel.rows.find((r) => r.storage_location_id === locA);
  const atB2 = afterCancel.rows.find((r) => r.storage_location_id === locB);
  assert.equal(Number(atA2.quantity_in_location), 12, 'cancelling an in-transit transfer must return the quantity to the source');
  assert.equal(Number(atB2.quantity_in_location), 8, 'destination must be unaffected by a cancelled transfer');
});

test('Recurring invoices: a due schedule generates an invoice, posts revenue, and advances — then dedupes', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const { runDueSchedules } = require('../services/recurringInvoiceService');

  const schedResult = await pool.query(
    `INSERT INTO recurring_invoice_schedules (customer_id, description, amount, tax_amount, frequency, next_run_date, created_by)
     VALUES ($1, 'ITEST monthly retainer', 500, 0, 'MONTHLY', CURRENT_DATE, $2) RETURNING id`,
    [customer.id, userId]
  );
  const scheduleId = schedResult.rows[0].id;
  created.recurringScheduleIds.push(scheduleId);

  const dry = await runDueSchedules(userId, { dryRun: true });
  const previewed = dry.created.find((c) => c.schedule_id === scheduleId);
  assert.ok(previewed, 'dry run should preview the due schedule');

  const noInvoiceYet = await pool.query('SELECT id FROM customer_invoices WHERE recurring_schedule_id = $1', [scheduleId]);
  assert.equal(noInvoiceYet.rows.length, 0, 'dry run must not create an invoice');

  const real = await runDueSchedules(userId, {});
  const made = real.created.find((c) => c.schedule_id === scheduleId);
  assert.ok(made, 'real run should generate an invoice for the due schedule');
  created.invoiceIds.push(made.invoice_id);

  const invoice = await pool.query('SELECT journal_entry_id, total_amount, status FROM customer_invoices WHERE id = $1', [made.invoice_id]);
  assert.equal(invoice.rows[0].status, 'APPROVED');
  assert.equal(Number(invoice.rows[0].total_amount), 500);
  assert.ok(invoice.rows[0].journal_entry_id, 'the recurring invoice must post a revenue journal entry');
  created.journalEntryIds.push(invoice.rows[0].journal_entry_id);

  const je = await pool.query('SELECT status, total_debit, total_credit FROM journal_entries WHERE id = $1', [invoice.rows[0].journal_entry_id]);
  assert.equal(je.rows[0].status, 'POSTED');
  assert.equal(Number(je.rows[0].total_debit), 500);
  assert.equal(Number(je.rows[0].total_credit), 500);

  const schedule = await pool.query('SELECT next_run_date, occurrences_run FROM recurring_invoice_schedules WHERE id = $1', [scheduleId]);
  assert.equal(schedule.rows[0].occurrences_run, 1);
  assert.ok(new Date(schedule.rows[0].next_run_date) > new Date(), 'next_run_date must advance into the future');

  // Re-running the same day must NOT generate a second invoice.
  const again = await runDueSchedules(userId, {});
  const dupe = again.created.find((c) => c.schedule_id === scheduleId);
  assert.ok(!dupe, 're-running after the schedule has advanced must not duplicate the invoice');
});

test('Audit trail: the O2C flow above is visible in the unified activity feed', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (created.salesOrderIds.length === 0) return t.skip('no sales order was created by an earlier test in this run');

  const { getAuditTrail, listEntityTypes } = require('../services/auditTrailService');
  const companyScope = require('../services/companyScope');

  assert.ok(listEntityTypes().includes('SALES_ORDER'));
  assert.ok(listEntityTypes().includes('AI_ACTION'));

  // Required now: every *_status_history source is joined back to its parent
  // record for its company_id (those tables carry none of their own — see
  // auditTrailService.js), so getAuditTrail refuses to run without one.
  const companyId = companyScope.currentCompanyId();
  assert.ok(companyId, 'this suite runs inside runWithCompany (see helpers/withCompany.js) — company_id must be set');

  const soId = created.salesOrderIds[0];
  const history = await getAuditTrail({ entity_type: 'SALES_ORDER', entity_id: soId, limit: 50, company_id: companyId });
  assert.ok(history.length > 0, 'the sales order created earlier in this suite must appear in its own audit trail');
  assert.ok(history.every((h) => h.entity_type === 'SALES_ORDER' && h.entity_id === soId));

  // Unfiltered (global) query must include multiple entity types, not just one table.
  const global = await getAuditTrail({ limit: 100, company_id: companyId });
  const distinctTypes = new Set(global.map((g) => g.entity_type));
  assert.ok(distinctTypes.size >= 2, 'the unified feed must span more than one entity type');
});

test('API keys: a valid key authenticates, a revoked key does not', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const ApiKey = require('../models/ApiKey');
  const { auth } = require('../middleware/auth');

  const created = await ApiKey.create({ name: 'ITEST integration key', scopes: ['read'], role: 'MANAGER' }, userId);
  const apiKeyId = created.id;

  const makeReq = (key) => ({ header: (name) => (name === 'X-API-Key' ? key : undefined) });
  const makeRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; };
    return res;
  };

  let nextCalled = false;
  const res1 = makeRes();
  await auth(makeReq(created.key), res1, () => { nextCalled = true; });
  assert.ok(nextCalled, 'a valid API key must authenticate');
  assert.equal(res1.statusCode, null, 'a valid API key must not produce an error response');

  const res2 = makeRes();
  let nextCalled2 = false;
  await auth(makeReq('qira_' + '0'.repeat(64)), res2, () => { nextCalled2 = true; });
  assert.equal(nextCalled2, false, 'a bogus key must not authenticate');
  assert.equal(res2.statusCode, 401);

  await ApiKey.revoke(apiKeyId);
  const res3 = makeRes();
  let nextCalled3 = false;
  await auth(makeReq(created.key), res3, () => { nextCalled3 = true; });
  assert.equal(nextCalled3, false, 'a revoked key must stop authenticating');
  assert.equal(res3.statusCode, 401);

  // Cleanup: revoke() already ran; just delete the row.
  await pool.query('DELETE FROM api_keys WHERE id = $1', [apiKeyId]);
});

test('Webhooks: emit() delivers a signed payload to a subscribed endpoint and logs it', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const http = require('node:http');
  const { emit, sign } = require('../services/webhookService');

  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received = { signature: req.headers['x-webhook-signature'], event: req.headers['x-webhook-event'], body: JSON.parse(body) };
      res.writeHead(200); res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const secret = 'itest-webhook-secret';
  const sub = await pool.query(
    `INSERT INTO webhook_subscriptions (url, event_types, secret, created_by) VALUES ($1, ARRAY['journal_entry.posted'], $2, $3) RETURNING id`,
    [`http://127.0.0.1:${port}/hook`, secret, userId]
  );
  created.webhookIds.push(sub.rows[0].id);

  await emit('journal_entry.posted', { id: 'itest-je', journal_number: 'JE-ITEST-001' });
  await new Promise((resolve) => setTimeout(resolve, 500)); // let the fire-and-forget delivery complete

  server.close();

  assert.ok(received, 'the subscribed endpoint must receive the webhook');
  assert.equal(received.event, 'journal_entry.posted');
  assert.equal(received.body.data.journal_number, 'JE-ITEST-001');
  const expectedSignature = sign(secret, JSON.stringify(received.body));
  assert.equal(received.signature, expectedSignature, 'the HMAC signature must verify against the shared secret');

  const log = await pool.query('SELECT response_status FROM webhook_delivery_log WHERE subscription_id = $1', [sub.rows[0].id]);
  assert.equal(log.rows.length, 1, 'the delivery must be logged');
  assert.equal(log.rows[0].response_status, 200);
});

test('Auto-invoice on delivery: a sales order completes (and invoices) only once every shipment is delivered', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const DeliverySchedule = require('../models/DeliverySchedule');

  const so = await SalesOrder.create(
    { customer_id: customer.id, customer_name: customer.customer_name, subtotal: 300, tax_amount: 0, total_amount: 300, reference_number: 'ITEST-PARTIAL-DELIVERY' },
    userId
  );
  created.salesOrderIds.push(so.id);
  await SalesOrder.updateStatus(so.id, 'CONFIRMED', userId, 'integration test');

  const ds1 = randomUUID();
  const ds2 = randomUUID();
  for (const dsId of [ds1, ds2]) {
    await pool.query(
      `INSERT INTO delivery_schedules (id, schedule_number, sales_order_id, sales_order_number, customer_id, customer_name, delivery_date, delivery_address, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,'ITEST address','SCHEDULED',$7)`,
      [dsId, `ITEST-DS-${dsId.slice(0, 8)}`, so.id, so.so_number, customer.id, customer.customer_name, userId]
    );
  }
  // First shipment delivered — order must NOT complete yet (second shipment pending).
  await DeliverySchedule.updateStatus(ds1, 'DELIVERED', userId, 'integration test - first shipment');
  const mid = await pool.query('SELECT status FROM sales_orders WHERE id = $1', [so.id]);
  assert.notEqual(mid.rows[0].status, 'COMPLETED', 'must not auto-complete while a shipment is still outstanding');

  // Second (final) shipment delivered — the order now advances to await the
  // customer's confirmation. It deliberately does NOT invoice yet: the warehouse
  // marking a shipment delivered is not the customer confirming receipt, and
  // COMPLETED is what raises the invoice (see DeliverySchedule.updateStatus).
  await DeliverySchedule.updateStatus(ds2, 'DELIVERED', userId, 'integration test - second shipment');
  const awaiting = await pool.query('SELECT status FROM sales_orders WHERE id = $1', [so.id]);
  assert.equal(
    awaiting.rows[0].status,
    'WAITING_CUSTOMER_DELIVERY_CONFIRMATION',
    'the final delivery must hand the order to the customer-confirmation step'
  );
  assert.equal(
    (await pool.query('SELECT COUNT(*)::int AS n FROM customer_invoices WHERE sales_order_id = $1', [so.id])).rows[0].n,
    0,
    'no invoice may be raised before the customer confirms delivery'
  );

  // Customer confirms receipt (what routes/customers.js does with the delivery
  // token) — NOW it must complete and invoice.
  await SalesOrder.updateStatus(so.id, 'COMPLETED', userId, 'integration test - customer confirmed delivery');
  const done = await pool.query('SELECT status FROM sales_orders WHERE id = $1', [so.id]);
  assert.equal(done.rows[0].status, 'COMPLETED', 'must complete once the customer confirms every delivery');

  const inv = await pool.query('SELECT id, journal_entry_id FROM customer_invoices WHERE sales_order_id = $1', [so.id]);
  assert.equal(inv.rows.length, 1, 'auto-completion must generate exactly one invoice');
  created.invoiceIds.push(inv.rows[0].id);
  assert.ok(inv.rows[0].journal_entry_id);
  created.journalEntryIds.push(inv.rows[0].journal_entry_id);

  await pool.query('DELETE FROM delivery_status_history WHERE delivery_schedule_id = ANY($1)', [[ds1, ds2]]);
  await pool.query('DELETE FROM delivery_schedules WHERE id = ANY($1)', [[ds1, ds2]]);
});

test('Approval chains: an escalating request requires sequential approvals; a small one needs only the first step', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const ApprovalChain = require('../models/ApprovalChain');

  const template = await ApprovalChain.createTemplate(
    {
      name: `ITEST Escalation ${Date.now()}`,
      document_type: 'PURCHASE_ORDER',
      steps: [
        { min_amount: 0, approver_role: 'MANAGER' },
        { min_amount: 5000, approver_role: 'ADMIN' },
      ],
    },
    userId
  );
  created.approvalTemplateIds.push(template.id);

  // Small request: only step 1 (MANAGER) applies.
  const smallReq = await ApprovalChain.startRequest(
    { template_id: template.id, document_type: 'PURCHASE_ORDER', document_id: randomUUID(), amount: 300 },
    userId
  );
  created.approvalRequestIds.push(smallReq.id);
  assert.equal(smallReq.steps.length, 1, 'a $300 request should only need the $0-band step');

  // Large request: both steps apply, sequentially.
  const bigReq = await ApprovalChain.startRequest(
    { template_id: template.id, document_type: 'PURCHASE_ORDER', document_id: randomUUID(), amount: 6000 },
    userId
  );
  created.approvalRequestIds.push(bigReq.id);
  assert.equal(bigReq.steps.length, 2, 'a $6000 request should need both escalation steps');
  assert.equal(bigReq.current_step, 1);

  // A USER-role decider must be rejected for a MANAGER-gated step. This has to
  // be attempted by somebody OTHER than the suite's actor: that actor is the
  // platform owner, who may decide any step by design (ApprovalChain.decide's
  // ownerOverride), so the role gate would never be reached.
  const outsider = await pool.query(
    `SELECT id FROM users
      WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true
        AND id <> $1 AND COALESCE(is_platform_owner, false) = false
      LIMIT 1`,
    [userId]
  );
  if (outsider.rows.length) {
    await assert.rejects(
      () => ApprovalChain.decide(bigReq.id, outsider.rows[0].id, 'USER', 'APPROVE', 'unauthorized attempt'),
      /not authorized/i
    );
  }

  // MANAGER approves step 1 -> advances to step 2, still PENDING overall.
  const afterStep1 = await ApprovalChain.decide(bigReq.id, userId, 'MANAGER', 'APPROVE', 'step 1 ok');
  assert.equal(afterStep1.current_step, 2);
  assert.equal(afterStep1.status, 'PENDING');

  // ADMIN approves step 2 -> the whole request completes.
  const afterStep2 = await ApprovalChain.decide(bigReq.id, userId, 'ADMIN', 'APPROVE', 'step 2 ok');
  assert.equal(afterStep2.status, 'APPROVED');

  // The small (single-step) request: rejecting step 1 must reject the whole request.
  const rejected = await ApprovalChain.decide(smallReq.id, userId, 'MANAGER', 'REJECT', 'not needed');
  assert.equal(rejected.status, 'REJECTED');
  assert.ok(rejected.steps.every((s) => s.status === 'REJECTED' || s.status === 'SKIPPED'));
});

test('AI findings: a duplicate invoice is detected, notifies a manager, and dedupes on re-run', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const { runFindingsScan } = require('../services/ai/findingsScan');

  const mgr = await pool.query("SELECT id FROM users WHERE role IN ('MANAGER','ADMIN') LIMIT 1");
  if (mgr.rows.length === 0) return t.skip('no manager/admin user to notify');
  const managerId = mgr.rows[0].id;

  const id1 = randomUUID();
  const id2 = randomUUID();
  // A precise, unlikely-to-collide amount (cents included) — the duplicate-
  // match query requires an EXACT amount match, so any pre-existing invoice
  // sharing this exact value for this exact customer would inflate the count.
  const amount = 888.17 + Math.floor(Math.random() * 10000) / 100;
  await pool.query(
    `INSERT INTO customer_invoices (id, invoice_number, customer_id, invoice_date, due_date, subtotal, tax_amount, total_amount, status, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE + 30, $4, 0, $4, 'APPROVED', $5)`,
    [id1, `ITEST-DUP-A-${Date.now()}`, customer.id, amount, userId]
  );
  await pool.query(
    `INSERT INTO customer_invoices (id, invoice_number, customer_id, invoice_date, due_date, subtotal, tax_amount, total_amount, status, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE + 30, $4, 0, $4, 'APPROVED', $5)`,
    [id2, `ITEST-DUP-B-${Date.now()}`, customer.id, amount, userId]
  );
  created.invoiceIds.push(id1, id2);

  const notifBefore = await pool.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1', [managerId]);

  // NOTE: this asserts against findings for OUR specific seeded pair (by
  // entity_id), not the scan's global new-finding count — the shared test
  // `customer` accumulates invoices from other tests in this suite, and any
  // coincidental exact-amount match elsewhere would otherwise make this flaky.
  await runFindingsScan();
  const findingRows = await pool.query(
    `SELECT id, finding_type, severity, status FROM ai_findings WHERE finding_type = 'DUPLICATE_INVOICE' AND entity_id = ANY($1)`,
    [[id1, id2]]
  );
  assert.equal(findingRows.rows.length, 1, 'the scan must detect the seeded duplicate pair exactly once');
  created.aiFindingIds.push(findingRows.rows[0].id);
  assert.equal(findingRows.rows[0].severity, 'HIGH');
  assert.equal(findingRows.rows[0].status, 'OPEN');

  const notifAfter = await pool.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1', [managerId]);
  assert.ok(notifAfter.rows[0].n > notifBefore.rows[0].n, 'a manager must be notified of the HIGH-severity finding (regression check for the lowercase-role bug in createForManagers)');

  // Re-running must not create a second finding for the same duplicate pair.
  await runFindingsScan();
  const again = await pool.query(
    `SELECT id FROM ai_findings WHERE finding_type = 'DUPLICATE_INVOICE' AND entity_id = ANY($1)`,
    [[id1, id2]]
  );
  assert.equal(again.rows.length, 1, 're-running must dedupe against the already-open finding, not create a second one');
});
