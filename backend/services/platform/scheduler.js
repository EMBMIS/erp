/**
 * Scheduled automations, across every company and every installed application.
 *
 * ===========================================================================
 * WHY THIS IS SEPARATE FROM THE EVENT PATH
 * ===========================================================================
 * Most automations run because something happened: a record was created, a
 * state changed. Those fire on the request that caused them
 * (routes/platform/runtimeRouter.js), after the write and outside its
 * transaction, so a failing notification cannot roll back a record the user
 * successfully saved.
 *
 * A scheduled automation has no such request. "Chase anything overdue" has to
 * be run BY something, at a cadence, for every company that installed an
 * application declaring it. That is this file.
 *
 * ===========================================================================
 * WHY IT IS OFF BY DEFAULT
 * ===========================================================================
 * Same reason the agent and report schedulers are: starting the server should
 * not begin notifying people, least of all from a developer's machine pointed
 * at production data. `PLATFORM_SCHEDULER_ENABLED=true` is a deliberate act.
 *
 * ===========================================================================
 * WHAT IT WILL NOT DO
 * ===========================================================================
 * Nothing here decides what an automation does — it dispatches to the same
 * bounded action vocabulary the event path uses, with the same depth limit and
 * the same run records. A scheduled automation cannot do anything an
 * event-driven one cannot.
 *
 * Each company's sweep is independent: one company's broken specification must
 * not stop another company's chase-ups. Failures are recorded per run
 * (app_automation_runs) and per tick here, not thrown.
 */

const companyContext = require('../companyContext');
const registry = require('./registry');
const resolver = require('./runtime/resolver');
const automation = require('./runtime/automation');
const { SCHEDULE_CADENCES } = require('./spec/types');

// Hourly ticks. The cadences are hourly/daily/weekly/monthly, so anything
// finer would do nothing but wake the process up.
const DEFAULT_TICK_MS = 60 * 60 * 1000;

let timer = null;
let lastRun = { at: null, cadences: [], companies: 0, automations: 0, errors: [] };

/**
 * Which cadences are due at this moment.
 *
 * Deliberately clock-based rather than stateful: an hourly automation runs
 * every hour, a daily one at the hour its specification names (default 8), a
 * weekly one on Monday, a monthly one on the first. A missed tick — a restart,
 * a deploy — means that cadence is skipped once rather than fired twice on
 * catch-up, which is the safer direction for something that sends messages.
 */
function dueCadences(now = new Date()) {
  const due = ['hourly'];
  const hour = now.getUTCHours();
  if (hour === Number(process.env.PLATFORM_SCHEDULER_DAILY_HOUR || 8)) {
    due.push('daily');
    if (now.getUTCDay() === 1) due.push('weekly');
    if (now.getUTCDate() === 1) due.push('monthly');
  }
  return due.filter((c) => SCHEDULE_CADENCES.has(c));
}

/**
 * Run every due scheduled automation for one company.
 *
 * Exported so an operator can run a cadence by hand, and so a test can run one
 * without waiting an hour.
 */
async function runCompany(companyId, cadences) {
  const instances = await registry.listInstancesForCompany(companyId);
  const results = [];

  for (const instance of instances) {
    if (instance.status !== 'active' || !instance.version_id) continue;
    try {
      const context = await resolver.resolveApplication(companyId, instance.app_key);
      const scheduled = (context.spec.automations || [])
        .filter((a) => a.enabled !== false && a.trigger?.kind === 'schedule');
      if (!scheduled.length) continue;

      for (const cadence of cadences) {
        if (!scheduled.some((a) => a.trigger.cadence === cadence)) continue;
        const runs = await automation.runSchedule(context, cadence);
        results.push({ application: instance.app_key, cadence, runs: runs.length });
      }
    } catch (error) {
      // One application's problem is not another's, and certainly not another
      // company's.
      results.push({ application: instance.app_key, error: error.message });
    }
  }
  return results;
}

/** One tick: every company, every due cadence. */
async function tick(now = new Date()) {
  const cadences = dueCadences(now);
  const summary = { at: now.toISOString(), cadences, companies: 0, automations: 0, errors: [] };

  const outcomes = await companyContext.forEachCompany(async (companyId) => runCompany(companyId, cadences));
  outcomes.forEach((outcome) => {
    summary.companies += 1;
    if (outcome.status === 'rejected') {
      summary.errors.push({ companyId: outcome.companyId, error: outcome.reason?.message });
      return;
    }
    (outcome.value || []).forEach((r) => {
      if (r.error) summary.errors.push({ companyId: outcome.companyId, application: r.application, error: r.error });
      else summary.automations += r.runs;
    });
  });

  lastRun = summary;
  return summary;
}

function startScheduler({ tickMs = DEFAULT_TICK_MS } = {}) {
  if (String(process.env.PLATFORM_SCHEDULER_ENABLED || '').toLowerCase() !== 'true') {
    return { started: false, reason: 'PLATFORM_SCHEDULER_ENABLED is not "true"' };
  }
  if (timer) return { started: true, alreadyRunning: true };
  timer = setInterval(() => { tick().catch((e) => console.error('[platform scheduler]', e.message)); }, tickMs);
  if (timer.unref) timer.unref();
  return { started: true, tickMs };
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

const getStats = () => ({ running: !!timer, lastRun });

module.exports = { startScheduler, stopScheduler, tick, runCompany, dueCadences, getStats };
