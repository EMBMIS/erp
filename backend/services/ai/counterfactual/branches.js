/**
 * Branch generation — enumerating the courses of action worth measuring.
 *
 * WHERE THE CANDIDATES COME FROM, AND WHY IT IS MOSTLY NOT THE MODEL
 * ---------------------------------------------------------------------------
 * The engine's value is in the measurement, not in the imagination. So the
 * default generators here are deterministic: for a payment run, the branches
 * are the strategies a treasurer would actually list — oldest first, largest
 * first, cheapest-to-defer, pay nothing — built from the company's own open
 * bills. They need no API key, cost nothing, and produce the same branches
 * twice for the same data, which is what makes a decision defensible a month
 * later when someone asks why.
 *
 * The model is offered a seat, not the wheel. `proposeWithModel` asks it for
 * ADDITIONAL branches given the effect catalogue and a digest of the real
 * numbers, and every branch it returns is validated against the catalogue and
 * then measured exactly like the deterministic ones. A branch the model
 * invented that turns out to be best is a good outcome; a branch it invented
 * that breaks a constraint is caught by Postgres, not by a reviewer. What it
 * cannot do is score anything, or add an effect that does not exist.
 *
 * All reads in this file use the pool, and deliberately so: candidate
 * generation happens BEFORE the shadow transaction opens, so that the
 * transaction — which holds locks on live rows — is open for as little time as
 * possible and never for the duration of a model call.
 */

const { pool } = require('../../../config/database');
const { catalogue, effects } = require('./effects');
const { safeJsonParse } = require('../../aiJson');

const MAX_BRANCHES = 8;

// ---------------------------------------------------------------------------
// Data digests: the facts a scenario is built from.
// ---------------------------------------------------------------------------

async function openBills(companyId, limit = 15) {
  const { rows } = await pool.query(
    `SELECT si.bill_number, si.outstanding_amount::float AS outstanding, si.due_date,
            GREATEST(0, CURRENT_DATE - si.due_date)::int AS days_late,
            s.legal_name AS supplier
       FROM supplier_invoices si
       LEFT JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.company_id = $1
        AND si.deleted_at IS NULL
        AND si.status IN ('APPROVED','PARTIALLY_PAID','OVERDUE')
        AND si.outstanding_amount > 0
      ORDER BY si.due_date ASC
      LIMIT $2`,
    [companyId, limit]
  );
  return rows;
}

async function openInvoices(companyId, limit = 15) {
  const { rows } = await pool.query(
    `SELECT ci.invoice_number, ci.outstanding_amount::float AS outstanding, ci.due_date,
            GREATEST(0, CURRENT_DATE - ci.due_date)::int AS days_late,
            c.customer_name AS customer
       FROM customer_invoices ci
       LEFT JOIN customers c ON c.id = ci.customer_id
      WHERE ci.company_id = $1
        AND ci.deleted_at IS NULL
        AND ci.status IN ('APPROVED','SENT','PARTIALLY_PAID','OVERDUE')
        AND ci.outstanding_amount > 0
      ORDER BY ci.outstanding_amount DESC
      LIMIT $2`,
    [companyId, limit]
  );
  return rows;
}

async function shortItems(companyId, limit = 12) {
  const { rows } = await pool.query(
    `SELECT i.item_code, i.name,
            ii.current_stock_quantity::float AS on_hand,
            ii.reorder_point::float          AS reorder_point,
            ii.unit_price::float             AS unit_price
       FROM inventory_items ii
       JOIN items i ON i.id = ii.item_master_id
      WHERE ii.company_id = $1
        AND ii.reorder_point IS NOT NULL
        AND ii.current_stock_quantity <= ii.reorder_point
      ORDER BY (ii.reorder_point - ii.current_stock_quantity) DESC
      LIMIT $2`,
    [companyId, limit]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Deterministic generators, one per scenario.
// ---------------------------------------------------------------------------

/**
 * How should this week's payables be settled?
 *
 * The branches are the four strategies that are genuinely different in their
 * consequences — not four rewordings of "pay the bills". Each is capped by the
 * cash actually available, because a strategy that spends money the company
 * does not have is not a strategy, and the point is to find that out here.
 */
function paymentRunBranches(bills, availableCash) {
  if (!bills.length) return [];

  const budget = Math.max(0, Number(availableCash) || 0);
  const take = (sorted) => {
    const chosen = [];
    let left = budget;
    for (const b of sorted) {
      if (left <= 0) break;
      const amount = Math.min(b.outstanding, left);
      if (amount <= 0) continue;
      chosen.push({ effect: 'pay_supplier_invoice', args: { bill_number: b.bill_number, amount } });
      left -= amount;
    }
    return chosen;
  };

  const byDue = [...bills].sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  const byValueDesc = [...bills].sort((a, b) => b.outstanding - a.outstanding);
  const byValueAsc = [...bills].sort((a, b) => a.outstanding - b.outstanding);
  const late = bills.filter((b) => b.days_late > 0);

  const branches = [
    {
      label: 'Oldest first',
      summary: 'Settle bills in due-date order until the cash runs out — the conventional payment run.',
      effects: take(byDue),
    },
    {
      label: 'Largest first',
      summary: 'Clear the biggest exposures first, on the view that a few large suppliers matter most.',
      effects: take(byValueDesc),
    },
    {
      label: 'Most invoices cleared',
      summary: 'Smallest first: the same cash closes the greatest number of open items.',
      effects: take(byValueAsc),
    },
    {
      label: 'Pay only what is late',
      summary: 'Settle overdue bills only and hold the rest — preserves cash, and shows what holding costs.',
      effects: take([...late].sort((a, b) => b.days_late - a.days_late)),
    },
    {
      label: 'Defer instead of pay',
      summary: 'Renegotiate 30 more days on the overdue bills rather than spending the cash.',
      effects: late.slice(0, 8).map((b) => ({
        effect: 'defer_supplier_invoice',
        args: { bill_number: b.bill_number, days: 30 },
      })),
    },
    {
      // The control. Without it there is no way to tell whether any of the
      // above beats simply waiting, and "do nothing" wins more often than
      // anyone building a recommendation engine wants to admit.
      label: 'Do nothing this week',
      summary: 'The null branch. Every other branch is only worth its improvement on this one.',
      effects: [],
    },
  ];

  return branches.filter((b) => b.effects.length || b.label.startsWith('Do nothing'));
}

/** How should we get cash in — chase, discount, or wait? */
function collectionsBranches(invoices) {
  if (!invoices.length) return [];
  const overdue = invoices.filter((i) => i.days_late > 0);
  const biggest = invoices.slice(0, 5);

  return [
    {
      label: 'Collect the overdue',
      summary: 'Everything past its due date is collected in full — the best case for chasing.',
      effects: overdue.map((i) => ({ effect: 'collect_customer_invoice', args: { invoice_number: i.invoice_number } })),
    },
    {
      label: 'Collect the five largest',
      summary: 'Concentrate the effort on the biggest balances regardless of age.',
      effects: biggest.map((i) => ({ effect: 'collect_customer_invoice', args: { invoice_number: i.invoice_number } })),
    },
    {
      label: '2% to settle now',
      summary: 'Offer a 2% early-settlement discount on the largest balances — cash sooner, margin given up.',
      effects: biggest.map((i) => ({
        effect: 'discount_for_early_payment',
        args: { invoice_number: i.invoice_number, discount_percent: 2 },
      })),
    },
    {
      label: '5% to settle now',
      summary: 'The same offer at a price most customers accept — and one that shows up plainly in the numbers.',
      effects: biggest.map((i) => ({
        effect: 'discount_for_early_payment',
        args: { invoice_number: i.invoice_number, discount_percent: 5 },
      })),
    },
    { label: 'Do nothing', summary: 'The null branch.', effects: [] },
  ].filter((b) => b.effects.length || b.label === 'Do nothing');
}

/**
 * Replenish or hold?
 *
 * Every branch carries the SAME demand — the consume_stock steps — so that the
 * branch which skips replenishment is measured against real demand rather than
 * against an empty week. Without that, holding cash always wins and the model
 * of the decision is simply wrong.
 */
function replenishmentBranches(items) {
  if (!items.length) return [];

  const demand = items.map((it) => ({
    effect: 'consume_stock',
    // Demand proxy: the gap the reorder point was set to protect. It is the
    // company's own stated view of what it expects to move, which is a better
    // assumption than one invented here.
    args: { item_code: it.item_code, quantity: Math.max(1, Math.round(it.reorder_point - it.on_hand)) },
  }));

  const restock = (subset) => subset.map((it) => ({
    effect: 'replenish_item',
    args: { item_code: it.item_code, quantity: Math.max(1, Math.round((it.reorder_point - it.on_hand) * 2)) },
  }));

  const worst = items.slice(0, 3);

  return [
    {
      label: 'Replenish everything below reorder',
      summary: 'Bring every short line back above its reorder point, then meet demand.',
      effects: [...restock(items), ...demand],
    },
    {
      label: 'Replenish the three worst only',
      summary: 'Spend on the deepest shortfalls and let the rest ride.',
      effects: [...restock(worst), ...demand],
    },
    {
      label: 'Hold the cash',
      summary: 'Buy nothing and meet demand from stock on hand — this is where the stockouts appear.',
      effects: demand,
    },
  ];
}

// ---------------------------------------------------------------------------
// Model-proposed branches (optional, additive, validated).
// ---------------------------------------------------------------------------

function validate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const steps = Array.isArray(raw.effects) ? raw.effects : [];
  const clean = steps
    .filter((s) => s && typeof s.effect === 'string' && effects[s.effect])
    .map((s) => ({ effect: s.effect, args: (s.args && typeof s.args === 'object') ? s.args : {} }))
    .slice(0, 25);
  if (!clean.length) return null;
  return {
    label: String(raw.label || 'Proposed branch').slice(0, 120),
    summary: String(raw.summary || '').slice(0, 500),
    effects: clean,
    proposed_by: 'model',
  };
}

/**
 * Ask the model for extra branches. Failure is not an error: no key, a timeout,
 * unparseable output — all return [] and the deterministic branches carry the
 * run. The engine must work on an installation with no AI configured at all.
 */
async function proposeWithModel({ question, digest, existing }) {
  try {
    const { getAIClient, getAIProvider, isAIEnabled, AI_MODEL_RESOLVED } = require('../../../config/aiConfig');
    if (typeof isAIEnabled === 'function' && !isAIEnabled()) return [];

    const prompt = [
      'You propose CANDIDATE COURSES OF ACTION for an ERP decision. You do not evaluate them —',
      'each one will be applied to the real ledger inside a transaction that rolls back, and the',
      'database will report the outcome. Your job is coverage: propose courses of action that are',
      'materially DIFFERENT from the ones already listed, not variations in wording.',
      '',
      `DECISION: ${question}`,
      '',
      'EFFECTS YOU MAY USE (nothing else exists):',
      JSON.stringify(catalogue(), null, 1),
      '',
      'THE REAL DATA:',
      JSON.stringify(digest).slice(0, 6000),
      '',
      'ALREADY BEING MEASURED:',
      JSON.stringify((existing || []).map((b) => b.label)),
      '',
      'Reply with JSON only: {"branches":[{"label":"...","summary":"...","effects":[{"effect":"...","args":{...}}]}]}',
      'At most 3 branches. Use only bill_number / invoice_number / item_code values that appear in the data above.',
    ].join('\n');

    const client = getAIClient();
    const model = AI_MODEL_RESOLVED;
    let text;

    if (getAIProvider() === 'anthropic') {
      const res = await client.messages.create({
        model, max_tokens: 1500, temperature: 0.7,
        messages: [{ role: 'user', content: prompt }],
      });
      text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    } else {
      const res = await client.chat.completions.create({
        model, temperature: 0.7, max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      });
      text = res.choices?.[0]?.message?.content;
    }

    const parsed = safeJsonParse(text, { branches: [] });
    return (parsed.branches || []).map(validate).filter(Boolean).slice(0, 3);
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------

const SCENARIOS = {
  payment_run: {
    label: 'Payment run',
    async build(companyId, availableCash) {
      const bills = await openBills(companyId);
      return { branches: paymentRunBranches(bills, availableCash), digest: { open_bills: bills, available_cash: availableCash } };
    },
  },
  collections: {
    label: 'Collections',
    async build(companyId) {
      const invoices = await openInvoices(companyId);
      return { branches: collectionsBranches(invoices), digest: { open_invoices: invoices } };
    },
  },
  replenishment: {
    label: 'Replenishment',
    async build(companyId) {
      const items = await shortItems(companyId);
      return { branches: replenishmentBranches(items), digest: { short_items: items } };
    },
  },
  /**
   * Everything at once — used when the question does not obviously belong to
   * one module, which is most real questions ("we are tight on cash this month,
   * what do we do?"). The cross-module branches are the ones a departmental
   * tool structurally cannot produce.
   */
  open: {
    label: 'Open decision',
    async build(companyId, availableCash) {
      const [bills, invoices, items] = await Promise.all([
        openBills(companyId, 10), openInvoices(companyId, 10), shortItems(companyId, 8),
      ]);
      const branches = [
        ...paymentRunBranches(bills, availableCash).slice(0, 3),
        ...collectionsBranches(invoices).slice(0, 2),
        ...replenishmentBranches(items).slice(0, 1),
      ];
      // Deduplicate the "Do nothing" controls the sub-generators each contribute.
      const seen = new Set();
      const unique = branches.filter((b) => (seen.has(b.label) ? false : seen.add(b.label)));
      if (!unique.some((b) => b.label.startsWith('Do nothing'))) {
        unique.push({ label: 'Do nothing', summary: 'The null branch.', effects: [] });
      }
      return { branches: unique, digest: { open_bills: bills, open_invoices: invoices, short_items: items, available_cash: availableCash } };
    },
  },
};

/**
 * Pick a scenario from the question when the caller did not name one. Keyword
 * matching, deliberately — routing a decision through a model call before the
 * decision engine has done anything is latency spent on a choice a person can
 * override with one field.
 */
function inferScenario(question = '') {
  const q = question.toLowerCase();
  // Plurals matter more than they look: "receivables" is how people write it,
  // and a \b-terminated "receivable" silently misroutes the commonest phrasing
  // of the commonest question this engine answers.
  if (/\b(pay|paying|payables?|payment run|suppliers?|bills?|vendors?)\b/.test(q)) return 'payment_run';
  if (/\b(collect|collections?|receivables?|customer invoices?|chase|dso|dunning)\b/.test(q)) return 'collections';
  if (/\b(stock|inventory|reorder|replenish\w*|purchase|shortages?|stockouts?)\b/.test(q)) return 'replenishment';
  return 'open';
}

async function generate({ companyId, question, scenario, availableCash, useModel = true }) {
  const key = SCENARIOS[scenario] ? scenario : inferScenario(question);
  const { branches, digest } = await SCENARIOS[key].build(companyId, availableCash);

  let all = branches;
  if (useModel && branches.length) {
    const proposed = await proposeWithModel({ question, digest, existing: branches });
    all = [...branches, ...proposed];
  }

  return { scenario: key, branches: all.slice(0, MAX_BRANCHES), digest };
}

module.exports = {
  generate,
  inferScenario,
  SCENARIOS,
  MAX_BRANCHES,
  // exported for tests
  paymentRunBranches,
  collectionsBranches,
  replenishmentBranches,
};
