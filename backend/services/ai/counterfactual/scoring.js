/**
 * Scoring — turning measured deltas into a ranking, visibly.
 *
 * THE RULE THIS FILE OBEYS
 * ---------------------------------------------------------------------------
 * A model never scores a branch. The numbers being scored were measured by the
 * database (observables.js) and the weights were chosen by the company, so the
 * ranking is arithmetic anyone can redo by hand. If a person disagrees with the
 * winner, they disagree with a weight — which is a conversation worth having —
 * rather than with an opinion they cannot inspect.
 *
 * TWO KINDS OF BAD
 * ---------------------------------------------------------------------------
 * Constraints and preferences are not the same thing and must not be traded off
 * against each other. Running the company's cash negative is not a low score,
 * it is disqualifying; no amount of improvement elsewhere buys it back. So a
 * violation sets `feasible = false` and the branch is ranked below every
 * feasible one regardless of score. Everything else — cash, lateness, working
 * capital — is a weighted preference.
 *
 * The weights are signed so that positive always means better. `cash: 1.0`
 * means a dollar of extra cash is worth one point; `ap_overdue: -0.6` means a
 * dollar more of overdue payables costs six tenths of a point. Amounts are
 * normalised against the baseline's own scale so a company holding ten million
 * and one holding fifty thousand get comparable numbers.
 */

/**
 * What the business is optimising for, by default.
 *
 * These are defaults, not truths — a company running for growth weights cash
 * differently from one running for supplier goodwill. The weights actually used
 * are stored on the run so a ranking can always be re-derived.
 */
const DEFAULT_OBJECTIVE = {
  cash: 1.0,               // more cash on hand is better
  working_capital: 0.35,   // ... but not by liquidating everything else
  ap_overdue: -0.60,       // owing money late damages supply
  ar_overdue: -0.30,       // being owed late is a problem you own less directly
  inventory_below_reorder: -0.25,
  stockouts: -3.0,         // heavily penalised even before the hard constraint
  open_commitments: -0.10,
};

/** Hard rules. A branch that trips any of these cannot be recommended. */
function violations(baseline, measured, deltas) {
  const out = [];
  if (!measured) return out;

  if (measured.cash < 0) {
    out.push({
      rule: 'cash_negative',
      detail: `Cash ends at ${measured.cash.toFixed(2)} — the company cannot fund this.`,
    });
  }
  // A branch may inherit stockouts that already existed; only ones it CAUSES
  // are its fault, which is why this compares against the baseline rather than
  // against zero.
  if (measured.stockouts > baseline.stockouts) {
    out.push({
      rule: 'causes_stockout',
      detail: `Stockouts rise from ${baseline.stockouts} to ${measured.stockouts}.`,
    });
  }
  // The tripwire from observables.ledgerBalance. Under the current effect
  // catalogue this can only fire if an effect started posting — see effects.js.
  if (Math.abs(measured.ledger_difference - baseline.ledger_difference) > 0.01) {
    out.push({
      rule: 'ledger_unbalanced',
      detail: `Debits and credits diverge by ${(measured.ledger_difference - baseline.ledger_difference).toFixed(2)} — an effect posted a one-sided entry.`,
    });
  }
  if (deltas && deltas.cash < 0 && measured.cash < Math.abs(deltas.cash) * 0.05) {
    out.push({
      rule: 'no_cash_buffer',
      detail: `Leaves ${measured.cash.toFixed(2)} against an outflow of ${Math.abs(deltas.cash).toFixed(2)} — under a 5% buffer.`,
    });
  }
  return out;
}

/**
 * Score one branch's deltas.
 *
 * Money terms are divided by `scale` — the larger of the baseline's cash and a
 * floor — so that the result is "in units of the company's own cash position"
 * and comparable between branches, runs and companies. Count terms (stockouts,
 * lines below reorder) are not scaled, because one stockout is one stockout.
 */
function scoreDeltas(baseline, deltas, objective = DEFAULT_OBJECTIVE) {
  const scale = Math.max(Math.abs(Number(baseline.cash) || 0), 10000);
  const MONEY = new Set(['cash', 'working_capital', 'ap_overdue', 'ar_overdue', 'ap_open', 'ar_open', 'inventory_value', 'open_commitments']);

  const contributions = [];
  let total = 0;

  for (const [metric, weight] of Object.entries(objective)) {
    const delta = Number(deltas?.[metric] || 0);
    if (!delta) continue;
    const normalised = MONEY.has(metric) ? delta / scale : delta;
    const points = Math.round(weight * normalised * 10000) / 10000;
    total += points;
    contributions.push({ metric, delta, weight, points });
  }

  contributions.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { score: Math.round(total * 10000) / 10000, contributions };
}

/**
 * Rank the branches: feasible ones first by score, then the infeasible, then
 * the ones that could not be applied at all. Mutates and returns the array so
 * the caller writes one shape to the database.
 */
function rank(branches) {
  const tier = (b) => (b.apply_error ? 2 : b.feasible ? 0 : 1);
  branches.sort((a, b) => {
    const t = tier(a) - tier(b);
    if (t !== 0) return t;
    return Number(b.score || 0) - Number(a.score || 0);
  });
  branches.forEach((b, i) => { b.rank = i + 1; });
  return branches;
}

/**
 * Why the winner won, in the language of the measurement rather than the model.
 *
 * Written from the contributions and the runner-up, so it is a description of
 * the arithmetic and cannot drift from it.
 */
function explain(winner, runnerUp) {
  if (!winner) return 'No branch could be applied to the ledger, so there is nothing to recommend.';

  const top = (winner.contributions || []).slice(0, 3)
    .map((c) => `${c.metric} ${c.delta >= 0 ? '+' : ''}${c.delta.toLocaleString()}`)
    .join(', ');

  const lead = `"${winner.label}" scores ${winner.score} on the measured outcome (${top || 'no material movement'}).`;

  if (!runnerUp) return `${lead} It was the only feasible course of action measured.`;

  const gap = Math.round((Number(winner.score) - Number(runnerUp.score)) * 10000) / 10000;
  const margin = Math.abs(gap) < 0.02
    ? `It is effectively tied with "${runnerUp.label}" (${gap >= 0 ? '+' : ''}${gap}) — the choice between them is a judgement call, not a measurement.`
    : `It beats "${runnerUp.label}" by ${gap}.`;

  const blocked = (runnerUp.violations || []).length
    ? ` "${runnerUp.label}" also breaks a hard rule: ${runnerUp.violations[0].detail}`
    : '';

  return `${lead} ${margin}${blocked}`;
}

module.exports = { DEFAULT_OBJECTIVE, violations, scoreDeltas, rank, explain };
