// Regression test for the dunning credit-hold trigger
// (PHASE3_TEN_TENTHS_PROMPT.md CRM item 3, "dunning depth ... credit-hold
// trigger"):
//
//   dunningService.runDunning escalated overdue invoices by email only —
//   nothing connected a severely delinquent customer to a block on new
//   orders. customers.credit_hold (migration 202608140300) plus
//   dunningService.syncCreditHolds now puts a customer on hold the moment
//   one of their invoices reaches FINAL_NOTICE (46+ days overdue), clears it
//   automatically once no FINAL_NOTICE invoice remains, and
//   SalesOrder.approveOrder refuses to approve a new order for a customer on
//   hold — independent of, and checked before, the numeric credit-limit gate.
//
// Run on its own:  node --test --test-concurrency=1 tests/dunningCreditHold.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const companyContext = require('../services/companyContext');
const dunningService = require('../services/dunningService');
const SalesOrder = require('../models/SalesOrder');

let dbAvailable = false;
let userId = null;
let companyId = null;
const created = { customerIds: [], invoiceIds: [], orderIds: [] };

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!users.rows.length) throw new Error('no users');
    userId = users.rows[0].id;
    companyId = await companyContext.getDefaultCompanyId();
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.orderIds) {
      await pool.query('DELETE FROM sales_order_items WHERE sales_order_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM sales_orders WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.invoiceIds) {
      await pool.query('DELETE FROM customer_invoices WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.customerIds) {
      await pool.query('DELETE FROM customers WHERE id = $1', [id]).catch(() => {});
    }
  }
  await pool.end().catch(() => {});
});

async function makeCustomer(overrides = {}) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customers (id, customer_code, customer_name, primary_email, credit_limit, created_by, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, `CUST-${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`,
     overrides.customer_name || 'Dunning Credit Hold Test Co', overrides.primary_email || null,
     overrides.credit_limit || 0, userId, companyId]
  );
  created.customerIds.push(id);
  return id;
}

async function makeOverdueInvoice(customerId, daysOverdue) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices
       (id, invoice_number, customer_id, invoice_date, due_date, currency, subtotal, tax_amount, total_amount, paid_amount, status, created_by, company_id)
     VALUES ($1,$2,$3,CURRENT_DATE - ($4 || ' days')::interval, CURRENT_DATE - ($4 || ' days')::interval, 'USD', 500, 0, 500, 0, 'APPROVED', $5, $6)`,
    [id, `DCH-INV-${randomUUID().slice(0, 8)}`, customerId, String(daysOverdue), userId, companyId]
  );
  created.invoiceIds.push(id);
  return id;
}

test('a customer with an invoice at FINAL_NOTICE (46+ days overdue) is put on credit hold by runDunning', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const customerId = await makeCustomer();
  await makeOverdueInvoice(customerId, 60); // FINAL_NOTICE range (46+)

  await dunningService.runDunning({ dryRun: false }, companyId);

  const { rows: [cust] } = await pool.query('SELECT credit_hold, credit_hold_reason FROM customers WHERE id = $1', [customerId]);
  assert.equal(cust.credit_hold, true);
  assert.match(cust.credit_hold_reason, /FINAL_NOTICE/);
});

test('a customer only at REMINDER/OVERDUE_NOTICE level is not put on hold', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const customerId = await makeCustomer();
  await makeOverdueInvoice(customerId, 10); // REMINDER range

  await dunningService.runDunning({ dryRun: false }, companyId);

  const { rows: [cust] } = await pool.query('SELECT credit_hold FROM customers WHERE id = $1', [customerId]);
  assert.equal(cust.credit_hold, false);
});

test('credit hold is released once the customer no longer has a FINAL_NOTICE invoice', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const customerId = await makeCustomer();
  const invoiceId = await makeOverdueInvoice(customerId, 60);
  await dunningService.runDunning({ dryRun: false }, companyId);
  let { rows: [cust] } = await pool.query('SELECT credit_hold FROM customers WHERE id = $1', [customerId]);
  assert.equal(cust.credit_hold, true);

  // Pay it off, so it drops out of the overdue query entirely.
  await pool.query('UPDATE customer_invoices SET paid_amount = total_amount WHERE id = $1', [invoiceId]);

  await dunningService.runDunning({ dryRun: false }, companyId);
  ({ rows: [cust] } = await pool.query('SELECT credit_hold, credit_hold_reason FROM customers WHERE id = $1', [customerId]));
  assert.equal(cust.credit_hold, false);
  assert.equal(cust.credit_hold_reason, null);
});

test('a dry run never sets or releases a credit hold', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const customerId = await makeCustomer();
  await makeOverdueInvoice(customerId, 60);
  const result = await dunningService.runDunning({ dryRun: true }, companyId);
  assert.deepEqual(result.credit_holds_set, []);

  const { rows: [cust] } = await pool.query('SELECT credit_hold FROM customers WHERE id = $1', [customerId]);
  assert.equal(cust.credit_hold, false);
});

test('SalesOrder.approveOrder refuses to approve a new order for a customer on credit hold, independent of credit limit', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const customerId = await makeCustomer({ credit_limit: 0 }); // no numeric limit set — would otherwise sail through
  await pool.query(
    `UPDATE customers SET credit_hold = true, credit_hold_reason = 'Dunning: invoice(s) at FINAL_NOTICE (46+ days overdue)', credit_hold_set_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [customerId]
  );

  const orderId = randomUUID();
  await pool.query(
    `INSERT INTO sales_orders (id, so_number, customer_id, customer_name, order_date, currency, status, subtotal, tax_amount, total_amount, created_by, company_id)
     VALUES ($1,$2,$3,$4,CURRENT_DATE,'USD','PENDING_APPROVAL',100,0,100,$5,$6)`,
    [orderId, `DCH-SO-${randomUUID().slice(0, 8)}`, customerId, 'Dunning Credit Hold Test Co', userId, companyId]
  );
  created.orderIds.push(orderId);

  await assert.rejects(
    () => SalesOrder.approveOrder(orderId, userId),
    /on credit hold/
  );
});
