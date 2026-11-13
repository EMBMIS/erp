/**
 * "Simeli watches what is happening and surfaces what matters. One line slows
 * down, and it already knows what that will cost."
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * "What needs my attention today?" Every watcher this product has — the
 * delivery trace, the line watch, the cash outlook, the duplicate-bill check,
 * the margin drivers, supplier risk, decisions held open, people coverage —
 * answers its own question well, but only when someone thinks to ask it. A
 * person opening the system in the morning should not have to know eight
 * questions. This asks all of them, as that person, and returns the handful of
 * things that need someone today, most money first, each with its cause, the
 * record it came from and the next step a person approves.
 *
 * HOW IT IS PUT TOGETHER
 * ---------------------------------------------------------------------------
 *   • Each watcher runs as the asking user, so its own role rule applies: a
 *     sales rep sees their own orders, cash and bills stay with finance and
 *     managers, and a watcher that refuses the role is reported as "not in
 *     your view" rather than leaking a number. Watchers for modules the
 *     company has turned off do not run.
 *   • One business problem is shown once. A late order caused by a slow line,
 *     a late supplier or a decision nobody has made is folded into that cause
 *     — the line, the supplier, the decision — instead of appearing twice; the
 *     exposure in the summary counts each customer order once.
 *   • Ranking: severity first (something already late, short or about to be
 *     paid twice), then the money at stake.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing. Every next step names the existing tool or screen that
 * carries it out, and each of those drafts, holds or asks — the approval stays
 * with a person.
 */

const companyContext = require('./companyContext');
const moduleService = require('./moduleService');

const round = (v, p = 2) => Math.round((Number(v) || 0) * 10 ** p) / 10 ** p;
const TTL_MS = 60 * 1000;
const cache = new Map();

function money(v, cur) {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur || 'EUR', maximumFractionDigits: 0 }).format(v || 0);
  } catch {
    return `${Math.round(v || 0).toLocaleString('en-GB')} ${cur || ''}`.trim();
  }
}

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

function linkFor(r) {
  if (!r?.id && !r?.type) return null;
  switch (r.type) {
    case 'sales_order': return `/sales/sales-orders/${r.id}`;
    case 'purchase_order': return `/procurement/purchase-orders/${r.id}`;
    case 'supplier': return `/procurement/suppliers/${r.id}`;
    case 'work_center': return '/manufacturing/work-centers';
    case 'work_order': return '/manufacturing/work-orders';
    case 'supplier_invoice': return '/finance/supplier-invoices';
    case 'cash': return '/finance/cash-forecast';
    case 'margin': return '/finance/dashboard';
    case 'item': return `/inventory/items/${r.id}`;
    case 'customer': return `/sales/customers/${r.id}`;
    default: return null;
  }
}

/** The watchers, each as the asking user. `module` null = always on (role rules still apply inside). */
const WATCHERS = [
  {
    key: 'deliveries', label: 'Customer deliveries', module: 'sales',
    run: (o) => require('./deliveryRisk').traceDeliveryRisk({ ...o, horizonDays: 14 }),
  },
  {
    key: 'lines', label: 'Production lines', module: 'manufacturing',
    run: (o) => require('./lineWatch').watchLines(o),
  },
  {
    key: 'suppliers', label: 'Suppliers', module: 'procurement',
    run: (o) => require('./supplierRisk').assessSupplierRisk(o),
  },
  {
    key: 'decisions', label: 'Decisions waiting on a person', module: null,
    run: (o) => require('./decisionsHeldOpen').decisionsHeldOpen({ ...o, limit: 50 }),
  },
  {
    key: 'people', label: 'Who is in to decide', module: null,
    run: (o) => require('./peopleCoverage').peopleCoverage(o),
  },
  {
    key: 'cash', label: 'Cash, next 13 weeks', module: null,
    run: (o) => require('./cashOutlook').explainCashOutlook(o),
  },
  {
    key: 'bills', label: 'Supplier bills before payment', module: null,
    run: (o) => require('./billedTwice').scanBills({ ...o, limit: 20 }),
  },
  {
    key: 'margin', label: 'Gross margin this month', module: null,
    run: (o) => require('./marginDrivers').explainMargin(o),
  },  {
    // What the company built for itself in Sandbox (quality findings, audits, claims…), read as the person.
    key: 'built', label: 'What you built in Sandbox', module: null,
    run: (o) => require('./builtSignals').readBuiltSignals(o),
  },
];

/* ------------------------------------------------------------- per watcher */

function fromLines(r) {
  return (r.lines || []).map((l) => {
    const cost = (l.extra_cost || 0) + (l.lost_cost || 0);
    const move = (l.proposals || []).find((p) => p.kind === 'move_operation');
    return {
      id: `line:${l.work_center_id}`,
      area: 'Production',
      severity: l.severity === 'HIGH' ? 'HIGH' : 'MEDIUM',
      title: l.headline,
      cause: l.chain?.[0]?.text || null,
      at_stake: { amount: round(cost + (l.value_at_risk || 0)), currency: l.currency, what: [cost > 0 && `${money(cost, l.currency)} in line time`, l.value_at_risk > 0 && `${money(l.value_at_risk, l.currency)} of orders at risk`].filter(Boolean).join(', ') || 'line time' },
      orders: (l.orders_at_risk || []).map((o) => o.sales_order_id),
      order_numbers: (l.orders_at_risk || []).map((o) => o.so_number),
      record: { type: 'work_center', id: l.work_center_id, number: l.code },
      next_step: move
        ? { label: move.label, tool: null, screen: '/manufacturing/work-centers', approver: 'A manager, on the Work Centres screen' }
        : { label: l.proposals?.[0]?.label || `Look at ${l.code}`, tool: 'watch_production_lines', args: { work_center: l.code } },
      proposals: (l.proposals || []).map((p) => p.label),
      ask: `Why has ${l.code} slowed down, what is it costing us, and which orders does it put at risk?`,
    };
  });
}

function fromSuppliers(r) {
  return (r.suppliers || []).filter((s) => s.band === 'HIGH').map((s) => {
    const stake = s.value_at_risk || s.overdue_value || 0;
    return {
      id: `supplier:${s.supplier_id}`,
      area: 'Suppliers',
      severity: (s.orders_at_risk || []).some((o) => o.verdict === 'late' || o.verdict === 'uncovered') ? 'HIGH' : 'MEDIUM',
      title: s.headline,
      // The strongest reason, not the first found (the orders it reaches are the stake, shown below).
      cause: [...(s.signals || [])].filter((x) => x.kind !== 'orders_at_risk').sort((a, b) => b.points - a.points)[0]?.text || s.signals?.[0]?.text || null,
      at_stake: { amount: round(stake), currency: s.currency, what: s.value_at_risk > 0 ? `${money(s.value_at_risk, s.currency)} of customer orders depend on it` : `${money(s.overdue_value, s.currency)} overdue from them` },
      orders: (s.orders_at_risk || []).map((o) => o.sales_order_id),
      order_numbers: (s.orders_at_risk || []).map((o) => o.so_number),
      record: { type: 'supplier', id: s.supplier_id, number: s.name },
      next_step: { label: s.proposals?.[0]?.label || `Review ${s.name}`, tool: 'recall_supplier_precedent', args: { supplier: s.name } },
      proposals: (s.proposals || []).map((p) => p.label),
      ask: `${s.name} is a risk. What did we do last time they were late, and what should we do now?`,
    };
  });
}

function fromDecisions(r) {
  return (r.decisions || []).filter((d) => d.held_value > 0 || d.escalated).map((d) => ({
    id: `decision:${d.kind}:${d.id}`,
    decision_id: d.id,
    area: 'Decisions',
    severity: d.held_value > 0 && (d.holding_up || []).some((h) => h.verdict === 'late' || h.verdict === 'uncovered' || h.saved_by_approval) ? 'HIGH' : 'MEDIUM',
    title: d.reason || `${d.kind_label} ${d.number} waiting ${d.waiting_for}`,
    cause: `${d.kind_label} ${d.number}${d.party ? ` (${d.party})` : ''} has waited ${d.waiting_for} on ${d.waiting_on}`,
    at_stake: { amount: round(d.held_value || d.value), currency: d.currency, what: d.held_value > 0 ? `${money(d.held_value, d.currency)} of customer orders held` : `${money(d.value, d.currency)} awaiting decision` },
    orders: (d.holding_up || []).map((h) => h.sales_order_id),
    order_numbers: (d.holding_up || []).map((h) => h.so_number).filter(Boolean),
    record: { type: d.kind, id: d.id, number: d.number },
    link: d.decide_at || null,
    next_step: d.yours_to_decide
      ? { label: `Review and decide ${d.number}`, tool: null, screen: d.decide_at, approver: 'You' }
      : { label: `Waiting on ${d.waiting_on}`, tool: 'explain_pending_decisions', args: { document: d.number } },
    yours_to_decide: !!d.yours_to_decide,
    ask: `What is ${d.number} holding up, and who can decide it?`,
  }));
}

function fromPeople(r) {
  return (r.at_risk || []).filter((a) => a.state === 'gap' || a.state === 'nobody').map((a) => {
    const prop = (r.proposals || []).find((p) => p.id && (p.id.includes(a.id) || (p.label || '').includes(a.number)));
    return {
      id: `people:${a.id}`,
      decision_id: a.id,
      area: 'People',
      severity: a.held_value > 0 ? 'HIGH' : 'MEDIUM',
      title: a.reason,
      cause: a.away?.length ? `${a.away.map((p) => p.name).join(', ')} away${a.away[0].from ? ` from ${a.away[0].from}` : ''}` : 'Nobody who can decide it is in before it is needed',
      at_stake: { amount: round(a.held_value || a.value), currency: a.currency, what: a.held_value > 0 ? `${money(a.held_value, a.currency)} of customer orders held` : `${money(a.value, a.currency)} awaiting decision` },
      orders: (a.holding_up || []).map((h) => h.sales_order_id),
      order_numbers: (a.holding_up || []).map((h) => h.so_number).filter(Boolean),
      record: { type: a.kind, id: a.id, number: a.number },
      link: '/hr/overview',
      next_step: prop
        ? { label: prop.label, tool: 'act_on_people_coverage', args: { proposal_id: prop.id }, approver: 'A manager or admin confirms' }
        : { label: `Find cover for ${a.number}`, tool: 'explain_people_coverage', args: {} },
      ask: `Who can decide ${a.number} while ${a.away?.[0]?.name || 'its approver'} is away?`,
    };
  });
}

function fromCash(r) {
  if (!r || r.verdict === 'covered' || !r.low_point) return [];
  const gap = Math.max(0, (r.floor?.amount || 0) - r.low_point.p50, -r.low_point.p50);
  const remind = (r.proposals || []).find((p) => p.kind === 'remind');
  return [{
    id: 'cash',
    area: 'Cash',
    severity: r.verdict === 'short' || r.first_below_zero ? 'HIGH' : r.verdict === 'under_floor' ? 'HIGH' : 'MEDIUM',
    title: r.headline,
    cause: r.causes?.[0]?.text || null,
    at_stake: { amount: round(gap), currency: r.currency, what: `${money(gap, r.currency)} short of ${r.floor?.source || 'the floor'} at the low point (${r.low_point.date})` },
    orders: [],
    order_numbers: [],
    record: { type: 'cash', id: null, number: `Week ${r.low_point.week}` },
    next_step: remind
      ? { label: remind.label, tool: 'send_cash_reminders', args: remind.args, approver: 'You confirm before anything is sent' }
      : { label: r.proposals?.[0]?.label || 'Read the cash outlook', tool: 'explain_cash_outlook', args: {} },
    proposals: (r.proposals || []).map((p) => p.label),
    ask: 'Where does cash dip, why, and what lifts it?',
  }];
}

function fromBills(r) {
  return (r.bills || []).filter((b) => b.verdict !== 'clear' && !b.bill.payment_hold && b.unpaid_at_stake > 0).map((b) => {
    const hold = (b.proposals || []).find((p) => p.tool === 'hold_supplier_payment');
    return {
      id: `bill:${b.bill.id}`,
      area: 'Payables',
      severity: b.verdict === 'possible_duplicate' ? 'MEDIUM' : 'HIGH',
      title: b.headline,
      cause: b.chain?.[0]?.text || (b.order ? `Billed on ${b.order.po_number}` : null),
      at_stake: { amount: round(b.unpaid_at_stake), currency: b.bill.currency, what: `${money(b.unpaid_at_stake, b.bill.currency)} would be paid twice` },
      orders: [],
      order_numbers: [],
      record: { type: 'supplier_invoice', id: b.bill.id, number: b.bill.bill_number },
      next_step: hold
        ? { label: hold.label, tool: 'hold_supplier_payment', args: hold.args, approver: hold.who_approves }
        : { label: `Check ${b.bill.bill_number}`, tool: 'check_supplier_bill', args: { bill: b.bill.bill_number } },
      ask: `Is ${b.bill.bill_number} from ${b.bill.supplier} a second copy? Walk me through it.`,
    };
  });
}

function fromMargin(r) {
  const g = r?.gross_margin;
  if (!g || g.change_pts == null || g.change_pts > -0.5) return [];
  const moved = (r.drivers || []).reduce((s, d) => s + Math.max(0, Number(d.money) || 0), 0);
  return [{
    id: 'margin',
    area: 'Margin',
    severity: g.change_pts <= -2 ? 'HIGH' : 'MEDIUM',
    title: r.headline,
    cause: r.drivers?.[0] ? `${r.drivers[0].name}: ${r.drivers[0].detail}` : null,
    at_stake: { amount: round(moved), currency: r.currency, what: moved > 0 ? `${money(moved, r.currency)} of margin lost to its causes this period` : `${round(-g.change_pts, 1)} points of margin` },
    orders: [],
    order_numbers: [],
    record: { type: 'margin', id: null, number: `${g.current_pct}%` },
    next_step: { label: 'Prepare the follow-ups for their owners', tool: 'prepare_margin_follow_ups', args: {}, approver: 'Each follow-up waits for its owner' },
    proposals: (r.drivers || []).flatMap((d) => (d.proposals || []).map((p) => p.label)).slice(0, 4),
    ask: 'What is hurting our margins this month?',
  }];
}

function fromDeliveries(r, claimed) {
  return (r.orders || [])
    .filter((o) => ['late', 'uncovered', 'at_risk'].includes(o.verdict) && !claimed.has(o.sales_order_id))
    .map((o) => {
      const penalty = o.penalty?.amount || 0;
      return {
        id: `order:${o.sales_order_id}`,
        area: 'Deliveries',
        severity: o.verdict === 'at_risk' ? 'MEDIUM' : 'HIGH',
        title: o.verdict === 'uncovered'
          ? `${o.so_number} for ${o.customer_name} (due ${o.due_date}) cannot be fulfilled from stock or supply on order`
          : o.verdict === 'late'
            ? `${o.so_number} for ${o.customer_name} ships around ${o.projected_date}, ${o.days_late} day${o.days_late === 1 ? '' : 's'} after the ${o.due_date} promise`
            : `${o.so_number} for ${o.customer_name} (due ${o.due_date}) depends on supply that is already slipping`,
        cause: o.cause,
        at_stake: { amount: round((o.value_at_risk || 0) + penalty), currency: o.currency, what: [`${money(o.value_at_risk, o.currency)} of the order`, penalty > 0 && `${money(penalty, o.currency)} penalty`].filter(Boolean).join(' + ') },
        orders: [o.sales_order_id],
        order_numbers: [o.so_number],
        record: { type: 'sales_order', id: o.sales_order_id, number: o.so_number },
        next_step: { label: `Find what would make ${o.so_number} hold`, tool: 'plan_delivery_recovery', args: { sales_order: o.so_number }, approver: 'A manager or admin approves the plan' },
        proposals: (o.proposals || []).map((p) => p.label),
        ask: `Why will ${o.so_number} for ${o.customer_name} be late, and what would make it hold?`,
      };
    });
}

/**
 * Open records in the applications the company built, wired to what already
 * exists: the supplier, customer or order they point at, and what that reaches.
 * One item per application and counterpart. A supplier already shown as a
 * high risk carries these inside its own item (supplier risk counts them), so
 * the problem is not shown twice.
 */
function fromBuilt(r, { suppliers, deliveries, shownSuppliers }) {
  const { describeRecord } = require('./builtSignals');
  const supplierById = new Map((suppliers?.suppliers || []).map((s) => [s.supplier_id, s]));
  const traced = deliveries?.orders || [];
  const PRIORITY = ['sales_order', 'supplier', 'customer', 'purchase_order', 'item', 'project', 'work_order', 'employee'];

  const groups = new Map();
  for (const rec of r.records || []) {
    const ref = PRIORITY.map((t) => rec.refs.find((x) => x.type === t)).find(Boolean) || null;
    const key = `${rec.application.key}:${ref ? `${ref.type}:${ref.id}` : `record:${rec.id}`}`;
    if (!groups.has(key)) groups.set(key, { app: rec.application, ref, records: [] });
    groups.get(key).records.push(rec);
  }

  const folded = [];
  const items = [];
  for (const [key, g] of groups) {
    if (g.ref?.type === 'supplier' && shownSuppliers.has(g.ref.id)) { folded.push({ supplier_id: g.ref.id, records: g.records }); continue; }
    const top = g.records[0];
    const critical = g.records.filter((x) => x.critical).length;
    const late = g.records.filter((x) => x.overdue_days || x.signals.some((s) => s.kind === 'stuck')).length;
    const severe = g.records.filter((x) => x.signals.some((s) => s.kind === 'severe')).length;
    const own = g.records.reduce((sum, x) => sum + (x.own_value || 0), 0);

    // What it reaches in the rest of the business.
    let orders = [];
    let currency = suppliers?.currency || deliveries?.currency || r.currency || null;
    const reach = [];
    if (g.ref?.type === 'supplier') {
      const s = supplierById.get(g.ref.id);
      if (s) {
        currency = s.currency || currency;
        orders = s.orders_at_risk || [];
        if (s.open_exposure > 0) reach.push(`${money(s.open_exposure, currency)} still to arrive from ${s.name} on open purchase orders`);
      }
    } else if (g.ref?.type === 'customer') {
      orders = traced.filter((o) => o.customer_id === g.ref.id && ['late', 'uncovered', 'at_risk'].includes(o.verdict));
    } else if (g.ref?.type === 'sales_order') {
      orders = traced.filter((o) => o.sales_order_id === g.ref.id);
    }
    const ordersValue = orders.reduce((sum, o) => sum + (o.value_at_risk || 0), 0);
    if (orders.length) {
      currency = orders[0].currency || currency;
      reach.unshift(`${orders.map((o) => o.so_number).slice(0, 3).join(', ')}${orders.length > 3 ? ` and ${orders.length - 3} more` : ''} `
        + `(${money(ordersValue, currency)}) ${orders.some((o) => ['late', 'uncovered'].includes(o.verdict)) ? 'already late or short' : 'at risk'}`);
    }

    const who = g.ref?.label || g.ref?.via || null;
    const noun = top.entity_label.toLowerCase();
    const n = g.records.length;
    items.push({
      id: `built:${key}`,
      area: 'Built in Sandbox',
      severity: critical || (severe && late) || orders.some((o) => ['late', 'uncovered'].includes(o.verdict)) ? 'HIGH' : 'MEDIUM',
      title: `${g.app.name}: ${n} open ${noun}${n === 1 ? '' : 's'}${who ? ` on ${who}` : ''}`
        + [critical && `${critical} critical`, !critical && severe && `${severe} severe`, late && `${late} past due`].filter(Boolean).map((x) => `, ${x}`).join(''),
      cause: describeRecord(top),
      at_stake: {
        amount: round(ordersValue + own),
        currency,
        what: [...reach, own > 0 && `${money(own, currency)} recorded on the ${noun}${n === 1 ? '' : 's'}`].filter(Boolean).join('; ') || `${n} open ${noun}${n === 1 ? '' : 's'} past what the application allows`,
      },
      orders: orders.map((o) => o.sales_order_id),
      order_numbers: orders.map((o) => o.so_number),
      record: { type: 'app_record', id: top.id, number: top.number || top.title, application: g.app.key },
      link: top.link,
      connects: g.ref ? [{ type: g.ref.type, id: g.ref.id, label: g.ref.label, link: linkFor(g.ref) }] : [],
      built_records: g.records.slice(0, 5).map((x) => ({ id: x.id, number: x.number, title: x.title, state: x.state_label, why: x.signals.map((s) => s.text), link: x.link })),
      next_step: { label: `Open ${top.number || noun} in ${g.app.name}`, tool: null, screen: top.link, approver: 'Whoever holds the record moves its workflow' },
      ask: `What is open in ${g.app.name}${who ? ` about ${who}` : ''}, and what does it put at risk?`,
      own_value: own,
    });
  }
  return { items, folded };
}

/* -------------------------------------------------------------------- main */

async function compute({ companyId, userId, role, limit }) {
  const enabled = await moduleService.getEnabledModuleKeys(companyId);
  const who = { companyId, userId, role };

  const settled = await Promise.all(WATCHERS.map(async (w) => {
    if (w.module && !enabled.has(w.module)) return { w, status: 'off' };
    const t0 = Date.now();
    try {
      const r = await companyContext.runWithCompany(companyId, () => w.run(who));
      if (r?.error) return { w, status: r.status === 403 || /role|visible|see/i.test(r.error) ? 'not_in_view' : 'failed', note: r.error, ms: Date.now() - t0 };
      return { w, status: 'ok', r, ms: Date.now() - t0 };
    } catch (err) {
      console.warn(`[whatMattersNow] ${w.key} failed:`, err.message);
      return { w, status: 'failed', note: 'Could not be read just now.', ms: Date.now() - t0 };
    }
  }));
  const res = Object.fromEntries(settled.map((s) => [s.w.key, s]));
  const got = (k) => (res[k]?.status === 'ok' ? res[k].r : null);

  // Causes first, so an order they explain is not shown again on its own.
  let items = [];
  if (got('lines')) items.push(...fromLines(got('lines')));
  if (got('suppliers')) items.push(...fromSuppliers(got('suppliers')));
  const people = got('people') ? fromPeople(got('people')) : [];
  const covered = new Set(people.map((p) => p.decision_id));
  if (got('decisions')) items.push(...fromDecisions(got('decisions')).filter((d) => !covered.has(d.decision_id)));
  items.push(...people);
  const claimed = new Set(items.flatMap((i) => i.orders));
  if (got('deliveries')) items.push(...fromDeliveries(got('deliveries'), claimed));
  if (got('cash')) items.push(...fromCash(got('cash')));
  if (got('bills')) items.push(...fromBills(got('bills')));
  if (got('margin')) items.push(...fromMargin(got('margin')));
  if (got('built')) {
    const shownSuppliers = new Set(items.filter((i) => i.area === 'Suppliers').map((i) => i.record.id));
    const { items: built, folded } = fromBuilt(got('built'), { suppliers: got('suppliers'), deliveries: got('deliveries'), shownSuppliers });
    for (const f of folded) {
      const item = items.find((i) => i.area === 'Suppliers' && i.record.id === f.supplier_id);
      if (item) item.built_records = f.records.slice(0, 5).map((x) => ({ id: x.id, number: x.number, title: x.title, application: x.application.name, state: x.state_label, why: x.signals.map((s) => s.text), link: x.link }));
    }
    items.push(...built);
  }

  // An order reached by several causes is counted once in exposure; it stays
  // named under each cause, because each is a separate thing a person can fix.
  const orderValue = new Map();
  for (const o of got('deliveries')?.orders || []) orderValue.set(o.sales_order_id, { value: (o.value_at_risk || 0) + (o.penalty?.amount || 0), currency: o.currency });

  items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'HIGH' ? -1 : 1) || b.at_stake.amount - a.at_stake.amount);
  const total = items.length;
  const all = items;
  items = items.slice(0, limit).map((i, n) => ({
    rank: n + 1,
    ...i,
    link: i.link || linkFor(i.record),
    orders: undefined,
    decision_id: undefined,
    own_value: undefined,
  }));

  const stake = {};
  const add = (cur, v) => { if (v > 0) stake[cur || 'EUR'] = round((stake[cur || 'EUR'] || 0) + v); };
  // Line time, each customer order once, bills about to be paid twice, margin lost. A cash dip is a timing gap,
  // not money lost, so it is ranked as an item but not added here.
  for (const l of got('lines')?.lines || []) add(l.currency, (l.extra_cost || 0) + (l.lost_cost || 0));
  for (const v of orderValue.values()) add(v.currency, v.value);
  for (const b of all.filter((i) => i.area === 'Payables' || i.area === 'Margin')) add(b.at_stake.currency, b.at_stake.amount);
  // Money recorded on built records (a finding's cost impact); the orders they reach are already counted above.
  for (const b of all.filter((i) => i.area === 'Built in Sandbox')) add(b.at_stake.currency, b.own_value);

  const checked = settled.map((s) => {
    let note = s.note || null;
    if (s.status === 'ok') {
      const r = s.r;
      switch (s.w.key) {
        case 'deliveries': note = `${r.summary?.orders_checked ?? 0} open orders traced, ${(r.summary?.late || 0) + (r.summary?.uncovered || 0)} late or short, ${r.summary?.at_risk || 0} at risk`; break;
        case 'lines': note = `${r.summary?.centres_watched ?? 0} work centres against their own norm, ${(r.summary?.slowed || 0) + (r.summary?.stopped || 0)} slowed or stopped`; break;
        case 'suppliers': note = `${r.summary?.high ?? 0} high-risk supplier${r.summary?.high === 1 ? '' : 's'}`; break;
        case 'decisions': note = `${r.summary?.awaiting ?? 0} waiting, ${r.summary?.yours ?? 0} yours, ${r.summary?.orders_held ?? 0} customer orders held`; break;
        case 'people': note = r.headline; break;
        case 'cash': note = r.verdict === 'covered' ? 'Covered for 13 weeks' : r.headline; break;
        case 'bills': note = r.headline; break;
        case 'margin': note = r.headline; break;
        case 'built': note = r.summary?.applications
          ? `${r.summary.read} of ${r.summary.applications} built application${r.summary.applications === 1 ? '' : 's'} read as you, ${r.summary.flagged} open record${r.summary.flagged === 1 ? '' : 's'} need someone${r.summary.not_in_view ? `, ${r.summary.not_in_view} not in your view` : ''}`
          : 'No applications built in Sandbox yet'; break;
        default: break;
      }
    } else if (s.status === 'off') note = 'Module is off for this company';
    // A late order shown under its cause (a line, a supplier, a decision) still counts as something this watcher found.
    const found = s.status === 'ok' && (all.some((i) => areaOf(s.w.key) === i.area)
      || (s.w.key === 'built' && (s.r.records || []).length > 0)
      || (s.w.key === 'deliveries' && (s.r.orders || []).some((o) => ['late', 'uncovered', 'at_risk'].includes(o.verdict))));
    if (found && s.w.key === 'deliveries' && !all.some((i) => i.area === 'Deliveries')) note += ' — shown under their cause';
    return { key: s.w.key, watcher: s.w.label, status: s.status === 'ok' ? (found ? 'flagged' : 'clear') : s.status, note };
  });

  const watched = checked.filter((c) => c.status === 'clear' || c.status === 'flagged');
  const stakeText = Object.entries(stake).map(([c, v]) => money(v, c)).join(' + ');
  const highs = all.filter((i) => i.severity === 'HIGH').length;
  const headline = !total
    ? `Nothing needs you right now. ${watched.length} watcher${watched.length === 1 ? '' : 's'} checked: ${watched.map((c) => c.watcher.toLowerCase()).join(', ')}.`
    : `${total} thing${total === 1 ? ' needs' : 's need'} a person${highs ? ` (${highs} urgent)` : ''}${stakeText ? `, ${stakeText} at stake` : ''}. First: ${items[0].title}`;

  // What each watcher measured, not only what it flagged — the business map (services/businessMap.js)
  // draws every part of the business from these, so it reads the same run as the brief.
  const readings = Object.fromEntries(settled.map((s) => [s.w.key, {
    status: s.status,
    summary: s.status === 'ok' ? (s.r.summary || null) : null,
    headline: s.status === 'ok' ? (s.r.headline || null) : null,
  }]));
  if (got('deliveries')) {
    readings.deliveries.orders = (got('deliveries').orders || [])
      .filter((o) => ['late', 'uncovered', 'at_risk'].includes(o.verdict))
      .slice(0, 10)
      .map((o) => ({
        sales_order_id: o.sales_order_id, so_number: o.so_number, customer_name: o.customer_name, verdict: o.verdict,
        due_date: o.due_date, projected_date: o.projected_date, days_late: o.days_late, value_at_risk: o.value_at_risk,
        penalty: o.penalty?.amount || 0, currency: o.currency, chain: o.chain || [], proposals: (o.proposals || []).map((p) => p.label),
      }));
  }
  if (got('lines')) readings.lines.lines = (got('lines').lines || []).slice(0, 5).map((l) => ({ work_center_id: l.work_center_id, code: l.code, signal: l.signal, headline: l.headline }));
  if (got('suppliers')) readings.suppliers.top = (got('suppliers').suppliers || []).filter((s) => s.band !== 'LOW').slice(0, 5).map((s) => ({ supplier_id: s.supplier_id, name: s.name, band: s.band, headline: s.headline }));
  if (got('built')) {
    readings.built.applications = (got('built').applications || []).map((a) => ({
      key: a.key, name: a.name, status: a.status, open: a.open, flagged: a.flagged,
      points_at: [...new Set((got('built').records || []).filter((r) => r.application?.key === a.key).flatMap((r) => (r.refs || []).map((x) => x.type)))],
    }));
  }

  return {
    as_of: new Date().toISOString(),
    headline,
    summary: { items: total, urgent: highs, at_stake: stake, watchers_run: watched.length, yours_to_decide: all.filter((i) => i.yours_to_decide).length },
    items,
    checked,
    readings,
    method:
      'Each watcher ran as you, with your role\'s view: the delivery trace (open orders due in 14 days), the line watch (each '
      + 'work centre against its own 90-day pace), supplier risk, decisions held open, people coverage, the 13-week cash '
      + 'outlook, the duplicate-bill check, the margin drivers, and the applications the company built in Sandbox (open records past due, '
      + 'severe or stuck, read with your role in each application, tied to the supplier, customer or order they point at). An order explained by a slow line, a risky supplier or a '
      + 'waiting decision is shown under that cause; at-stake money counts each customer order once. Ranked by urgency, then '
      + 'money. Nothing was changed: each next step drafts, holds or asks, and a person approves it.',
  };
}

function areaOf(key) {
  return { deliveries: 'Deliveries', lines: 'Production', suppliers: 'Suppliers', decisions: 'Decisions', people: 'People', cash: 'Cash', bills: 'Payables', margin: 'Margin', built: 'Built in Sandbox' }[key];
}

/**
 * @param {object} opts { companyId, userId, role, limit, fresh, all }
 */
async function whatMattersNow(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  if (!companyId) return { error: 'No company to read.' };
  // `all` is the watch (services/simeliWatch.js): it needs every item to tell what has cleared.
  const limit = opts.all ? 500 : Math.min(Math.max(parseInt(opts.limit, 10) || 7, 1), 25);
  const role = opts.role ? String(opts.role).toUpperCase() : null;
  const key = `${companyId}:${opts.userId || '-'}:${role || '-'}:${limit}`;
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = compute({ companyId, userId: opts.userId || null, role: opts.role || null, limit });
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return promise;
}

module.exports = { whatMattersNow };
