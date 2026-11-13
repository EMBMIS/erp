/**
 * Explaining why a number moved.
 *
 * WHY THIS IS THE CENTRAL TOOL OF AN ERP AGENT
 * ---------------------------------------------------------------------------
 * "Why did cash deteriorate this month?" is the question the whole product is
 * organised around, and until now the agent could only approach it by pulling
 * two totals and writing a sentence about the difference. That sentence is
 * where a model invents: it knows revenue fell 12% and it does not know WHICH
 * accounts fell, so it reaches for a plausible reason.
 *
 * Variance decomposition removes the temptation. It returns the movement split
 * by account — every contributor, its before, its after, its delta, and its
 * share of the total change — computed in SQL from journal postings. The model
 * does not have to work out what drove the change; it is handed the list,
 * ranked. Its job becomes explaining a fact rather than proposing a cause.
 *
 * WHAT COUNTS AS A PERIOD
 * ---------------------------------------------------------------------------
 * Plain date ranges, not accounting periods. Someone asking about "this month
 * versus last" means calendar months, and forcing that through the period table
 * fails on a deployment that has not opened periods. Both ranges are stated
 * back in the result so there is never a question about what was compared.
 */

const { pool } = require('../../config/database');

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function validRange(from, to, label) {
  if (!ISO.test(String(from || '')) || !ISO.test(String(to || ''))) {
    return `${label} needs from and to dates as YYYY-MM-DD.`;
  }
  if (from > to) return `${label} starts after it ends.`;
  return null;
}

/** The month containing a date, and the one before it — the common default. */
function defaultRanges() {
  const now = new Date();
  const startThis = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startPrev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const endPrev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const iso = (d) => d.toISOString().slice(0, 10);
  return {
    current: { from: iso(startThis), to: iso(now) },
    baseline: { from: iso(startPrev), to: iso(endPrev) },
  };
}

/**
 * Movement by GL account between two ranges.
 *
 * Debits minus credits per account in each window, then the difference. An
 * account that only exists in one window still appears, with zero on the other
 * side — a cost that started this month is exactly the kind of contributor
 * worth surfacing, and an inner join would hide it.
 */
async function varianceByAccount({ current, baseline, account_type, limit }) {
  const { rows } = await pool.query(
    `WITH movement AS (
       SELECT jei.account_id,
              SUM(CASE WHEN je.entry_date BETWEEN $1 AND $2
                       THEN COALESCE(jei.debit_amount,0) - COALESCE(jei.credit_amount,0) ELSE 0 END) AS current_amount,
              SUM(CASE WHEN je.entry_date BETWEEN $3 AND $4
                       THEN COALESCE(jei.debit_amount,0) - COALESCE(jei.credit_amount,0) ELSE 0 END) AS baseline_amount
         FROM journal_entry_items jei
         JOIN journal_entries je ON je.id = jei.journal_entry_id
        WHERE je.status = 'POSTED'
          AND (je.entry_date BETWEEN $1 AND $2 OR je.entry_date BETWEEN $3 AND $4)
        GROUP BY jei.account_id
     )
     SELECT coa.account_code, coa.account_name, coa.account_type,
            ROUND(m.current_amount, 2)  AS current_amount,
            ROUND(m.baseline_amount, 2) AS baseline_amount,
            ROUND(m.current_amount - m.baseline_amount, 2) AS delta
       FROM movement m
       JOIN chart_of_accounts coa ON coa.id = m.account_id
      WHERE (m.current_amount <> 0 OR m.baseline_amount <> 0)
        AND ($5::text IS NULL OR coa.account_type = $5)
      ORDER BY ABS(m.current_amount - m.baseline_amount) DESC
      LIMIT $6`,
    [current.from, current.to, baseline.from, baseline.to, account_type || null, Math.min(limit || 15, 40)],
  );
  return rows;
}

const varianceTools = [
  {
    name: 'compare_periods',
    description:
      'Compare two date ranges on the general ledger and return the movement broken down by account: what each account '
      + 'was in the baseline, what it is now, the change, and its share of the total change.\n\n'
      + 'This is the tool for "why did X go up/down?". Do not answer that question from two totals and a guess — the '
      + 'contributors come back ranked, and your job is to explain them, not to propose them.\n\n'
      + 'Defaults to this month against last month if no ranges are given. Both ranges are echoed back, so state which '
      + 'periods you compared in your answer.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        current_from: { type: 'string', description: 'YYYY-MM-DD' },
        current_to: { type: 'string', description: 'YYYY-MM-DD' },
        baseline_from: { type: 'string', description: 'YYYY-MM-DD' },
        baseline_to: { type: 'string', description: 'YYYY-MM-DD' },
        account_type: { type: 'string', description: 'Limit to one type, e.g. REVENUE, EXPENSE, ASSET, LIABILITY' },
        limit: { type: 'number', description: 'How many contributors, 1-40. Default 15.' },
      },
    },
    handler: async (args) => {
      const fallback = defaultRanges();
      const current = args.current_from && args.current_to
        ? { from: args.current_from, to: args.current_to }
        : fallback.current;
      const baseline = args.baseline_from && args.baseline_to
        ? { from: args.baseline_from, to: args.baseline_to }
        : fallback.baseline;

      const bad = validRange(current.from, current.to, 'The current range')
        || validRange(baseline.from, baseline.to, 'The baseline range');
      if (bad) return { error: bad };

      let rows;
      try {
        rows = await varianceByAccount({ current, baseline, account_type: args.account_type, limit: args.limit });
      } catch (err) {
        return { error: `Could not read the ledger: ${err.message}` };
      }

      if (!rows.length) {
        return {
          current_range: current,
          baseline_range: baseline,
          contributors: [],
          // A real finding, and a different one from "the query failed".
          note: 'Nothing posted to the ledger in either range, so there is no movement to explain.',
        };
      }

      const totalDelta = rows.reduce((s, r) => s + Number(r.delta), 0);
      const contributors = rows.map((r) => ({
        account_code: r.account_code,
        account_name: r.account_name,
        account_type: r.account_type,
        baseline_amount: Number(r.baseline_amount),
        current_amount: Number(r.current_amount),
        delta: Number(r.delta),
        // Share of the NET change. Null when the net is zero — offsetting
        // movements are real and a percentage of nothing is not meaningful.
        share_of_change: totalDelta === 0 ? null : Math.round((Number(r.delta) / totalDelta) * 1000) / 10,
      }));

      return {
        current_range: current,
        baseline_range: baseline,
        total_delta: Math.round(totalDelta * 100) / 100,
        contributor_count: contributors.length,
        contributors,
        ...(totalDelta === 0 ? {
          note: 'The net change is zero: movements offset each other. The contributors below are still real and worth '
            + 'reading — say that they offset rather than that nothing happened.',
        } : {}),
      };
    },
  },
  {
    name: 'get_cash_movement',
    description:
      'Money in and money out over a date range, from customer receipts and supplier payments, with the net. Use this '
      + 'for a cash question specifically — compare_periods works on the whole ledger, which includes accruals that '
      + 'never touched the bank.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
      },
    },
    handler: async (args) => {
      const fallback = defaultRanges();
      const from = args.from || fallback.current.from;
      const to = args.to || fallback.current.to;
      const bad = validRange(from, to, 'The range');
      if (bad) return { error: bad };

      const inflow = await pool.query(
        `SELECT COALESCE(SUM(payment_amount), 0)::numeric AS total, COUNT(*)::int AS n
           FROM customer_payments
          WHERE payment_date BETWEEN $1 AND $2
            AND deleted_at IS NULL
            AND status <> 'CANCELLED'`,
        [from, to],
      ).catch(() => null);

      const outflow = await pool.query(
        `SELECT COALESCE(SUM(payment_amount), 0)::numeric AS total, COUNT(*)::int AS n
           FROM supplier_payments
          WHERE payment_date BETWEEN $1 AND $2
            AND deleted_at IS NULL
            AND status <> 'CANCELLED'`,
        [from, to],
      ).catch(() => null);

      if (!inflow && !outflow) {
        return { error: 'Neither the customer nor the supplier payment table is present in this deployment.' };
      }

      const received = inflow ? Number(inflow.rows[0].total) : null;
      const paid = outflow ? Number(outflow.rows[0].total) : null;

      return {
        range: { from, to },
        // Null rather than zero where a table is missing: "no payments table"
        // and "no payments" are different answers.
        received,
        received_count: inflow ? inflow.rows[0].n : null,
        paid,
        paid_count: outflow ? outflow.rows[0].n : null,
        net: received === null || paid === null ? null : Math.round((received - paid) * 100) / 100,
      };
    },
  },
];

module.exports = { varianceTools, defaultRanges };
