/**
 * Agent scheduler — the component that makes the agents actually unattended.
 *
 * Ticks on an interval, claims every agent whose next_run_at has passed, and
 * runs it. Deliberately simple: no cron expressions, just interval scheduling,
 * because ERP background work ("check for overdue invoices every hour") is
 * interval-shaped and cron syntax would add a dependency and a parsing surface
 * for no gain.
 *
 * Safety properties that matter for something running without supervision:
 *
 *   • Claim-then-run. Due agents are claimed with UPDATE ... RETURNING, which is
 *     atomic, so two app instances cannot both pick up the same agent. The
 *     runtime's advisory lock is the second line of defence.
 *   • Restart-safe. Schedule state lives in the database, not in memory, so a
 *     deploy does not lose or double-fire scheduled work.
 *   • Never crashes the host process. An agent throwing must not take the API
 *     server down with it, so every run is caught and recorded.
 *   • Off by default. The scheduler only starts when AGENT_SCHEDULER_ENABLED is
 *     set, so importing the app (tests, scripts, CLI) never silently starts
 *     sending dunning emails.
 *
 * Start with `startScheduler()` from server.js.
 */

const { pool } = require('../../config/database');
const { forEachCompany, currentCompanyId } = require('../companyContext');
const runtime = require('./runtime');

// The AI continuous-close sweep (Round 7, Task 19): reconcile each sub-ledger
// to its GL control account and raise finding + DRAFT-journal pairs. Loaded
// lazily to keep the scheduler import cheap and dependency-light.
let continuousCloseAgent = null;

// The learned-baseline fraud/anomaly scan (Round 7, Task 20:
// services/ai/anomalyDetectionService.js). Fully built and unit-tested
// (tests/anomalyDetection.test.js) but, before this fix, had no caller
// anywhere outside its own test — the vendor bank-detail-change,
// duplicate-payment, threshold-hugging and vendor-employee-link detectors
// never ran in production. Wired the same way as the continuous-close sweep
// above: once per company per day, since it's a full-table scan and every
// detector dedupes/suppresses via upsertFinding regardless.
let anomalyDetectionService = null;

const DEFAULT_TICK_MS = 60_000;
// Never claim a huge batch in one tick: a backlog should drain over several
// ticks rather than stalling the loop.
const MAX_AGENTS_PER_TICK = 5;

let timer = null;
let ticking = false;
let stats = { ticks: 0, runs: 0, failures: 0, startedAt: null, lastTickAt: null };

// Nightly guard for the continuous-close sweep: the sweep is idempotent
// (open-finding dedup + stable posting key), but it is also a full-table scan,
// so run it at most once per company per day. A restart simply allows an extra
// run, which is harmless. `continuousCloseResults` keeps the last sweep
// outcomes for observability and tests.
const continuousCloseRunDates = new Map();
const continuousCloseResults = [];

// Same once-per-company-per-day guard, for the anomaly scan.
const anomalyScanRunDates = new Map();
const anomalyScanResults = [];

/**
 * Atomically claim agents that are due for a given company.
 */
async function claimDueAgents(limit = MAX_AGENTS_PER_TICK, companyId = currentCompanyId()) {
  const params = [limit];
  let companyFilter = '';
  if (companyId) {
    companyFilter = 'AND d.company_id = $2';
    params.push(companyId);
  }

  const { rows } = await pool.query(
    `UPDATE agent_definitions d
        SET next_run_at = CURRENT_TIMESTAMP + (d.schedule_seconds || ' seconds')::interval,
            updated_at  = CURRENT_TIMESTAMP
      WHERE d.id IN (
        SELECT id FROM agent_definitions d
         WHERE enabled = true
           AND schedule_seconds IS NOT NULL
           AND (next_run_at IS NULL OR next_run_at <= CURRENT_TIMESTAMP) ${companyFilter}
         ORDER BY next_run_at NULLS FIRST
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING d.agent_key`,
    params
  );
  return rows.map((r) => r.agent_key);
}

/**
 * Run the AI continuous-close sweep for one company, at most once per day.
 * Same per-company shape as the agent claims above — both run inside
 * forEachCompany so every company gets its own sweep.
 */
async function maybeRunContinuousClose(companyId) {
  if (!continuousCloseAgent) {
    continuousCloseAgent = require('../ai/continuousCloseAgent');
  }
  const today = new Date().toISOString().split('T')[0];
  if (continuousCloseRunDates.get(companyId) === today) {
    return null; // already swept today
  }
  continuousCloseRunDates.set(companyId, today);

  const result = await continuousCloseAgent.runSweep(companyId);
  continuousCloseResults.push({
    company_id: companyId,
    executed_at: result.executed_at,
    findings_created: result.findings_created,
    drafts_created: result.drafts_created,
  });
  return result;
}

/** Test hook: forget the daily guard so a test can re-run the sweep. */
function resetContinuousCloseGuard() {
  continuousCloseRunDates.clear();
  continuousCloseResults.length = 0;
}

/**
 * Run the learned-baseline anomaly/fraud scan for one company, at most once
 * per day. Same shape as maybeRunContinuousClose above.
 */
async function maybeRunAnomalyScan(companyId) {
  if (!anomalyDetectionService) {
    anomalyDetectionService = require('../ai/anomalyDetectionService');
  }
  const today = new Date().toISOString().split('T')[0];
  if (anomalyScanRunDates.get(companyId) === today) {
    return null; // already scanned today
  }
  anomalyScanRunDates.set(companyId, today);

  const result = await anomalyDetectionService.runAnomalyScan({ companyId });
  anomalyScanResults.push(result);
  return result;
}

/** Test hook: forget the daily guard so a test can re-run the anomaly scan. */
function resetAnomalyScanGuard() {
  anomalyScanRunDates.clear();
  anomalyScanResults.length = 0;
}

/**
 * Watch the production lines for one company, at most once an hour. The shop
 * floor also triggers it directly when time is booked (routes/manufacturing.js);
 * this catches what changes without a booking — a centre put into maintenance,
 * work released onto a centre that was already slow.
 */
const lineWatchRunAt = new Map();
async function maybeRunLineWatch(companyId) {
  const now = Date.now();
  if (now - (lineWatchRunAt.get(companyId) || 0) < 3600_000) return null;
  lineWatchRunAt.set(companyId, now);
  return require('../lineWatch').raiseLineFindings(companyId);
}

const supplierWatchRunAt = new Map();
async function maybeRunSupplierWatch(companyId) {
  const now = Date.now();
  if (now - (supplierWatchRunAt.get(companyId) || 0) < 3600_000) return null;
  supplierWatchRunAt.set(companyId, now);
  return require('../supplierRisk').raiseSupplierFindings(companyId);
}

const decisionWatchRunAt = new Map();
async function maybeRunDecisionWatch(companyId) {
  const now = Date.now();
  if (now - (decisionWatchRunAt.get(companyId) || 0) < 3600_000) return null;
  decisionWatchRunAt.set(companyId, now);
  return require('../decisionsHeldOpen').raiseDecisionFindings(companyId);
}

// Orders that landed short (services/orderWatch.js): look again hourly, so one
// that stock, an approved purchase order or a cancellation has settled closes
// by itself, and one still short carries today's numbers.
const orderWatchRunAt = new Map();
async function maybeRunOrderWatch(companyId) {
  const now = Date.now();
  if (now - (orderWatchRunAt.get(companyId) || 0) < 3600_000) return null;
  orderWatchRunAt.set(companyId, now);
  return require('../orderWatch').recheckOpen(companyId);
}

async function tick() {
  // Skip rather than queue if the previous tick is still going — overlapping
  // ticks would let slow agents pile up.
  if (ticking) return { skipped: true, reason: 'previous tick still running' };
  ticking = true;
  stats.ticks += 1;
  stats.lastTickAt = new Date().toISOString();

  const results = [];
  try {
    await forEachCompany(async (companyId) => {
      // Round 7, Task 19: nightly continuous-close sweep, per company. Errors
      // are caught here so one company's ledger problem cannot starve the
      // other companies' agent claims.
      const sweep = await maybeRunContinuousClose(companyId).catch((err) => {
        console.error(`Continuous-close sweep failed for tenant ${companyId}:`, err.message);
        return { success: false, company_id: companyId, error: err.message };
      });
      results.push({ type: 'continuous_close', result: sweep });

      const anomalyScan = await maybeRunAnomalyScan(companyId).catch((err) => {
        console.error(`Anomaly scan failed for tenant ${companyId}:`, err.message);
        return { success: false, company_id: companyId, error: err.message };
      });
      results.push({ type: 'anomaly_scan', result: anomalyScan });

      const lineWatch = await maybeRunLineWatch(companyId).catch((err) => {
        console.error(`Line watch failed for tenant ${companyId}:`, err.message);
        return { success: false, company_id: companyId, error: err.message };
      });
      results.push({ type: 'line_watch', result: lineWatch });

      const supplierWatch = await maybeRunSupplierWatch(companyId).catch((err) => {
        console.error(`Supplier watch failed for tenant ${companyId}:`, err.message);
        return { success: false, company_id: companyId, error: err.message };
      });
      results.push({ type: 'supplier_watch', result: supplierWatch });

      const decisionWatch = await maybeRunDecisionWatch(companyId).catch((err) => {
        console.error(`Decision watch failed for tenant ${companyId}:`, err.message);
        return { success: false, company_id: companyId, error: err.message };
      });
      results.push({ type: 'decision_watch', result: decisionWatch });

      const orderWatch = await maybeRunOrderWatch(companyId).catch((err) => {
        console.error(`Order watch failed for tenant ${companyId}:`, err.message);
        return { success: false, company_id: companyId, error: err.message };
      });
      results.push({ type: 'order_watch', result: orderWatch });

      const due = await claimDueAgents(MAX_AGENTS_PER_TICK, companyId);
      for (const agentKey of due) {
        try {
          const result = await runtime.runAgent(agentKey, { trigger: 'schedule' });
          stats.runs += 1;
          if (result.status === 'FAILED') stats.failures += 1;
          results.push(result);
        } catch (err) {
          // A broken agent must not stop the others in this tick, nor the loop.
          stats.failures += 1;
          results.push({ agent_key: agentKey, status: 'FAILED', error: err.message });
          console.error(`Agent ${agentKey} threw outside its run:`, err.message);
        }
      }
    });
  } catch (err) {
    console.error('Agent scheduler tick failed:', err.message);
  } finally {
    ticking = false;
  }

  return { claimed: results.length, results };
}


function startScheduler({ tickMs = DEFAULT_TICK_MS, force = false } = {}) {
  if (timer) return { started: false, reason: 'already running' };

  // Opt-in. Importing server.js in a test or a script must never start sending
  // real email or reconciling real bank lines.
  if (!force && process.env.AGENT_SCHEDULER_ENABLED !== 'true') {
    return { started: false, reason: 'AGENT_SCHEDULER_ENABLED is not "true"' };
  }

  stats = { ticks: 0, runs: 0, failures: 0, startedAt: new Date().toISOString(), lastTickAt: null };
  timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
  // Do not hold the event loop open purely for the scheduler.
  if (typeof timer.unref === 'function') timer.unref();

  console.log(`🤖 Agent scheduler started (tick ${Math.round(tickMs / 1000)}s)`);
  return { started: true, tick_ms: tickMs };
}

function stopScheduler() {
  if (!timer) return { stopped: false, reason: 'not running' };
  clearInterval(timer);
  timer = null;
  return { stopped: true };
}

function schedulerStatus() {
  return {
    running: !!timer,
    enabled_by_env: process.env.AGENT_SCHEDULER_ENABLED === 'true',
    ...stats,
  };
}

module.exports = {
  startScheduler,
  stopScheduler,
  schedulerStatus,
  tick,
  claimDueAgents,
  DEFAULT_TICK_MS,
  resetContinuousCloseGuard,
  continuousCloseResults,
  maybeRunAnomalyScan,
  resetAnomalyScanGuard,
  anomalyScanResults,
};
