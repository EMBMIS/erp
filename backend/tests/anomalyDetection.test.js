// Round 7, Task 20 — anomaly detection with a learned baseline.
//
// Every detector in services/ai/anomalyDetectionService.js learns from the
// company's own history and flags DEVIATION. This suite seeds company A with
// one anomalous scenario per detector and company B with clean, consistent
// data, then asserts:
//
//   • each detector fires on its seeded anomaly, with a severity and a
//     plain-English explanation
//   • normal data produces NOTHING (the false-positive test)
//   • re-running the scan does not duplicate findings
//
// Run on its own:  node --test tests/anomalyDetection.test.js

// This suite seeds TWO of its own dedicated companies (A anomalous, B clean),
// not the shared default, so seedAnomalousCompany/seedCleanCompany each wrap
// their own body in the right company's context (see below) rather than
// using a single blanket wrapper. See tests/helpers/withCompany.js's header.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const AnomalyDetectionService = require('../services/ai/anomalyDetectionService');
const { pool } = require('../config/database');
const { enableMultiCompany, disableMultiCompany, insertAsAppRole, resetTestCompanies } = require('./helpers/multiCompany');
const companyContext = require('../services/companyContext');

let dbAvailable = false;
let users = [];
const created = {
  companyIds: [],
  supplierIds: [],
  employeeIds: [],
  paymentIds: [],
  invoiceIds: [],
  entryIds: [],
  accountIds: [],
  templateIds: [],
  stepIds: [],
  changeIds: [],
};

let companyA = null;
let companyB = null;

function daysAgo(days, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

// Weekday-only variant for the false-positive fixture: any 6 dates spread over
// 180 days will include a weekend, and the weighted off-hours detector
// legitimately flags a weekend posting by a user who rarely posts off-hours.
// "Clean" fixtures must not contain weekend postings at all.
function weekdayAgo(days, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function isoDate(daysAgoValue) {
  return daysAgoValue.toISOString().split('T')[0];
}

async function insertJournalEntry({ companyId, totalDebit, createdBy, approvedBy = null, createdAt, status = 'POSTED', accountId, accountCode, accountName, debit = null, credit = null }) {
  const number = `JE-ANOM-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const entryDate = isoDate(createdAt);
  const amount = debit !== null ? debit : credit;
  const { rows } = await pool.query(
    `INSERT INTO journal_entries
       (company_id, journal_number, entry_date, posting_date, period_year, period_month,
        source_type, description, total_debit, total_credit, status, currency, created_by,
        approved_by, created_at)
     VALUES ($1, $2, $3, $3, EXTRACT(YEAR FROM $3::date), EXTRACT(MONTH FROM $3::date),
        'MANUAL', $4, $5, $6, $7, 'USD', $8, $9, $10)
     RETURNING id`,
    [companyId, number, entryDate, `test entry ${number}`, totalDebit, totalDebit, status, createdBy, approvedBy, createdAt]
  );
  await pool.query(
    `INSERT INTO journal_entry_items
       (journal_entry_id, line_number, account_id, account_code, account_name,
        debit_amount, credit_amount, description)
     VALUES ($1, 1, $2, $3, $4, $5, $6, 'test line')`,
    [rows[0].id, accountId, accountCode, accountName, debit !== null ? debit : 0, credit !== null ? credit : 0]
  );
  created.entryIds.push(rows[0].id);
  return rows[0].id;
}

async function insertSupplier({ companyId, code, name, bank = null, tax = null, address = null }) {
  const { rows } = await pool.query(
    `INSERT INTO suppliers (company_id, supplier_code, legal_name, status, bank_account_number, tax_id, address)
     VALUES ($1, $2, $3, 'ACTIVE', $4, $5, $6) RETURNING id`,
    [companyId, code, name, bank, tax, address]
  );
  created.supplierIds.push(rows[0].id);
  return rows[0].id;
}

async function insertPayment({ companyId, supplierId, amount, paymentDate, createdBy, status = 'CLEARED' }) {
  const number = `SPY-ANOM-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await pool.query(
    `INSERT INTO supplier_payments
       (company_id, payment_number, supplier_id, payment_date, payment_method, payment_amount, status, created_by)
     VALUES ($1, $2, $3, $4, 'BANK_TRANSFER', $5, $6, $7) RETURNING id`,
    [companyId, number, supplierId, isoDate(paymentDate), amount, status, createdBy]
  );
  created.paymentIds.push(rows[0].id);
  return rows[0].id;
}

async function insertBill({ companyId, supplierId, billNumber, supplierInvoiceNumber, invoiceDate, total }) {
  const { rows } = await pool.query(
    `INSERT INTO supplier_invoices
       (company_id, bill_number, supplier_id, supplier_invoice_number, invoice_date, due_date,
        total_amount, paid_amount, status, created_by)
     VALUES ($1, $2, $3, $4, $5::date, $5::date + 30, $6, 0, 'APPROVED', $7) RETURNING id`,
    [companyId, billNumber, supplierId, supplierInvoiceNumber, isoDate(invoiceDate), total, users[0]]
  );
  created.invoiceIds.push(rows[0].id);
  return rows[0].id;
}

async function insertEmployee({ companyId, number, firstName, lastName, bank = null, tax = null, address = null }) {
  const { rows } = await pool.query(
    `INSERT INTO employees
       (company_id, employee_number, first_name, last_name, status, created_by, bank_account_number, tax_id, address)
     VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, $7, $8) RETURNING id`,
    [companyId, number, firstName, lastName, users[0], bank, tax, address]
  );
  created.employeeIds.push(rows[0].id);
  return rows[0].id;
}

async function insertAccount({ companyId, code, name, type = 'EXPENSE', balance = 0 }) {
  const { rows } = await pool.query(
    `INSERT INTO chart_of_accounts
       (company_id, account_code, account_name, account_type, account_subtype, account_level,
        is_header, normal_balance, status, created_by, allow_manual_posting, current_balance)
     VALUES ($1, $2, $3, $4, 'TEST', 3, false, 'DEBIT', 'ACTIVE', $5, true, $6) RETURNING id`,
    [companyId, code, name, type, users[0], balance]
  );
  created.accountIds.push(rows[0].id);
  return rows[0].id;
}

async function seedCompany(code, name) {
  const { rows } = await insertAsAppRole(pool,
    `INSERT INTO companies (company_code, name, legal_name, base_currency, is_default, status)
     VALUES ($1, $2, $2, 'USD', false, 'ACTIVE') RETURNING id`,
    [code, name]
  );
  created.companyIds.push(rows[0].id);
  return rows[0].id;
}

// Wraps the WHOLE function in this company's context — every insert below
// (directly, or via the insert* helpers above) touches an RLS-forced table
// (suppliers, supplier_payments, journal_entries, chart_of_accounts, etc.),
// and this suite seeds TWO companies, so there is no single ambient context
// that's right for both. See tests/helpers/withCompany.js's file header.
async function seedAnomalousCompany(companyId) {
  return companyContext.runWithCompany(companyId, () => seedAnomalousCompanyImpl(companyId));
}

async function seedAnomalousCompanyImpl(companyId) {
  const [u, w] = users;

  // --- 1. Vendor amount baseline: consistent history, one wild payment -----
  const v1 = await insertSupplier({ companyId, code: `SUPAMT${Date.now().toString(36).toUpperCase()}`, name: 'Amount Deviant Vendor' });
  for (const days of [200, 170, 140, 110]) {
    await insertPayment({ companyId, supplierId: v1, amount: 1000, paymentDate: daysAgo(days), createdBy: u });
  }
  await insertPayment({ companyId, supplierId: v1, amount: 50000, paymentDate: daysAgo(5), createdBy: u });

  // --- 2. Frequency spike: monthly history, then a burst -------------------
  const v2 = await insertSupplier({ companyId, code: `SUPFREQ${Date.now().toString(36).toUpperCase()}`, name: 'Frequency Spike Vendor' });
  for (const days of [180, 150, 120, 90, 60, 30]) {
    await insertPayment({ companyId, supplierId: v2, amount: 1500, paymentDate: daysAgo(days), createdBy: u });
  }
  for (const days of [25, 20, 15, 10]) {
    await insertPayment({ companyId, supplierId: v2, amount: 1500, paymentDate: daysAgo(days), createdBy: u });
  }

  // --- 3. Atypical approver: one payment by a different user ----------------
  const v3 = await insertSupplier({ companyId, code: `SUPAPPR${Date.now().toString(36).toUpperCase()}`, name: 'Approver Shift Vendor' });
  for (const days of [200, 170, 140, 110, 80]) {
    await insertPayment({ companyId, supplierId: v3, amount: 800, paymentDate: daysAgo(days), createdBy: u });
  }
  await insertPayment({ companyId, supplierId: v3, amount: 800, paymentDate: daysAgo(50), createdBy: w });

  // --- 4. Duplicate payment: same vendor, same amount, 3 days apart ---------
  const v4 = await insertSupplier({ companyId, code: `SUPDUP${Date.now().toString(36).toUpperCase()}`, name: 'Duplicate Payment Vendor' });
  await insertPayment({ companyId, supplierId: v4, amount: 2500, paymentDate: daysAgo(10), createdBy: u });
  await insertPayment({ companyId, supplierId: v4, amount: 2500, paymentDate: daysAgo(7), createdBy: u });

  // --- 5. Same invoice number across two vendors ----------------------------
  const v5 = await insertSupplier({ companyId, code: `SUPX1${Date.now().toString(36).toUpperCase()}`, name: 'Cross Vendor A' });
  const v6 = await insertSupplier({ companyId, code: `SUPX2${Date.now().toString(36).toUpperCase()}`, name: 'Cross Vendor B' });
  const sharedInv = `INV-SHARED-${Date.now()}`;
  await insertBill({ companyId, supplierId: v5, billNumber: `BILL-X1-${Date.now()}`, supplierInvoiceNumber: sharedInv, invoiceDate: daysAgo(15), total: 900 });
  await insertBill({ companyId, supplierId: v6, billNumber: `BILL-X2-${Date.now()}`, supplierInvoiceNumber: sharedInv, invoiceDate: daysAgo(14), total: 900 });

  // --- 6. Bank detail changed shortly before a payment ----------------------
  const v7 = await insertSupplier({ companyId, code: `SUPBANK${Date.now().toString(36).toUpperCase()}`, name: 'Bank Change Vendor', bank: '1111111111' });
  const p7 = await insertPayment({ companyId, supplierId: v7, amount: 4000, paymentDate: daysAgo(3), createdBy: u });
  const { rows: changeRows } = await pool.query(
    `INSERT INTO supplier_bank_detail_changes
       (company_id, supplier_id, changed_at, changed_by, field_name, old_value, new_value)
     VALUES ($1, $2, $3, $4, 'bank_account_number', '9999999999', '1111111111') RETURNING id`,
    [companyId, v7, daysAgo(6), u]
  );
  created.changeIds.push(changeRows[0].id);
  created.paymentIds.push(p7);

  // --- 7. Threshold hugging: 9,500 under a 10,000 approval threshold ---------
  const thrAccount = await insertAccount({ companyId, code: `ACCTHR${Date.now().toString(36).toUpperCase()}`, name: 'Threshold Account' });
  const { rows: tmpl } = await pool.query(
    `INSERT INTO approval_chain_templates (company_id, name, document_type, is_active)
     VALUES ($1, $2, 'JOURNAL_ENTRY', true) RETURNING id`,
    [companyId, `TMPL-THR-${Date.now()}`]
  );
  created.templateIds.push(tmpl[0].id);
  const { rows: step } = await pool.query(
    `INSERT INTO approval_chain_steps (template_id, step_number, min_amount, approver_role)
     VALUES ($1, 1, 10000, 'MANAGER') RETURNING id`,
    [tmpl[0].id]
  );
  created.stepIds.push(step[0].id);
  await insertJournalEntry({
    companyId,
    totalDebit: 9500,
    createdBy: u,
    approvedBy: u,
    // weekdayAgo, not daysAgo: this entry counts toward user u's off-hours
    // rate in detector #8 below (it aggregates every JE u posted in this
    // company, not just the ones in its own section) — a stray weekend
    // landing here inflates that rate on some calendar days and can mask
    // the deliberate anomaly detector #8 is actually testing for.
    createdAt: weekdayAgo(4),
    accountId: thrAccount,
    accountCode: 'ACC-THR',
    accountName: 'Threshold Account',
    debit: 9500,
  });

  // --- 8. Off-hours posting by a user who does not normally do that ---------
  // This is the baseline: weekdayAgo guarantees these 5 land on real weekday
  // business hours, so u's off-hours rate stays governed by the ONE
  // deliberate weekend anomaly below, not by whichever calendar dates
  // daysAgo happened to compute today.
  const offAccount = await insertAccount({ companyId, code: `ACCOFF${Date.now().toString(36).toUpperCase()}`, name: 'Off Hours Account' });
  for (const days of [90, 75, 60, 45, 30]) {
    await insertJournalEntry({
      companyId,
      totalDebit: 500,
      createdBy: u,
      createdAt: weekdayAgo(days, 10),
      accountId: offAccount,
      accountCode: 'ACC-OFF',
      accountName: 'Off Hours Account',
      debit: 500,
    });
  }
  const weekend = daysAgo(2, 2);
  await insertJournalEntry({
    companyId,
    totalDebit: 500,
    createdBy: u,
    createdAt: weekend,
    accountId: offAccount,
    accountCode: 'ACC-OFF',
    accountName: 'Off Hours Account',
    debit: 500,
  });

  // --- 9. Account amount baseline: consistent lines, one huge posting --------
  // Same reasoning as #8 above — weekdayAgo so these six don't randomly
  // contribute to u's off-hours rate depending on today's date.
  const acct = await insertAccount({ companyId, code: `ACCBASE${Date.now().toString(36).toUpperCase()}`, name: 'Baseline Account' });
  for (const days of [200, 170, 140, 110, 80]) {
    await insertJournalEntry({
      companyId,
      totalDebit: 1000,
      createdBy: u,
      createdAt: weekdayAgo(days, 10),
      accountId: acct,
      accountCode: 'ACC-BASE',
      accountName: 'Baseline Account',
      debit: 1000,
    });
  }
  await insertJournalEntry({
    companyId,
    totalDebit: 40000,
    createdBy: u,
    createdAt: weekdayAgo(5, 10),
    accountId: acct,
    accountCode: 'ACC-BASE',
    accountName: 'Baseline Account',
    debit: 40000,
  });

  // --- 10. Vendor shares bank / tax id / address with an employee ------------
  const v8 = await insertSupplier({ companyId, code: `SUPLNK1${Date.now().toString(36).toUpperCase()}`, name: 'Bank-Linked Vendor', bank: '9876543210' });
  const v9 = await insertSupplier({ companyId, code: `SUPLNK2${Date.now().toString(36).toUpperCase()}`, name: 'Tax-Linked Vendor', tax: 'TX12345' });
  const v10 = await insertSupplier({ companyId, code: `SUPLNK3${Date.now().toString(36).toUpperCase()}`, name: 'Address-Linked Vendor', address: '1 Main Street' });
  await insertEmployee({ companyId, number: `EMPBANK${Date.now().toString(36).toUpperCase()}`, firstName: 'Bank', lastName: 'Employee', bank: '9876543210' });
  await insertEmployee({ companyId, number: `EMPTAX${Date.now().toString(36).toUpperCase()}`, firstName: 'Tax', lastName: 'Employee', tax: 'TX12345' });
  await insertEmployee({ companyId, number: `EMPADDR${Date.now().toString(36).toUpperCase()}`, firstName: 'Address', lastName: 'Employee', address: '1 Main Street' });

  return { v1, v2, v3, v4, v5, v6, v7, v8, v9, v10 };
}

async function seedCleanCompany(companyId) {
  return companyContext.runWithCompany(companyId, () => seedCleanCompanyImpl(companyId));
}

async function seedCleanCompanyImpl(companyId) {
  const u = users[0];

  const vendor = await insertSupplier({ companyId, code: `SUPCLEAN${Date.now().toString(36).toUpperCase()}`, name: 'Clean Vendor' });
  for (const days of [180, 150, 120, 90, 60, 30]) {
    await insertPayment({ companyId, supplierId: vendor, amount: 1200, paymentDate: weekdayAgo(days), createdBy: u });
  }

  const acct = await insertAccount({ companyId, code: `ACCCLEAN${Date.now().toString(36).toUpperCase()}`, name: 'Clean Account' });
  for (const days of [180, 150, 120, 90, 60, 30]) {
    await insertJournalEntry({
      companyId,
      totalDebit: 1000,
      createdBy: u,
      createdAt: weekdayAgo(days, 10),
      accountId: acct,
      accountCode: 'ACC-CLEAN',
      accountName: 'Clean Account',
      debit: 1000,
    });
  }
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const { rows } = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 2');
    if (rows.length < 2) throw new Error('need at least two users for the approver test');
    users = rows.map((r) => r.id);
    dbAvailable = true;
  } catch (err) {
    console.error('anomaly test setup failed:', err.message);
    dbAvailable = false;
    return;
  }

  await resetTestCompanies(pool);
  // Seeding a SECOND company is refused by migration 111's guard unless
  // isolation is actually on — without this the whole suite fails in its
  // before hook. The helper was imported but never called.
  await enableMultiCompany(pool);
  companyA = await seedCompany(`ANMA${Date.now().toString(36).toUpperCase()}`, 'Anomaly Test A');
  companyB = await seedCompany(`ANMB${Date.now().toString(36).toUpperCase()}`, 'Anomaly Test B');
  await seedAnomalousCompany(companyA);
  await seedCleanCompany(companyB);
});

after(async () => {
  if (!dbAvailable) return;
  try {
    for (const id of created.companyIds) {
      await pool.query('DELETE FROM ai_findings WHERE company_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM ai_finding_suppressions WHERE company_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM supplier_bank_detail_changes WHERE company_id = $1', [id]).catch(() => {});
      await pool.query(
        `DELETE FROM journal_entry_status_history
          WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id = $1)`,
        [id]
      ).catch(() => {});
      await pool.query(
        `DELETE FROM journal_entry_items
          WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id = $1)`,
        [id]
      ).catch(() => {});
      await pool.query('DELETE FROM journal_entries WHERE company_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM supplier_payments WHERE company_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM supplier_invoices WHERE company_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM approval_chain_steps WHERE template_id IN (SELECT id FROM approval_chain_templates WHERE company_id = $1)', [id]).catch(() => {});
      await pool.query('DELETE FROM approval_chain_templates WHERE company_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM employees WHERE company_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM suppliers WHERE company_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM chart_of_accounts WHERE company_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM companies WHERE id = $1', [id]).catch(() => {});
    }
    // Through the helper: it runs on the owner connection (the app role cannot
    // disable isolation) and puts back the role isolation protected before.
    await disableMultiCompany(pool).catch(() => {});
  } catch (err) {
    console.error('anomaly test teardown error:', err.message);
  }
  await pool.end();
});

test('every detector fires on its seeded anomaly, with severity and a plain-English explanation', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // AnomalyDetectionService reads its company from ambient context
  // (companyId = currentCompanyId() default) — every real caller is a route
  // handler already inside establishCompany's runWithCompany, so the test
  // has to replicate that rather than pass companyId to an unscoped call.
  const result = await companyContext.runWithCompany(companyA,
    () => AnomalyDetectionService.runAnomalyScan({ companyId: companyA }));

  assert.ok(result.vendor_baseline_deviation >= 1, 'vendor amount baseline must fire');
  assert.ok(result.account_baseline_deviation >= 1, 'account amount baseline must fire');
  assert.ok(result.duplicate_payments >= 2, 'both duplicate detectors must fire (same-vendor pair + cross-vendor invoice)');
  assert.ok(result.bank_detail_change_before_payment >= 1, 'bank-detail-change-before-payment must fire');
  assert.ok(result.threshold_hugging >= 1, 'threshold hugging must fire');
  assert.ok(result.off_hours_postings >= 1, 'weighted off-hours detector must fire');
  assert.ok(result.vendor_employee_links >= 3, 'bank + tax + address vendor-employee links must fire');

  // Every finding must carry a severity and explain itself in plain English.
  const { rows } = await companyContext.runWithCompany(companyA, () => pool.query(
    `SELECT finding_type, severity, title, description FROM ai_findings WHERE company_id = $1`,
    [companyA]
  ));
  assert.ok(rows.length >= 8, `expected findings for every detector, got ${rows.length}`);
  for (const f of rows) {
    assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(f.severity), `severity missing on ${f.finding_type}`);
    assert.ok(f.description && f.description.length > 40,
      `finding ${f.finding_type} must explain WHY it was flagged`);
  }
});

test('normal data produces no findings at all (false-positive test)', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const result = await companyContext.runWithCompany(companyB,
    () => AnomalyDetectionService.runAnomalyScan({ companyId: companyB }));
  assert.equal(result.total_new_findings, 0, 'a clean company must produce zero findings');
  const { rows } = await companyContext.runWithCompany(companyB, () => pool.query(
    'SELECT COUNT(*)::int AS n FROM ai_findings WHERE company_id = $1',
    [companyB]
  ));
  assert.equal(rows[0].n, 0);
});

test('re-running the scan does not duplicate findings', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const result = await companyContext.runWithCompany(companyA,
    () => AnomalyDetectionService.runAnomalyScan({ companyId: companyA }));
  assert.equal(result.total_new_findings, 0, 'the open-finding dedup must suppress re-raises');
});

test('Benford analysis and the legacy helpers still work', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  await companyContext.runWithCompany(companyA, async () => {
    const benford = await AnomalyDetectionService.analyzeBenfordLaw(companyA);
    assert.ok(benford.sample_size >= 0);
    assert.equal(typeof benford.anomaly_flag, 'boolean');
    const legacy = await AnomalyDetectionService.detectOffHoursPostings(companyA);
    assert.ok(Array.isArray(legacy));
    const hugging = await AnomalyDetectionService.detectThresholdHugging(10000, companyA);
    assert.ok(Array.isArray(hugging));
  });
});
