/**
 * AI audit-trail analysis: suspicious patterns and internal-control weaknesses.
 *
 * This is a controls-and-fraud lens over activity that individually looks
 * legitimate. Every check below corresponds to a real audit test:
 *
 *   • Segregation of duties — the same person creating and approving the same
 *     transaction is the single most common enabler of internal fraud, and no
 *     individual record looks wrong.
 *   • Approval-limit avoidance — amounts clustered just under an approval
 *     threshold suggest deliberate splitting.
 *   • Off-hours posting — entries booked at night or at a weekend are unusual
 *     for routine business and are a classic concealment window.
 *   • Round-number amounts — fabricated figures are round far more often than
 *     genuine ones.
 *   • Backdating — entries posted well after their stated effective date can
 *     move a transaction into an earlier reporting period.
 *   • Benford's law — the leading-digit distribution of natural financial data
 *     is strongly non-uniform; a large deviation is a recognised (though not
 *     conclusive) indicator of manipulation.
 *
 * These are INDICATORS, not accusations. Every one has innocent explanations —
 * a small team genuinely cannot segregate every duty, and month-end really does
 * involve late nights. Output is phrased so a reviewer investigates rather than
 * concludes, and severity reflects how much the pattern narrows that down.
 *
 * Statistical throughout; no LLM. A model asked "does this look like fraud?"
 * produces unfalsifiable narrative, which is precisely the wrong output for an
 * accusation about a named employee.
 */

const { pool } = require('../../config/database');
const stats = require('./stats');

// Business hours outside which posting is treated as off-hours.
const BUSINESS_START_HOUR = 7;
const BUSINESS_END_HOUR = 20;

// Expected first-digit frequencies under Benford's law.
const BENFORD = [0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046];
// Benford needs a decent sample before divergence means anything.
const BENFORD_MIN_SAMPLE = 50;

// ---------------------------------------------------------------------------
// Segregation of duties
// ---------------------------------------------------------------------------

/**
 * Transactions created and approved by the same person.
 * Checked across the document types that carry both fields.
 */
async function checkSegregationOfDuties({ months = 12 } = {}) {
  const targets = [
    { table: 'purchase_orders', number: 'po_number', amount: 'total_amount', date: 'po_date', label: 'purchase order' },
    { table: 'customer_invoices', number: 'invoice_number', amount: 'total_amount', date: 'invoice_date', label: 'customer invoice' },
    { table: 'supplier_invoices', number: 'bill_number', amount: 'total_amount', date: 'invoice_date', label: 'supplier bill' },
  ];

  const violations = [];
  for (const t of targets) {
    const { rows } = await pool
      .query(
        `
        SELECT d.${t.number} AS document_number, d.${t.amount}::float AS amount, d.${t.date} AS document_date,
               u.email AS actor_email, u.first_name, u.last_name, u.role
          FROM ${t.table} d
          JOIN users u ON u.id = d.created_by
         WHERE d.created_by IS NOT NULL
           AND d.approved_by IS NOT NULL
           AND d.created_by = d.approved_by
           AND d.${t.date} >= (CURRENT_DATE - ($1::int || ' months')::interval)
         ORDER BY d.${t.amount} DESC
         LIMIT 50
        `,
        [months]
      )
      .catch(() => ({ rows: [] })); // table may lack these columns in some builds

    rows.forEach((r) => {
      violations.push({
        check: 'SEGREGATION_OF_DUTIES',
        severity: Number(r.amount) >= 10000 ? 'HIGH' : 'MEDIUM',
        document_type: t.label,
        document_number: r.document_number,
        amount: stats.round2(r.amount),
        document_date: r.document_date,
        actor: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.actor_email,
        actor_email: r.actor_email,
        actor_role: r.role,
        detail: `${t.label} ${r.document_number} (${stats.round2(r.amount)}) was created and approved by the same user.`,
        why_it_matters:
          'One person controlling both creation and approval removes the check that makes fictitious or inflated transactions hard to push through.',
        innocent_explanation:
          'Common and often unavoidable in small teams where one manager holds both rights. Confirm whether an independent approver was available.',
      });
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Approval-threshold avoidance
// ---------------------------------------------------------------------------

/**
 * Amounts sitting just below an approval limit. Splitting a 60k purchase into
 * three 19.9k orders is deliberate, and each order looks fine alone.
 */
async function checkThresholdAvoidance({ months = 12, bandPct = 0.05 } = {}) {
  const { rows: limits } = await pool
    .query(`SELECT DISTINCT amount_limit::float AS threshold FROM delegation_of_authority WHERE amount_limit > 0`)
    .catch(() => ({ rows: [] }));

  const thresholds = limits.length ? limits.map((r) => r.threshold) : [5000, 10000, 25000, 50000, 100000];

  const { rows } = await pool.query(
    `
    SELECT po.po_number, po.total_amount::float AS amount, po.po_date,
           s.legal_name AS supplier_name, u.email AS created_by_email
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id
      LEFT JOIN users u     ON u.id = po.created_by
     WHERE po.po_date >= (CURRENT_DATE - ($1::int || ' months')::interval)
       AND po.total_amount > 0
    `,
    [months]
  );

  const findings = [];
  for (const po of rows) {
    for (const threshold of thresholds) {
      const lower = threshold * (1 - bandPct);
      if (po.amount >= lower && po.amount < threshold) {
        findings.push({
          check: 'APPROVAL_THRESHOLD_AVOIDANCE',
          severity: 'MEDIUM',
          document_type: 'purchase order',
          document_number: po.po_number,
          amount: stats.round2(po.amount),
          threshold,
          supplier: po.supplier_name,
          actor_email: po.created_by_email,
          detail: `PO ${po.po_number} at ${stats.round2(po.amount)} sits just under the ${threshold} approval threshold (within ${bandPct * 100}%).`,
          why_it_matters:
            'Values clustered immediately below an approval limit can indicate transactions sized to avoid a higher level of scrutiny.',
          innocent_explanation:
            'Budget holders often work to a known limit legitimately. Look for repetition — the same supplier repeatedly just under the line is the real signal.',
        });
        break;
      }
    }
  }

  // Repetition is what elevates this from coincidence.
  const bySupplier = new Map();
  findings.forEach((f) => {
    const key = f.supplier || 'unknown';
    bySupplier.set(key, (bySupplier.get(key) || 0) + 1);
  });
  findings.forEach((f) => {
    const count = bySupplier.get(f.supplier || 'unknown');
    if (count >= 3) {
      f.severity = 'HIGH';
      f.detail += ` ${count} such orders exist for this supplier — a repeating pattern, not an isolated amount.`;
    }
  });

  return findings;
}

// ---------------------------------------------------------------------------
// Off-hours and weekend activity
// ---------------------------------------------------------------------------

async function checkOffHoursActivity({ months = 6 } = {}) {
  const { rows } = await pool.query(
    `
    SELECT je.journal_number, je.entry_date, je.created_at, je.total_debit::float AS amount,
           je.description, u.email AS actor_email, u.first_name, u.last_name,
           EXTRACT(HOUR FROM je.created_at)::int AS hour,
           EXTRACT(ISODOW FROM je.created_at)::int AS iso_dow
      FROM journal_entries je
      LEFT JOIN users u ON u.id = je.created_by
     WHERE je.status = 'POSTED' AND je.deleted_at IS NULL
       AND je.created_at >= (CURRENT_DATE - ($1::int || ' months')::interval)
       AND (EXTRACT(ISODOW FROM je.created_at) >= 6
            OR EXTRACT(HOUR FROM je.created_at) < $2
            OR EXTRACT(HOUR FROM je.created_at) >= $3)
     ORDER BY je.total_debit DESC
     LIMIT 50
    `,
    [months, BUSINESS_START_HOUR, BUSINESS_END_HOUR]
  );

  return rows.map((r) => {
    const weekend = r.iso_dow >= 6;
    return {
      check: 'OFF_HOURS_POSTING',
      severity: weekend && Number(r.amount) >= 10000 ? 'HIGH' : 'LOW',
      document_type: 'journal entry',
      document_number: r.journal_number,
      amount: stats.round2(r.amount),
      posted_at: r.created_at,
      actor: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.actor_email,
      actor_email: r.actor_email,
      detail: `${r.journal_number} (${stats.round2(r.amount)}) was posted ${weekend ? 'at a weekend' : `at ${String(r.hour).padStart(2, '0')}:00`}.`,
      why_it_matters:
        'Postings made when nobody else is working attract less contemporaneous review.',
      innocent_explanation:
        'Month-end and year-end close routinely run late and through weekends. Judge against the period, not the clock alone.',
    };
  });
}

// ---------------------------------------------------------------------------
// Backdating
// ---------------------------------------------------------------------------

/**
 * Entries whose effective date is well before the moment they were recorded —
 * how a transaction gets pushed back into an earlier reporting period.
 */
async function checkBackdating({ months = 12, thresholdDays = 30 } = {}) {
  const { rows } = await pool.query(
    `
    SELECT je.journal_number, je.entry_date, je.created_at, je.total_debit::float AS amount, je.description,
           u.email AS actor_email,
           (je.created_at::date - je.entry_date)::int AS lag_days
      FROM journal_entries je
      LEFT JOIN users u ON u.id = je.created_by
     WHERE je.status = 'POSTED' AND je.deleted_at IS NULL
       AND je.created_at >= (CURRENT_DATE - ($1::int || ' months')::interval)
       AND (je.created_at::date - je.entry_date) > $2
     ORDER BY (je.created_at::date - je.entry_date) DESC
     LIMIT 50
    `,
    [months, thresholdDays]
  );

  return rows.map((r) => ({
    check: 'BACKDATED_ENTRY',
    severity: r.lag_days > 90 ? 'HIGH' : 'MEDIUM',
    document_type: 'journal entry',
    document_number: r.journal_number,
    amount: stats.round2(r.amount),
    entry_date: r.entry_date,
    recorded_at: r.created_at,
    lag_days: r.lag_days,
    actor_email: r.actor_email,
    detail: `${r.journal_number} is dated ${new Date(r.entry_date).toISOString().split('T')[0]} but was only recorded ${r.lag_days} days later.`,
    why_it_matters:
      'A large gap between effective and recording date can shift results between reporting periods after the fact.',
    innocent_explanation:
      'Accruals, late supplier documents and corrections are legitimately backdated. Check whether the period was already closed and reported.',
  }));
}

// ---------------------------------------------------------------------------
// Round-number amounts
// ---------------------------------------------------------------------------

async function checkRoundAmounts({ months = 12, minAmount = 1000 } = {}) {
  const { rows } = await pool.query(
    `
    SELECT je.journal_number, je.entry_date, je.total_debit::float AS amount, je.description,
           u.email AS actor_email
      FROM journal_entries je
      LEFT JOIN users u ON u.id = je.created_by
     WHERE je.status = 'POSTED' AND je.deleted_at IS NULL
       AND je.entry_date >= (CURRENT_DATE - ($1::int || ' months')::interval)
       AND je.total_debit >= $2
       AND MOD(je.total_debit::numeric, 1000) = 0
     ORDER BY je.total_debit DESC
     LIMIT 50
    `,
    [months, minAmount]
  );

  return rows.map((r) => ({
    check: 'ROUND_NUMBER_AMOUNT',
    severity: 'LOW',
    document_type: 'journal entry',
    document_number: r.journal_number,
    amount: stats.round2(r.amount),
    entry_date: r.entry_date,
    actor_email: r.actor_email,
    detail: `${r.journal_number} is an exact round amount (${stats.round2(r.amount)}).`,
    why_it_matters:
      'Genuine transactional amounts are rarely perfectly round; estimated or fabricated figures often are.',
    innocent_explanation:
      'Accruals, transfers, budgets, retainers and fixed fees are legitimately round. This is only meaningful in aggregate.',
  }));
}

// ---------------------------------------------------------------------------
// Benford's law
// ---------------------------------------------------------------------------

/**
 * Compare the leading-digit distribution of posted amounts against Benford.
 * Reports the sample size prominently: on a small ledger this test is noise,
 * and presenting it as a result would be actively misleading.
 */
async function checkBenfordsLaw({ months = 24 } = {}) {
  const { rows } = await pool.query(
    `
    SELECT je.total_debit::float AS amount
      FROM journal_entries je
     WHERE je.status = 'POSTED' AND je.deleted_at IS NULL
       AND je.entry_date >= (CURRENT_DATE - ($1::int || ' months')::interval)
       AND je.total_debit > 0
    `,
    [months]
  );

  const digits = rows
    .map((r) => String(Math.abs(r.amount)).replace(/[^1-9]/, '').charAt(0))
    .filter((d) => d >= '1' && d <= '9')
    .map(Number);

  if (digits.length < BENFORD_MIN_SAMPLE) {
    return {
      applicable: false,
      sample_size: digits.length,
      required_sample: BENFORD_MIN_SAMPLE,
      note: `Only ${digits.length} posted amounts — Benford's law needs at least ${BENFORD_MIN_SAMPLE} to mean anything. Test not run.`,
      findings: [],
    };
  }

  const observed = new Array(9).fill(0);
  digits.forEach((d) => { observed[d - 1] += 1; });

  // Chi-squared goodness of fit, 8 degrees of freedom.
  let chiSquared = 0;
  const distribution = observed.map((count, i) => {
    const expected = BENFORD[i] * digits.length;
    chiSquared += (count - expected) ** 2 / expected;
    return {
      digit: i + 1,
      observed: count,
      observed_pct: stats.round2((count / digits.length) * 100),
      expected_pct: stats.round2(BENFORD[i] * 100),
    };
  });

  // 15.51 = 95th percentile, 20.09 = 99th percentile at df=8.
  const deviates = chiSquared > 15.51;
  return {
    applicable: true,
    sample_size: digits.length,
    chi_squared: stats.round2(chiSquared),
    critical_value_95: 15.51,
    deviates,
    distribution,
    findings: deviates
      ? [
          {
            check: 'BENFORD_DEVIATION',
            severity: chiSquared > 20.09 ? 'MEDIUM' : 'LOW',
            detail: `Leading-digit distribution deviates from Benford's law (χ²=${stats.round2(chiSquared)} against a 95% critical value of 15.51).`,
            why_it_matters:
              'Naturally occurring financial amounts follow a predictable leading-digit distribution; a significant departure is a recognised screening indicator.',
            innocent_explanation:
              'Strongly skewed by design in many legitimate ledgers — fixed pricing, round contract values, or a narrow range of transaction sizes all break the assumption. This is a screen, never evidence.',
          },
        ]
      : [],
  };
}

// ---------------------------------------------------------------------------
// AI tool-usage review
// ---------------------------------------------------------------------------

/**
 * Review the AI's own audit log. If the agent is acting in the ERP, its
 * behaviour is part of the control environment too.
 */
async function checkAiActivity({ days = 30 } = {}) {
  const { rows } = await pool
    .query(
      `
      SELECT tool_name, actor, COUNT(*)::int AS calls,
             COUNT(*) FILTER (WHERE success = false)::int AS failures,
             COUNT(*) FILTER (WHERE read_only = false)::int AS writes,
             MAX(created_at) AS last_used
        FROM ai_audit_log
       WHERE created_at >= (CURRENT_DATE - ($1::int || ' days')::interval)
       GROUP BY tool_name, actor
       ORDER BY writes DESC, calls DESC
       LIMIT 50
      `,
      [days]
    )
    .catch(() => ({ rows: [] }));

  const findings = [];
  const totalWrites = rows.reduce((s, r) => s + r.writes, 0);
  const totalFailures = rows.reduce((s, r) => s + r.failures, 0);

  rows.forEach((r) => {
    if (r.failures >= 5 && r.failures / r.calls > 0.5) {
      findings.push({
        check: 'AI_TOOL_FAILURE_RATE',
        severity: 'LOW',
        detail: `AI tool "${r.tool_name}" failed ${r.failures} of ${r.calls} calls.`,
        why_it_matters:
          'A repeatedly failing tool may indicate a broken integration, or repeated attempts to do something the guardrails are refusing.',
        innocent_explanation: 'Most often a genuine bug or missing data rather than misuse.',
      });
    }
  });

  return {
    window_days: days,
    total_calls: rows.reduce((s, r) => s + r.calls, 0),
    total_writes: totalWrites,
    total_failures: totalFailures,
    by_tool: rows,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Full analysis
// ---------------------------------------------------------------------------

/**
 * Run every control test and return a consolidated, severity-ranked report.
 */
async function analyzeAuditTrail({ months = 12 } = {}) {
  const [sod, thresholds, offHours, backdating, roundAmounts, benford, aiActivity] = await Promise.all([
    checkSegregationOfDuties({ months }),
    checkThresholdAvoidance({ months }),
    checkOffHoursActivity({ months: Math.min(months, 6) }),
    checkBackdating({ months }),
    checkRoundAmounts({ months }),
    checkBenfordsLaw({ months: Math.max(months, 24) }),
    checkAiActivity({}),
  ]);

  const findings = [...sod, ...thresholds, ...offHours, ...backdating, ...roundAmounts, ...benford.findings, ...aiActivity.findings];

  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.amount || 0) - (a.amount || 0));

  const bySeverity = {
    HIGH: findings.filter((f) => f.severity === 'HIGH').length,
    MEDIUM: findings.filter((f) => f.severity === 'MEDIUM').length,
    LOW: findings.filter((f) => f.severity === 'LOW').length,
  };

  return {
    analysed_at: new Date().toISOString(),
    window_months: months,
    checks_run: [
      'SEGREGATION_OF_DUTIES',
      'APPROVAL_THRESHOLD_AVOIDANCE',
      'OFF_HOURS_POSTING',
      'BACKDATED_ENTRY',
      'ROUND_NUMBER_AMOUNT',
      benford.applicable ? 'BENFORD_LAW' : 'BENFORD_LAW (skipped — sample too small)',
      'AI_TOOL_USAGE',
    ],
    total_findings: findings.length,
    by_severity: bySeverity,
    findings,
    benford,
    ai_activity: aiActivity,
    disclaimer:
      'These are control indicators, not findings of wrongdoing. Every pattern here has legitimate explanations, and small organisations will unavoidably trigger several. Investigate before drawing conclusions, and never treat a flag as evidence about a named individual.',
  };
}

module.exports = {
  analyzeAuditTrail,
  checkSegregationOfDuties,
  checkThresholdAvoidance,
  checkOffHoursActivity,
  checkBackdating,
  checkRoundAmounts,
  checkBenfordsLaw,
  checkAiActivity,
};
