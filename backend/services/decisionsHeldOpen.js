/**
 * Decisions held open — what is waiting on a person, what it is worth, and
 * what it is holding up.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * An approval inbox says how many things are pending. It does not say which
 * one matters. A purchase order for twelve thousand can be holding up a
 * customer order for fifty, and the only way to know is to walk from the
 * approval to what depends on it: the purchase line is the supply a work order
 * or an order line is counting on, and the order line is a customer's promise.
 *
 * So every pending decision in the company — purchase orders, sales orders,
 * purchase requisitions and supplier contracts awaiting approval, and anything
 * an agent escalated to a person — comes back with:
 *
 *   worth        the document's own value
 *   waiting      since when (the last move into its pending state), and on whom
 *                (the approval-chain step if there is one, else the role its
 *                approve endpoint requires)
 *   holding up   the customer orders that depend on it, read from the same
 *                delivery trace Simeli answers "why will Friday slip?" from
 *                (services/deliveryRisk.js): a pending purchase order is a
 *                supply line an order is waiting on; a requisition is the only
 *                cover for a line with nothing on order; a pending sales order
 *                is itself a customer's promise that cannot move
 *   verdict      whether approving it is enough to keep those dates, or whether
 *                something else on the chain is late too
 *
 * and the whole set is ranked by what it holds, so the first row is the one
 * decision that is costing the most by waiting.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It decides nothing. Approving stays on the document's own approve endpoint
 * (DoA limits, approval chains and segregation of duties are enforced there),
 * reached from the Approval Inbox. Simeli brings the decision with its reason
 * attached; a person makes it.
 *
 * VISIBILITY
 * ---------------------------------------------------------------------------
 * Every query is filtered by company_id on top of RLS. Managers, finance
 * managers and admins see every pending decision. Anyone else sees the
 * decisions on documents they raised and the ones an approval chain addresses
 * to them. The customer orders named under "holding up" come through the
 * delivery trace with the caller's role, so a USER role only sees its own.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const moduleService = require('./moduleService');
const { traceDeliveryRisk } = require('./deliveryRisk');

const SEES_ALL = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER']);
/** The roles each document's approve endpoint accepts (routes/*: requireRole / requireManagerOrAdmin). */
const DECIDERS = ['MANAGER', 'ADMIN'];
/** Held longer than this and it counts as escalated, whether or not anyone escalated it. */
const OVERDUE_DAYS = 3;
/** How far ahead the trace looks for orders a decision can hold up. */
const HORIZON_DAYS = 60;

const DAY = 86400000;
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const round = (v, p = 2) => Math.round((Number(v) || 0) * 10 ** p) / 10 ** p;

function fmtMoney(value, cur) {
  const v = Math.round(Number(value) || 0).toLocaleString('en-US');
  return cur ? `${cur} ${v}` : v;
}

function ago(since, now) {
  if (!since) return null;
  const hours = Math.max(0, (now - new Date(since).getTime()) / 3600000);
  if (hours < 24) return `${Math.max(1, Math.round(hours))} h`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/* ------------------------------------------------------------------ reads */

/** The open approval-chain step for a document, if an approval chain governs it. */
const CHAIN_STEP = (docId) => `
  LEFT JOIN LATERAL (
    SELECT ars.approver_role, ars.approver_user_id,
           NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS approver_name
      FROM approval_requests ar
      JOIN approval_request_steps ars ON ars.request_id = ar.id AND ars.step_number = ar.current_step
      LEFT JOIN users u ON u.id = ars.approver_user_id
     WHERE ar.document_id = ${docId} AND ar.status = 'PENDING' AND ar.company_id = $1
     ORDER BY ar.created_at DESC
     LIMIT 1
  ) step ON true`;

async function readPending(companyId, modules) {
  const reads = [];

  if (modules.has('procurement')) {
    reads.push(pool.query(
      `SELECT 'purchase_order' AS kind, po.id, po.po_number AS number, po.total_amount::float AS value, po.currency,
              po.created_by, COALESCE(s.trade_name, s.legal_name) AS party, po.delivery_date AS needed_by,
              COALESCE((SELECT MAX(h.status_date) FROM purchase_order_status_history h
                         WHERE h.purchase_order_id = po.id AND h.to_status = 'PENDING_APPROVAL'),
                       po.updated_at, po.created_at) AS waiting_since,
              step.approver_role, step.approver_user_id, step.approver_name
         FROM purchase_orders po
         LEFT JOIN suppliers s ON s.id = po.supplier_id
         ${CHAIN_STEP('po.id')}
        WHERE po.company_id = $1 AND po.status = 'PENDING_APPROVAL'`,
      [companyId],
    ));
    reads.push(pool.query(
      `SELECT 'purchase_requisition' AS kind, pr.id, pr.pr_number AS number,
              (COALESCE(pr.quantity, 0) * COALESCE(pr.estimated_unit_price, 0))::float AS value, pr.currency,
              pr.requested_by AS created_by, COALESCE(i.name, pr.item_description) AS party,
              pr.item_id, pr.quantity::float AS quantity, NULL::date AS needed_by,
              COALESCE((SELECT MAX(h.status_date) FROM purchase_requisition_status_history h
                         WHERE h.requisition_id = pr.id AND h.to_status = 'PENDING_APPROVAL'),
                       pr.updated_at, pr.created_at) AS waiting_since,
              step.approver_role, step.approver_user_id, step.approver_name
         FROM purchase_requisitions pr
         LEFT JOIN items i ON i.id = pr.item_id
         ${CHAIN_STEP('pr.id')}
        WHERE pr.company_id = $1 AND pr.status = 'PENDING_APPROVAL'`,
      [companyId],
    ));
    reads.push(pool.query(
      `SELECT 'contract' AS kind, c.id, COALESCE(c.contract_number, c.title) AS number, c.contract_value::float AS value,
              c.currency, c.created_by, COALESCE(s.trade_name, s.legal_name) AS party, c.start_date AS needed_by,
              COALESCE((SELECT MAX(h.status_date) FROM contract_status_history h
                         WHERE h.contract_id = c.id AND h.to_status = 'PENDING_APPROVAL'),
                       c.updated_at, c.created_at) AS waiting_since,
              step.approver_role, step.approver_user_id, step.approver_name
         FROM contracts c
         LEFT JOIN suppliers s ON s.id = c.supplier_id
         ${CHAIN_STEP('c.id')}
        WHERE c.company_id = $1 AND c.status = 'PENDING_APPROVAL'`,
      [companyId],
    ));
  }

  if (modules.has('sales')) {
    reads.push(pool.query(
      `SELECT 'sales_order' AS kind, so.id, so.so_number AS number, so.total_amount::float AS value, so.currency,
              so.created_by, so.customer_name AS party, so.delivery_date AS needed_by,
              COALESCE(so.approval_requested_at,
                       (SELECT MAX(h.status_date) FROM sales_order_status_history h
                         WHERE h.sales_order_id = so.id AND h.to_status = 'PENDING_APPROVAL'),
                       so.updated_at, so.created_at) AS waiting_since,
              step.approver_role, step.approver_user_id, step.approver_name
         FROM sales_orders so
         ${CHAIN_STEP('so.id')}
        WHERE so.company_id = $1 AND so.deleted_at IS NULL AND so.status = 'PENDING_APPROVAL'`,
      [companyId],
    ));
  }

  // What an agent could not decide on its own and handed to a person.
  reads.push(pool.query(
    `SELECT 'escalation' AS kind, e.id, e.title AS number, e.amount::float AS value, e.currency,
            NULL::uuid AS created_by, e.agent_key AS party, NULL::date AS needed_by, e.created_at AS waiting_since,
            e.entity_type, e.entity_id, e.reason, e.proposed_action, e.detail,
            NULL::text AS approver_role, NULL::uuid AS approver_user_id, NULL::text AS approver_name
       FROM agent_escalations e
      WHERE e.company_id = $1 AND e.status = 'OPEN'`,
    [companyId],
  ));

  const results = await Promise.all(reads);
  return results.flatMap((r) => r.rows);
}

/** Decisions people made in the last seven days, by kind. */
async function readMadeThisWeek(companyId) {
  const { rows: [r] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM purchase_orders WHERE company_id = $1
          AND (approved_at >= now() - interval '7 days' OR rejected_at >= now() - interval '7 days'))::int AS purchase_orders,
       (SELECT COUNT(*) FROM sales_orders WHERE company_id = $1
          AND (approved_at >= now() - interval '7 days' OR rejected_at >= now() - interval '7 days'))::int AS sales_orders,
       (SELECT COUNT(*) FROM purchase_requisition_status_history h
          JOIN purchase_requisitions pr ON pr.id = h.requisition_id
         WHERE pr.company_id = $1 AND h.from_status = 'PENDING_APPROVAL' AND h.to_status IN ('APPROVED', 'DECLINED')
           AND h.status_date >= now() - interval '7 days')::int AS purchase_requisitions,
       (SELECT COUNT(*) FROM contracts WHERE company_id = $1 AND approved_at >= now() - interval '7 days')::int AS contracts,
       (SELECT COUNT(*) FROM agent_escalations WHERE company_id = $1 AND resolved_at >= now() - interval '7 days')::int AS escalations`,
    [companyId],
  );
  const total = Object.values(r).reduce((s, n) => s + Number(n || 0), 0);
  return { total, by_kind: r };
}

async function baseCurrency(companyId) {
  const { rows } = await pool.query('SELECT base_currency FROM companies WHERE id = $1', [companyId]);
  return rows[0]?.base_currency || null;
}

/* ------------------------------------------------------------ dependencies */

/** Every purchase order a traced customer order is counting on, directly or through a component. */
function purchaseOrdersBehind(order) {
  const ids = new Set();
  for (const l of order.lines || []) {
    for (const d of l.depends_on || []) if (d.type === 'purchase_order' && d.id) ids.add(d.id);
  }
  for (const s of order.chain || []) if (s.record?.type === 'purchase_order' && s.record.id) ids.add(s.record.id);
  return ids;
}

/**
 * Is approving `decisionId` enough for this order to keep its date? Only when
 * the order is merely at risk and every cause on its chain is an approval that
 * has not happened yet — the order is otherwise covered in time.
 */
function approvalSaves(order, pendingPoIds) {
  if (order.verdict !== 'at_risk') return false;
  const causes = (order.chain || []).filter((s) => s.kind);
  return causes.length > 0 && causes.every((s) => s.kind === 'po_not_approved' && pendingPoIds.has(s.record?.id));
}

function heldOrder(order, extra = {}) {
  return {
    sales_order_id: order.sales_order_id,
    so_number: order.so_number,
    customer_name: order.customer_name,
    due_date: order.due_date,
    projected_date: order.projected_date,
    verdict: order.verdict,
    value: round(order.value_at_risk),
    currency: order.currency,
    cause: order.cause,
    ...extra,
  };
}

/* ------------------------------------------------------------------- build */

const KIND_LABEL = {
  purchase_order: 'Purchase order',
  sales_order: 'Sales order',
  purchase_requisition: 'Purchase requisition',
  contract: 'Contract',
  escalation: 'Agent escalation',
};

/** Where the person makes the decision. The Approval Inbox deep-links to the row. */
function decideAt(d) {
  switch (d.kind) {
    case 'purchase_order': return `/approvals/unified?tab=purchase-orders&id=${d.id}`;
    case 'sales_order': return `/approvals/unified?tab=sales-orders&id=${d.id}`;
    case 'purchase_requisition': return `/approvals/unified?tab=purchase-requisitions&id=${d.id}`;
    case 'contract': return `/approvals/unified?tab=contracts&id=${d.id}`;
    case 'escalation': return '/agents';
    default: return '/approvals/unified';
  }
}

function waitingOn(d) {
  if (d.approver_name) return d.approver_name;
  if (d.approver_role) return `a ${String(d.approver_role).toLowerCase().replace(/_/g, ' ')}`;
  return 'a manager';
}

function canDecide(d, userId, role) {
  if (d.created_by && userId && d.created_by === userId) return false;   // segregation of duties
  if (d.approver_user_id) return d.approver_user_id === userId;
  if (d.approver_role) return d.approver_role === role || role === 'ADMIN';
  return DECIDERS.includes(role);
}

function reasonFor(d) {
  const worth = d.value ? ` (${fmtMoney(d.value, d.currency)}${d.party ? `, ${d.party}` : ''})` : (d.party ? ` (${d.party})` : '');
  const head = `${d.number}${worth}`;
  const held = d.holding_up;
  if (!held.length) {
    if (d.holding_up_outside_your_view) {
      const n = d.holding_up_outside_your_view;
      return `${head}: ${n} customer order${n === 1 ? '' : 's'} outside your view depend${n === 1 ? 's' : ''} on it.`;
    }
    if (d.kind === 'sales_order') return `${head} is a customer order that cannot go out until someone approves it.`;
    if (d.kind === 'escalation') return `${head}: ${d.escalation?.reason || 'an agent handed this to a person'}.`;
    return `${head}: nothing due in the next ${HORIZON_DAYS} days depends on it.`;
  }
  const first = held[0];
  const more = held.length > 1 ? ` and ${held.length - 1} more order${held.length === 2 ? '' : 's'}` : '';
  const due = first.due_date ? `, due ${first.due_date}` : '';
  if (d.kind === 'sales_order') {
    return `${head} is ${first.customer_name}'s order${due}; it cannot move until someone approves it.`;
  }
  if (d.kind === 'escalation') {
    return `${head} holds ${first.so_number} for ${first.customer_name} (${fmtMoney(first.value, first.currency)}${due})${more}: ${d.escalation?.reason || 'an agent handed it to a person'}.`;
  }
  if (d.kind === 'purchase_requisition') {
    return `${head} is the only cover for ${first.uncovered} units ${first.so_number} for ${first.customer_name}${due} has nothing on order for${more}.`;
  }
  const lead = `${first.so_number} for ${first.customer_name} (${fmtMoney(first.value, first.currency)}${due})${more} depend${held.length > 1 ? '' : 's'} on ${head}.`;
  if (d.approval_keeps_dates) return `${lead} Approving it is all that stands between ${held.length > 1 ? 'those orders' : 'the order'} and ${held.length > 1 ? 'their dates' : 'its date'}.`;
  const stillLate = held.find((h) => h.verdict === 'late' || h.verdict === 'uncovered');
  if (stillLate) return `${lead} Approving it is needed but not enough: ${stillLate.cause || `${stillLate.so_number} is late for other reasons too`}.`;
  return lead;
}

/**
 * @param {object} opts
 *   companyId, userId, role   who is asking
 *   mine                      only decisions this person can make
 *   kind                      purchase_order | sales_order | purchase_requisition | contract | escalation
 *   document                  one decision, by id or number
 *   limit                     how many to return (default 25)
 */
async function decisionsHeldOpen(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  const now = Date.now();
  const userId = opts.userId || null;
  const role = opts.role || null;
  const seesAll = !userId || SEES_ALL.has(role);

  const modules = await moduleService.getEnabledModuleKeys(companyId);
  const [pending, made, currency] = await Promise.all([
    readPending(companyId, modules),
    readMadeThisWeek(companyId),
    baseCurrency(companyId),
  ]);

  // The trace, as the person asking: allocation counts every order, the orders
  // it names are the ones this role may see.
  // Orders the caller may not see still count — as a number, never by name —
  // so a buyer is not told nothing depends on a purchase order that holds up
  // somebody else's customer.
  let trace = { orders: [] };
  let visibleOrders = null;
  if (modules.has('sales') && pending.some((d) => d.kind !== 'contract')) {
    const [all, own] = await Promise.all([
      traceDeliveryRisk({ companyId, horizonDays: HORIZON_DAYS }),
      seesAll ? null : traceDeliveryRisk({ companyId, userId, role, horizonDays: HORIZON_DAYS }),
    ]);
    trace = all.error ? { orders: [] } : all;
    if (own) visibleOrders = new Set((own.orders || []).map((o) => o.sales_order_id));
  }
  const pendingPoIds = new Set(pending.filter((d) => d.kind === 'purchase_order').map((d) => d.id));
  const behind = trace.orders.map((o) => ({ order: o, pos: purchaseOrdersBehind(o) }));

  const decisions = [];
  for (const d of pending) {
    const visible = seesAll
      || (d.created_by && d.created_by === userId)
      || (d.approver_user_id && d.approver_user_id === userId)
      || (d.approver_role && d.approver_role === role);
    if (!visible) continue;

    let holding = [];
    if (d.kind === 'purchase_order') {
      holding = behind.filter((b) => b.pos.has(d.id)).map((b) => heldOrder(b.order, { saved_by_approval: approvalSaves(b.order, pendingPoIds) }));
    } else if (d.kind === 'purchase_requisition' && d.item_id) {
      for (const o of trace.orders) {
        const uncovered = (o.lines || []).filter((l) => l.item_id === d.item_id && l.uncovered > 0)
          .reduce((s, l) => s + l.uncovered, 0);
        if (uncovered > 0) holding.push(heldOrder(o, { uncovered: round(uncovered, 3), covered_by_request: round(Math.min(uncovered, d.quantity || 0), 3) }));
      }
    } else if (d.kind === 'sales_order') {
      const traced = trace.orders.find((o) => o.sales_order_id === d.id);
      holding = [traced
        ? heldOrder(traced, { value: round(d.value) })
        : { sales_order_id: d.id, so_number: d.number, customer_name: d.party, due_date: iso(d.needed_by), projected_date: null, verdict: 'awaiting_approval', value: round(d.value), currency: d.currency, cause: null }];
    } else if (d.kind === 'escalation' && d.entity_id) {
      holding = trace.orders
        .filter((o) => o.sales_order_id === d.entity_id || purchaseOrdersBehind(o).has(d.entity_id))
        .map((o) => heldOrder(o));
    }
    // A pending sales order is the document itself; whoever may decide it may see it.
    const hidden = visibleOrders && d.kind !== 'sales_order' ? holding.filter((h) => !visibleOrders.has(h.sales_order_id)) : [];
    if (hidden.length) holding = holding.filter((h) => !hidden.includes(h));
    holding.sort((a, b) => b.value - a.value || String(a.due_date).localeCompare(String(b.due_date)));

    const waitedDays = d.waiting_since ? (now - new Date(d.waiting_since).getTime()) / DAY : 0;
    const entry = {
      kind: d.kind,
      kind_label: KIND_LABEL[d.kind],
      id: d.id,
      number: d.number,
      party: d.party,
      value: round(d.value),
      currency: d.currency,
      waiting_since: d.waiting_since,
      waiting_for: ago(d.waiting_since, now),
      waiting_on: d.kind === 'escalation' ? 'a manager' : waitingOn(d),
      approver_user_id: d.approver_user_id || null,
      approver_role: d.approver_role || null,
      raised_by: d.created_by || null,
      yours_to_decide: canDecide(d, userId, role),
      escalated: d.kind === 'escalation' || waitedDays > OVERDUE_DAYS,
      holding_up: holding,
      holding_up_outside_your_view: hidden.length,
      held_value: round(holding.reduce((s, h) => s + (h.value || 0), 0)),
      approval_keeps_dates: holding.length > 0 && holding.every((h) => h.saved_by_approval),
      decide_at: decideAt(d),
      ...(d.kind === 'escalation' ? { escalation: { reason: d.reason, proposed_action: d.proposed_action, detail: d.detail, entity_type: d.entity_type, entity_id: d.entity_id } } : {}),
    };
    entry.reason = reasonFor(entry);
    entry.proposal = entry.yours_to_decide
      ? { kind: 'decide', label: `Review and decide ${entry.number}`, at: entry.decide_at }
      : { kind: 'nudge', label: `Waiting on ${entry.waiting_on}`, at: entry.decide_at };
    decisions.push(entry);
  }

  if (opts.kind) {
    for (let i = decisions.length - 1; i >= 0; i--) if (decisions[i].kind !== opts.kind) decisions.splice(i, 1);
  }
  if (opts.mine) {
    for (let i = decisions.length - 1; i >= 0; i--) if (!decisions[i].yours_to_decide) decisions.splice(i, 1);
  }
  let target = null;
  if (opts.document) {
    const q = String(opts.document).trim().toLowerCase();
    target = decisions.find((d) => String(d.id) === q || String(d.number || '').toLowerCase() === q) || null;
    if (!target) return { error: `${opts.document} is not waiting on anyone you can see — it may already be decided, or it is not pending approval.` };
  }

  // What waiting is costing, most first: what it holds, then how soon that is due, then how long it has waited.
  const soonest = (d) => d.holding_up.reduce((m, h) => (h.due_date && (!m || h.due_date < m) ? h.due_date : m), null) || '9999-12-31';
  decisions.sort((a, b) => b.held_value - a.held_value
    || soonest(a).localeCompare(soonest(b))
    || new Date(a.waiting_since || 0) - new Date(b.waiting_since || 0));

  // Exposure: each customer order counted once, however many decisions hold it.
  const heldOrders = new Map();
  for (const d of decisions) for (const h of d.holding_up) if (!heldOrders.has(h.sales_order_id)) heldOrders.set(h.sales_order_id, h);
  const exposure = [...heldOrders.values()].reduce((s, h) => s + (h.value || 0), 0);

  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 25, 1), 100);
  return {
    as_of: new Date(now).toISOString(),
    scope: seesAll ? 'every pending decision in the company' : 'decisions on documents you raised or addressed to you',
    summary: {
      awaiting: decisions.length,
      yours: decisions.filter((d) => d.yours_to_decide).length,
      made_this_week: made.total,
      made_this_week_by_kind: made.by_kind,
      escalated: decisions.filter((d) => d.escalated).length,
      value_awaiting: round(decisions.reduce((s, d) => s + (d.value || 0), 0)),
      exposure_held_open: round(exposure),
      orders_held: heldOrders.size,
      currency: currency || decisions.find((d) => d.currency)?.currency || null,
    },
    decisions: target ? [target] : decisions.slice(0, limit),
    method:
      'Pending approvals are read from purchase orders, sales orders, purchase requisitions and supplier contracts in '
      + `PENDING_APPROVAL, plus open agent escalations. What each one holds up comes from the delivery trace over the next ${HORIZON_DAYS} `
      + 'days: the customer orders whose lines (or whose work orders\' components) count on a pending purchase order, the '
      + 'order lines with nothing on order for a requisition\'s item, and a pending sales order itself. Exposure counts each '
      + `customer order once. A decision waiting more than ${OVERDUE_DAYS} days, or escalated by an agent, counts as escalated. `
      + 'Nothing was changed; each decision is made on its own approval screen.',
  };
}

/* --------------------------------------------------------------- finding */

/** A decision is worth interrupting someone for when a customer order due this soon is waiting on it. */
const SOON_DAYS = 7;

/**
 * Raise (or refresh) a finding for every pending decision that holds up a
 * customer order due within a week, and tell the people who can make it.
 * Deduplicated per document while open; a dismissal suppresses re-raising for
 * its window (both handled by upsertFinding). A finding whose decision has
 * since been made, or no longer holds anything that soon, is resolved.
 * Run by the scheduler and the findings scan.
 */
async function raiseDecisionFindings(companyId) {
  const { upsertFinding } = require('./ai/findingsScan');
  const resolved = await resolveCompany(companyId);
  const result = await decisionsHeldOpen({ companyId: resolved, limit: 100 });
  const soon = new Date(Date.now() + SOON_DAYS * DAY).toISOString().slice(0, 10);

  const urgent = result.decisions.filter((d) => d.holding_up.some((h) => h.due_date && h.due_date <= soon));
  const created = [];
  for (const d of urgent) {
    const r = await upsertFinding({
      companyId: resolved,
      finding_type: 'DECISION_HOLDING_ORDER',
      severity: d.approval_keeps_dates || d.escalated ? 'HIGH' : 'MEDIUM',
      entity_type: d.kind.toUpperCase(),
      entity_id: d.id,
      title: `${d.number} is holding up ${d.holding_up.map((h) => h.so_number).join(', ')}`.slice(0, 255),
      description: d.reason,
      data: {
        number: d.number, value: d.value, held_value: d.held_value, currency: d.currency, waiting_for: d.waiting_for,
        orders: d.holding_up.map((h) => ({ so_number: h.so_number, due_date: h.due_date, value: h.value })),
        approval_keeps_dates: d.approval_keeps_dates, link: d.decide_at,
      },
    });
    if (r.created) {
      created.push(r.id);
      await notifyDeciders(resolved, d, r.id).catch((e) => console.warn('Decision notify failed:', e.message));
    }
  }
  await pool.query(
    `UPDATE ai_findings SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND finding_type = 'DECISION_HOLDING_ORDER' AND status = 'OPEN'
        AND NOT (entity_id = ANY($2::uuid[]))`,
    [resolved, urgent.map((d) => d.id)],
  );
  return { created, decisions: result.decisions.length };
}

/** The people who can make this decision, in THIS company only — never the person who raised it. */
async function notifyDeciders(companyId, d, findingId) {
  const { rows: [doc] } = await pool.query(
    `SELECT created_by FROM (
       SELECT id, created_by FROM purchase_orders WHERE company_id = $1
       UNION ALL SELECT id, created_by FROM sales_orders WHERE company_id = $1
       UNION ALL SELECT id, requested_by FROM purchase_requisitions WHERE company_id = $1
       UNION ALL SELECT id, created_by FROM contracts WHERE company_id = $1
     ) x WHERE id = $2`,
    [companyId, d.id],
  );
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
       LEFT JOIN user_companies uc ON uc.user_id = u.id AND uc.company_id = $1
      WHERE COALESCE(uc.role, u.role) = ANY($2)
        AND u.id IS DISTINCT FROM $3
        AND (uc.user_id IS NOT NULL
             OR (NOT EXISTS (SELECT 1 FROM user_companies x WHERE x.user_id = u.id)
                 AND EXISTS (SELECT 1 FROM companies c WHERE c.id = $1 AND c.is_default)))`,
    [companyId, DECIDERS, doc?.created_by || null],
  );
  for (const u of rows) {
    await pool.query(
      `INSERT INTO notifications (id, type, title, message, data, user_id, company_id, created_at)
       VALUES (gen_random_uuid(), 'AI_FINDING', $1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [
        `Waiting on you: ${d.number} holds ${d.holding_up.map((h) => h.so_number).join(', ')}`.slice(0, 255),
        d.reason,
        JSON.stringify({ finding_id: findingId, document_id: d.id, link: d.decide_at }),
        u.id,
        companyId,
      ],
    );
  }
}

module.exports = { decisionsHeldOpen, raiseDecisionFindings };
