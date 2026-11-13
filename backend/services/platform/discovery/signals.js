/**
 * Deterministic business signals, counted from the ledger.
 *
 * ===========================================================================
 * WHY NO MODEL RUNS HERE
 * ===========================================================================
 * The obvious way to build capability discovery is to show a model the
 * business's data and ask what is wrong. That is one model call per scan per
 * company, over data that mostly has not changed, producing a fresh opinion
 * every time — expensive, non-reproducible, and impossible to threshold.
 *
 * So detection is arithmetic. Each detector below is a query that counts
 * something specific and returns a weight. The counts accumulate in
 * app_discovery_signals across scans, so "three late deliveries this week" and
 * "three late deliveries every week for two months" are distinguishable, which
 * is the difference between noise and a capability gap.
 *
 * A model is consulted at most once per OPPORTUNITY — after a threshold is
 * crossed and after deduplication — to write the description. Never per scan,
 * and never per row.
 *
 * Every detector is best-effort: a deployment missing a table returns no signal
 * rather than failing the scan. Discovery that breaks when one module is absent
 * is discovery nobody leaves switched on.
 */

const companyContext = require('../../companyContext');

async function safeQuery(client, sql, params = []) {
  try {
    const { rows } = await client.query(sql, params);
    return rows;
  } catch (error) {
    if (error.code === '42P01' || error.code === '42703') return []; // missing table/column
    throw error;
  }
}

/**
 * Each detector: { key, describe(rows), rows }.
 * `weight` is roughly "how much this matters", used to rank opportunities.
 */
const DETECTORS = [
  {
    key: 'late_supplier_deliveries',
    label: 'Purchase orders past their delivery date',
    async detect(client) {
      const rows = await safeQuery(client, `
        SELECT po.supplier_id AS subject, s.legal_name AS subject_label, count(*)::int AS n,
               max(CURRENT_DATE - po.delivery_date)::int AS worst_days_late
          FROM purchase_orders po
          JOIN suppliers s ON s.id = po.supplier_id
         WHERE po.delivery_date < CURRENT_DATE
           AND po.status NOT IN ('RECEIVED', 'CLOSED', 'CANCELLED', 'COMPLETED')
         GROUP BY po.supplier_id, s.legal_name
        HAVING count(*) >= 2
         ORDER BY count(*) DESC LIMIT 20`);
      return rows.map((r) => ({
        subject: r.subject,
        observations: r.n,
        weight: Math.min(10, r.n) + Math.min(10, (r.worst_days_late || 0) / 7),
        evidence: { supplier: r.subject_label, latePurchaseOrders: r.n, worstDaysLate: r.worst_days_late },
      }));
    },
  },

  {
    key: 'overdue_receivables',
    label: 'Customer invoices outstanding past their due date',
    async detect(client) {
      const rows = await safeQuery(client, `
        SELECT customer_id AS subject, count(*)::int AS n,
               sum(outstanding_amount)::numeric AS amount,
               max(CURRENT_DATE - due_date)::int AS worst_days
          FROM customer_invoices
         WHERE due_date < CURRENT_DATE AND COALESCE(outstanding_amount, 0) > 0
           AND deleted_at IS NULL
         GROUP BY customer_id
        HAVING count(*) >= 2
         ORDER BY sum(outstanding_amount) DESC LIMIT 20`);
      return rows.map((r) => ({
        subject: r.subject,
        observations: r.n,
        weight: Math.min(12, r.n * 1.5),
        evidence: { overdueInvoices: r.n, outstanding: Number(r.amount), worstDaysOverdue: r.worst_days },
      }));
    },
  },

  {
    key: 'stock_below_reorder',
    label: 'Inventory sitting below its reorder point',
    async detect(client) {
      const rows = await safeQuery(client, `
        SELECT count(*)::int AS n
          FROM inventory_items
         WHERE reorder_point IS NOT NULL
           AND COALESCE(current_stock_quantity, 0) < reorder_point`);
      const n = rows[0]?.n || 0;
      if (n < 3) return [];
      return [{ subject: null, observations: n, weight: Math.min(10, n / 2), evidence: { itemsBelowReorder: n } }];
    },
  },

  {
    key: 'goods_receipt_quality_issues',
    label: 'Deliveries received in poor condition',
    async detect(client) {
      const rows = await safeQuery(client, `
        SELECT count(*)::int AS n
          FROM goods_receipts
         WHERE condition_grade IS NOT NULL
           AND upper(condition_grade) NOT IN ('A', 'GOOD', 'NEW', 'OK', 'ACCEPTABLE')`);
      const n = rows[0]?.n || 0;
      if (n < 2) return [];
      return [{ subject: null, observations: n, weight: Math.min(12, n), evidence: { poorConditionReceipts: n } }];
    },
  },

  {
    key: 'unresolved_ai_findings',
    label: 'Anomalies the platform raised and nobody closed',
    async detect(client) {
      const rows = await safeQuery(client, `
        SELECT count(*)::int AS n
          FROM ai_findings
         WHERE COALESCE(status, 'OPEN') IN ('OPEN', 'NEW')
           AND created_at > CURRENT_TIMESTAMP - INTERVAL '60 days'`);
      const n = rows[0]?.n || 0;
      if (n < 5) return [];
      return [{ subject: null, observations: n, weight: Math.min(8, n / 3), evidence: { openFindings: n } }];
    },
  },

  {
    key: 'supplier_concentration',
    label: 'A large share of purchasing with one supplier',
    async detect(client) {
      const rows = await safeQuery(client, `
        WITH totals AS (
          SELECT supplier_id, count(*)::int AS orders, sum(COALESCE(total_amount, 0))::numeric AS value
            FROM purchase_orders WHERE po_date > CURRENT_DATE - INTERVAL '365 days'
           GROUP BY supplier_id
        ), overall AS (SELECT sum(value) AS total FROM totals)
        SELECT t.supplier_id AS subject, s.legal_name AS subject_label, t.orders, t.value,
               (t.value / NULLIF((SELECT total FROM overall), 0))::numeric AS share
          FROM totals t JOIN suppliers s ON s.id = t.supplier_id
         WHERE t.value / NULLIF((SELECT total FROM overall), 0) > 0.35
         ORDER BY t.value DESC LIMIT 5`);
      return rows.map((r) => ({
        subject: r.subject,
        observations: r.orders,
        weight: 6 + Number(r.share) * 10,
        evidence: { supplier: r.subject_label, orders: r.orders, shareOfSpend: Math.round(Number(r.share) * 100) },
      }));
    },
  },
];

/**
 * A signal of a different kind: canonical data the company clearly relies on
 * that no installed application does anything with.
 *
 * This is the one that most directly answers "data that lacks an appropriate
 * application" — and it is computed by comparing the catalogue against the
 * counts, with no query over business rows at all.
 */
async function unservedDataSignals(companyId) {
  const catalog = require('../catalog');
  const studioContext = require('../studio/context');
  const [described, context] = await Promise.all([
    catalog.describe(companyId),
    studioContext.gather(companyId),
  ]);
  const served = new Set(described.applications.flatMap((a) => a.dependsOn));
  return context.canonical
    .filter((c) => c.count >= 5 && !served.has(c.key))
    .map((c) => ({
      key: 'canonical_data_unserved',
      subject: c.key,
      observations: c.count,
      weight: Math.min(8, Math.log10(c.count + 1) * 3),
      evidence: { entity: c.key, label: c.label, records: c.count, applicationsUsingIt: 0 },
    }));
}

/**
 * Run every detector for a company. Writes nothing.
 *
 * @returns {Array<{key, subject, observations, weight, evidence}>}
 */
async function collect(companyId) {
  const results = [];
  await companyContext.withCompany(companyId, async (client) => {
    for (const detector of DETECTORS) {
      try {
        const found = await detector.detect(client);
        found.forEach((f) => results.push({ key: detector.key, label: detector.label, ...f }));
      } catch (error) {
        console.warn(`[discovery] detector ${detector.key} failed:`, error.message);
      }
    }
  });
  try {
    results.push(...(await unservedDataSignals(companyId)));
  } catch (error) {
    console.warn('[discovery] unserved-data detection failed:', error.message);
  }
  return results;
}

module.exports = { collect, DETECTORS, unservedDataSignals };
