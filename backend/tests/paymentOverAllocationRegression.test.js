// Regression test for a cross-module money-chain gap: neither
// SupplierPayment.create() nor CustomerPayment.create() checked a single
// allocation against the bill/invoice's OWN outstanding balance — only that
// the SUM of all allocations in the request didn't exceed the payment's own
// total. A single allocation could therefore overpay one bill/invoice by any
// amount, driving its outstanding_amount (GENERATED ALWAYS AS total_amount -
// paid_amount) negative and silently marking it PAID despite the excess, with
// no vendor-credit/customer-credit tracking to represent the overage.
//
// Live-verified before the fix: a $100 supplier bill accepted a $150
// allocation, leaving paid_amount=150, outstanding_amount=-50, status=PAID.
// Same reproduction on the customer side with CustomerPayment.create().
//
// This file asserts both models now reject an over-allocating payment
// (leaving the bill/invoice completely unchanged — no partial state), while
// legitimate partial-then-full payment sequences still work exactly as
// before.
//
// Real-DB suite: self-skips when no database is reachable, following the
// established pattern in tests/grRegression.test.js. Run on its own (it
// opens a pg pool and must not race other suites):
//   cd backend && node --test tests/paymentOverAllocationRegression.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const SupplierPayment = require('../models/SupplierPayment');
const CustomerPayment = require('../models/CustomerPayment');

let dbAvailable = false;
let userId = null;
let supplier = null;
let customer = null;
let balanceSnapshot = null;
let actorIsPlatformOwner = false;

const created = { billIds: [], invoiceIds: [], supplierPaymentIds: [], customerPaymentIds: [], journalEntryIds: [] };

before(async () => {
  try {
    await pool.query('SELECT 1');
    const suppliers = await pool.query('SELECT id FROM suppliers LIMIT 1');
    const customers = await pool.query('SELECT id FROM customers WHERE deleted_at IS NULL LIMIT 1');
    const ownerEmail = (process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
    let actorRow = null;
    if (ownerEmail) {
      const r = await pool.query(
        'SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL AND COALESCE(is_active, true) = true LIMIT 1',
        [ownerEmail]
      );
      actorRow = r.rows[0] || null;
      if (actorRow) actorIsPlatformOwner = true;
    }
    if (!actorRow) {
      const r = await pool.query(
        'SELECT id FROM users WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true AND is_platform_owner = true LIMIT 1'
      );
      actorRow = r.rows[0] || null;
      if (actorRow) actorIsPlatformOwner = true;
    }
    if (!actorRow) {
      const r = await pool.query(
        'SELECT id FROM users WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true ORDER BY created_at LIMIT 1'
      );
      actorRow = r.rows[0] || null;
    }
    if (actorRow && suppliers.rows.length && customers.rows.length) {
      userId = actorRow.id;
      supplier = suppliers.rows[0];
      customer = customers.rows[0];
      balanceSnapshot = (await pool.query('SELECT id, current_balance FROM chart_of_accounts')).rows;
      dbAvailable = true;
    }
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.supplierPaymentIds) {
      await pool.query('DELETE FROM supplier_payment_allocations WHERE payment_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM supplier_payment_status_history WHERE payment_id = $1', [id]).catch(() => {});
      await pool.query('UPDATE supplier_payments SET journal_entry_id = NULL WHERE id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM supplier_payments WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.customerPaymentIds) {
      await pool.query('DELETE FROM customer_payment_allocations WHERE payment_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM customer_payment_status_history WHERE payment_id = $1', [id]).catch(() => {});
      await pool.query('UPDATE customer_payments SET journal_entry_id = NULL WHERE id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM customer_payments WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.journalEntryIds) {
      await pool.query('DELETE FROM journal_entry_status_history WHERE journal_entry_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entries WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.billIds) {
      await pool.query('DELETE FROM supplier_invoice_status_history WHERE bill_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM supplier_invoices WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.invoiceIds) {
      await pool.query('DELETE FROM customer_invoice_status_history WHERE invoice_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM customer_invoices WHERE id = $1', [id]).catch(() => {});
    }
    if (balanceSnapshot) {
      for (const row of balanceSnapshot) {
        await pool.query('UPDATE chart_of_accounts SET current_balance = $1 WHERE id = $2',
          [row.current_balance, row.id]).catch(() => {});
      }
    }
  }
  await pool.end().catch(() => {});
});

async function seedBill(total) {
  const billId = randomUUID();
  const billNo = `PAYOVER-BILL-${randomUUID()}`;
  await pool.query(
    `INSERT INTO supplier_invoices (id, bill_number, supplier_id, invoice_date, due_date, total_amount, tax_amount, paid_amount, currency, status, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE, $4, 0, 0, 'USD', 'APPROVED', $5)`,
    [billId, billNo, supplier.id, total, userId]
  );
  created.billIds.push(billId);
  return billId;
}

async function seedInvoice(total) {
  const invId = randomUUID();
  const invNo = `PAYOVER-INV-${randomUUID()}`;
  await pool.query(
    `INSERT INTO customer_invoices (id, invoice_number, customer_id, invoice_date, due_date, subtotal, tax_amount, total_amount, paid_amount, status, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE, $4, 0, $4, 0, 'APPROVED', $5)`,
    [invId, invNo, customer.id, total, userId]
  );
  created.invoiceIds.push(invId);
  return invId;
}

test('SupplierPayment: an allocation exceeding a bill\'s outstanding balance is rejected, leaving the bill unchanged', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!actorIsPlatformOwner) return t.skip('no platform-owner user in this DB: the payment self-posts its journal entry, which SoD blocks for non-owner actors');

  const billId = await seedBill(100);

  await assert.rejects(
    () => SupplierPayment.create(
      { supplier_id: supplier.id, payment_amount: 150, payment_method: 'BANK_TRANSFER', currency: 'USD' },
      [{ bill_id: billId, allocation_amount: 150 }],
      userId
    ),
    /exceeds bill .* outstanding balance/,
    'a $150 allocation against a $100 bill must be refused'
  );

  const bill = await pool.query('SELECT paid_amount, outstanding_amount, status FROM supplier_invoices WHERE id = $1', [billId]);
  assert.equal(Number(bill.rows[0].paid_amount), 0, 'a rejected overpayment must leave paid_amount untouched');
  assert.equal(Number(bill.rows[0].outstanding_amount), 100, 'outstanding_amount must never go negative from a rejected allocation');
  assert.equal(bill.rows[0].status, 'APPROVED', 'the bill must not be marked PAID by a rejected overpayment');

  const orphanPayments = await pool.query('SELECT id FROM supplier_payments WHERE payment_amount = 150 AND supplier_id = $1', [supplier.id]);
  assert.equal(orphanPayments.rows.length, 0, 'a rejected payment must roll back completely — no orphan supplier_payments row');
});

test('SupplierPayment: partial-then-full payment of the same bill still works exactly as before', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!actorIsPlatformOwner) return t.skip('no platform-owner user in this DB: the payment self-posts its journal entry, which SoD blocks for non-owner actors');

  const billId = await seedBill(100);

  const p1 = await SupplierPayment.create(
    { supplier_id: supplier.id, payment_amount: 60, payment_method: 'BANK_TRANSFER', currency: 'USD' },
    [{ bill_id: billId, allocation_amount: 60 }], userId
  );
  created.supplierPaymentIds.push(p1.id);
  if (p1.journal_entry_id) created.journalEntryIds.push(p1.journal_entry_id);

  const mid = await pool.query('SELECT paid_amount, outstanding_amount, status FROM supplier_invoices WHERE id = $1', [billId]);
  assert.equal(Number(mid.rows[0].paid_amount), 60);
  assert.equal(Number(mid.rows[0].outstanding_amount), 40);
  assert.equal(mid.rows[0].status, 'PARTIALLY_PAID');

  const p2 = await SupplierPayment.create(
    { supplier_id: supplier.id, payment_amount: 40, payment_method: 'BANK_TRANSFER', currency: 'USD' },
    [{ bill_id: billId, allocation_amount: 40 }], userId
  );
  created.supplierPaymentIds.push(p2.id);
  if (p2.journal_entry_id) created.journalEntryIds.push(p2.journal_entry_id);

  const fin = await pool.query('SELECT paid_amount, outstanding_amount, status FROM supplier_invoices WHERE id = $1', [billId]);
  assert.equal(Number(fin.rows[0].paid_amount), 100);
  assert.equal(Number(fin.rows[0].outstanding_amount), 0);
  assert.equal(fin.rows[0].status, 'PAID');
});

test('CustomerPayment: an allocation exceeding an invoice\'s outstanding balance is rejected, leaving the invoice unchanged', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!actorIsPlatformOwner) return t.skip('no platform-owner user in this DB: the payment self-posts its journal entry, which SoD blocks for non-owner actors');

  const invId = await seedInvoice(100);

  await assert.rejects(
    () => CustomerPayment.create(
      { customer_id: customer.id, payment_amount: 150, payment_method: 'BANK_TRANSFER', currency: 'USD' },
      [{ invoice_id: invId, allocation_amount: 150 }],
      userId
    ),
    /exceeds invoice .* outstanding balance/,
    'a $150 allocation against a $100 invoice must be refused'
  );

  const inv = await pool.query('SELECT paid_amount, outstanding_amount, status FROM customer_invoices WHERE id = $1', [invId]);
  assert.equal(Number(inv.rows[0].paid_amount), 0);
  assert.equal(Number(inv.rows[0].outstanding_amount), 100, 'outstanding_amount must never go negative from a rejected allocation');
  assert.equal(inv.rows[0].status, 'APPROVED');
});

test('CustomerPayment: partial-then-full payment of the same invoice still works exactly as before', async (t) => {
  if (!dbAvailable) return t.skip('no database available');
  if (!actorIsPlatformOwner) return t.skip('no platform-owner user in this DB: the payment self-posts its journal entry, which SoD blocks for non-owner actors');

  const invId = await seedInvoice(100);

  const p1 = await CustomerPayment.create(
    { customer_id: customer.id, payment_amount: 60, payment_method: 'BANK_TRANSFER', currency: 'USD' },
    [{ invoice_id: invId, allocation_amount: 60 }], userId
  );
  created.customerPaymentIds.push(p1.id);
  if (p1.journal_entry_id) created.journalEntryIds.push(p1.journal_entry_id);

  const mid = await pool.query('SELECT paid_amount, outstanding_amount, status FROM customer_invoices WHERE id = $1', [invId]);
  assert.equal(Number(mid.rows[0].paid_amount), 60);
  assert.equal(mid.rows[0].status, 'PARTIALLY_PAID');

  const p2 = await CustomerPayment.create(
    { customer_id: customer.id, payment_amount: 40, payment_method: 'BANK_TRANSFER', currency: 'USD' },
    [{ invoice_id: invId, allocation_amount: 40 }], userId
  );
  created.customerPaymentIds.push(p2.id);
  if (p2.journal_entry_id) created.journalEntryIds.push(p2.journal_entry_id);

  const fin = await pool.query('SELECT paid_amount, outstanding_amount, status FROM customer_invoices WHERE id = $1', [invId]);
  assert.equal(Number(fin.rows[0].paid_amount), 100);
  assert.equal(Number(fin.rows[0].outstanding_amount), 0);
  assert.equal(fin.rows[0].status, 'PAID');
});
