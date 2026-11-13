// The company home.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//     Every figure comes from a row, and every health verdict is a threshold
//     over a counted fact — the same verdict tomorrow for the same data.
//
// The verdicts are the part worth testing. A status band that only ever says
// "healthy" is decoration, and it would pass any test that merely checked the
// endpoint returns something. So this seeds the specific conditions each rule
// is looking for and asserts the verdict actually moves.
//
// Run on its own:  node --test tests/platformCompanyHome.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { pool } = require('../config/database');
const seedHelper = require('./helpers/platformSeed');
const app = require('./helpers/platformApp');
const companyHome = require('../services/platform/companyHome');

let available = false;
let seeded = null;
const planted = [];

before(async () => {
  available = await app.platformAvailable();
  if (!available) return;
  seeded = await seedHelper.seed();
});

after(async () => {
  const owner = available ? app.ownerPool() : null;
  // Planted rows go before the seed does, so a failed run does not leave a
  // company's figures quietly wrong for the next one.
  for (const { table, id } of planted.reverse()) {
    await owner.query(`DELETE FROM ${table} WHERE id = $1`, [id]).catch(() => {});
  }
  if (seeded) await seedHelper.cleanup(seeded);
  await pool.end().catch(() => {});
});

const dbTest = (name, fn) => test(name, async (t) => {
  if (!available) { t.skip('no database with the platform schema'); return; }
  await fn(t);
});

/** Insert a row as the owner (bypassing RLS) and remember it for cleanup. */
async function plant(table, columns) {
  const owner = app.ownerPool();
  const keys = Object.keys(columns);
  const { rows } = await owner.query(
    `INSERT INTO ${table} (${keys.join(', ')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    keys.map((k) => columns[k])
  );
  planted.push({ table, id: rows[0].id });
  return rows[0].id;
}

// --- the delta, which has an edge case that matters ------------------------
test('a delta compares two COMPLETE months, and is omitted when it cannot', () => {
  // Twelve buckets: [...ten, lastComplete, thisMonthSoFar]. Comparing the
  // partial current month against a full one reports a collapse every time
  // somebody opens the page early in the month, so it is not what happens.
  const points = [0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 150, 12];
  assert.equal(companyHome.delta(points), 50);

  // No previous month to compare against: no honest percentage exists, so
  // there is no number rather than a confident zero.
  assert.equal(companyHome.delta([0, 0, 5]), null);
  assert.equal(companyHome.delta([7]), null);
});

// --- the verdicts ----------------------------------------------------------
test('every health rule can return something other than healthy', () => {
  // The bug this catches: a threshold written so that no real data ever
  // crosses it, leaving a band that is decorative and nobody notices.
  for (const rule of companyHome.RULES) {
    const states = new Set();
    // Facts are plain numbers, so the rule can be exercised without a
    // database at all — which is the point of keeping them separate.
    for (const facts of [
      { overdue: 0, open: 0, late: 0, outstanding: 0, headcount: 0, joined: 0, unonboarded: 0 },
      { overdue: 0, open: 10, late: 0, outstanding: 1000, headcount: 10, joined: 2, unonboarded: 0 },
      { overdue: 1, open: 10, late: 1, outstanding: 1000, headcount: 10, joined: 0, unonboarded: 1 },
      { overdue: 900, open: 10, late: 50, outstanding: 1000, headcount: 10, joined: 0, unonboarded: 9 },
    ]) {
      states.add(rule.verdict(facts).state);
    }
    assert.ok(states.size >= 3,
      `${rule.key} only ever produces ${[...states].join('/')} — its thresholds cannot be crossed`);
    assert.ok(states.has('attention') || states.has('risk'),
      `${rule.key} never raises anything`);
  }
});

test('a verdict always says what the number was', () => {
  for (const rule of companyHome.RULES) {
    const { line } = rule.verdict({ overdue: 3, open: 10, late: 3, outstanding: 5000, headcount: 12, joined: 1, unonboarded: 3 });
    assert.match(line, /\d/, `${rule.key} produced a verdict with no figure in it: "${line}"`);
  }
});

// --- against a real database -----------------------------------------------
dbTest('the home is built from rows, and an empty company says so honestly', async () => {
  const home = await companyHome.build(seeded.companyB.id);

  assert.ok(Array.isArray(home.hero));
  assert.equal(home.metrics.length, 6);
  assert.ok(home.health.length >= 1);

  // A metric with no data is null or zero — never invented, never a
  // placeholder that reads like a real figure.
  home.metrics.forEach((m) => {
    assert.ok(m.value === null || typeof m.value === 'number', `${m.key} has a non-numeric value`);
    assert.ok(Array.isArray(m.series));
    m.series.forEach((p) => assert.equal(typeof p, 'number'));
  });

  // Hero stats are omitted when they are zero rather than shown as "0
  // Suppliers", which reads like a broken page rather than a new company.
  home.hero.forEach((s) => assert.ok(s.value > 0));
});

dbTest('an overdue invoice moves Finance off healthy, and it moves back', async () => {
  const before = await companyHome.build(seeded.companyA.id);
  const financeBefore = before.health.find((h) => h.key === 'finance');
  assert.ok(financeBefore);

  const customerId = await plant('customers', {
    company_id: seeded.companyA.id,
    customer_code: `HOME${Date.now().toString(36).slice(-6).toUpperCase()}`,
    customer_name: 'Home Probe Customer',
  });
  const invoiceId = await plant('customer_invoices', {
    company_id: seeded.companyA.id,
    customer_id: customerId,
    invoice_number: `HOME-${Date.now()}`,
    invoice_date: new Date(Date.now() - 90 * 86400000),
    due_date: new Date(Date.now() - 60 * 86400000),
    // outstanding_amount is GENERATED as total_amount - paid_amount, so it is
    // set by not paying rather than by writing it. Worth knowing: it means the
    // Finance rule reads a figure the database keeps consistent, not one an
    // importer could leave stale.
    subtotal: 10000,
    total_amount: 10000,
    paid_amount: 0,
    status: 'SENT',
    created_by: seeded.userA.id,
  });

  const after = await companyHome.build(seeded.companyA.id);
  const finance = after.health.find((h) => h.key === 'finance');
  assert.notEqual(finance.state, 'healthy', 'an invoice 60 days past due did not register');
  assert.ok(['attention', 'risk'].includes(finance.state), `unexpected state ${finance.state}`);
  // The sentence has to name the money, or a person cannot act on it.
  assert.match(finance.line, /past due/);
  assert.match(finance.line, /\$/);

  // Receivables is a figure, not a verdict, and it moved too.
  const receivables = after.metrics.find((m) => m.key === 'receivables');
  assert.ok(receivables.value >= 10000);

  // Paying it puts the verdict back — the rule reads current data, it does
  // not latch.
  await app.ownerPool().query(
    'UPDATE customer_invoices SET paid_amount = total_amount WHERE id = $1', [invoiceId]
  );
  const settled = await companyHome.build(seeded.companyA.id);
  assert.equal(settled.health.find((h) => h.key === 'finance').state,
    financeBefore.state, 'the verdict did not return once the invoice was settled');
});

dbTest('one company\'s home never counts another company\'s rows', async () => {
  const customerId = await plant('customers', {
    company_id: seeded.companyA.id,
    customer_code: `ISO${Date.now().toString(36).slice(-6).toUpperCase()}`,
    customer_name: 'Isolation Probe',
  });
  await plant('customer_invoices', {
    company_id: seeded.companyA.id,
    customer_id: customerId,
    invoice_number: `ISO-${Date.now()}`,
    invoice_date: new Date(Date.now() - 30 * 86400000),
    due_date: new Date(Date.now() - 10 * 86400000),
    subtotal: 999999,
    total_amount: 999999,
    paid_amount: 0,
    status: 'SENT',
    created_by: seeded.userA.id,
  });

  const theirs = await companyHome.build(seeded.companyB.id);
  const receivables = theirs.metrics.find((m) => m.key === 'receivables');
  assert.ok(receivables.value < 999999, 'company B can see company A\'s receivables');
  assert.equal(theirs.health.find((h) => h.key === 'finance').state, 'healthy');
});
