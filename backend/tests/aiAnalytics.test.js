// Tests for the AI analytics surface: statistics, forecasting, duplicate
// detection, journal-entry suggestion and the NL-query SQL guardrails.
//
// The pure-logic tests (stats, SQL validation) always run. The rest need a
// database and self-skip without one, matching the other integration suites.
// Everything seeded is tracked and removed in teardown.
//
// Run on its own:  npm run test:ai

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const stats = require('../services/ai/stats');
const nlQuery = require('../services/ai/nlQuery');
const forecasting = require('../services/ai/forecasting');
const duplicates = require('../services/ai/duplicateDetection');
const journalSuggestions = require('../services/ai/journalSuggestions');
const { pool } = require('../config/database');

// ===========================================================================
// Pure logic — statistics
// ===========================================================================

test('mean/median/stdDev handle empty and single-value input without throwing', () => {
  assert.equal(stats.mean([]), 0);
  assert.equal(stats.median([]), 0);
  assert.equal(stats.stdDev([]), 0);
  assert.equal(stats.stdDev([5]), 0);
  assert.equal(stats.median([3, 1, 2]), 2);
  assert.equal(stats.median([4, 1, 3, 2]), 2.5);
});

test('MAD resists the outlier that inflates standard deviation', () => {
  const clean = [10, 11, 10, 12, 11];
  const withOutlier = [...clean, 900];

  // The outlier roughly triples nothing in the robust measure but explodes stdDev.
  assert.ok(stats.stdDev(withOutlier) > 300, 'stdDev should be dragged up by the outlier');
  assert.ok(stats.mad(withOutlier) < 5, 'MAD should stay near the bulk of the data');
});

test('outlierScores flags a planted anomaly and leaves normal values near zero', () => {
  const scores = stats.outlierScores([10, 11, 10, 12, 11, 900]);
  const normal = scores.slice(0, 5);
  const anomaly = scores[5];

  normal.forEach((s) => assert.ok(Math.abs(s) < 3, `normal value scored ${s}`));
  assert.ok(anomaly > 10, `planted anomaly scored only ${anomaly}`);
});

test('linearRegression recovers a known slope and intercept', () => {
  const fit = stats.linearRegression([2, 4, 6, 8, 10]); // y = 2x + 2
  assert.equal(stats.round2(fit.slope), 2);
  assert.equal(stats.round2(fit.intercept), 2);
  assert.equal(fit.r2, 1);
});

test('forecast refuses to call two points a trend', () => {
  const f = stats.forecast([10, 20], 3);
  assert.equal(f.sufficient, false);
  assert.equal(f.method, 'insufficient-data-average');
  // All projected points are the flat average — not an extrapolated line.
  assert.deepEqual(f.points.map((p) => p.value), [15, 15, 15]);
  assert.match(f.note, /not a trend projection/);
});

test('forecast projects a real trend once there is enough history', () => {
  const f = stats.forecast([10, 20, 30, 40, 50, 60], 2);
  assert.equal(f.sufficient, true);
  assert.equal(f.method, 'linear-regression');
  assert.deepEqual(f.points.map((p) => p.value), [70, 80]);
  assert.equal(f.confidence, 'high');
});

test('forecast reports low confidence and a wide interval on noisy history', () => {
  const noisy = [10, 90, 15, 85, 20, 80, 25];
  const f = stats.forecast(noisy, 1);
  assert.equal(f.confidence, 'low');
  const [point] = f.points;
  assert.ok(point.upper - point.lower > 50, 'a noisy series must produce a wide interval');
});

test('forecast handles an all-zero series without dividing by zero', () => {
  const f = stats.forecast([0, 0, 0, 0, 0], 2);
  assert.ok(Number.isFinite(f.points[0].value));
  assert.equal(f.points[0].value, 0);
});

// ===========================================================================
// Pure logic — name similarity
// ===========================================================================

test('normalizeName strips case, punctuation, accents and legal suffixes', () => {
  assert.equal(stats.normalizeName('Café Münster GmbH'), 'cafe munster');
  assert.equal(stats.normalizeName('ACME Trading, Ltd.'), 'acme trading');
});

test('nameSimilarity treats legal-suffix variants as the same company', () => {
  assert.equal(stats.nameSimilarity('Acme Ltd', 'ACME Limited.'), 1);
  assert.ok(stats.nameSimilarity('Acme Trading Ltd', 'Acme Trading Inc') >= 0.9);
});

test('nameSimilarity keeps genuinely different companies apart', () => {
  assert.ok(stats.nameSimilarity('Acme Corp', 'Globex Inc') < 0.4);
  assert.ok(stats.nameSimilarity('Northwind Traders', 'Contoso Ltd') < 0.4);
});

test('nameSimilarity survives token reordering', () => {
  assert.ok(stats.nameSimilarity('Smith and Sons', 'Sons and Smith') > 0.7);
});

// ===========================================================================
// NL query — SQL guardrails. These are security controls, so they are asserted
// as adversarial cases rather than happy-path examples.
// ===========================================================================

test('validateSql allows ordinary reporting queries', () => {
  for (const sql of [
    'SELECT customer_name FROM customers WHERE deleted_at IS NULL',
    'SELECT c.customer_name, SUM(i.outstanding_amount) FROM customer_invoices i JOIN customers c ON c.id = i.customer_id GROUP BY 1',
    'WITH open AS (SELECT id FROM customer_invoices) SELECT * FROM open LIMIT 10',
  ]) {
    assert.equal(nlQuery.validateSql(sql).ok, true, `should allow: ${sql}`);
  }
});

test('validateSql appends a row cap when the query has none', () => {
  const r = nlQuery.validateSql('SELECT customer_name FROM customers');
  assert.equal(r.ok, true);
  assert.match(r.sql, new RegExp(`LIMIT ${nlQuery.MAX_ROWS}`));
});

test('validateSql rejects writes, DDL and stacked statements', () => {
  const attacks = [
    'UPDATE customers SET customer_name = 1',
    'DELETE FROM customers',
    'DROP TABLE customers',
    'SELECT 1 FROM customers; DROP TABLE customers',
    'WITH x AS (INSERT INTO customers(customer_name) VALUES (1) RETURNING *) SELECT * FROM x',
  ];
  for (const sql of attacks) {
    assert.equal(nlQuery.validateSql(sql).ok, false, `should have blocked: ${sql}`);
  }
});

test('validateSql enforces the table allowlist', () => {
  for (const sql of [
    'SELECT * FROM users',
    'SELECT * FROM api_keys',
    'SELECT * FROM schema_migrations',
    'SELECT * FROM information_schema.columns',
    'SELECT * FROM pg_catalog.pg_shadow',
  ]) {
    assert.equal(nlQuery.validateSql(sql).ok, false, `should have blocked: ${sql}`);
  }
});

test('validateSql blocks file access, dblink and denial-of-service functions', () => {
  for (const sql of [
    'SELECT pg_read_file(0) FROM customers',
    'SELECT pg_sleep(60) FROM customers',
    'SELECT dblink(1,2) FROM customers',
  ]) {
    assert.equal(nlQuery.validateSql(sql).ok, false, `should have blocked: ${sql}`);
  }
});

test('validateSql blocks credential columns, including inside snake_case names', () => {
  // `\btoken\b` does NOT match supplier_delivery_token — these portal tokens
  // authenticate supplier access, so this is an account-takeover path.
  for (const sql of [
    'SELECT password_hash FROM customers',
    'SELECT supplier_delivery_token FROM purchase_orders',
    'SELECT supplier_delivery_token_expires_at FROM purchase_orders',
  ]) {
    assert.equal(nlQuery.validateSql(sql).ok, false, `should have blocked: ${sql}`);
  }
});

test('validateSql cannot be evaded by hiding a table reference in a comment', () => {
  // The comment is stripped before scanning, so the UNION never reaches the DB.
  const evasion = 'SELECT 1 FROM customers --\nUNION SELECT 1 FROM users';
  assert.equal(nlQuery.validateSql(evasion).ok, false);
});

test('validateSql rejects a query that touches no known reporting table', () => {
  assert.equal(nlQuery.validateSql('SELECT 1').ok, false);
});

// ===========================================================================
// Database-backed tests
// ===========================================================================

let dbAvailable = false;
let userId = null;
const created = {
  supplierIds: [],
  customerIds: [],
  itemIds: [],
  inventoryItemIds: [],
  warehouseTransactionIds: [],
};

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (users.rows.length) {
      userId = users.rows[0].id;
      dbAvailable = true;
    }
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    // Children first — these have FKs back to the rows removed below.
    for (const id of created.warehouseTransactionIds) {
      await pool.query('DELETE FROM warehouse_transaction_items WHERE warehouse_transaction_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM warehouse_transactions WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.inventoryItemIds) {
      await pool.query('DELETE FROM inventory_items WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.itemIds) {
      await pool.query('DELETE FROM items WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.supplierIds) {
      await pool.query('DELETE FROM suppliers WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.customerIds) {
      await pool.query('DELETE FROM customers WHERE id = $1', [id]).catch(() => {});
    }
  }
  await pool.end();
});

test('read-only execution physically prevents a write, independent of validation', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  await assert.rejects(
    () => nlQuery.runReadOnly("UPDATE customers SET customer_name = 'x'"),
    /read-only transaction/,
    'the transaction itself must reject writes as a second line of defence'
  );
});

test('query results redact credential columns even when selected via *', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const result = await nlQuery.runReadOnly('SELECT * FROM purchase_orders LIMIT 3');
  if (!result.rows.length) return t.skip('no purchase orders to inspect');

  assert.ok(
    result.redacted_columns.includes('supplier_delivery_token'),
    'the portal token column should have been redacted'
  );
  for (const row of result.rows) {
    assert.equal(row.supplier_delivery_token, '[redacted]');
  }
});

test('duplicate detection finds a seeded near-duplicate supplier', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const mk = async (name, email) => {
    const code = `DUPTEST-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await pool.query(
      `INSERT INTO suppliers (supplier_code, legal_name, email, status, created_by)
       VALUES ($1, $2, $3, 'ACTIVE', $4) RETURNING id`,
      [code, name, email, userId]
    );
    created.supplierIds.push(rows[0].id);
    return rows[0].id;
  };

  // The classic case: same company, different legal suffix and punctuation.
  const aId = await mk('Zentara Industrial Supplies Ltd', `zen-${Date.now()}@example.test`);
  const bId = await mk('ZENTARA Industrial Supplies, Limited.', `other-${Date.now()}@example.test`);

  const result = await duplicates.findDuplicateSuppliers({ limit: 100 });
  const pair = result.by_name.find(
    (p) => p.records.some((r) => r.id === aId) && p.records.some((r) => r.id === bId)
  );

  assert.ok(pair, 'the seeded near-duplicate supplier pair should have been detected');
  assert.ok(pair.score >= 0.9, `expected a high similarity score, got ${pair.score}`);
  assert.equal(pair.confidence, 'high');
});

test('duplicate detection catches a shared email even when names differ entirely', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const shared = `shared-${Date.now()}@example.test`;
  const mk = async (name) => {
    const code = `DUPTEST-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await pool.query(
      `INSERT INTO suppliers (supplier_code, legal_name, email, status, created_by)
       VALUES ($1, $2, $3, 'ACTIVE', $4) RETURNING id`,
      [code, name, shared, userId]
    );
    created.supplierIds.push(rows[0].id);
    return rows[0].id;
  };

  const aId = await mk('Blue Harbour Logistics');
  const bId = await mk('Redstone Freight Partners');

  const result = await duplicates.findDuplicateSuppliers({ limit: 100 });
  const pair = result.by_shared_email.find(
    (p) => p.records.some((r) => r.id === aId) && p.records.some((r) => r.id === bId)
  );

  assert.ok(pair, 'suppliers sharing an email address should be flagged despite dissimilar names');
  assert.equal(pair.confidence, 'high');
});

test('duplicate detection does not flag genuinely distinct suppliers', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const mk = async (name) => {
    const code = `DUPTEST-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await pool.query(
      `INSERT INTO suppliers (supplier_code, legal_name, email, status, created_by)
       VALUES ($1, $2, $3, 'ACTIVE', $4) RETURNING id`,
      [code, name, `uniq-${Math.random().toString(36).slice(2)}@example.test`, userId]
    );
    created.supplierIds.push(rows[0].id);
    return rows[0].id;
  };

  const aId = await mk('Vantage Precision Engineering');
  const bId = await mk('Kestrel Chemical Distribution');

  const result = await duplicates.findDuplicateSuppliers({ limit: 100 });
  const falsePositive = result.by_name.find(
    (p) => p.records.some((r) => r.id === aId) && p.records.some((r) => r.id === bId)
  );
  assert.equal(falsePositive, undefined, 'unrelated suppliers must not be reported as duplicates');
});

test('forecasting reports insufficient data honestly rather than inventing a trend', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const result = await forecasting.forecastProfitAndLoss({ horizon: 3 });

  assert.ok(Array.isArray(result.projected));
  if (!result.sufficient_data) {
    assert.ok(result.caveat, 'an unreliable projection must carry a caveat');
    // The caveat must name the weak series rather than mislabel both.
    assert.match(result.caveat, /Revenue:|Expense:/);
  }
});

test('anomaly detection distinguishes "found nothing" from "could not run"', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const result = await forecasting.detectAmountAnomalies({});

  assert.equal(typeof result.analysis_ran, 'boolean');
  if (!result.analysis_ran) {
    // A scan that tested nothing must not read as a clean bill of health.
    assert.match(result.note, /not a clean result|nothing to analyse/);
  }
});

test('journal suggestions say so plainly when there is no basis to suggest', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const result = await journalSuggestions.suggestAccounts({
    description: `Utterly unprecedented transaction ${Math.random().toString(36).slice(2)}`,
    allow_llm: false,
  });

  assert.deepEqual(result.suggestions, []);
  assert.match(result.note, /manual coding/);
});

test('a proposed journal entry is always balanced', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const result = await journalSuggestions.suggestJournalEntry({
    description: 'Office supplies',
    amount: 250,
  });

  if (!result.proposed) {
    // Acceptable outcome when there is no precedent — but it must explain why.
    assert.ok(result.note, 'a refusal to propose must carry an explanation');
    return;
  }
  assert.equal(result.proposed.total_debit, result.proposed.total_credit);
  assert.equal(result.proposed.balanced, true);
  assert.equal(result.proposed.status, 'DRAFT', 'suggestions must never be pre-posted');
});

test('suggestJournalEntry rejects a non-positive amount instead of proposing nonsense', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  for (const amount of [0, -100, 'abc', null]) {
    const r = await journalSuggestions.suggestJournalEntry({ description: 'x', amount });
    assert.ok(r.error, `amount ${amount} should have been rejected`);
  }
});

// ===========================================================================
// Demand forecasting — seeded consumption history
// ===========================================================================

test('demand forecast derives a consumption rate and stockout date from goods issues', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const demandForecast = require('../services/ai/demandForecast');

  // Seed an item consuming a known 70 units/week for 8 consecutive weeks, with
  // 140 units left — i.e. exactly 2 weeks of cover.
  const { rows: itemRows } = await pool.query(
    `INSERT INTO items (item_code, stock_code, name, description, status, unit_of_measure, user_id)
     VALUES ($1, $2, 'Demand Test Widget', 'seeded', 'APPROVED', 'EA', $3) RETURNING id`,
    [`DEMANDTEST-${Date.now()}`, 'ST2', userId]
  );
  const itemId = itemRows[0].id;
  created.itemIds.push(itemId);

  const { rows: invRows } = await pool.query(
    `INSERT INTO inventory_items (item_master_id, current_stock_quantity, reorder_point,
                                  minimum_stock_level, maximum_stock_level, unit_price, currency, user_id, status)
     VALUES ($1, 140, 10, 5, 500, 25, 'USD', $2, 'APPROVED') RETURNING id`,
    [itemId, userId]
  );
  const inventoryItemId = invRows[0].id;
  created.inventoryItemIds.push(inventoryItemId);

  for (let week = 1; week <= 8; week++) {
    const { rows: txRows } = await pool.query(
      `INSERT INTO warehouse_transactions
         (transaction_number, transaction_type, transaction_date, status, total_quantity, created_by)
       VALUES ($1, 'GI', CURRENT_DATE - ($2::int || ' days')::interval, 'POSTED', 70, $3) RETURNING id`,
      // transaction_number is varchar(20) — keep the seeded number short.
      [`DT${String(Date.now()).slice(-9)}${week}`, week * 7, userId]
    );
    created.warehouseTransactionIds.push(txRows[0].id);
    await pool.query(
      `INSERT INTO warehouse_transaction_items
         (warehouse_transaction_id, inventory_item_id, item_name, quantity, issued_quantity, reason_code)
       VALUES ($1, $2, 'Demand Test Widget', 70, 70, 'CONSUMPTION')`,
      [txRows[0].id, inventoryItemId]
    );
  }

  const result = await demandForecast.predictReorders({ months: 3 });
  const prediction = result.predictions.find((p) => p.inventory_item_id === inventoryItemId);
  assert.ok(prediction, 'the seeded item should appear in the predictions');

  assert.equal(prediction.sufficient_history, true, 'eight weeks of issues is enough history');
  assert.equal(prediction.observed_consumption_weeks, 8);

  // 560 units over a ~13-week window ≈ 43/week. The rate must be averaged over
  // the whole window, not only the weeks with activity (which would give 70).
  assert.ok(
    prediction.weekly_consumption_rate > 35 && prediction.weekly_consumption_rate < 50,
    `expected ~43/week averaged over the window, got ${prediction.weekly_consumption_rate}`
  );

  // 140 in stock at ~6.15/day ≈ 22 days of cover.
  assert.ok(
    prediction.days_of_cover >= 18 && prediction.days_of_cover <= 28,
    `expected roughly 22 days of cover, got ${prediction.days_of_cover}`
  );
  assert.match(prediction.projected_stockout_date, /^\d{4}-\d{2}-\d{2}$/);

  // Cover (~22d) exceeds the 14-day default lead time but the reorder point is
  // already breached, so this must be actionable rather than OK.
  assert.notEqual(prediction.urgency, 'OK');

  // The demand-based reorder point must exceed the naive configured 10.
  assert.ok(
    prediction.suggested_reorder_point > 10,
    `a 14-day lead time at this rate needs far more than the configured 10, got ${prediction.suggested_reorder_point}`
  );
  assert.ok(prediction.suggested_order_quantity > 0);
});

test('audit analysis reports control indicators with non-accusatory framing', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const auditAnalysis = require('../services/ai/auditAnalysis');
  const report = await auditAnalysis.analyzeAuditTrail({ months: 24 });

  assert.ok(Array.isArray(report.findings));
  assert.ok(report.disclaimer.length > 0, 'the report must carry a disclaimer');

  // Every finding must explain both why it matters and how it could be innocent —
  // these are indicators about named people, not conclusions.
  for (const f of report.findings) {
    assert.ok(f.severity && f.check && f.detail, 'findings need severity, check and detail');
    if (f.check !== 'AI_TOOL_FAILURE_RATE') {
      assert.ok(f.innocent_explanation, `${f.check} must offer an innocent explanation`);
    }
  }
});

test("Benford's law refuses to run on a sample too small to mean anything", async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const auditAnalysis = require('../services/ai/auditAnalysis');
  const benford = await auditAnalysis.checkBenfordsLaw({ months: 24 });

  if (benford.sample_size < 50) {
    assert.equal(benford.applicable, false);
    assert.deepEqual(benford.findings, []);
    assert.match(benford.note, /needs at least/);
  } else {
    assert.equal(benford.applicable, true);
    assert.equal(typeof benford.chi_squared, 'number');
  }
});
