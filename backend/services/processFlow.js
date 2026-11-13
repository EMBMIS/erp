/**
 * Which steps actually move — order to cash and procure to pay, measured.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * A process diagram says what the steps are. It does not say which of them the
 * business actually gets through and which it sits in. "Where do our orders
 * get stuck", "why is cash slow to come in", "what is holding up purchasing"
 * are answered here from the timestamps the documents already carry, for each
 * step of the two flows every company runs:
 *
 *   Order to cash    quotation sent → customer answers
 *                    order raised → approved
 *                    approved → goods issued
 *                    goods issued → invoiced
 *                    invoiced → paid
 *   Procure to pay   requisition raised → approved
 *                    requisition approved → purchase order raised
 *                    purchase order raised → approved
 *                    approved → goods received
 *                    received → supplier invoice booked
 *                    supplier invoice → paid
 *
 * For every step:
 *
 *   Moves        documents that finished the step in the window (default 90
 *                days): how many, the median and the 80th-percentile days it
 *                took. The same median over the window before says whether the
 *                step has slowed down or sped up.
 *   Waiting      documents in the step right now: how many, what they are
 *                worth, how long the oldest has waited.
 *   Stuck        the ones waiting longer than the step's own 80th percentile —
 *                its normal, measured, not a configured SLA — or past the date
 *                the document itself promised (delivery date, due date, quote
 *                validity). Each names its record.
 *
 * The flow's bottleneck is the step with the most value stuck in it. Its
 * proposals name the tool that acts on that step (explain_pending_decisions,
 * explain_delivery_risk, preview_dunning_reminders, plan_supplier_payment_run…);
 * every one of those drafts or previews for a person.
 *
 * WHERE THE TIMESTAMPS COME FROM
 * ---------------------------------------------------------------------------
 * Goods issued is the first goods issue posted against the order, or the first
 * status-history move into a shipped state, whichever is earlier. Received is
 * the first goods receipt, or the supplier-confirmed delivery. Paid is the last
 * payment allocated to an invoice that is now paid. A step is only measured on
 * documents that have both ends; a document that skipped a step (an order that
 * needed no approval) is not counted in it.
 *
 * WHO SEES WHAT
 * ---------------------------------------------------------------------------
 * Company-scoped like everything else. Roles that see all orders (admin,
 * manager, finance manager) see the company's flow; anyone else sees what is
 * waiting and stuck among the documents they raised, measured against the
 * company's timings for each step (durations only, no other document). A flow is only read when its module is
 * enabled for the company.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const moduleService = require('./moduleService');

const SEES_ALL = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER']);
const DAY = 86400000;
const SHIPPED = ['GOODS_ISSUED', 'READY_FOR_DELIVERY', 'SHIPPED', 'DELIVERED', 'WAITING_CUSTOMER_DELIVERY_CONFIRMATION', 'DELIVERY_ISSUE_REPORTED', 'COMPLETED'];
const TO_SHIP = ['APPROVED', 'SENT_TO_CUSTOMER', 'CONFIRMED', 'CUSTOMER_ACCEPTED', 'IN_PRODUCTION'];
const PO_TO_RECEIVE = ['APPROVED', 'SENT_TO_SUPPLIER', 'CONFIRMED', 'PREPARING_DELIVERY', 'IN_TRANSIT'];

const round = (v, p = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** p) / 10 ** p);
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function money(v, cur) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 }).format(v || 0);
  } catch {
    return `${Math.round(v || 0)} ${cur || ''}`.trim();
  }
}
const days = (d) => (d == null ? '—' : d < 1 ? 'under a day' : `${round(d, d < 10 ? 1 : 0)} day${round(d, 1) === 1 ? '' : 's'}`);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/* ------------------------------------------------------------------ steps */

/**
 * Each step is one query returning, per document: id, number, start_at,
 * end_at (null while it waits), value, currency, party, promise (the date the
 * document itself committed to) and open (true while it waits in this step).
 * $1 company, $2 the user whose own documents are read (null = all).
 */
const SO_SHIP_AT = `LEAST(
  (SELECT MIN(wt.created_at)::timestamptz FROM warehouse_transactions wt
    WHERE wt.company_id = so.company_id AND wt.transaction_type = 'GI' AND wt.reference_type = 'SO' AND wt.reference_id = so.id
      AND COALESCE(wt.status, '') NOT IN ('CANCELLED', 'REJECTED')),
  (SELECT MIN(h.status_date) FROM sales_order_status_history h
    WHERE h.sales_order_id = so.id AND h.to_status = ANY('{${SHIPPED.join(',')}}'::text[])))`;

const PO_RECEIVED_AT = `LEAST(
  (SELECT MIN(gr.received_date) FROM goods_receipts gr WHERE gr.po_id = po.id AND gr.company_id = po.company_id),
  po.delivery_confirmed_at)`;

const FLOWS = [
  {
    key: 'order_to_cash',
    label: 'Order to cash',
    module: 'sales',
    steps: [
      {
        key: 'quote_answer',
        label: 'Quotation sent → customer answers',
        waits_on: 'the customer',
        tool: 'create_crm_activity',
        propose: (s) => `Follow up the ${s.stuck.count} quotation${s.stuck.count === 1 ? '' : 's'} the customer has not answered`,
        sql: `SELECT q.id, q.quotation_number AS number, 'sales_quotation' AS type, q.sent_to_customer_at AS start_at,
                     COALESCE(q.accepted_at, q.customer_responded_at) AS end_at,
                     q.total_amount::float8 AS value, q.currency, c.customer_name AS party, q.valid_until AS promise,
                     q.status = 'SENT' AS open
                FROM sales_quotations q LEFT JOIN customers c ON c.id = q.customer_id
               WHERE q.company_id = $1 AND q.deleted_at IS NULL AND ($2::uuid IS NULL OR q.created_by = $2)`,
      },
      {
        key: 'so_approval',
        label: 'Order raised → approved',
        waits_on: 'an approver',
        tool: 'explain_pending_decisions',
        propose: (s) => `Bring the ${s.stuck.count} order${s.stuck.count === 1 ? '' : 's'} waiting for approval to their approvers, largest first`,
        sql: `SELECT so.id, so.so_number AS number, 'sales_order' AS type, COALESCE(so.approval_requested_at, so.created_at) AS start_at,
                     so.approved_at AS end_at, so.total_amount::float8 AS value, so.currency,
                     COALESCE(so.customer_name, c.customer_name) AS party, so.delivery_date AS promise,
                     (so.status = 'PENDING_APPROVAL' AND so.approved_at IS NULL) AS open
                FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id
               WHERE so.company_id = $1 AND so.deleted_at IS NULL AND ($2::uuid IS NULL OR so.created_by = $2)`,
      },
      {
        key: 'so_ship',
        label: 'Approved → goods issued',
        waits_on: 'the warehouse and production',
        tool: 'explain_delivery_risk',
        propose: (s) => `Trace why ${s.stuck.count} approved order${s.stuck.count === 1 ? ' has' : 's have'} not shipped, and what would make ${s.stuck.count === 1 ? 'it' : 'them'} hold`,
        sql: `SELECT so.id, so.so_number AS number, 'sales_order' AS type,
                     COALESCE(so.approved_at, CASE WHEN so.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'CANCELLED', 'CUSTOMER_REJECTED') THEN so.created_at END) AS start_at,
                     ${SO_SHIP_AT} AS end_at, so.total_amount::float8 AS value, so.currency,
                     COALESCE(so.customer_name, c.customer_name) AS party, so.delivery_date AS promise,
                     so.status = ANY('{${TO_SHIP.join(',')}}'::text[]) AS open
                FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id
               WHERE so.company_id = $1 AND so.deleted_at IS NULL AND ($2::uuid IS NULL OR so.created_by = $2)`,
      },
      {
        key: 'ship_invoice',
        label: 'Goods issued → invoiced',
        waits_on: 'finance',
        tool: 'create_customer_invoice_draft',
        propose: (s, cur) => `Invoice the ${s.stuck.count} shipped order${s.stuck.count === 1 ? '' : 's'} worth ${money(s.stuck.value, cur)} — each invoice is a draft until it is approved`,
        sql: `SELECT so.id, so.so_number AS number, 'sales_order' AS type, ${SO_SHIP_AT} AS start_at,
                     (SELECT MIN(ci.created_at) FROM customer_invoices ci
                       WHERE ci.sales_order_id = so.id AND ci.company_id = so.company_id AND ci.deleted_at IS NULL AND ci.status <> 'CANCELLED') AS end_at,
                     so.total_amount::float8 AS value, so.currency,
                     COALESCE(so.customer_name, c.customer_name) AS party, NULL::date AS promise,
                     so.status = ANY('{${SHIPPED.join(',')}}'::text[]) AS open
                FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id
               WHERE so.company_id = $1 AND so.deleted_at IS NULL AND ($2::uuid IS NULL OR so.created_by = $2)`,
      },
      {
        key: 'invoice_cash',
        label: 'Invoiced → paid',
        waits_on: 'the customer',
        tool: 'preview_dunning_reminders',
        propose: (s, cur) => `Preview the reminders for the ${s.stuck.count} invoice${s.stuck.count === 1 ? '' : 's'} past due (${money(s.stuck.value, cur)} outstanding)`,
        sql: `SELECT ci.id, ci.invoice_number AS number, 'customer_invoice' AS type, ci.invoice_date::timestamptz AS start_at,
                     CASE WHEN ci.status = 'PAID' OR COALESCE(ci.outstanding_amount, 0) <= 0 THEN
                       (SELECT MAX(p.payment_date)::timestamptz FROM customer_payment_allocations a
                          JOIN customer_payments p ON p.id = a.payment_id AND p.company_id = ci.company_id AND p.deleted_at IS NULL AND COALESCE(p.status, '') NOT IN ('BOUNCED', 'CANCELLED', 'VOID', 'REVERSED')
                         WHERE a.invoice_id = ci.id) END AS end_at,
                     (CASE WHEN ci.status = 'PAID' THEN ci.total_amount ELSE ci.outstanding_amount END)::float8 AS value, ci.currency,
                     c.customer_name AS party, ci.due_date AS promise,
                     (ci.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED', 'PAID') AND COALESCE(ci.outstanding_amount, 0) > 0) AS open
                FROM customer_invoices ci LEFT JOIN customers c ON c.id = ci.customer_id
               WHERE ci.company_id = $1 AND ci.deleted_at IS NULL AND ci.status <> 'CANCELLED' AND ($2::uuid IS NULL OR ci.created_by = $2)`,
      },
    ],
  },
  {
    key: 'procure_to_pay',
    label: 'Procure to pay',
    module: 'procurement',
    steps: [
      {
        key: 'pr_approval',
        label: 'Requisition raised → approved',
        waits_on: 'an approver',
        tool: 'explain_pending_decisions',
        propose: (s) => `Bring the ${s.stuck.count} requisition${s.stuck.count === 1 ? '' : 's'} waiting for approval to their approvers`,
        sql: `SELECT pr.id, pr.pr_number AS number, 'purchase_requisition' AS type, pr.created_at AS start_at, pr.approved_at AS end_at,
                     (COALESCE(pr.quantity, 0) * COALESCE(pr.estimated_unit_price, 0))::float8 AS value, pr.currency,
                     pr.item_description AS party, NULL::date AS promise,
                     (pr.status IN ('SUBMITTED', 'PENDING_APPROVAL') AND pr.approved_at IS NULL) AS open
                FROM purchase_requisitions pr
               WHERE pr.company_id = $1 AND pr.status NOT IN ('DRAFT', 'CANCELLED') AND ($2::uuid IS NULL OR pr.requested_by = $2)`,
      },
      {
        key: 'pr_po',
        label: 'Requisition approved → purchase order raised',
        waits_on: 'procurement',
        tool: 'create_purchase_order_draft',
        propose: (s) => `Draft purchase orders for the ${s.stuck.count} approved requisition${s.stuck.count === 1 ? '' : 's'} nobody has ordered`,
        sql: `SELECT pr.id, pr.pr_number AS number, 'purchase_requisition' AS type, pr.approved_at AS start_at,
                     (SELECT MIN(po.created_at) FROM purchase_orders po
                       WHERE po.purchase_requisition_id = pr.id AND po.company_id = pr.company_id AND po.status NOT IN ('CANCELLED', 'REJECTED')) AS end_at,
                     (COALESCE(pr.quantity, 0) * COALESCE(pr.estimated_unit_price, 0))::float8 AS value, pr.currency,
                     pr.item_description AS party, NULL::date AS promise, pr.status = 'APPROVED' AS open
                FROM purchase_requisitions pr
               WHERE pr.company_id = $1 AND ($2::uuid IS NULL OR pr.requested_by = $2)`,
      },
      {
        key: 'po_approval',
        label: 'Purchase order raised → approved',
        waits_on: 'an approver',
        tool: 'explain_pending_decisions',
        propose: (s) => `Bring the ${s.stuck.count} purchase order${s.stuck.count === 1 ? '' : 's'} waiting for approval to their approvers, with what each holds up`,
        sql: `SELECT po.id, po.po_number AS number, 'purchase_order' AS type, po.created_at AS start_at, po.approved_at AS end_at,
                     po.total_amount::float8 AS value, po.currency, COALESCE(s.trade_name, s.legal_name) AS party, po.delivery_date AS promise,
                     (po.status = 'PENDING_APPROVAL' AND po.approved_at IS NULL) AS open
                FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
               WHERE po.company_id = $1 AND po.status NOT IN ('DRAFT') AND ($2::uuid IS NULL OR po.created_by = $2)`,
      },
      {
        key: 'po_receipt',
        label: 'Approved → goods received',
        waits_on: 'the supplier',
        tool: 'monitor_supplier_risk',
        propose: (s) => `See which suppliers are behind the ${s.stuck.count} late purchase order${s.stuck.count === 1 ? '' : 's'} and which customer orders they reach`,
        sql: `SELECT po.id, po.po_number AS number, 'purchase_order' AS type, COALESCE(po.approved_at, po.po_date::timestamptz) AS start_at,
                     ${PO_RECEIVED_AT} AS end_at, po.total_amount::float8 AS value, po.currency,
                     COALESCE(s.trade_name, s.legal_name) AS party, po.delivery_date AS promise,
                     po.status = ANY('{${PO_TO_RECEIVE.join(',')}}'::text[]) AS open
                FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
               WHERE po.company_id = $1 AND po.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED', 'REJECTED')
                 AND ($2::uuid IS NULL OR po.created_by = $2)`,
      },
      {
        key: 'receipt_bill',
        label: 'Received → supplier invoice booked',
        waits_on: 'the supplier and accounts payable',
        tool: 'get_invoice_match_exceptions',
        propose: (s) => `Check the ${s.stuck.count} received order${s.stuck.count === 1 ? '' : 's'} with no supplier invoice against the three-way match`,
        sql: `SELECT po.id, po.po_number AS number, 'purchase_order' AS type, ${PO_RECEIVED_AT} AS start_at,
                     (SELECT MIN(si.created_at) FROM supplier_invoices si
                       WHERE si.purchase_order_id = po.id AND si.company_id = po.company_id AND si.deleted_at IS NULL AND si.status <> 'CANCELLED') AS end_at,
                     po.total_amount::float8 AS value, po.currency, COALESCE(s.trade_name, s.legal_name) AS party, NULL::date AS promise,
                     po.status NOT IN ('CANCELLED', 'REJECTED') AS open
                FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
               WHERE po.company_id = $1 AND ($2::uuid IS NULL OR po.created_by = $2)`,
      },
      {
        key: 'bill_pay',
        label: 'Supplier invoice → paid',
        waits_on: 'finance',
        tool: 'plan_supplier_payment_run',
        propose: (s, cur) => `Plan a payment run for the ${s.stuck.count} supplier invoice${s.stuck.count === 1 ? '' : 's'} past due (${money(s.stuck.value, cur)})`,
        sql: `SELECT si.id, COALESCE(si.bill_number, si.supplier_invoice_number) AS number, 'supplier_invoice' AS type, si.invoice_date::timestamptz AS start_at,
                     CASE WHEN si.status = 'PAID' OR COALESCE(si.outstanding_amount, 0) <= 0 THEN
                       (SELECT MAX(p.payment_date)::timestamptz FROM supplier_payment_allocations a
                          JOIN supplier_payments p ON p.id = a.payment_id AND p.company_id = si.company_id AND p.deleted_at IS NULL AND COALESCE(p.status, '') NOT IN ('BOUNCED', 'CANCELLED', 'VOID', 'REVERSED')
                         WHERE a.bill_id = si.id) END AS end_at,
                     (CASE WHEN si.status = 'PAID' THEN si.total_amount ELSE si.outstanding_amount END)::float8 AS value, si.currency,
                     COALESCE(s.trade_name, s.legal_name) AS party, si.due_date AS promise,
                     (si.status NOT IN ('DRAFT', 'CANCELLED', 'PAID') AND COALESCE(si.outstanding_amount, 0) > 0) AS open
                FROM supplier_invoices si LEFT JOIN suppliers s ON s.id = si.supplier_id
               WHERE si.company_id = $1 AND si.deleted_at IS NULL AND si.status <> 'CANCELLED' AND ($2::uuid IS NULL OR si.created_by = $2)`,
      },
    ],
  },
];

/* --------------------------------------------------------------- measure */

async function readStep(step, companyId, ownerId, since) {
  const { rows } = await pool.query(
    `SELECT * FROM (${step.sql}) d
      WHERE d.start_at IS NOT NULL
        AND ((d.end_at IS NOT NULL AND d.end_at >= $3) OR (d.end_at IS NULL AND d.open))`,
    [companyId, ownerId, since],
  );
  return rows;
}

/**
 * rows are the documents the person sees; normRows the company's, which the
 * step's timings are measured on (durations only — no document reaches the
 * answer from them).
 */
function measure(step, rows, normRows, { windowDays, now }) {
  const cut = now - windowDays * DAY;
  const cur = [];
  const prior = [];
  const waiting = [];
  for (const r of normRows) {
    if (!r.end_at) continue;
    const end = new Date(r.end_at).getTime();
    const d = Math.max(0, end - new Date(r.start_at).getTime()) / DAY;
    (end >= cut ? cur : prior).push(d);
  }
  for (const r of rows) {
    if (!r.end_at) waiting.push({ ...r, age: Math.max(0, now - new Date(r.start_at).getTime()) / DAY });
  }
  cur.sort((a, b) => a - b);
  prior.sort((a, b) => a - b);
  const median = percentile(cur, 0.5);
  const p80 = percentile(cur, 0.8);
  const priorMedian = percentile(prior, 0.5);
  // A norm needs a few finished documents behind it; with fewer, only a broken
  // promise makes a waiting document stuck.
  const norm = cur.length >= 3 ? Math.max(p80, 1) : null;
  const today = new Date(new Date(now).toISOString().slice(0, 10)).getTime();

  let trend = 'steady';
  if (median != null && priorMedian != null && prior.length >= 3) {
    if (median > priorMedian * 1.25 && median - priorMedian >= 1) trend = 'slower';
    else if (median < priorMedian * 0.8 && priorMedian - median >= 1) trend = 'faster';
  }

  const stuck = [];
  for (const w of waiting) {
    const pastPromise = w.promise && new Date(w.promise).getTime() < today;
    const overNorm = norm != null && w.age > norm;
    if (!pastPromise && !overNorm) continue;
    stuck.push({
      id: w.id,
      type: w.type,
      number: w.number,
      party: w.party,
      value: round(w.value || 0, 2),
      currency: w.currency,
      waiting_days: round(w.age, 1),
      since: iso(w.start_at),
      promise: iso(w.promise),
      why: pastPromise && overNorm
        ? `waiting ${days(w.age)}, past its ${iso(w.promise)} date and over the usual ${days(norm)}`
        : pastPromise ? `past its ${iso(w.promise)} date` : `waiting ${days(w.age)}, the step usually takes ${days(norm)} at most`,
    });
  }
  stuck.sort((a, b) => b.value - a.value || b.waiting_days - a.waiting_days);
  const sum = (list) => round(list.reduce((s, x) => s + (Number(x.value) || 0), 0), 2);

  let status = 'moving';
  if (stuck.length) status = 'stuck';
  else if (trend === 'slower') status = 'slower';
  else if (!cur.length && !waiting.length) status = 'idle';

  return {
    key: step.key,
    label: step.label,
    waits_on: step.waits_on,
    status,
    finished: { count: cur.length, median_days: round(median), p80_days: round(p80), prior_median_days: round(priorMedian), prior_count: prior.length },
    trend,
    waiting: { count: waiting.length, value: sum(waiting), oldest_days: waiting.length ? round(Math.max(...waiting.map((w) => w.age)), 1) : null },
    stuck: { count: stuck.length, value: sum(stuck), documents: stuck.slice(0, 6) },
  };
}

function flowHeadline(flow, steps, currency) {
  const stuckSteps = steps.filter((s) => s.stuck.count).sort((a, b) => b.stuck.value - a.stuck.value || b.stuck.count - a.stuck.count);
  const slower = steps.filter((s) => s.trend === 'slower').sort((a, b) => (b.finished.median_days - b.finished.prior_median_days) - (a.finished.median_days - a.finished.prior_median_days));
  const measured = steps.filter((s) => s.finished.count);
  if (!measured.length && !steps.some((s) => s.waiting.count)) {
    return { bottleneck: null, text: `${flow.label}: nothing has moved through it in the window yet.` };
  }
  const b = stuckSteps[0];
  let text;
  if (b) {
    const norm = b.finished.median_days != null ? `; it usually takes ${days(b.finished.median_days)}` : '';
    text = `${flow.label} is stuck at "${b.label}": ${b.stuck.count} document${b.stuck.count === 1 ? '' : 's'} worth ${money(b.stuck.value, currency)} `
      + `${b.stuck.count === 1 ? 'is' : 'are'} waiting longer than they should${norm}, oldest ${days(b.waiting.oldest_days)}. It waits on ${b.waits_on}.`;
  } else {
    const slowest = [...measured].sort((x, y) => y.finished.median_days - x.finished.median_days)[0];
    // Documents are waiting but none has finished a step yet: there is no norm to be slow against.
    text = slowest
      ? `${flow.label} is moving: nothing is waiting past its normal time. The longest step is "${slowest.label}" at ${days(slowest.finished.median_days)} (median).`
      : `${flow.label}: ${steps.reduce((n, s) => n + s.waiting.count, 0)} document(s) waiting, none past its promised date; no step has finished in the window yet, so there is no normal time to measure against.`;
  }
  if (slower[0]) {
    const s = slower[0];
    text += ` "${s.label}" has slowed from ${days(s.finished.prior_median_days)} to ${days(s.finished.median_days)}.`;
  }
  return { bottleneck: b ? b.key : null, text };
}

/* ------------------------------------------------------------------ main */

/**
 * opts: { companyId, userId, role, flow: 'order_to_cash' | 'procure_to_pay' | 'all', windowDays }
 */
async function mapProcessFlow(opts = {}) {
  const companyId = opts.companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
  if (!companyId) return { error: 'No company in context.' };
  const windowDays = Math.min(365, Math.max(30, Number(opts.windowDays) || 90));
  const seesAll = SEES_ALL.has(opts.role) || !opts.userId;
  const ownerId = seesAll ? null : opts.userId;
  const now = Date.now();
  const since = new Date(now - 2 * windowDays * DAY);

  const enabled = await moduleService.getEnabledModuleKeys(companyId).catch(() => null);
  const wanted = FLOWS.filter((f) => (!opts.flow || opts.flow === 'all' || opts.flow === f.key) && (!enabled || enabled.has(f.module)));
  if (!wanted.length) return { error: opts.flow && opts.flow !== 'all' ? `The ${opts.flow.replace(/_/g, ' ')} flow is not available: its module is not enabled.` : 'Neither Sales nor Procurement is enabled for this company.' };

  const { rows: [co] } = await pool.query('SELECT base_currency FROM companies WHERE id = $1', [companyId]);
  const currency = co?.base_currency || 'EUR';

  const flows = [];
  for (const flow of wanted) {
    const steps = [];
    for (const step of flow.steps) {
      const normRows = await readStep(step, companyId, null, since);
      const rows = ownerId ? await readStep(step, companyId, ownerId, since) : normRows;
      steps.push(measure(step, rows, normRows, { windowDays, now }));
    }
    const head = flowHeadline(flow, steps, currency);
    const proposals = steps
      .filter((s) => s.stuck.count)
      .sort((a, b) => b.stuck.value - a.stuck.value || b.stuck.count - a.stuck.count)
      .slice(0, 3)
      .map((s) => {
        const def = flow.steps.find((d) => d.key === s.key);
        return {
          step: s.key,
          tool: def.tool,
          label: def.propose(s, currency),
          documents: s.stuck.documents.map((d) => ({ id: d.id, type: d.type, number: d.number })),
        };
      });
    flows.push({ key: flow.key, label: flow.label, headline: head.text, bottleneck: head.bottleneck, steps, proposals });
  }

  const worst = [...flows].sort((a, b) => {
    const v = (f) => f.steps.find((s) => s.key === f.bottleneck)?.stuck.value || 0;
    return v(b) - v(a);
  })[0];

  return {
    headline: flows.length > 1 ? flows.map((f) => f.headline).join(' ') : flows[0].headline,
    worst_flow: worst.bottleneck ? worst.key : null,
    currency,
    window_days: windowDays,
    scope: seesAll ? 'company' : 'yours',
    as_of: new Date(now).toISOString(),
    flows,
    sources: ['sales_quotations', 'sales_orders', 'sales_order_status_history', 'warehouse_transactions', 'customer_invoices', 'customer_payment_allocations',
      'purchase_requisitions', 'purchase_orders', 'goods_receipts', 'supplier_invoices', 'supplier_payment_allocations']
      .filter((t) => flows.some((f) => (f.key === 'order_to_cash' ? !/purchase|supplier|goods_receipts/.test(t) : /purchase|supplier|goods_receipts/.test(t)))),
    note: 'Read-only. Stuck means waiting longer than the step\'s own 80th percentile over the window, or past the date the document promised.',
  };
}

module.exports = { mapProcessFlow, FLOWS };
