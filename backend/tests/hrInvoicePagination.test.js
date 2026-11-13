// Server-side pagination + sorting for the two list GET endpoints:
//   GET /api/hr/employees          (backend/routes/hr.js + models/Employee.js)
//   GET /api/supplier-invoices     (backend/routes/supplier-invoices.js + models/SupplierInvoice.js)
//
// These used to return the FULL table. Both now accept limit/offset (and the
// REST-style page param), sort_by/sort_dir and return the same envelope as
// /api/customer-invoices: { success, data, total, limit, offset } — the shape
// the shared useListControls front-end hook consumes unchanged.
//
// The routes are exercised over real HTTP (express on an ephemeral port) with
// the auth middleware stubbed to pass-through, so the assertions land on the
// actual response envelope, not just the model. All fixtures use unique UUIDs
// and random prefixes so concurrent workers (this suite shares the DB) can
// never collide with them, and after() removes everything the test created.
//
// Run on its own:  node --test --test-concurrency=1 tests/hrInvoicePagination.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');

const { pool } = require('../config/database');
const companyContext = require('../services/companyContext');
const { v4: uuidv4 } = require('uuid');

// Unique per run, so a search filter only ever matches rows this test created.
const EPFX = `EPG${crypto.randomBytes(4).toString('hex')}`; // employee prefix
const BPFX = `BPG${crypto.randomBytes(4).toString('hex')}`; // bill prefix

let dbAvailable = false;
let userId = null;
let companyId = null;
let server = null;
let baseUrl = null;

const created = { employees: [], bills: [], supplierId: null };

// ---- HTTP harness ----------------------------------------------------------
// The route files apply `auth` internally, so stub that module in the require
// cache before loading them. The company middleware below plays the role the
// real server's per-request companyScope middleware plays: pool.query reads
// companyScope.currentCompanyId() via AsyncLocalStorage on every call, so the
// RLS-protected employees/supplier_invoices tables need the ambient company.
function withStubbedAuth(load) {
  const authPath = require.resolve('../middleware/auth');
  const original = require.cache[authPath];
  const stub = {
    auth: (req, res, next) => next(),
    optionalAuth: (req, res, next) => next(),
    requireManagerOrAdmin: (req, res, next) => next(),
  };
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: stub };
  try {
    return load();
  } finally {
    if (original) require.cache[authPath] = original;
    else delete require.cache[authPath];
  }
}

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

// ---- Fixtures --------------------------------------------------------------
async function seedEmployee(i, status) {
  const id = uuidv4();
  const empNum = `${EPFX}-EMP-${String(i).padStart(2, '0')}`;
  await pool.query(
    `INSERT INTO employees (id, employee_number, first_name, last_name, email, department, position,
                            hire_date, base_salary, currency, status, created_by, created_at, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, empNum, `${EPFX}-first-${i}`, `${EPFX}-last-${i}`, null, 'QA', 'Tester',
     '2026-01-01', 1000, 'USD', status, userId, new Date(`2026-01-01T00:00:0${i}Z`), companyId]
  );
  created.employees.push(id);
  return id;
}

async function seedBill(i, status) {
  const id = uuidv4();
  await pool.query(
    `INSERT INTO supplier_invoices (id, bill_number, supplier_invoice_number, supplier_id,
                                    invoice_date, due_date, payment_terms, currency,
                                    subtotal, tax_amount, total_amount, status, description,
                                    created_by, created_at, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id, `${BPFX}-BILL-${String(i).padStart(2, '0')}`, `VEND-${i}`,
     created.supplierId, `2026-02-01`, `2026-03-0${i}`, 'Net 30', 'USD',
     100 * i, 0, 100 * i, status, `pagination fixture ${i}`, userId,
     new Date(`2026-02-0${i}T00:00:00Z`), companyId]
  );
  created.bills.push(id);
  return id;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!users.rows.length) return;
    userId = users.rows[0].id;
    companyId = await companyContext.getDefaultCompanyId();
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }

  // Seed: one supplier, 6 employees (3 ACTIVE + 3 TERMINATED), 5 bills
  // (3 DRAFT + 2 APPROVED) — all with explicit company_id and distinct
  // created_at/due_date so ordering assertions are deterministic.
  const supplierId = uuidv4();
  await pool.query(
    `INSERT INTO suppliers (id, supplier_code, legal_name, status, company_id, created_by)
     VALUES ($1,$2,$3,'ACTIVE',$4,$5)`,
    [supplierId, `${BPFX}-SUP`, `${BPFX} Supplies Ltd`, companyId, userId]
  );
  created.supplierId = supplierId;

  for (let i = 1; i <= 3; i++) {
    await seedEmployee(i, 'ACTIVE');
    await seedEmployee(i + 3, 'TERMINATED');
    await seedBill(i, 'DRAFT');
  }
  await seedBill(4, 'APPROVED');
  await seedBill(5, 'APPROVED');

  const hrRouter = withStubbedAuth(() => require('../routes/hr'));
  const billsRouter = withStubbedAuth(() => require('../routes/supplier-invoices'));

  const app = express();
  app.use(express.json());
  // Mirror the production request scope: every handler and its awaited pool
  // queries run inside the ambient company context (see tests/helpers/withCompany.js).
  app.use((req, res, next) => companyContext.runWithCompany(companyId, () => next()));
  app.use('/api/hr', hrRouter);
  app.use('/api/supplier-invoices', billsRouter);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (dbAvailable) {
    if (created.bills.length) {
      await pool.query('DELETE FROM supplier_invoices WHERE id = ANY($1)', [created.bills]).catch(() => {});
    }
    if (created.employees.length) {
      await pool.query('DELETE FROM employees WHERE id = ANY($1)', [created.employees]).catch(() => {});
    }
    if (created.supplierId) {
      await pool.query('DELETE FROM suppliers WHERE id = $1', [created.supplierId]).catch(() => {});
    }
  }
  if (server) await new Promise((resolve) => server.close(resolve)).catch(() => {});
  await pool.end();
});

// ---- Tests -----------------------------------------------------------------

test('employees GET returns a paginated envelope with total and limited rows', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const first = await get(`/api/hr/employees?search=${EPFX}&limit=2&offset=0`);
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);
  assert.equal(first.body.limit, 2);
  assert.equal(first.body.offset, 0);
  assert.equal(first.body.total, 6, 'search filter isolates exactly the 6 seeded employees');
  assert.equal(first.body.data.length, 2);
  assert.ok(Array.isArray(first.body.data));

  const second = await get(`/api/hr/employees?search=${EPFX}&limit=2&offset=2`);
  assert.equal(second.body.data.length, 2);
  const page1Ids = new Set(first.body.data.map((e) => e.id));
  for (const row of second.body.data) {
    assert.ok(!page1Ids.has(row.id), `row ${row.id} must not repeat across pages`);
  }

  // REST-style ?page=1..N maps to the same window as ?offset=.
  const byPage = await get(`/api/hr/employees?search=${EPFX}&limit=2&page=3`);
  assert.deepEqual(
    byPage.body.data.map((e) => e.id).sort(),
    (await get(`/api/hr/employees?search=${EPFX}&limit=2&offset=4`)).body.data.map((e) => e.id).sort(),
    'page=3&limit=2 must equal offset=4&limit=2'
  );

  // No params at all: still a valid envelope, default limit 50, offset 0.
  const defaults = await get('/api/hr/employees');
  assert.equal(defaults.body.success, true);
  assert.equal(defaults.body.limit, 50);
  assert.equal(defaults.body.offset, 0);
  assert.ok(Array.isArray(defaults.body.data));
  assert.ok(defaults.body.data.length <= 50);
  assert.ok(defaults.body.total >= 6);
});

test('supplier-invoices GET returns a paginated envelope with total and limited rows', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const first = await get(`/api/supplier-invoices?search=${BPFX}&limit=2&offset=0`);
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);
  assert.equal(first.body.limit, 2);
  assert.equal(first.body.offset, 0);
  assert.equal(first.body.total, 5, 'search filter isolates exactly the 5 seeded bills');
  assert.equal(first.body.data.length, 2);

  const second = await get(`/api/supplier-invoices?search=${BPFX}&limit=2&offset=2`);
  const page1Ids = new Set(first.body.data.map((b) => b.id));
  for (const row of second.body.data) {
    assert.ok(!page1Ids.has(row.id), `bill ${row.id} must not repeat across pages`);
  }

  // Sorting is server-side and whitelisted: due_date ascending, within the
  // filtered set, with a stable tie-break on id.
  const sorted = await get(`/api/supplier-invoices?search=${BPFX}&limit=10&offset=0&sort_by=due_date&sort_dir=asc`);
  assert.equal(sorted.body.data.length, 5);
  const dates = sorted.body.data.map((b) => new Date(b.due_date).getTime());
  for (let i = 1; i < dates.length; i++) {
    assert.ok(dates[i] >= dates[i - 1], `due_date must be ascending, broke at index ${i}`);
  }

  const defaults = await get('/api/supplier-invoices');
  assert.equal(defaults.body.success, true);
  assert.equal(defaults.body.limit, 50);
  assert.ok(Array.isArray(defaults.body.data));
});

test('filters compose with pagination and the page-size cap holds', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // status filter + search + pagination: 3 of the 6 seeded employees are TERMINATED.
  const term = await get(`/api/hr/employees?search=${EPFX}&status=TERMINATED&limit=10&offset=0`);
  assert.equal(term.body.success, true);
  assert.equal(term.body.total, 3);
  assert.equal(term.body.data.length, 3);
  for (const row of term.body.data) {
    assert.equal(row.status, 'TERMINATED');
  }

  // And the ACTIVE half, sorted by first_name ascending.
  const active = await get(`/api/hr/employees?search=${EPFX}&status=ACTIVE&sort_by=first_name&sort_dir=asc&limit=10`);
  assert.equal(active.body.total, 3);
  const names = active.body.data.map((e) => e.first_name);
  for (let i = 1; i < names.length; i++) {
    assert.ok(names[i] >= names[i - 1], `first_name must be ascending, broke at index ${i}`);
  }

  // DRAFT bills compose the same way.
  const drafts = await get(`/api/supplier-invoices?search=${BPFX}&status=DRAFT&limit=10&offset=0`);
  assert.equal(drafts.body.total, 3);
  for (const row of drafts.body.data) {
    assert.equal(row.status, 'DRAFT');
  }

  // Page size is capped server-side; the cap must be reflected back in limit.
  const capped = await get(`/api/supplier-invoices?limit=99999&offset=0`);
  assert.equal(capped.body.limit, 200);
  assert.ok(capped.body.data.length <= 200);
});
