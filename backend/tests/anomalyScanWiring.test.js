// AI push, session 9 — the learned-baseline fraud/anomaly detectors in
// services/ai/anomalyDetectionService.js (Round 7, Task 20) were real,
// unit-tested (tests/anomalyDetection.test.js), and completely inert: no
// route, no chat tool, no scheduler ever called runAnomalyScan() or its
// seven detectors in production. This suite proves the two places that now
// call it actually reach it:
//
//   • services/ai/findingsScan.js's runFindingsScan() — the on-demand path
//     (POST /ai-findings/scan and the AI chat tool `run_findings_scan`)
//   • services/agents/scheduler.js's maybeRunAnomalyScan() — the automatic
//     path, mirroring the existing continuous-close sweep: once per company
//     per day, called from tick()
//
// It does not re-prove the detector math itself (already covered by
// tests/anomalyDetection.test.js) — only that these call sites reach
// AnomalyDetectionService.runAnomalyScan() and that the once-per-day guard
// behaves like its continuous-close sibling.
//
// Run on its own:  node --test tests/anomalyScanWiring.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const companyContext = require('../services/companyContext');

let dbAvailable = false;
let companyId = null;

before(async () => {
  try {
    await pool.query('SELECT 1');
    companyId = await companyContext.getDefaultCompanyId();
    dbAvailable = !!companyId;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  await pool.end();
});

test('runFindingsScan() reaches AnomalyDetectionService.runAnomalyScan and folds its counts into the total', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const { runFindingsScan } = require('../services/ai/findingsScan');
  const result = await runFindingsScan();

  assert.ok(result.anomaly_scan, 'runFindingsScan() result must include an anomaly_scan key');
  assert.equal(result.anomaly_scan.company_id, companyId);
  assert.equal(typeof result.anomaly_scan.total_new_findings, 'number');
  // All seven Round 7 detectors must have actually run (each returns a count,
  // not undefined) — this is what distinguishes "wired" from "key merged in
  // but detector never invoked".
  for (const key of [
    'vendor_baseline_deviation',
    'account_baseline_deviation',
    'duplicate_payments',
    'bank_detail_change_before_payment',
    'threshold_hugging',
    'off_hours_postings',
    'vendor_employee_links',
  ]) {
    assert.equal(typeof result.anomaly_scan[key], 'number', `detector ${key} did not run`);
  }
  // total_new must be numeric and must not have thrown trying to add an
  // object (the pre-fix reduce assumed every result was an array).
  assert.equal(typeof result.total_new, 'number');
});

test('scheduler.maybeRunAnomalyScan runs the scan once per company per day, like the continuous-close sweep', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const scheduler = require('../services/agents/scheduler');
  scheduler.resetAnomalyScanGuard();

  const first = await companyContext.runWithCompany(companyId, () => scheduler.maybeRunAnomalyScan(companyId));
  assert.ok(first, 'first call on a given day must run the scan');
  assert.equal(first.company_id, companyId);
  assert.equal(typeof first.total_new_findings, 'number');

  const second = await companyContext.runWithCompany(companyId, () => scheduler.maybeRunAnomalyScan(companyId));
  assert.equal(second, null, 'second call the same day must be a no-op (daily guard)');

  scheduler.resetAnomalyScanGuard();
});

// Not exercised here: a full scheduler.tick() also runs the anomaly scan
// (and the continuous-close sweep) for EVERY active company via
// companyContext.forEachCompany — this dev DB has 200+ from prior sessions,
// so a full tick() takes minutes and would make this suite unusably slow.
// tick()'s one-line call to maybeRunAnomalyScan is covered by source
// inspection (services/agents/scheduler.js, right next to the pre-existing
// maybeRunContinuousClose call it mirrors) plus the direct test above, which
// exercises the exact same function tick() calls.
