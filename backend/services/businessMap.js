/**
 * "Your business, with a brain." — the whole business on one map, from its own records.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * The website opens on one picture: people, processes, software, data,
 * operations, infrastructure, decisions, suppliers, production and Sandbox,
 * wired into each other, with Simeli walking a problem from a slow machine to
 * the customer order it will miss. Each of those parts already has its own
 * reading in this product (people coverage, the process flow, the line watch,
 * supplier risk, the delivery trace, what the business runs on, decisions held
 * open, what was built in Sandbox), but only one question at a time. This puts
 * them on one map:
 *
 *   regions        the ten parts, each with what is on record (how many, from
 *                  the company's own rows), what Simeli sees in it now, and its
 *                  state: clear, watch or alert.
 *   relationships  which part depends on which, each with what actually flows
 *                  along it (decisions waiting on people, work orders queued on
 *                  lines, systems the software runs through…).
 *   trace          the problem that crosses the most of the business right now:
 *                  the at-risk customer order whose cause chain walks the most
 *                  regions, step by step, each step naming the record it read.
 *   grown          what the company built in Sandbox, and which existing parts
 *                  it is wired into (the records it points at).
 *
 * HOW IT IS PUT TOGETHER
 * ---------------------------------------------------------------------------
 * It reads the same run as the brief (whatMattersNow, every watcher as the
 * person asking — their role decides what they see), plus the process flow and
 * the runs-on map, plus a handful of counts read inside the company's own
 * row-level-security context. Finance counts are only shown to roles that see
 * finance; connected systems only to managers and admins; a module the company
 * has turned off is shown as off, never as zero.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing. Every next step is the one the watcher that found it
 * proposed, naming the tool or screen that carries it out — and each of those
 * drafts, holds or asks; a person approves.
 */

const companyContext = require('./companyContext');
const moduleService = require('./moduleService');
const { whatMattersNow } = require('./whatMattersNow');

const SEES_FINANCE = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER', 'FINANCE_USER']);
const SEES_SYSTEMS = new Set(['ADMIN', 'MANAGER']);
const TTL_MS = 60 * 1000;
const cache = new Map();

const plural = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString('en-GB')} ${Number(n) === 1 ? one : many}`;
function money(v, cur) {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur || 'EUR', maximumFractionDigits: 0 }).format(v || 0);
  } catch {
    return `${Math.round(v || 0)} ${cur || ''}`.trim();
  }
}

/** The ten parts, in the website's words: label, what the chip counts, and what Simeli does with it. */
const REGIONS = [
  { key: 'people', label: 'People', metric: 'Employees and roles', line: 'Simeli understands your people.' },
  { key: 'processes', label: 'Processes', metric: 'Workflows', line: 'Simeli knows which steps actually move.' },
  { key: 'software', label: 'Software', metric: 'Applications', line: 'Simeli reads across every system you already run.' },
  { key: 'data', label: 'Data', metric: 'Records', line: 'Simeli treats all of it as one record.' },
  { key: 'operations', label: 'Operations', metric: 'Signals', line: 'Simeli keeps watch over operations.' },
  { key: 'infrastructure', label: 'Infrastructure', metric: 'Systems', line: 'Simeli maps what everything actually runs on.' },
  { key: 'decisions', label: 'Decisions', metric: 'Awaiting a person', line: 'Simeli brings you the decision with its reason attached.' },
  { key: 'suppliers', label: 'Suppliers', metric: 'Relationships', line: 'Simeli sees supplier relationships, not supplier records.' },
  { key: 'production', label: 'Production', metric: 'Lines', line: 'Simeli traces an anomaly to what it will cost.' },
  { key: 'sandbox', label: 'Sandbox', metric: 'Capability in development', line: 'Describe what your business needs. Sandbox builds it here.' },
];

/** Which part depends on which — the website's arrows. */
const RELATIONSHIPS = [
  ['people', 'processes'],
  ['processes', 'software'],
  ['software', 'data'],
  ['data', 'decisions'],
  ['operations', 'processes'],
  ['infrastructure', 'software'],
];

/** A delivery-trace step's layer, as a part of the business. Stock and money are the record. */
const LAYER_REGION = { operations: 'operations', production: 'production', inventory: 'data', finance: 'data', suppliers: 'suppliers', decisions: 'decisions' };

/** What a built application's record points at, as a part of the business. */
const REF_REGION = {
  supplier: 'suppliers', customer: 'data', item: 'data', sales_order: 'decisions', purchase_order: 'suppliers', employee: 'people',
  project: 'processes', work_order: 'production', shipment: 'operations', goods_receipt: 'suppliers', customer_invoice: 'data', supplier_invoice: 'data',
};

const RECORD_LINK = {
  sales_order: (r) => `/sales/sales-orders/${r.id}`,
  purchase_order: (r) => `/procurement/purchase-orders/${r.id}`,
  supplier: (r) => `/procurement/suppliers/${r.id}`,
  item: (r) => `/inventory/items/${r.id}`,
  customer: (r) => `/sales/customers/${r.id}`,
  work_center: () => '/manufacturing/work-centers',
  work_order: () => '/manufacturing/work-orders',
};

async function readCounts(companyId, { finance, systems }) {
  return companyContext.withCompany(companyId, async (c) => {
    const one = async (sql) => {
      try { return Number((await c.query(`SELECT (${sql})::int AS n`, [companyId])).rows[0].n) || 0; } catch { return null; }
    };
    // Savepoint per read, so a table this database does not have yet does not end the transaction for the rest.
    const safe = async (sql) => {
      await c.query('SAVEPOINT m');
      const n = await one(sql);
      await c.query(n == null ? 'ROLLBACK TO SAVEPOINT m' : 'RELEASE SAVEPOINT m');
      return n;
    };
    const records = {
      customers: await safe('SELECT count(*) FROM customers WHERE company_id = $1 AND deleted_at IS NULL'),
      suppliers: await safe("SELECT count(*) FROM suppliers WHERE company_id = $1 AND COALESCE(status, 'ACTIVE') NOT IN ('INACTIVE', 'BLOCKED', 'REJECTED')"),
      items: await safe('SELECT count(*) FROM items WHERE company_id = $1'),
      sales_orders: await safe('SELECT count(*) FROM sales_orders WHERE company_id = $1 AND deleted_at IS NULL'),
      purchase_orders: await safe('SELECT count(*) FROM purchase_orders WHERE company_id = $1'),
      work_orders: await safe('SELECT count(*) FROM work_orders WHERE company_id = $1 AND deleted_at IS NULL'),
      stock_movements: await safe('SELECT count(*) FROM warehouse_transactions WHERE company_id = $1'),
    };
    if (finance) {
      records.journal_entries = await safe('SELECT count(*) FROM journal_entries WHERE company_id = $1 AND deleted_at IS NULL');
      records.customer_invoices = await safe('SELECT count(*) FROM customer_invoices WHERE company_id = $1 AND deleted_at IS NULL');
      records.supplier_invoices = await safe('SELECT count(*) FROM supplier_invoices WHERE company_id = $1 AND deleted_at IS NULL');
    }
    return {
      records,
      employees: await safe("SELECT count(*) FROM employees WHERE company_id = $1 AND deleted_at IS NULL AND status <> 'TERMINATED'"),
      roles: await safe('SELECT count(DISTINCT role) FROM user_companies WHERE company_id = $1'),
      users: await safe('SELECT count(*) FROM user_companies WHERE company_id = $1'),
      work_centers: await safe("SELECT count(*) FROM work_centers WHERE company_id = $1 AND deleted_at IS NULL AND COALESCE(status, 'ACTIVE') <> 'INACTIVE'"),
      open_work_orders: await safe("SELECT count(*) FROM work_orders WHERE company_id = $1 AND deleted_at IS NULL AND status IN ('DRAFT', 'RELEASED', 'IN_PROGRESS')"),
      sites: await safe('SELECT count(*) FROM storage_locations WHERE company_id = $1'),
      apps_live: await safe("SELECT count(*) FROM app_company_instances WHERE company_id = $1 AND status = 'active'"),
      apps_building: await safe("SELECT count(*) FROM app_studio_sessions WHERE company_id = $1 AND status IN ('planning', 'building', 'preview', 'iterating', 'deploying')"),
      opportunities: await safe("SELECT count(*) FROM capability_opportunities WHERE company_id = $1 AND status IN ('detected', 'proposed') AND (expires_at IS NULL OR expires_at > now())"),
      top_opportunity: await (async () => {
        await c.query('SAVEPOINT o');
        try {
          const { rows: [r] } = await c.query(
            "SELECT title, reason FROM capability_opportunities WHERE company_id = $1 AND status IN ('detected', 'proposed') AND (expires_at IS NULL OR expires_at > now()) ORDER BY confidence DESC NULLS LAST, created_at DESC LIMIT 1",
            [companyId],
          );
          await c.query('RELEASE SAVEPOINT o');
          return r || null;
        } catch { await c.query('ROLLBACK TO SAVEPOINT o'); return null; }
      })(),
      connectors: systems ? await safe("SELECT count(*) FROM connectors WHERE company_id = $1 AND status = 'connected'") : null,
      connectors_failing: systems ? await safe("SELECT count(*) FROM connectors WHERE company_id = $1 AND status = 'error'") : null,
      mcp: systems ? await safe("SELECT count(*) FROM mcp_connections WHERE company_id = $1 AND status = 'connected'") : null,
      mcp_failing: systems ? await safe("SELECT count(*) FROM mcp_connections WHERE company_id = $1 AND status = 'error'") : null,
    };
  });
}

/** The at-risk order whose cause walks the most of the business, as a path through the regions. */
function pickTrace(orders) {
  const RANK = { late: 0, uncovered: 0, at_risk: 1 };
  const scored = (orders || []).map((o) => {
    const regions = new Set(o.chain.map((s) => LAYER_REGION[s.layer]).filter(Boolean));
    return { o, span: regions.size };
  }).filter((x) => x.span >= 2);
  scored.sort((a, b) => b.span - a.span || RANK[a.o.verdict] - RANK[b.o.verdict] || (b.o.value_at_risk + b.o.penalty) - (a.o.value_at_risk + a.o.penalty));
  const pick = scored[0]?.o;
  if (!pick) return null;
  // Causes first, the customer's order last — the order the walk is read in.
  const steps = [...pick.chain.filter((s) => s.layer !== 'decisions'), ...pick.chain.filter((s) => s.layer === 'decisions')]
    .filter((s) => LAYER_REGION[s.layer])
    .slice(0, 8)
    .map((s) => ({
      region: LAYER_REGION[s.layer],
      step: s.text,
      record: s.record ? { type: s.record.type, id: s.record.id || null, number: s.record.number || null } : null,
      link: s.record && RECORD_LINK[s.record.type] && (s.record.id || s.record.type === 'work_center' || s.record.type === 'work_order') ? RECORD_LINK[s.record.type](s.record) : null,
    }));
  const due = pick.due_date ? new Date(`${pick.due_date}T00:00:00Z`) : null;
  const daysOut = due ? Math.round((due - Date.now()) / 86400000) : null;
  const day = due ? (daysOut != null && daysOut >= -1 && daysOut <= 6 ? due.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }) : pick.due_date) : null;
  return {
    sales_order: { id: pick.sales_order_id, number: pick.so_number, customer: pick.customer_name, link: `/sales/sales-orders/${pick.sales_order_id}` },
    verdict: pick.verdict,
    due_date: pick.due_date,
    projected_date: pick.projected_date,
    question: day && /day$/.test(day)
      ? `Why are we going to miss ${day}'s delivery to ${pick.customer_name} (${pick.so_number})?`
      : `Why are we going to miss the ${pick.due_date} delivery to ${pick.customer_name} (${pick.so_number})?`,
    headline: pick.verdict === 'at_risk'
      ? `${pick.so_number} for ${pick.customer_name} still makes ${pick.due_date}, but it depends on supply that is already slipping`
      : pick.verdict === 'uncovered'
        ? `${pick.so_number} for ${pick.customer_name} (due ${pick.due_date}) cannot be filled from stock or supply on order`
        : `${pick.so_number} for ${pick.customer_name} ships around ${pick.projected_date}, ${plural(pick.days_late, 'day')} after the ${pick.due_date} promise`,
    at_stake: { amount: Math.round(((pick.value_at_risk || 0) + (pick.penalty || 0)) * 100) / 100, currency: pick.currency },
    regions: [...new Set(steps.map((s) => s.region))],
    steps,
    proposals: pick.proposals || [],
    next_step: { label: `Find what would make ${pick.so_number} hold`, tool: 'plan_delivery_recovery', args: { sales_order: pick.so_number }, approver: 'A manager or admin approves the plan' },
  };
}

async function compute({ companyId, userId, role }) {
  const finance = !userId || SEES_FINANCE.has(role);
  const systems = !userId || SEES_SYSTEMS.has(role);
  const who = { companyId, userId, role };
  const quiet = (p) => p.catch((err) => ({ error: err.message || 'Could not be read just now.' }));
  const inCompany = (fn) => companyContext.runWithCompany(companyId, fn);

  const [enabled, brief, counts, flow, runsOn] = await Promise.all([
    moduleService.getEnabledModuleKeys(companyId),
    whatMattersNow({ ...who, all: true }),
    readCounts(companyId, { finance, systems }),
    quiet(inCompany(() => require('./processFlow').mapProcessFlow(who))),
    quiet(inCompany(() => require('./runsOn').mapRunsOn(who))),
  ]);
  if (brief.error) return { error: brief.error };

  const R = brief.readings || {};
  const read = (k) => (R[k]?.status === 'ok' ? R[k] : null);
  const items = brief.items || [];
  const itemsIn = (area) => items.filter((i) => i.area === area);
  const top = (area) => itemsIn(area)[0] || null;
  const nextOf = (i) => (i ? { label: i.next_step?.label || null, tool: i.next_step?.tool || null, args: i.next_step?.args || null, approver: i.next_step?.approver || null, ask: i.ask || null } : null);
  const regions = {};
  const set = (key, r) => { regions[key] = { ...REGIONS.find((x) => x.key === key), ...r }; };
  const statusOf = (k) => R[k]?.status;
  const unavailable = (k, what) => (statusOf(k) === 'off'
    ? { state: 'off', reading: 'Module is off for this company', signal: null }
    : statusOf(k) === 'not_in_view'
      ? { state: 'not_in_view', reading: `${what} are not in your role's view`, signal: null }
      : null);

  /* People ------------------------------------------------------------- */
  {
    const p = read('people')?.summary;
    const it = top('People');
    set('people', {
      reading: [counts.employees != null && plural(counts.employees, 'employee'), counts.roles != null && plural(counts.roles, 'role'), p && `${p.deciders_in_today}/${p.deciders} deciders in today`].filter(Boolean).join(' · '),
      count: counts.employees,
      state: p?.decisions_at_risk ? 'alert' : p?.away_in_window || p?.single_approver ? 'watch' : 'clear',
      signal: it?.title || read('people')?.headline || null,
      next_step: nextOf(it),
      tool: 'explain_people_coverage',
      ask: 'Who is the business waiting on, who is away when, and what does an absence hold up?',
      link: '/hr/employees',
    });
  }

  /* Processes ---------------------------------------------------------- */
  if (flow && !flow.error) {
    const stuck = flow.flows.flatMap((f) => f.steps.filter((s) => s.stuck?.count).map((s) => ({ flow: f.label, ...s })));
    const steps = flow.flows.reduce((n, f) => n + f.steps.length, 0);
    set('processes', {
      reading: `${plural(flow.flows.length, 'flow')} · ${plural(steps, 'step')} timed from documents${stuck.length ? ` · ${plural(stuck.reduce((n, s) => n + s.stuck.count, 0), 'document')} stuck` : ''}`,
      count: steps,
      state: stuck.length ? (stuck.some((s) => s.stuck.count >= 3) ? 'alert' : 'watch') : 'clear',
      signal: flow.headline,
      next_step: flow.flows.flatMap((f) => f.proposals || [])[0] ? { label: flow.flows.flatMap((f) => f.proposals)[0].label, tool: flow.flows.flatMap((f) => f.proposals)[0].tool } : null,
      tool: 'map_process_flow',
      ask: 'Where do our orders get stuck, and which steps actually move?',
      link: '/sales/sales-orders',
    });
  } else {
    set('processes', { reading: flow?.error || 'Could not be read just now.', state: 'off', signal: null, tool: 'map_process_flow', ask: 'Which steps actually move?', link: '/sales/sales-orders' });
  }

  /* Software ----------------------------------------------------------- */
  {
    const failing = (counts.connectors_failing || 0) + (counts.mcp_failing || 0);
    const connected = systems ? (counts.connectors || 0) + (counts.mcp || 0) : null;
    set('software', {
      reading: [plural(enabled.size, 'module'), counts.apps_live != null && plural(counts.apps_live, 'built application'), connected != null ? plural(connected, 'connected system') : 'connected systems: managers and admins'].filter(Boolean).join(' · '),
      count: enabled.size + (counts.apps_live || 0) + (connected || 0),
      state: failing ? 'watch' : 'clear',
      signal: failing
        ? `${plural(failing, 'connected system')} reporting an error — Simeli cannot read through ${failing === 1 ? 'it' : 'them'} until it is reconnected.`
        : `Every module${counts.apps_live ? ', every built application' : ''}${connected ? ' and every connected system' : ''} is read through the same permissions as you.`,
      tool: 'map_what_the_business_runs_on',
      ask: 'Which systems do we run on, and is any of them failing?',
      link: systems ? '/admin/integrations' : '/system',
    });
  }

  /* Data --------------------------------------------------------------- */
  {
    const rec = counts.records;
    const total = Object.values(rec).reduce((s, n) => s + (n || 0), 0);
    const d = read('deliveries')?.summary;
    const short = (d?.uncovered || 0) + (d?.late || 0);
    set('data', {
      reading: `${plural(total, 'record')} in one ledger · ${plural(rec.sales_orders, 'sales order')} · ${plural(rec.items, 'item')}${finance ? ` · ${plural(rec.journal_entries, 'journal entry', 'journal entries')}` : ''}`,
      count: total,
      breakdown: rec,
      state: d?.uncovered ? 'alert' : short ? 'watch' : 'clear',
      signal: d
        ? `${plural(d.orders_checked, 'open customer order')} checked against stock and supply on order: ${short ? `${short} late or short` : 'stock and supply cover them'}${d.at_risk ? `, ${d.at_risk} at risk` : ''}.`
        : 'Nothing synced between modules: every one writes to the same company-scoped record.',
      tool: 'explain_delivery_risk',
      ask: 'Which customer orders does our stock not cover, and why?',
      link: '/inventory/items',
    });
  }

  /* Operations — the signals ------------------------------------------ */
  {
    const s = brief.summary || {};
    const watched = (brief.checked || []).filter((c) => c.status === 'clear' || c.status === 'flagged');
    const flagged = watched.filter((c) => c.status === 'flagged').length;
    set('operations', {
      reading: `${plural(watched.length, 'watcher')} ran as you · ${plural(s.items || 0, 'signal')}${s.urgent ? ` · ${s.urgent} urgent` : ''}`,
      count: s.items || 0,
      state: s.urgent ? 'alert' : flagged ? 'watch' : 'clear',
      signal: brief.headline,
      at_stake: s.at_stake,
      next_step: nextOf(items[0]),
      tool: 'what_matters_now',
      ask: 'What needs my attention today?',
      link: '/',
    });
  }

  /* Infrastructure ----------------------------------------------------- */
  if (runsOn && !runsOn.error) {
    const sm = runsOn.summary;
    set('infrastructure', {
      reading: [plural(sm.lines, 'line'), plural(sm.sites, 'site'), sm.systems != null && plural(sm.systems, 'system'), sm.equipment && plural(sm.equipment, 'asset')].filter(Boolean).join(' · '),
      count: (sm.lines || 0) + (sm.sites || 0) + (sm.systems || 0),
      state: sm.down ? 'alert' : sm.single_points ? 'watch' : 'clear',
      signal: runsOn.headline,
      single_points: sm.single_points,
      tool: 'map_what_the_business_runs_on',
      ask: 'What is our single point of failure, and what stops if it does?',
      link: '/manufacturing/work-centers',
    });
  } else {
    set('infrastructure', { reading: runsOn?.error || 'Could not be read just now.', state: 'off', signal: null, tool: 'map_what_the_business_runs_on', ask: 'What do we run on?', link: '/system' });
  }

  /* Decisions ---------------------------------------------------------- */
  {
    const sm = read('decisions')?.summary;
    const it = top('Decisions');
    set('decisions', sm ? {
      reading: `${plural(sm.awaiting, 'decision')} awaiting a person · ${sm.yours} yours${sm.value_awaiting ? ` · ${money(sm.value_awaiting, sm.currency)}` : ''}`,
      count: sm.awaiting,
      state: sm.orders_held ? 'alert' : sm.awaiting ? 'watch' : 'clear',
      signal: it?.title || (sm.orders_held ? `${plural(sm.orders_held, 'customer order')} held up by a decision nobody has made, ${money(sm.exposure_held_open, sm.currency)}.` : sm.awaiting ? 'Nothing waiting holds up a customer order.' : 'Nothing is waiting on a decision.'),
      next_step: nextOf(it),
      tool: 'explain_pending_decisions',
      ask: 'What is waiting on me, and what does it hold up?',
      link: '/approvals/unified',
    } : { ...unavailable('decisions', 'Decisions'), tool: 'explain_pending_decisions', ask: 'What is waiting on me?', link: '/approvals/unified' });
  }

  /* Suppliers ---------------------------------------------------------- */
  {
    const sm = read('suppliers')?.summary;
    const lead = R.suppliers?.top?.[0];
    const it = top('Suppliers');
    set('suppliers', sm ? {
      reading: `${plural(sm.suppliers_watched, 'supplier')} watched · ${sm.high} high risk · ${sm.delayed} delayed`,
      count: sm.suppliers_watched,
      state: sm.high ? 'alert' : sm.medium || sm.delayed ? 'watch' : 'clear',
      signal: it?.title || lead?.headline || (sm.suppliers_watched ? 'Every supplier delivering to its record.' : 'No supplier deliveries on record yet.'),
      next_step: nextOf(it),
      tool: 'monitor_supplier_risk',
      ask: lead ? `${lead.name} — how reliable are they, and what did we do last time they were late?` : 'Which suppliers are a risk?',
      link: lead?.supplier_id ? `/procurement/suppliers/${lead.supplier_id}` : '/procurement/suppliers',
    } : { ...(unavailable('suppliers', 'Suppliers') || { state: 'off', reading: 'Could not be read just now.' }), tool: 'monitor_supplier_risk', ask: 'Which suppliers are a risk?', link: '/procurement/suppliers' });
  }

  /* Production --------------------------------------------------------- */
  {
    const sm = read('lines')?.summary;
    const it = top('Production');
    set('production', sm ? {
      reading: `${plural(sm.centres_watched, 'line')} against their own pace · ${plural(counts.open_work_orders, 'open work order')}`,
      count: sm.centres_watched,
      state: sm.stopped || (sm.slowed && sm.value_at_risk) ? 'alert' : sm.slowed ? 'watch' : 'clear',
      signal: it?.title || (sm.centres_watched ? 'Every line running at its own 90-day pace.' : 'No work centres on record.'),
      at_stake: sm.extra_cost ? { amount: sm.extra_cost, currency: R.lines?.summary?.currency } : null,
      next_step: nextOf(it),
      tool: 'watch_production_lines',
      ask: it?.ask || 'Is any line slowing down, and what will it cost?',
      link: '/manufacturing/work-centers',
    } : { ...(unavailable('lines', 'Production lines') || { state: 'off', reading: 'Could not be read just now.' }), tool: 'watch_production_lines', ask: 'Is any line slowing down?', link: '/manufacturing/work-centers' });
  }

  /* Sandbox ------------------------------------------------------------ */
  {
    const b = read('built')?.summary;
    const it = top('Built in Sandbox');
    set('sandbox', {
      reading: [plural(counts.apps_live || 0, 'capability', 'capabilities') + ' live', counts.apps_building && `${counts.apps_building} in development`, counts.opportunities && `${counts.opportunities} proposed by Simeli`].filter(Boolean).join(' · '),
      count: (counts.apps_live || 0) + (counts.apps_building || 0),
      state: b?.critical ? 'alert' : b?.flagged ? 'watch' : 'clear',
      signal: it?.title
        || (counts.top_opportunity ? `Simeli proposes building "${counts.top_opportunity.title}"${counts.top_opportunity.reason ? `: ${counts.top_opportunity.reason}` : ''}.` : null)
        || (counts.apps_live ? 'Nothing open in what you built needs someone.' : 'Nothing built yet. Describe what the business needs in a sentence.'),
      next_step: nextOf(it),
      tool: counts.apps_live ? 'what_built_apps_flag' : 'build_in_sandbox',
      ask: counts.apps_live ? 'Does anything we built affect our suppliers or orders?' : 'Create a supplier risk monitor',
      link: '/studio',
    });
  }

  /* Relationships ------------------------------------------------------ */
  const p = read('people')?.summary;
  const dec = read('decisions')?.summary;
  const flows = flow && !flow.error ? flow.flows : [];
  const along = {
    'people>processes': p ? `${plural(p.deciders, 'decider')} behind ${plural(p.decisions_pending, 'pending decision')}` : null,
    'processes>software': flows.length ? `${flows.map((f) => f.label).join(' and ')} run through ${plural(enabled.size, 'module')}` : null,
    'software>data': `${plural(enabled.size, 'module')}${counts.apps_live ? ` and ${plural(counts.apps_live, 'built application')}` : ''} write to one record`,
    'data>decisions': dec ? `${plural(dec.awaiting, 'decision')} raised from records${dec.orders_held ? `, ${plural(dec.orders_held, 'customer order')} held` : ''}` : null,
    'operations>processes': counts.open_work_orders != null ? `${plural(counts.open_work_orders, 'open work order')} on ${plural(counts.work_centers, 'line')}` : null,
    'infrastructure>software': runsOn && !runsOn.error ? `${runsOn.summary.systems != null ? plural(runsOn.summary.systems, 'system') : 'Systems'} and ${plural(runsOn.summary.sites, 'site')} underneath` : null,
  };
  const trace = pickTrace(R.deliveries?.orders);
  const hot = new Set();
  if (trace) for (let n = 1; n < trace.steps.length; n++) if (trace.steps[n].region !== trace.steps[n - 1].region) hot.add(`${trace.steps[n - 1].region}>${trace.steps[n].region}`);
  const relationships = RELATIONSHIPS.map(([from, to]) => ({
    from, to, flows: along[`${from}>${to}`] || null, in_trace: hot.has(`${from}>${to}`) || hot.has(`${to}>${from}`),
  }));
  // The walk also crosses parts the standing arrows do not join (a slow line straight to a short cover): show them too.
  for (const k of hot) {
    const [from, to] = k.split('>');
    if (!relationships.some((r) => (r.from === from && r.to === to) || (r.from === to && r.to === from))) relationships.push({ from, to, flows: 'on the path of the trace', in_trace: true });
  }

  /* Grown — what Sandbox wired in -------------------------------------- */
  const grown = (R.built?.applications || []).map((a) => ({
    key: a.key, name: a.name, status: a.status, open: a.open, need_someone: a.flagged,
    wires: [...new Set((a.points_at || []).map((t) => REF_REGION[t]).filter(Boolean))],
    link: `/apps/${a.key}`,
  }));

  const order = REGIONS.map((r) => regions[r.key]);
  const alerts = order.filter((r) => r.state === 'alert');
  const watching = order.filter((r) => r.state === 'watch');
  const headline = trace
    ? `${trace.headline}. The cause runs through ${trace.regions.map((k) => REGIONS.find((r) => r.key === k).label.toLowerCase()).join(' → ')}.`
    : alerts.length
      ? `${alerts.map((r) => r.label).join(', ')} need${alerts.length === 1 ? 's' : ''} a person: ${alerts[0].signal}`
      : watching.length
        ? `Nothing urgent. Watching ${watching.map((r) => r.label.toLowerCase()).join(', ')}.`
        : 'Every part of the business is clear right now.';

  return {
    as_of: brief.as_of,
    headline,
    summary: {
      regions: order.length,
      alert: alerts.length,
      watch: watching.length,
      clear: order.filter((r) => r.state === 'clear').length,
      at_stake: brief.summary?.at_stake || {},
      urgent: brief.summary?.urgent || 0,
    },
    regions: order,
    relationships,
    trace,
    grown,
    not_in_your_view: [
      !finance && 'finance records (journal entries, invoices)',
      !systems && 'connected systems',
      ...order.filter((r) => r.state === 'not_in_view').map((r) => r.label.toLowerCase()),
    ].filter(Boolean),
    method:
      'Each part is read from this company\'s own records as you, with your role\'s view: people coverage (who decides, who is away), '
      + 'the process flow (every step from quote to cash and requisition to payment, timed from documents), the modules, built '
      + 'applications and connected systems, record counts across the ledger, every watcher of the brief (what matters now), '
      + 'what the business runs on (lines, sites, systems), decisions held open, supplier risk, the line watch, and what was built in '
      + 'Sandbox. The trace is the late or at-risk customer order whose cause, from the delivery trace, crosses the most parts of '
      + 'the business. Nothing was changed: each next step drafts, holds or asks, and a person approves it.',
  };
}

/**
 * @param {object} opts { companyId, userId, role, fresh }
 */
async function businessMap(opts = {}) {
  const companyId = opts.companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
  if (!companyId) return { error: 'No company to read.' };
  const role = opts.role ? String(opts.role).toUpperCase() : null;
  const key = `${companyId}:${opts.userId || '-'}:${role || '-'}`;
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  // Every read below goes out in this company's context, so row-level security answers for it.
  const promise = companyContext.runWithCompany(companyId, () => compute({ companyId, userId: opts.userId || null, role }));
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return promise;
}

module.exports = { businessMap, REGIONS, RELATIONSHIPS };
