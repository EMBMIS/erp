// Counterfactual decision engine.
//
// Two things are worth testing here, and only one of them is the arithmetic.
//
//   1. THE GUARANTEE. A simulation applies real writes to real rows and must
//      leave the database byte-for-byte unchanged. Everything else this feature
//      claims rests on that, so the DB-backed test below seeds a bill, runs a
//      branch that pays it, and asserts the bill is still unpaid and the cash
//      account still has its original balance afterwards. If that test ever
//      fails, the feature is not "slightly wrong" — it is issuing payments.
//
//   2. THE RANKING. Scores must be reproducible arithmetic over measured
//      deltas, constraint violations must disqualify rather than merely
//      penalise, and a branch the database refuses must survive as a result
//      rather than vanish. Those are pure functions and run with no database.
//
// Run on its own:  node --test tests/counterfactual.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const scoring = require('../services/ai/counterfactual/scoring');
const branches = require('../services/ai/counterfactual/branches');
const { catalogue, effects } = require('../services/ai/counterfactual/effects');
const observables = require('../services/ai/counterfactual/observables');
const { withShadow } = require('../services/ai/counterfactual/shadowLedger');
const { pool } = require('../config/database');

// ---------------------------------------------------------------------------
// Pure logic — no database.
// ---------------------------------------------------------------------------

test('scoring: money terms are normalised against the company\'s own scale', () => {
  const small = scoring.scoreDeltas({ cash: 50000 }, { cash: 5000 }, { cash: 1 });
  const large = scoring.scoreDeltas({ cash: 5000000 }, { cash: 500000 }, { cash: 1 });
  // Ten percent more cash scores the same whether the company holds 50k or 5m —
  // otherwise a ranking could never be compared across companies or over time.
  assert.equal(small.score, large.score);
});

test('scoring: counts are not normalised', () => {
  const a = scoring.scoreDeltas({ cash: 50000 }, { stockouts: 1 }, { stockouts: -3 });
  const b = scoring.scoreDeltas({ cash: 5000000 }, { stockouts: 1 }, { stockouts: -3 });
  assert.equal(a.score, -3);
  assert.equal(b.score, -3);
});

test('scoring: contributions explain the score and sum to it', () => {
  const { score, contributions } = scoring.scoreDeltas(
    { cash: 100000 },
    { cash: 20000, ap_overdue: -10000, stockouts: 1 },
    { cash: 1, ap_overdue: -0.6, stockouts: -3 }
  );
  const summed = contributions.reduce((s, c) => s + c.points, 0);
  assert.ok(Math.abs(summed - score) < 1e-6, `contributions ${summed} should sum to score ${score}`);
  // Ranked by magnitude, so the first line of an explanation is the biggest mover.
  assert.equal(contributions[0].metric, 'stockouts');
});

test('violations: negative cash disqualifies', () => {
  const v = scoring.violations({ cash: 1000, stockouts: 0, ledger_difference: 0 },
    { cash: -50, stockouts: 0, ledger_difference: 0 }, { cash: -1050 });
  assert.ok(v.some((x) => x.rule === 'cash_negative'));
});

test('violations: only stockouts the branch CAUSES count against it', () => {
  const baseline = { cash: 1000, stockouts: 3, ledger_difference: 0 };
  const unchanged = scoring.violations(baseline, { cash: 1000, stockouts: 3, ledger_difference: 0 }, {});
  assert.equal(unchanged.filter((v) => v.rule === 'causes_stockout').length, 0);

  const caused = scoring.violations(baseline, { cash: 1000, stockouts: 4, ledger_difference: 0 }, {});
  assert.equal(caused.filter((v) => v.rule === 'causes_stockout').length, 1);
});

test('violations: a one-sided posting trips the ledger tripwire', () => {
  const v = scoring.violations(
    { cash: 1000, stockouts: 0, ledger_difference: 0 },
    { cash: 1000, stockouts: 0, ledger_difference: 250 },
    {}
  );
  assert.ok(v.some((x) => x.rule === 'ledger_unbalanced'));
});

test('rank: infeasible branches lose to feasible ones however well they score', () => {
  const ranked = scoring.rank([
    { label: 'reckless', score: 99, feasible: false },
    { label: 'sound', score: 0.1, feasible: true },
    { label: 'refused', score: null, feasible: false, apply_error: 'constraint' },
  ]);
  assert.deepEqual(ranked.map((b) => b.label), ['sound', 'reckless', 'refused']);
  assert.deepEqual(ranked.map((b) => b.rank), [1, 2, 3]);
});

test('explain: a near-tie is reported as a judgement call, not a winner', () => {
  const text = scoring.explain(
    { label: 'A', score: 1.0, contributions: [{ metric: 'cash', delta: 5000 }] },
    { label: 'B', score: 0.99, violations: [] }
  );
  assert.match(text, /judgement call/);
});

test('branch generation: a payment run never proposes spending cash it does not have', () => {
  const bills = [
    { bill_number: 'B1', outstanding: 6000, due_date: '2026-01-01', days_late: 40 },
    { bill_number: 'B2', outstanding: 6000, due_date: '2026-02-01', days_late: 10 },
    { bill_number: 'B3', outstanding: 6000, due_date: '2026-03-01', days_late: 0 },
  ];
  for (const branch of branches.paymentRunBranches(bills, 10000)) {
    const spend = branch.effects
      .filter((e) => e.effect === 'pay_supplier_invoice')
      .reduce((s, e) => s + Number(e.args.amount || 0), 0);
    assert.ok(spend <= 10000 + 1e-9, `${branch.label} would spend ${spend} of a 10000 budget`);
  }
});

test('branch generation: the null branch is always offered', () => {
  const bills = [{ bill_number: 'B1', outstanding: 100, due_date: '2026-01-01', days_late: 5 }];
  const labels = branches.paymentRunBranches(bills, 1000).map((b) => b.label);
  // Without a "do nothing" control there is no way to tell whether acting beats
  // waiting, and every branch looks like an improvement.
  assert.ok(labels.some((l) => l.startsWith('Do nothing')));
});

test('branch generation: replenishment branches all carry the same demand', () => {
  const items = [
    { item_code: 'X1', on_hand: 1, reorder_point: 10, unit_price: 5 },
    { item_code: 'X2', on_hand: 0, reorder_point: 4, unit_price: 2 },
  ];
  const generated = branches.replenishmentBranches(items);
  const demandOf = (b) => b.effects.filter((e) => e.effect === 'consume_stock')
    .map((e) => `${e.args.item_code}:${e.args.quantity}`).sort().join(',');
  const first = demandOf(generated[0]);
  // If the "hold the cash" branch faced no demand it would win every time, and
  // the comparison would be meaningless.
  for (const b of generated) assert.equal(demandOf(b), first, `${b.label} faces different demand`);
});

test('branch generation: no scenario, no crash — an empty business yields no branches', () => {
  assert.deepEqual(branches.paymentRunBranches([], 1000), []);
  assert.deepEqual(branches.collectionsBranches([]), []);
  assert.deepEqual(branches.replenishmentBranches([]), []);
});

test('scenario inference routes a question to a family of courses of action', () => {
  assert.equal(branches.inferScenario('which supplier bills should we pay this week?'), 'payment_run');
  assert.equal(branches.inferScenario('how do we bring the receivables in faster?'), 'collections');
  assert.equal(branches.inferScenario('should we reorder the low stock lines?'), 'replenishment');
  assert.equal(branches.inferScenario('we are tight this month, what should we do?'), 'open');
});

test('the effect catalogue is closed — a branch cannot name an effect that does not exist', () => {
  const names = catalogue().map((e) => e.name);
  assert.ok(names.length >= 5);
  for (const name of names) assert.equal(typeof effects[name].apply, 'function');
  assert.equal(effects.definitely_not_an_effect, undefined);
});

test('effects never reach for the pool — the guarantee depends on it', () => {
  // Read as text rather than mocked: the failure this guards against is an
  // effect module that acquires its OWN connection and therefore commits
  // outside the shadow transaction. That is invisible to a behavioural test
  // against a mock client, and catastrophic in production.
  const src = require('node:fs').readFileSync(
    require.resolve('../services/ai/counterfactual/effects.js'), 'utf8'
  );
  assert.equal(/require\(['"].*config\/database/.test(src), false,
    'effects.js must not import the database pool — it operates only on the client it is handed');
});

test('the shadow ledger contains no COMMIT', () => {
  const src = require('node:fs').readFileSync(
    require.resolve('../services/ai/counterfactual/shadowLedger.js'), 'utf8'
  );
  assert.equal(/query\(\s*['"`]COMMIT/i.test(src), false, 'shadowLedger.js must never commit');
});

// ---------------------------------------------------------------------------
// The guarantee, against a real database.
// ---------------------------------------------------------------------------

let dbAvailable = false;
let companyId = null;
let userId = null;
let seeded = null;

before(async () => {
  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
  } catch (_) {
    return; // no database in this environment; the pure tests above still ran
  }

  const { rows: companies } = await pool.query('SELECT id FROM companies ORDER BY created_at LIMIT 1');
  const { rows: users } = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
  if (!companies[0] || !users[0]) { dbAvailable = false; return; }
  companyId = companies[0].id;
  userId = users[0].id;

  // Deliberately not wrapped in a catch: a query that fails for a schema
  // reason must surface, not silently skip the three tests that carry the
  // whole safety claim. "Skipped" and "passed" look identical in a CI summary.
  const { rows: suppliers } = await pool.query(
    'SELECT id FROM suppliers WHERE company_id = $1 LIMIT 1', [companyId]
  );
  if (!suppliers[0]) { dbAvailable = false; return; }

  const billNumber = `CF-TEST-${Date.now().toString(36).toUpperCase()}`;
  const { rows } = await pool.query(
    `INSERT INTO supplier_invoices
       (company_id, bill_number, supplier_id, invoice_date, due_date, subtotal, total_amount,
        paid_amount, status, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE - 40, CURRENT_DATE - 10, 1500, 1500, 0, 'APPROVED', $4)
     RETURNING id, bill_number`,
    [companyId, billNumber, suppliers[0].id, userId]
  );
  seeded = rows[0];
});

after(async () => {
  if (seeded) {
    await pool.query('DELETE FROM supplier_invoices WHERE id = $1', [seeded.id]).catch(() => {});
  }
  await pool.end().catch(() => {});
});

test('a simulated payment is measured and then does not exist', async (t) => {
  if (!dbAvailable || !seeded) return t.skip('no seeded database');

  const before = await snapshot();

  const result = await withShadow({ companyId, userId }, async (session) => {
    const baseline = await session.measure();
    const branch = {
      label: 'pay the seeded bill',
      effects: [{ effect: 'pay_supplier_invoice', args: { bill_number: seeded.bill_number } }],
    };
    const run = await session.runBranch(branch);
    return { baseline, ...run };
  });

  assert.equal(result.apply_error, null, `branch failed to apply: ${result.apply_error}`);
  assert.ok(result.measured, 'the branch produced no measurement');

  // The measurement is real: 1500 left the cash position and the payables fell.
  const deltas = observables.diff(result.baseline, result.measured);
  assert.ok(deltas.cash <= -1499.99 && deltas.cash >= -1500.01,
    `cash should fall by 1500, moved by ${deltas.cash}`);
  assert.ok(deltas.ap_open <= -1499.99, `payables should fall by 1500, moved by ${deltas.ap_open}`);

  // And it is gone: nothing about the bill, the payment table, or the cash
  // account survived the transaction.
  const after = await snapshot();
  assert.deepEqual(after, before, 'the shadow transaction changed committed state');
});

test('a branch the database refuses is kept as a result, not lost as an error', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const run = await withShadow({ companyId, userId }, (session) => session.runBranch({
    label: 'pay a bill that does not exist',
    effects: [{ effect: 'pay_supplier_invoice', args: { bill_number: 'NO-SUCH-BILL-EVER' } }],
  }));

  assert.equal(run.measured, null);
  assert.match(run.apply_error, /No supplier invoice matched/);
});

test('one branch cannot see another branch\'s effects', async (t) => {
  if (!dbAvailable || !seeded) return t.skip('no seeded database');

  const { first, second } = await withShadow({ companyId, userId }, async (session) => {
    const branch = {
      label: 'pay it',
      effects: [{ effect: 'pay_supplier_invoice', args: { bill_number: seeded.bill_number } }],
    };
    // Running the same branch twice must give the same answer. If the savepoint
    // did not unwind, the second run would find the bill already paid and
    // measure a cash movement of zero — branches would silently compound in
    // the order they happened to be generated.
    const a = await session.runBranch(branch);
    const b = await session.runBranch(branch);
    return { first: a.measured, second: b.measured };
  });

  assert.equal(first.cash, second.cash);
  assert.equal(first.ap_open, second.ap_open);
});

/** Everything a simulated payment would touch, as committed state. */
async function snapshot() {
  const bill = await pool.query(
    'SELECT paid_amount::float AS paid, status, due_date FROM supplier_invoices WHERE id = $1',
    [seeded.id]
  );
  const cash = await pool.query(
    `SELECT COALESCE(SUM(current_balance), 0)::float AS c
       FROM chart_of_accounts
      WHERE company_id = $1 AND account_type = 'ASSET' AND account_subtype = 'CASH'
        AND status = 'ACTIVE' AND deleted_at IS NULL`,
    [companyId]
  );
  const payments = await pool.query(
    'SELECT COUNT(*)::int AS n FROM supplier_payments WHERE company_id = $1',
    [companyId]
  );
  return {
    bill: bill.rows[0],
    cash: cash.rows[0].c,
    payments: payments.rows[0].n,
  };
}
