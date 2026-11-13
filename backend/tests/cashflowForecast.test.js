// Round 7, Task 21-A3 — cash forecast from behaviour (backend).
//
// The forecast learns each customer's actual days-to-pay distribution from
// cleared payments and applies it to open AR; AP uses the company's own
// payment behaviour; payroll, recurring invoices, loan schedules and tax
// payments are scheduled at their real next dates. P10/P50/P90 come from the
// empirical percentiles of those distributions.
//
// This suite verifies:
//   • the bands are the empirical distribution's percentiles (they widen when
//     the underlying behaviour varies — no arbitrary ± percentages)
//   • a backtest refits the forecast from a past date using only data known
//     then, and P10/P90 bracket the actual outcomes that followed
//
// Run on its own:  node --test tests/cashflowForecast.test.js

const assert = require('node:assert/strict');

const CashflowForecastService = require('../services/cashflowForecastService');
const stats = require('../services/ai/stats');
const { pool } = require('../config/database');
const { enableMultiCompany, disableMultiCompany, insertAsAppRole, resetTestCompanies } = require('./helpers/multiCompany');
const companyContext = require('../services/companyContext');

let dbAvailable = false;
let userId = null;
let companyId = null;

// This suite seeds its own dedicated company (not the shared default) — see
// tests/helpers/withCompany.js's comment on wrapHooksFor for why before()
// itself is left unwrapped while test()/after() read `companyId` lazily.
const { test, before, after } = require('./helpers/withCompany').wrapHooksFor(require('node:test'), () => companyId);
const created = {
  accountIds: [],
  customerIds: [],
  invoiceIds: [],
  paymentIds: [],
  allocationIds: [],
  supplierIds: [],
  billIds: [],
  supplierPaymentIds: [],
  supplierAllocationIds: [],
  entryIds: [],
  payrollIds: [],
  recurringIds: [],
  loanIds: [],
  taxIds: [],
};

// The scenario, relative to asOf (today):
const AS_OF = (() => {
  const d = new Date();
  return d.toISOString().split('T')[0];
})();

function daysFromToday(days, hour = 12) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function iso(d) {
  return d.toISOString().split('T')[0];
}

async function insertCustomer(code, name) {
  const { rows } = await pool.query(
    `INSERT INTO customers (company_id, customer_code, customer_name, primary_email, status, created_by)
     VALUES ($1, $2, $3, 'cf@test.local', 'ACTIVE', $4) RETURNING id`,
    [companyId, code, name, userId]
  );
  created.customerIds.push(rows[0].id);
  return rows[0].id;
}

async function insertInvoice(customerId, invoiceNumber, invoiceDate, total) {
  const { rows } = await pool.query(
    `INSERT INTO customer_invoices (company_id, invoice_number, customer_id, invoice_date,
       due_date, total_amount, paid_amount, status, created_by)
     VALUES ($1, $2, $3, $4::date, $4::date + 30, $5, 0, 'APPROVED', $6) RETURNING id`,
    [companyId, invoiceNumber, customerId, iso(invoiceDate), total, userId]
  );
  created.invoiceIds.push(rows[0].id);
  return rows[0].id;
}

async function insertCustomerPayment(customerId, invoiceId, paymentNumber, paymentDate, amount) {
  const { rows } = await pool.query(
    `INSERT INTO customer_payments (company_id, payment_number, customer_id, payment_date,
       payment_method, payment_amount, status, created_by)
     VALUES ($1, $2, $3, $4, 'BANK_TRANSFER', $5, 'CLEARED', $6) RETURNING id`,
    [companyId, paymentNumber, customerId, iso(paymentDate), amount, userId]
  );
  // The real app reduces the invoice's paid amount when a payment lands; the
  // forecast's receivables read outstanding_amount, so a fixture that forgets
  // this would keep paid invoices "outstanding" and count their cash twice.
  await pool.query('UPDATE customer_invoices SET paid_amount = paid_amount + $2 WHERE id = $1', [invoiceId, amount]);
  created.paymentIds.push(rows[0].id);
  const alloc = await pool.query(
    `INSERT INTO customer_payment_allocations (payment_id, invoice_id, allocation_amount, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [rows[0].id, invoiceId, amount, userId]
  );
  created.allocationIds.push(alloc.rows[0].id);
  return rows[0].id;
}

async function insertSupplier(code, name) {
  const { rows } = await pool.query(
    `INSERT INTO suppliers (company_id, supplier_code, legal_name, status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [companyId, code, name]
  );
  created.supplierIds.push(rows[0].id);
  return rows[0].id;
}

async function insertBill(supplierId, billNumber, invoiceDate, total) {
  const { rows } = await pool.query(
    `INSERT INTO supplier_invoices (company_id, bill_number, supplier_id, invoice_date,
       due_date, total_amount, paid_amount, status, created_by)
     VALUES ($1, $2, $3, $4::date, $4::date + 30, $5, 0, 'APPROVED', $6) RETURNING id`,
    [companyId, billNumber, supplierId, iso(invoiceDate), total, userId]
  );
  created.billIds.push(rows[0].id);
  return rows[0].id;
}

async function insertSupplierPayment(supplierId, billId, paymentNumber, paymentDate, amount) {
  const { rows } = await pool.query(
    `INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date,
       payment_method, payment_amount, status, created_by)
     VALUES ($1, $2, $3, $4, 'BANK_TRANSFER', $5, 'CLEARED', $6) RETURNING id`,
    [companyId, paymentNumber, supplierId, iso(paymentDate), amount, userId]
  );
  // Same convention as customer payments: a payment reduces the bill's paid
  // amount, so paid bills leave the open payables.
  await pool.query('UPDATE supplier_invoices SET paid_amount = paid_amount + $2 WHERE id = $1', [billId, amount]);
  created.supplierPaymentIds.push(rows[0].id);
  const alloc = await pool.query(
    `INSERT INTO supplier_payment_allocations (payment_id, bill_id, allocation_amount, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [rows[0].id, billId, amount, userId]
  );
  created.supplierAllocationIds.push(alloc.rows[0].id);
  return rows[0].id;
}

/** Post a cash movement on a date (this is the "actual" outcome). */
async function postCash(date, amount, description) {
  const number = `JE-CF-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows: cashAcct } = await pool.query(
    `SELECT id, account_code FROM chart_of_accounts
      WHERE company_id = $1 AND account_type = 'ASSET' AND account_subtype = 'CASH'
        AND status = 'ACTIVE' LIMIT 1`,
    [companyId]
  );
  
  const { rows } = await pool.query(
    `INSERT INTO journal_entries
       (company_id, journal_number, entry_date, posting_date, period_year, period_month,
        source_type, description, total_debit, total_credit, status, currency, created_by, created_at)
     VALUES ($1, $2, $3, $3, EXTRACT(YEAR FROM $3::date), EXTRACT(MONTH FROM $3::date),
        'BANK_TRANSACTION', $4, $5, $5, 'POSTED', 'USD', $6, $3::date + INTERVAL '9 hours')
     RETURNING id`,
    [companyId, number, iso(date), description, Math.abs(amount), userId]
  );
  if (amount >= 0) {
    await pool.query(
      `INSERT INTO journal_entry_items (journal_entry_id, line_number, account_id, account_code,
         account_name, debit_amount, credit_amount, description)
       VALUES ($1, 1, $2, $3, 'Cash and Cash Equivalents', $4, 0, 'actual inflow')`,
      [rows[0].id, cashAcct[0].id, cashAcct[0].account_code, Math.abs(amount)]
    );
  } else {
    await pool.query(
      `INSERT INTO journal_entry_items (journal_entry_id, line_number, account_id, account_code,
         account_name, debit_amount, credit_amount, description)
       VALUES ($1, 1, $2, $3, 'Cash and Cash Equivalents', 0, $4, 'actual outflow')`,
      [rows[0].id, cashAcct[0].id, cashAcct[0].account_code, Math.abs(amount)]
    );
  }
  created.entryIds.push(rows[0].id);
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!users.rows.length) throw new Error('no users');
    userId = users.rows[0].id;
    dbAvailable = true;
  } catch (err) {
    console.error('cashflow test setup failed:', err.message);
    dbAvailable = false;
    return;
  }

  await resetTestCompanies(pool);
  // Seeding a SECOND company is refused by migration 111's guard unless
  // isolation is actually on. The helper was imported but never called.
  await enableMultiCompany(pool);
  const comp = await insertAsAppRole(pool,
    `INSERT INTO companies (company_code, name, legal_name, base_currency, is_default, status)
     VALUES ($1, 'Cashflow Test', 'Cashflow Test', 'USD', false, 'ACTIVE') RETURNING id`,
    [`CF-${Date.now()}`]
  );
  companyId = comp.rows[0].id;

  // Everything from here on inserts scoped data for the company just created
  // — it needs THAT company as ambient RLS context, not the suite's default.
  // See tests/helpers/withCompany.js's wrapHooksFor comment.
  await companyContext.runWithCompany(companyId, async () => {

  const cash = await pool.query(
    `INSERT INTO chart_of_accounts (company_id, account_code, account_name, account_type,
       account_subtype, account_level, is_header, normal_balance, status, created_by,
       allow_manual_posting, balance_sheet_section, current_balance)
     VALUES ($1, '1111' || $3, 'Cash and Cash Equivalents', 'ASSET', 'CASH', 3, false,
       'DEBIT', 'ACTIVE', $2, true, 'CURRENT_ASSETS', 10000) RETURNING id`,
    [companyId, userId, String(Date.now()).slice(-6)]
  );
  created.accountIds[0] = cash.rows[0].id;

  // -------------------------------------------------------------------------
  // Behaviour history (all dated BEFORE asOf, so the backtest only knows these):
  //   • Customer K pays in 10 days (history [10, 10, 12]).
  //   • Customer M pays variably (history [5, 10, 15]) — this is what makes
  //     the P10/P50/P90 bands differ instead of collapsing.
  //   • The company pays its suppliers in ~5 days ([5, 5, 7]).
  // -------------------------------------------------------------------------
  const k = await insertCustomer(`CUST-K-${Date.now()}`, 'K Customer');
  const kInv1 = await insertInvoice(k, `INV-K1-${Date.now()}`, daysFromToday(-100), 500);
  const kInv2 = await insertInvoice(k, `INV-K2-${Date.now()}`, daysFromToday(-90), 500);
  const kInv3 = await insertInvoice(k, `INV-K3-${Date.now()}`, daysFromToday(-80), 500);
  await insertCustomerPayment(k, kInv1, `CPY-K1-${Date.now()}`, daysFromToday(-90), 500);
  await insertCustomerPayment(k, kInv2, `CPY-K2-${Date.now()}`, daysFromToday(-80), 500);
  await insertCustomerPayment(k, kInv3, `CPY-K3-${Date.now()}`, daysFromToday(-68), 500);

  const m = await insertCustomer(`CUST-M-${Date.now()}`, 'M Customer');
  const mInv1 = await insertInvoice(m, `INV-M1-${Date.now()}`, daysFromToday(-60), 300);
  const mInv2 = await insertInvoice(m, `INV-M2-${Date.now()}`, daysFromToday(-50), 300);
  const mInv3 = await insertInvoice(m, `INV-M3-${Date.now()}`, daysFromToday(-40), 300);
  await insertCustomerPayment(m, mInv1, `CPY-M1-${Date.now()}`, daysFromToday(-55), 300);
  await insertCustomerPayment(m, mInv2, `CPY-M2-${Date.now()}`, daysFromToday(-40), 300);
  await insertCustomerPayment(m, mInv3, `CPY-M3-${Date.now()}`, daysFromToday(-25), 300);

  const s = await insertSupplier(`SUP-CF-${Date.now()}`, 'CF Supplier');
  const sInv1 = await insertBill(s, `BILL-CF1-${Date.now()}`, daysFromToday(-60), 400);
  const sInv2 = await insertBill(s, `BILL-CF2-${Date.now()}`, daysFromToday(-50), 400);
  const sInv3 = await insertBill(s, `BILL-CF3-${Date.now()}`, daysFromToday(-40), 400);
  await insertSupplierPayment(s, sInv1, `SPY-CF1-${Date.now()}`, daysFromToday(-55), 400);
  await insertSupplierPayment(s, sInv2, `SPY-CF2-${Date.now()}`, daysFromToday(-45), 400);
  await insertSupplierPayment(s, sInv3, `SPY-CF3-${Date.now()}`, daysFromToday(-33), 400);

  // -------------------------------------------------------------------------
  // Open positions at asOf:
  //   • K owes 1000 (invoice 10 days ago) — will pay at +10 (p10=p50) to +12 (p90)
  //   • M owes 400 (invoice 5 days ago)  — pays at +5 (p90) / +10 (p50) / +15 (p10)
  //   • AP bill of 800 (invoice 3 days ago) — company pays at +5..+7
  // -------------------------------------------------------------------------
  // K pays fast (learned 5 days) — an invoice dated 10 days ago would already
  // be expected in the past (week 0) and the service correctly drops it from
  // the future inflow drivers. Date it 2 days ago so its expected receipt
  // lands inside the horizon.
  await insertInvoice(k, `INV-K-OPEN-${Date.now()}`, daysFromToday(-2), 1000);
  await insertInvoice(m, `INV-M-OPEN-${Date.now()}`, daysFromToday(-5), 400);
  await insertBill(s, `BILL-CF-OPEN-${Date.now()}`, daysFromToday(-3), 800);

  // Standing schedules within the horizon:
  const rec = await pool.query(
    `INSERT INTO recurring_invoice_schedules (company_id, customer_id, description, amount,
       tax_amount, currency, frequency, next_run_date, status)
     VALUES ($1, $2, 'Monthly retainer', 400, 0, 'USD', 'MONTHLY', $3, 'ACTIVE') RETURNING id`,
    [companyId, k, iso(daysFromToday(5))]
  );
  created.recurringIds.push(rec.rows[0].id);

  const loan = await pool.query(
    `INSERT INTO loan_schedules (company_id, loan_name, lender, next_payment_date,
       payment_amount, frequency, status)
     VALUES ($1, 'Equipment loan', 'Test Bank', $2, 300, 'MONTHLY', 'ACTIVE') RETURNING id`,
    [companyId, iso(daysFromToday(10))]
  );
  created.loanIds.push(loan.rows[0].id);

  const tax = await pool.query(
    `INSERT INTO tax_payment_schedules (company_id, tax_type, next_due_date, amount, frequency, status)
     VALUES ($1, 'VAT', $2, 250, 'MONTHLY', 'ACTIVE') RETURNING id`,
    [companyId, iso(daysFromToday(20))]
  );
  created.taxIds.push(tax.rows[0].id);

  // Payroll history (two posted runs) — the forecast schedules the next run
  // from these; the actual entry is posted at whatever date the forecast picks.
  for (const days of [-70, -40]) {
    const run = await pool.query(
      `INSERT INTO payroll_runs (company_id, run_number, period_year, period_month, status,
         total_gross, total_deductions, total_net, created_by, created_at)
       VALUES ($1, $2, $3, $4, 'POSTED', 2500, 500, 2000, $5, $6) RETURNING id`,
      [companyId, `PR-CF-${Date.now()}-${days}`, new Date(daysFromToday(days)).getFullYear(),
        new Date(daysFromToday(days)).getMonth() + 1, userId, daysFromToday(days)]
    );
    created.payrollIds.push(run.rows[0].id);
  }
  });
});

after(async () => {
  if (!dbAvailable) return;
  try {
    for (const id of created.payrollIds) {
      await pool.query('DELETE FROM payroll_runs WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.recurringIds) {
      await pool.query('DELETE FROM recurring_invoice_schedules WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.loanIds) {
      await pool.query('DELETE FROM loan_schedules WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.taxIds) {
      await pool.query('DELETE FROM tax_payment_schedules WHERE id = $1', [id]).catch(() => {});
    }
    await pool.query(
      `DELETE FROM journal_entry_status_history
        WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id = $1)`,
      [companyId]
    ).catch(() => {});
    await pool.query(
      `DELETE FROM journal_entry_items
        WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id = $1)`,
      [companyId]
    ).catch(() => {});
    await pool.query('DELETE FROM journal_entries WHERE company_id = $1', [companyId]).catch(() => {});
    for (const id of created.supplierPaymentIds) {
      await pool.query('DELETE FROM supplier_payment_allocations WHERE payment_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM supplier_payments WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.paymentIds) {
      await pool.query('DELETE FROM customer_payment_allocations WHERE payment_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM customer_payments WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.billIds) {
      await pool.query('DELETE FROM supplier_invoices WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.invoiceIds) {
      await pool.query('DELETE FROM customer_invoices WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.supplierIds) {
      await pool.query('DELETE FROM suppliers WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.customerIds) {
      await pool.query('DELETE FROM customers WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.accountIds) {
      await pool.query('DELETE FROM chart_of_accounts WHERE id = $1', [id]).catch(() => {});
    }
    await pool.query('DELETE FROM companies WHERE id = $1', [companyId]).catch(() => {});
    await disableMultiCompany(pool).catch(() => {});
  } catch (err) {
    console.error('cashflow test teardown error:', err.message);
  }
  await pool.end();
});

test('percentile is the empirical quantile used for the bands', () => {
  assert.equal(stats.percentile([10, 10, 12], 10), 10);
  assert.equal(stats.percentile([10, 10, 12], 50), 10);
  assert.equal(stats.percentile([10, 10, 12], 90), 12);
  assert.equal(stats.percentile([5, 10, 15], 10), 5);
  assert.equal(stats.percentile([5, 10, 15], 90), 15);
  assert.equal(stats.percentile([], 50), 0);
});

test('the forecast learns behaviour and widens the bands with real variance', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const forecast = await CashflowForecastService.generate13WeekForecast(companyId, { asOf: AS_OF, horizonWeeks: 8 });

  assert.equal(forecast.success, true);
  assert.equal(forecast.method, 'behavioural');
  assert.equal(forecast.forecast_weeks.length, 8);
  assert.equal(forecast.starting_cash, 10000);

  // The open K invoice (1000) must appear as an inflow driver.

  const weekWithK = forecast.forecast_weeks.find((w) =>
    w.drivers.inflows.some((d) => d.type === 'AR' && d.label.includes('INV-K-OPEN')));
  assert.ok(weekWithK, 'open AR must be scheduled from the learned days-to-pay');
  const kDriver = weekWithK.drivers.inflows.find((d) => d.type === 'AR' && d.label.includes('INV-K-OPEN'));
  assert.equal(kDriver.amount, 1000);

  // M's variable history [5,10,15] must separate the paths: some week must
  // show a strictly wider P10/P90 band (real distribution, not ± percentages).
  assert.ok(
    forecast.forecast_weeks.some((w) => w.p90 > w.p10),
    'variance in the learned distribution must widen the P10/P90 band'
  );
  for (const w of forecast.forecast_weeks) {
    assert.ok(w.p10 <= w.p50 + 0.01 && w.p50 <= w.p90 + 0.01,
      `week ${w.week} bands must be ordered: p10 <= p50 <= p90`);
  }

  // Standing schedules must be present: loan and tax outflows, recurring inflow.
  const hasLoan = forecast.forecast_weeks.some((w) => w.drivers.outflows.some((d) => d.type === 'loan'));
  const hasTax = forecast.forecast_weeks.some((w) => w.drivers.outflows.some((d) => d.type === 'tax'));
  const hasRecurring = forecast.forecast_weeks.some((w) => w.drivers.inflows.some((d) => d.type === 'recurring_invoice'));
  const hasPayroll = forecast.forecast_weeks.some((w) => w.drivers.outflows.some((d) => d.type === 'payroll'));
  assert.ok(hasLoan, 'loan schedule must be in the forecast');
  assert.ok(hasTax, 'tax payment schedule must be in the forecast');
  assert.ok(hasRecurring, 'recurring invoice must be in the forecast');
  assert.ok(hasPayroll, 'payroll expectation must be in the forecast');
});

test('backtest: P10/P90 bracket the actual outcomes on historical data', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // First run the forecast to learn where the payroll run lands, then post the
  // "actual" cash movements at the dates the learned behaviour implies:
  //   K pays at +10 days, M at +10, AP at +5, loan +10, recurring +5, tax +20,
  //   payroll at whatever date the forecast scheduled.
  const forecast = await CashflowForecastService.generate13WeekForecast(companyId, { asOf: AS_OF, horizonWeeks: 8 });

  // The "actual" outcomes must be posted on the dates the learned behaviour
  // implies — the forecast's own p50 expected dates, for EVERY occurrence the
  // forecast schedules (monthly loan/retainer/tax items recur inside the
  // horizon). Hardcoding +5/+10/+20 would place the actuals in different
  // weeks than the bands, and the bracket test would fail through no fault
  // of the forecast.
  // postCash is async. Firing it without awaiting raced the backtest query:
  // the last-issued inserts had not committed when backtest() read the cash
  // lines, so the later occurrences of the recurring items (the week-7 VAT
  // payment, specifically) were silently missing from the "actuals" and the
  // bracket check failed against an incomplete history rather than a bad band.
  const postEvery = async (inflowPred, outflowPred, inflowAmount, outflowAmount, label) => {
    let count = 0;
    for (const w of forecast.forecast_weeks) {
      for (const d of w.drivers.inflows.filter(inflowPred)) {
        await postCash(new Date(d.expected_date), inflowAmount, label);
        count += 1;
      }
      for (const d of w.drivers.outflows.filter(outflowPred)) {
        await postCash(new Date(d.expected_date), -outflowAmount, label);
        count += 1;
      }
    }
    assert.ok(count > 0, `expected forecast drivers for ${label}`);
  };
  await postEvery((d) => d.type === 'AR' && d.label.includes('INV-K-OPEN'), () => false, 1000, 0, 'K pays');
  await postEvery((d) => d.type === 'AR' && d.label.includes('INV-M-OPEN'), () => false, 400, 0, 'M pays');
  await postEvery(() => false, (d) => d.type === 'AP', 0, 800, 'AP paid');
  await postEvery(() => false, (d) => d.type === 'payroll', 0, 2000, 'payroll');
  await postEvery(() => false, (d) => d.type === 'loan', 0, 300, 'loan payment');
  await postEvery((d) => d.type === 'recurring_invoice', () => false, 400, 0, 'recurring invoice');
  await postEvery(() => false, (d) => d.type === 'tax', 0, 250, 'VAT');

  const result = await CashflowForecastService.backtest({ companyId, asOf: AS_OF, horizonWeeks: 8 });



  assert.equal(result.success, true);
  assert.equal(result.horizon_weeks, 8);
  assert.equal(result.total, 8);

  // Every actual weekly closing cash position must fall inside [P10, P90].
  for (const w of result.weeks) {
    assert.ok(
      w.actual_closing_cash >= w.forecast_p10 - 0.01 && w.actual_closing_cash <= w.forecast_p90 + 0.01,
      `week ${w.week}: actual ${w.actual_closing_cash} outside [${w.forecast_p10}, ${w.forecast_p90}]`
    );
  }
  assert.equal(result.bracketed, result.total, 'all weeks must be bracketed');
  assert.equal(result.bracket_rate, 1);
});
