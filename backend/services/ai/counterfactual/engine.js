/**
 * The counterfactual decision engine.
 *
 * ONE QUESTION IN, ONE MEASURED ANSWER OUT
 * ---------------------------------------------------------------------------
 *   1. Generate candidate courses of action from the company's own open
 *      documents (branches.js). Deterministic; the model may add to the list.
 *   2. Open a shadow transaction and measure the BASELINE state vector.
 *   3. For each branch: apply its effects, measure, roll back to the savepoint.
 *   4. Score the measured deltas against the company's objective weights, and
 *      disqualify anything that broke a hard rule (scoring.js).
 *   5. Roll the whole transaction back and persist the evidence.
 *
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It is not an approval, an authorisation, or an instruction. A run produces a
 * ranked table with the numbers behind it; acting on the winning branch means
 * going and doing it through the ordinary draft / DOA / approval path, with a
 * human deciding. The engine never writes a real record, and the one place it
 * could have — the shadow transaction — has no COMMIT in it.
 *
 * WHAT IT COSTS, HONESTLY
 * ---------------------------------------------------------------------------
 * The shadow transaction holds row locks on the documents it touches for as
 * long as the run takes. Everything in this path is therefore bounded: the
 * branch count, the per-statement timeout, the lock timeout, and a wall-clock
 * deadline for the run as a whole. If a run runs out of time, the branches
 * measured so far are kept and the rest are reported as unmeasured — a partial
 * table of real numbers is worth more than a complete table of guesses.
 */

const { pool } = require('../../../config/database');
const { withShadow } = require('./shadowLedger');
const observables = require('./observables');
const scoring = require('./scoring');
const branchGen = require('./branches');

/**
 * Run a decision.
 *
 * @param {object}  opts
 * @param {string}  opts.companyId   required — the tenant this decides for
 * @param {string}  opts.userId      who asked (for attribution, not authority)
 * @param {string}  opts.question    the decision, in the person's own words
 * @param {string} [opts.scenario]   payment_run | collections | replenishment | open
 * @param {object} [opts.objective]  weight overrides; merged over the defaults
 * @param {Array}  [opts.branches]   explicit branches, skipping generation
 * @param {number} [opts.horizonDays]
 * @param {boolean}[opts.useModel]   let the model propose extra branches
 * @param {boolean}[opts.persist]    write the run to ai_decision_runs (default true)
 */
async function decide(opts) {
  const started = Date.now();
  const {
    companyId, userId, question,
    scenario, objective: objectiveOverride, branches: explicitBranches,
    horizonDays = 30, useModel = true, persist = true,
  } = opts || {};

  if (!companyId) throw new Error('decide() needs a companyId');
  if (!question) throw new Error('decide() needs a question');

  const objective = { ...scoring.DEFAULT_OBJECTIVE, ...(objectiveOverride || {}) };

  // Cash is read before the shadow transaction so that branch generation can
  // size a payment run against it without holding the transaction open across
  // a model call.
  const availableCash = await currentCash(companyId);

  let scenarioKey = scenario || branchGen.inferScenario(question);
  let candidates = explicitBranches;

  if (!candidates) {
    const generated = await branchGen.generate({ companyId, question, scenario, availableCash, useModel });
    scenarioKey = generated.scenario;
    candidates = generated.branches;
  }

  if (!candidates.length) {
    const run = {
      question, scenario: scenarioKey, horizon_days: horizonDays, objective,
      baseline: {}, branches: [], chosen: null,
      rationale: 'There is nothing open to decide about — no bills, invoices or short stock lines matched this scenario.',
      status: 'observed', duration_ms: Date.now() - started,
    };
    return persist ? persistRun(run, companyId, userId) : run;
  }

  let baseline = {};
  const measuredBranches = [];
  let status = 'observed';
  let runError = null;

  try {
    await withShadow({ companyId, userId }, async (session) => {
      baseline = await session.measure();

      for (const candidate of candidates) {
        if (session.expired()) {
          measuredBranches.push({
            ...candidate,
            measured: null, deltas: {}, violations: [], contributions: [],
            score: null, feasible: false,
            apply_error: 'Not measured — the run reached its time limit.',
          });
          continue;
        }

        const { measured, applied, apply_error } = await session.runBranch(candidate);

        if (!measured) {
          // A branch the database refused. Kept, with the reason: "you cannot
          // do this" is the most actionable result the engine produces.
          measuredBranches.push({
            ...candidate, applied, measured: null, deltas: {}, violations: [],
            contributions: [], score: null, feasible: false, apply_error,
          });
          continue;
        }

        const deltas = observables.diff(baseline, measured);
        const violations = scoring.violations(baseline, measured, deltas);
        const { score, contributions } = scoring.scoreDeltas(baseline, deltas, objective);

        measuredBranches.push({
          ...candidate, applied, measured, deltas, violations, contributions,
          score, feasible: violations.length === 0, apply_error: null,
        });
      }
    });
  } catch (err) {
    // The shadow transaction itself failed — no connection, a lock timeout on
    // BEGIN, isolation misconfigured. Report it as degraded rather than
    // returning a table of nulls that looks like a measurement.
    status = 'degraded';
    runError = err?.message || String(err);
  }

  scoring.rank(measuredBranches);

  const feasible = measuredBranches.filter((b) => b.feasible && b.measured);
  const chosen = feasible[0] || null;
  const rationale = runError
    ? `The shadow ledger could not be opened, so nothing was measured: ${runError}`
    : scoring.explain(chosen, feasible[1]);

  const run = {
    question, scenario: scenarioKey, horizon_days: horizonDays, objective,
    baseline, branches: measuredBranches, chosen, rationale,
    status, error: runError, duration_ms: Date.now() - started,
  };

  return persist ? persistRun(run, companyId, userId) : run;
}

async function currentCash(companyId) {
  const client = await pool.connect();
  try {
    return await observables.cash(client, companyId);
  } finally {
    client.release();
  }
}

/**
 * Write the run and its branches. Persistence failure must not lose the answer:
 * the caller already has the measured numbers in hand, and a full disk is no
 * reason to throw away a decision someone is waiting on. The returned object
 * carries `persisted: false` so a UI can say so rather than offering a
 * permalink that will 404.
 */
async function persistRun(run, companyId, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO ai_decision_runs
         (company_id, user_id, question, scenario, horizon_days, objective, baseline,
          branch_count, rationale, status, error, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12)
       RETURNING id, created_at`,
      [companyId, userId || null, run.question, run.scenario, run.horizon_days,
       JSON.stringify(run.objective), JSON.stringify(run.baseline),
       run.branches.length, run.rationale, run.status, run.error || null, run.duration_ms]
    );
    const runId = rows[0].id;
    let chosenId = null;

    for (const b of run.branches) {
      const { rows: br } = await client.query(
        `INSERT INTO ai_decision_branches
           (run_id, company_id, label, summary, effects, measured, deltas, violations,
            score, feasible, rank, apply_error)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12)
         RETURNING id`,
        [runId, companyId, b.label, b.summary || null,
         JSON.stringify(b.effects || []), JSON.stringify(b.measured || {}),
         JSON.stringify(b.deltas || {}), JSON.stringify(b.violations || []),
         b.score, b.feasible, b.rank, b.apply_error || null]
      );
      b.id = br[0].id;
      if (run.chosen && b === run.chosen) chosenId = b.id;
    }

    if (chosenId) {
      await client.query('UPDATE ai_decision_runs SET chosen_branch_id = $2 WHERE id = $1', [runId, chosenId]);
    }
    await client.query('COMMIT');

    return { ...run, id: runId, created_at: rows[0].created_at, persisted: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Counterfactual run could not be persisted:', err.message);
    return { ...run, persisted: false, persist_error: err.message };
  } finally {
    client.release();
  }
}

/** A previous run with its branches, for the evidence view. */
async function getRun(runId, companyId) {
  const { rows } = await pool.query(
    'SELECT * FROM ai_decision_runs WHERE id = $1 AND company_id = $2',
    [runId, companyId]
  );
  if (!rows[0]) return null;
  const { rows: branches } = await pool.query(
    'SELECT * FROM ai_decision_branches WHERE run_id = $1 ORDER BY rank NULLS LAST',
    [runId]
  );
  return { ...rows[0], branches };
}

async function listRuns(companyId, limit = 25) {
  const { rows } = await pool.query(
    `SELECT r.id, r.question, r.scenario, r.status, r.rationale, r.branch_count,
            r.duration_ms, r.created_at,
            b.label AS chosen_label, b.score AS chosen_score
       FROM ai_decision_runs r
       LEFT JOIN ai_decision_branches b ON b.id = r.chosen_branch_id
      WHERE r.company_id = $1
      ORDER BY r.created_at DESC
      LIMIT $2`,
    [companyId, Math.min(Math.max(Number(limit) || 25, 1), 100)]
  );
  return rows;
}

module.exports = { decide, getRun, listRuns };
