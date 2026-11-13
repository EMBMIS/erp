/**
 * The counterfactual engine, exposed to the agent as tools.
 *
 * WHY simulate_decision IS A READ TOOL
 * ---------------------------------------------------------------------------
 * `readOnly: true` on a tool in this registry means "running this leaves the
 * business unchanged", and that is exactly what the shadow transaction
 * guarantees (see counterfactual/shadowLedger.js: no COMMIT exists, and the
 * ROLLBACK is in a `finally`). It writes one evidence row to ai_decision_runs,
 * the same way a read tool writes one row to ai_audit_log — a record that a
 * question was asked, not a change to any business document.
 *
 * The distinction matters for the permission modes in services/ai/agent.js: a
 * simulation must not pause for confirmation, because the whole point is that
 * a person can ask "what happens if we do this?" as freely as they ask "what is
 * our cash?". The moment they want to actually do it, they are back in the
 * ordinary write path with its drafts and its approvals — and the model is told
 * so, in the tool description, because a model that reports a simulation as a
 * completed action is the one failure mode this feature cannot afford.
 */

const counterfactual = require('./counterfactual');
const companyContext = require('../companyContext');

async function companyFor() {
  return companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/** Trim a branch to what is worth putting in a model's context window. */
function branchDigest(b) {
  return {
    rank: b.rank,
    label: b.label,
    summary: b.summary,
    feasible: b.feasible,
    score: b.score,
    // The four movements a person actually reads first.
    cash: b.deltas?.cash,
    working_capital: b.deltas?.working_capital,
    overdue_payables: b.deltas?.ap_overdue,
    stockouts: b.deltas?.stockouts,
    violations: (b.violations || []).map((v) => v.detail),
    could_not_apply: b.apply_error || undefined,
    steps: (b.effects || []).length,
  };
}

const counterfactualTools = [
  {
    name: 'simulate_decision',
    description:
      'Measure what several different courses of action would actually do to this business, by applying each one '
      + 'to the real ledger inside a transaction that is rolled back. The numbers returned are the database\'s own '
      + '— cash, working capital, overdue payables, stockouts — not a forecast and not your estimate. Use this '
      + 'whenever someone asks "should we...", "what if we...", "is it better to...", or has to choose between '
      + 'ways of spending, collecting, deferring or replenishing. NOTHING IS CHANGED and nothing is scheduled: '
      + 'report the result as a measurement of hypotheticals, and say plainly that acting on the recommended '
      + 'course still has to be done and approved in the normal way.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The decision in the person\'s own words, e.g. "we have 180k and 340k of bills due — what do we pay?"' },
        scenario: {
          type: 'string',
          enum: ['payment_run', 'collections', 'replenishment', 'open'],
          description: 'Which family of courses of action to enumerate. Omit to infer it from the question; "open" spans all of them.',
        },
        objective: {
          type: 'object',
          description: 'Optional weight overrides, e.g. {"cash":1.5,"ap_overdue":-1.2} to weight cash preservation and supplier goodwill differently from the company default.',
        },
        horizon_days: { type: 'number', description: 'Decision horizon in days (default 30). Recorded on the run; it does not change the measurement.' },
      },
      required: ['question'],
    },
    handler: async (args, ctx) => {
      const companyId = await companyFor();
      const run = await counterfactual.decide({
        companyId,
        userId: ctx?.userId || null,
        question: args.question,
        scenario: args.scenario,
        objective: args.objective,
        horizonDays: args.horizon_days || 30,
      });

      return {
        run_id: run.id,
        scenario: run.scenario,
        status: run.status,
        // Stated explicitly in the payload as well as the description: a model
        // reading only the result must still be unable to conclude it acted.
        nothing_was_changed: true,
        measured_on: 'the live ledger, inside a transaction that was rolled back',
        baseline: {
          cash: run.baseline?.cash,
          working_capital: run.baseline?.working_capital,
          overdue_payables: run.baseline?.ap_overdue,
          overdue_receivables: run.baseline?.ar_overdue,
          stockouts: run.baseline?.stockouts,
        },
        recommended: run.chosen ? branchDigest(run.chosen) : null,
        rationale: run.rationale,
        branches: (run.branches || []).map(branchDigest),
        next_step: run.chosen
          ? 'To act on this, create the underlying records the normal way — they will still need the usual approvals.'
          : 'No course of action measured cleanly; the branches above say why.',
      };
    },
  },

  {
    name: 'get_decision_run',
    description:
      'Retrieve a previous decision simulation in full — every branch, the effects it applied, the complete measured '
      + 'state vector and the constraint violations. Use it when someone asks why a course of action was recommended, '
      + 'or wants the numbers behind one branch.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: 'The run id returned by simulate_decision.' } },
      required: ['run_id'],
    },
    handler: async (args) => {
      const companyId = await companyFor();
      const run = await counterfactual.getRun(args.run_id, companyId);
      if (!run) throw new Error(`No decision run ${args.run_id} for this company`);
      return run;
    },
  },

  {
    name: 'list_decision_runs',
    description: 'List recent decision simulations for this company: the question asked, the course of action recommended, and when.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'max rows, default 25' } },
    },
    handler: async (args) => {
      const companyId = await companyFor();
      return { runs: await counterfactual.listRuns(companyId, args.limit) };
    },
  },
];

module.exports = { counterfactualTools };
