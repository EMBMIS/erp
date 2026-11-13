/**
 * What the business actually runs on — and what stops if one piece of it does.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * "What do we run on?", "what is our single point of failure?", "what happens
 * if line ML-03 is down for three days?", "if the Oslo warehouse closes for a
 * week, which customers do we let down?", "what if Nordbay stops delivering?"
 *
 * The business runs on four kinds of thing, all read from this company's rows:
 *
 *   Lines     work centres, with the routing hours queued on them, the work
 *             orders behind those hours, the customer orders those work orders
 *             feed (from the delivery trace), the equipment registered there
 *             (fixed assets whose location names the centre) and whether any
 *             other running centre has hours free to take the work.
 *   Sites     storage locations, with the stock placed there, the customer
 *             orders shipping from there, and the items needed by open orders
 *             that are placed at no other site.
 *   Systems   what Simeli and the automations run through: the EMBMIS Gateway,
 *             the AI provider key, connected services and MCP servers, outgoing
 *             webhooks, mailboxes, the unattended scheduler and the enabled
 *             agents — each with its health from its own last error, status or
 *             delivery log.
 *   Equipment fixed assets in service, and those still in service past their
 *             useful life or fully written down.
 *
 * A single point of failure is a line with work queued and no other running
 * centre with free hours, or a site holding the only stock of an item an open
 * order needs. Each is ranked by the value of the customer orders behind it.
 *
 * WHAT IF IT STOPS
 * ---------------------------------------------------------------------------
 * whatIfDown() asks the delivery trace (services/deliveryRisk.js) twice — as
 * things stand, and with the line running nothing, the site shipping nothing or
 * the supplier delivering nothing for N days (assume.outages) — and returns the
 * orders that come out worse, by how many days, what they are worth and what
 * the customers' late-delivery terms charge. For a system it says what runs
 * through it and what would wait, from the same rows.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing. The what-if is never written. Proposals — move an
 * operation, transfer stock, second-source an item, tell a customer — come back
 * as proposals; moving an operation is a manager's click on the Work Centres
 * screen and everything else goes through the ordinary draft-and-approve path.
 *
 * VISIBILITY
 * ---------------------------------------------------------------------------
 * Every read is scoped to the company. Customer orders are the ones the asker's
 * role may see (the trace decides). Stock value and equipment book value only
 * reach roles that see margins; systems (keys, connections, errors) only reach
 * managers and admins.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const { traceDeliveryRisk } = require('./deliveryRisk');

const SEES_MARGINS = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER', 'FINANCE_USER']);
const SEES_SYSTEMS = new Set(['ADMIN', 'MANAGER']);
const OPEN_OP = ['PENDING', 'IN_PROGRESS'];
const OPEN_WO = ['DRAFT', 'RELEASED', 'IN_PROGRESS'];
const EXPOSED = new Set(['late', 'at_risk', 'uncovered']);
const RANK = { uncovered: 0, late: 1, unknown_item: 2, at_risk: 3, on_track: 4, covered: 5 };

const round = (v, p = 2) => Math.round((Number(v) || 0) * 10 ** p) / 10 ** p;
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isUuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v || ''));

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/** A table a deployment never migrated in answers empty, not as a fault. */
async function q(sql, params) {
  try {
    return (await pool.query(sql, params)).rows;
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return [];
    throw err;
  }
}

function money(v, cur) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 }).format(v || 0);
  } catch {
    return `${Math.round(v || 0)} ${cur || ''}`.trim();
  }
}

/* ------------------------------------------------------------------ reads */

async function readCurrency(companyId) {
  const rows = await q('SELECT base_currency FROM companies WHERE id = $1', [companyId]);
  return rows[0]?.base_currency || 'USD';
}

async function readCentres(companyId) {
  return q(
    `SELECT wc.id, wc.code, wc.name, wc.status,
            COALESCE(wc.daily_capacity_hours, 8)::float AS daily_capacity_hours,
            COALESCE(wc.efficiency_pct, 100)::float AS efficiency_pct,
            COALESCE(wc.hourly_rate, 0)::float AS hourly_rate,
            COALESCE(SUM(GREATEST(op.planned_hours - op.actual_hours, 0)) FILTER (WHERE wo.id IS NOT NULL), 0)::float AS open_hours,
            COUNT(DISTINCT wo.id)::int AS open_work_orders,
            COALESCE(array_agg(DISTINCT wo.id) FILTER (WHERE wo.id IS NOT NULL), '{}') AS work_order_ids,
            COALESCE(array_agg(DISTINCT wo.sales_order_id) FILTER (WHERE wo.sales_order_id IS NOT NULL), '{}') AS sales_order_ids
       FROM work_centers wc
       LEFT JOIN work_order_operations op ON op.work_center_id = wc.id AND op.status = ANY($2)
       LEFT JOIN work_orders wo ON wo.id = op.work_order_id AND wo.company_id = $1 AND wo.deleted_at IS NULL AND wo.status = ANY($3)
      WHERE wc.company_id = $1 AND wc.deleted_at IS NULL
      GROUP BY wc.id
      ORDER BY wc.code`,
    [companyId, OPEN_OP, OPEN_WO],
  );
}

async function readSites(companyId) {
  return q(
    `SELECT sl.id, sl.code, sl.name, sl.city, sl.country, sl.status, COALESCE(sl.is_active, true) AS is_active,
            sl.max_volume_capacity::float AS max_volume, sl.current_volume_used::float AS used_volume,
            COUNT(DISTINCT ii.item_master_id) FILTER (WHERE ism.quantity_in_location > 0)::int AS items_placed,
            COALESCE(SUM(ism.quantity_in_location * COALESCE(ii.unit_price, 0)) FILTER (WHERE ism.quantity_in_location > 0), 0)::float AS stock_value
       FROM storage_locations sl
       LEFT JOIN inventory_storage_mappings ism ON ism.storage_location_id = sl.id AND COALESCE(ism.status, 'APPROVED') <> 'DECLINED'
       LEFT JOIN inventory_items ii ON ii.id = ism.inventory_item_id AND ii.company_id = $1 AND COALESCE(ii.status, 'APPROVED') <> 'DECLINED'
      WHERE sl.company_id = $1
      GROUP BY sl.id
      ORDER BY sl.code`,
    [companyId],
  );
}

/** Per item, the sites holding it. An item at exactly one site is single-sited. */
async function readPlacement(companyId) {
  return q(
    `SELECT ii.item_master_id AS item_id, ism.storage_location_id AS site_id, SUM(ism.quantity_in_location)::float AS qty
       FROM inventory_storage_mappings ism
       JOIN inventory_items ii ON ii.id = ism.inventory_item_id
       JOIN storage_locations sl ON sl.id = ism.storage_location_id AND sl.company_id = $1
      WHERE ii.company_id = $1 AND ism.quantity_in_location > 0 AND ii.item_master_id IS NOT NULL
        AND COALESCE(ii.status, 'APPROVED') <> 'DECLINED' AND COALESCE(ism.status, 'APPROVED') <> 'DECLINED'
      GROUP BY 1, 2`,
    [companyId],
  );
}

async function readAssets(companyId) {
  return q(
    `SELECT id, asset_number, name, category, status, location, acquisition_date, useful_life_years,
            acquisition_cost::float AS acquisition_cost, book_value::float AS book_value, salvage_value::float AS salvage_value,
            (acquisition_date IS NOT NULL AND useful_life_years > 0
              AND acquisition_date + make_interval(years => useful_life_years) < CURRENT_DATE) AS past_life
       FROM fixed_assets
      WHERE company_id = $1 AND deleted_at IS NULL AND COALESCE(status, 'ACTIVE') <> 'DISPOSED'
      ORDER BY asset_number`,
    [companyId],
  );
}

/** Running centres with hours free over the next five working days. */
async function readFreeCapacity(centres) {
  return centres
    .filter((c) => c.status === 'ACTIVE')
    .map((c) => ({ id: c.id, code: c.code, name: c.name, free_hours: round(Math.max(c.daily_capacity_hours * (c.efficiency_pct / 100) * 5 - c.open_hours, 0), 1) }))
    .filter((c) => c.free_hours > 0)
    .sort((a, b) => b.free_hours - a.free_hours);
}

/** The systems Simeli and the automations run through, each with its health. */
async function readSystems(companyId) {
  const out = [];
  const add = (s) => out.push({ health: 'ok', ...s });

  try {
    const gw = require('./gateway/client');
    const st = await gw.getStatus(companyId);
    const counts = st.enabled ? await gw.getCounts(companyId, { days: 30 }).catch(() => null) : null;
    add({
      kind: 'gateway', id: 'gateway', name: 'EMBMIS Gateway',
      health: !st.enabled ? 'not_connected' : st.reachable ? 'ok' : 'down',
      detail: !st.enabled
        ? 'Not connected: Simeli\'s actions are not checked before they run'
        : st.reachable
          ? `Reachable${st.version ? ` (v${st.version})` : ''}; fails ${st.failMode}`
          : `Unreachable: ${st.error || 'no answer'}; fails ${st.failMode}`,
      runs: counts ? `${plural(counts.total, 'Simeli action')} checked in the last 30 days (${counts.blocked} blocked, ${counts.waiting} waiting on a person)` : 'Every Simeli write, once connected',
      if_down: st.failMode === 'open'
        ? 'Simeli\'s writes run unchecked until it is back'
        : 'Reads continue; every Simeli write waits for a person until it is back',
      last_error: st.lastError?.message || st.error || null,
    });
  } catch { /* gateway client absent in this build */ }

  try {
    const pk = await require('./ai/providerKey').status();
    add({
      kind: 'ai_provider', id: 'ai_provider', name: `AI provider (${pk.provider || 'unset'})`,
      health: pk.source === 'none' ? 'down' : 'ok',
      detail: pk.source === 'none' ? 'No key: Simeli cannot answer' : `Key …${pk.last4} from ${pk.source}${pk.setAt ? `, set ${iso(pk.setAt)}` : ''}`,
      runs: 'Simeli chat, agent runs, Sandbox builds',
      if_down: 'Simeli and the agents stop answering; every module screen and approval keeps working',
    });
  } catch { /* provider key module absent */ }

  for (const c of await q(
    `SELECT id, provider, label, status, last_error, access_token_expires_at, refresh_token_cipher IS NOT NULL AS can_refresh, updated_at
       FROM connectors WHERE company_id = $1 ORDER BY provider`, [companyId],
  )) {
    const expired = c.access_token_expires_at && new Date(c.access_token_expires_at) < new Date() && !c.can_refresh;
    let tools = [];
    try { tools = (require('./ai/connectorProviders').getProvider(c.provider)?.tools || []).map((t) => t.name); } catch { /* none */ }
    add({
      kind: 'connector', id: c.id, name: c.label || c.provider,
      health: c.last_error || expired ? 'warn' : String(c.status || '').toUpperCase() === 'CONNECTED' || String(c.status || '').toUpperCase() === 'ACTIVE' ? 'ok' : 'warn',
      detail: `${c.provider} · ${String(c.status || 'unknown').toLowerCase()}${expired ? ' · token expired' : ''}`,
      runs: tools.length ? `Simeli tools: ${tools.slice(0, 6).join(', ')}${tools.length > 6 ? ', …' : ''}` : `Simeli's ${c.provider} API access`,
      if_down: `Simeli can no longer read or act in ${c.label || c.provider}`,
      last_error: c.last_error || null,
    });
  }

  for (const m of await q(
    `SELECT id, name, status, last_error, tools_synced_at, jsonb_array_length(COALESCE(tools_cache, '[]'::jsonb)) AS tools
       FROM mcp_connections WHERE company_id = $1 ORDER BY name`, [companyId],
  )) {
    add({
      kind: 'mcp', id: m.id, name: m.name,
      health: m.last_error ? 'warn' : String(m.status || '').toUpperCase() === 'ACTIVE' || String(m.status || '').toUpperCase() === 'CONNECTED' ? 'ok' : 'warn',
      detail: `MCP server · ${String(m.status || 'unknown').toLowerCase()}${m.tools_synced_at ? ` · tools synced ${iso(m.tools_synced_at)}` : ''}`,
      runs: `${plural(m.tools || 0, 'tool')} Simeli can call`,
      if_down: `Those ${plural(m.tools || 0, 'tool')} stop answering`,
      last_error: m.last_error || null,
    });
  }

  for (const w of await q(
    `SELECT s.id, s.url, s.event_types, s.status, s.last_delivery_at, s.last_delivery_status,
            COUNT(l.id) FILTER (WHERE l.created_at >= now() - interval '7 days')::int AS sent,
            COUNT(l.id) FILTER (WHERE l.created_at >= now() - interval '7 days' AND (l.error IS NOT NULL OR l.response_status >= 400 OR l.response_status IS NULL))::int AS failed
       FROM webhook_subscriptions s LEFT JOIN webhook_delivery_log l ON l.subscription_id = s.id
      WHERE s.company_id = $1 GROUP BY s.id ORDER BY s.created_at`, [companyId],
  )) {
    let host = w.url;
    try { host = new URL(w.url).host; } catch { /* keep as is */ }
    add({
      kind: 'webhook', id: w.id, name: `Webhook → ${host}`,
      health: String(w.status || '').toUpperCase() !== 'ACTIVE' ? 'warn' : w.failed && w.failed === w.sent ? 'down' : w.failed ? 'warn' : 'ok',
      detail: `${String(w.status || '').toLowerCase()} · ${w.sent} sent, ${w.failed} failed in 7 days${w.last_delivery_status ? ` · last answer ${w.last_delivery_status}` : ''}`,
      runs: `Events: ${(w.event_types || []).join(', ') || 'all'}`,
      if_down: `${host} stops hearing about ${(w.event_types || []).slice(0, 3).join(', ') || 'events'}`,
    });
  }

  const [mb] = await q(
    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE quota_bytes > 0 AND used_bytes >= quota_bytes * 0.9)::int AS full
       FROM mailboxes WHERE company_id = $1 AND deleted_at IS NULL`, [companyId],
  );
  if (mb?.n) {
    add({
      kind: 'mailbox', id: 'mailboxes', name: 'Mailboxes',
      health: mb.full ? 'warn' : 'ok',
      detail: `${plural(mb.n, 'mailbox')}${mb.full ? `, ${mb.full} over 90% of quota` : ''}`,
      runs: 'Customer and supplier email, order intake',
      if_down: 'Mail to and from customers and suppliers stops arriving in the system',
    });
  }

  const sched = (() => { try { return require('./agents/scheduler').schedulerStatus(); } catch { return null; } })();
  const agents = await q(
    `SELECT agent_key, display_name, last_run_at, failure_count, last_error
       FROM agent_definitions WHERE company_id = $1 AND enabled = true ORDER BY display_name`, [companyId],
  );
  if (sched) {
    add({
      kind: 'scheduler', id: 'scheduler', name: 'Unattended watch (scheduler)',
      health: sched.running ? 'ok' : agents.length ? 'down' : 'not_connected',
      detail: sched.running
        ? `Running since ${iso(sched.startedAt)} · ${sched.runs || 0} runs, ${sched.failures || 0} failed`
        : 'Off: line watch, supplier risk and decision checks run only when someone asks',
      runs: `${plural(agents.length, 'enabled agent')}, the scheduled findings scans`,
      if_down: 'Nothing is watched between questions; findings appear only when someone looks',
    });
  }
  for (const a of agents.filter((x) => x.failure_count > 0 || x.last_error)) {
    add({
      kind: 'agent', id: a.agent_key, name: a.display_name || a.agent_key,
      health: 'warn',
      detail: `${plural(a.failure_count || 0, 'failure')} in a row${a.last_run_at ? ` · last run ${iso(a.last_run_at)}` : ''}`,
      runs: 'An enabled automation',
      if_down: 'Its work waits for a person',
      last_error: a.last_error || null,
    });
  }
  return out;
}

const matches = (location, ...names) => {
  const l = String(location || '').trim().toLowerCase();
  return !!l && names.filter(Boolean).some((n) => {
    const x = String(n).trim().toLowerCase();
    return x && (l === x || l.includes(x));
  });
};

/* ------------------------------------------------------------------- map */

/**
 * @param {object} opts  companyId, userId, role
 */
async function mapRunsOn(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  const seesMoney = SEES_MARGINS.has(opts.role) || !opts.userId;
  const seesSystems = SEES_SYSTEMS.has(opts.role) || !opts.userId;

  const [currency, centres, sites, placement, assets, trace] = await Promise.all([
    readCurrency(companyId),
    readCentres(companyId),
    readSites(companyId),
    readPlacement(companyId),
    readAssets(companyId),
    traceDeliveryRisk({ companyId, userId: opts.userId, role: opts.role, horizonDays: 45, includeCovered: true }),
  ]);
  const systems = seesSystems ? await readSystems(companyId) : null;
  const orders = trace.orders || [];
  const free = await readFreeCapacity(centres);

  const sitesOf = new Map();
  for (const p of placement) {
    if (!sitesOf.has(p.item_id)) sitesOf.set(p.item_id, []);
    sitesOf.get(p.item_id).push(p);
  }
  const usedAssets = new Set();
  const assetView = (a) => ({
    id: a.id, asset_number: a.asset_number, name: a.name, category: a.category, status: a.status,
    past_life: a.past_life, book_value: seesMoney ? round(a.book_value) : undefined,
  });

  const lines = centres.map((c) => {
    const wos = new Set(c.work_order_ids || []);
    const sos = new Set(c.sales_order_ids || []);
    const depending = orders.filter((o) => sos.has(o.sales_order_id) || o.lines.some((l) => l.depends_on.some((d) => d.type === 'work_order' && wos.has(d.id))));
    const value = depending.reduce((s, o) => s + (o.value_open || 0), 0);
    const alts = free.filter((f) => f.id !== c.id);
    const kit = assets.filter((a) => matches(a.location, c.code, c.name));
    kit.forEach((a) => usedAssets.add(a.id));
    const single = c.open_hours > 0 && !alts.length;
    return {
      kind: 'work_center', id: c.id, code: c.code, name: c.name, status: c.status,
      health: c.status !== 'ACTIVE' ? (c.open_hours > 0 ? 'down' : 'idle') : kit.some((a) => a.past_life) ? 'warn' : 'ok',
      open_hours: round(c.open_hours, 1),
      open_work_orders: c.open_work_orders,
      orders_depending: depending.length,
      orders_exposed: depending.filter((o) => EXPOSED.has(o.verdict)).length,
      value_depending: round(value),
      alternatives: alts.slice(0, 3),
      single_point: single,
      equipment: kit.map(assetView),
      note: c.open_hours > 0
        ? `${round(c.open_hours, 1)} h queued for ${plural(c.open_work_orders, 'work order')}${depending.length ? ` feeding ${plural(depending.length, 'customer order')} (${money(value, currency)})` : ''}`
          + (single ? '; no other running centre has free hours this week' : alts[0] ? `; ${alts[0].code} has ${alts[0].free_hours} h free` : '')
        : 'Nothing queued',
    };
  });

  const neededItems = new Map();
  for (const o of orders) {
    for (const l of o.lines) {
      if (!l.item_id || l.open_qty <= 0) continue;
      if (!neededItems.has(l.item_id)) neededItems.set(l.item_id, { item: l.item, orders: new Set(), value: 0 });
      const n = neededItems.get(l.item_id);
      n.orders.add(o.sales_order_id);
    }
  }
  const siteList = sites.map((s) => {
    const shipping = orders.filter((o) => o.ship_from?.id === s.id);
    const onlyHere = [...neededItems.entries()]
      .filter(([itemId]) => (sitesOf.get(itemId) || []).length === 1 && sitesOf.get(itemId)[0].site_id === s.id)
      .map(([itemId, n]) => ({ item_id: itemId, item: n.item, qty: round(sitesOf.get(itemId)[0].qty, 3), orders: n.orders.size }));
    const touched = new Set([...shipping.map((o) => o.sales_order_id), ...onlyHere.flatMap((i) => [...neededItems.get(i.item_id).orders])]);
    const depending = orders.filter((o) => touched.has(o.sales_order_id));
    const value = depending.reduce((v, o) => v + (o.value_open || 0), 0);
    const kit = assets.filter((a) => !usedAssets.has(a.id) && matches(a.location, s.code, s.name, s.city));
    kit.forEach((a) => usedAssets.add(a.id));
    const active = s.is_active && (!s.status || ['APPROVED', 'ACTIVE'].includes(String(s.status).toUpperCase()));
    return {
      kind: 'site', id: s.id, code: s.code, name: s.name, city: s.city, country: s.country, status: s.status,
      health: !active ? (depending.length ? 'down' : 'idle') : 'ok',
      items_placed: s.items_placed,
      stock_value: seesMoney ? round(s.stock_value) : undefined,
      utilisation_pct: s.max_volume ? round((s.used_volume / s.max_volume) * 100, 1) : null,
      orders_shipping: shipping.length,
      only_stock_of: onlyHere,
      orders_depending: depending.length,
      value_depending: round(value),
      single_point: onlyHere.length > 0,
      equipment: kit.map(assetView),
      note: [
        shipping.length ? `${plural(shipping.length, 'customer order')} ship from here` : null,
        onlyHere.length ? `only stock of ${onlyHere.slice(0, 3).map((i) => i.item).join(', ')}${onlyHere.length > 3 ? ` and ${onlyHere.length - 3} more` : ''} that open orders need` : null,
        depending.length ? `${money(value, currency)} of orders depend on it` : null,
      ].filter(Boolean).join('; ') || `${plural(s.items_placed, 'item')} placed; no open order depends on it alone`,
    };
  });

  const ageing = assets.filter((a) => a.past_life || (a.status === 'FULLY_DEPRECIATED') || (a.book_value != null && a.salvage_value != null && a.acquisition_cost > 0 && a.book_value <= a.salvage_value));
  const equipment = {
    in_service: assets.length,
    placed: usedAssets.size,
    unplaced: assets.length - usedAssets.size,
    book_value: seesMoney ? round(assets.reduce((s, a) => s + (a.book_value || 0), 0)) : undefined,
    past_life: ageing.map((a) => ({ ...assetView(a), location: a.location, acquired: iso(a.acquisition_date), useful_life_years: a.useful_life_years })),
  };

  // What to look at first: the single points with the most behind them, then
  // anything down, then systems that are failing.
  const watch = [];
  for (const l of lines) {
    if (l.health === 'down') watch.push({ weight: 3e12 + l.value_depending, kind: 'work_center', id: l.id, ref: l.code, text: `${l.code} is ${String(l.status).toLowerCase()} with ${l.open_hours} h queued${l.value_depending ? ` — ${money(l.value_depending, currency)} of orders behind it` : ''}` });
    else if (l.single_point && l.value_depending) watch.push({ weight: 2e12 + l.value_depending, kind: 'work_center', id: l.id, ref: l.code, text: `${l.code} is a single point of failure: ${money(l.value_depending, currency)} of orders run through it and no other centre has free hours` });
  }
  for (const s of siteList) {
    if (s.health === 'down') watch.push({ weight: 3e12 + s.value_depending, kind: 'site', id: s.id, ref: s.code, text: `${s.name} (${s.code}) is not active and ${money(s.value_depending, currency)} of orders depend on it` });
    else if (s.single_point && s.value_depending) watch.push({ weight: 2e12 + s.value_depending, kind: 'site', id: s.id, ref: s.code, text: `${s.name} (${s.code}) holds the only stock of ${plural(s.only_stock_of.length, 'item')} open orders need — ${money(s.value_depending, currency)} depends on it` });
  }
  for (const y of systems || []) {
    if (y.health === 'down' || y.health === 'warn') watch.push({ weight: (y.health === 'down' ? 1.5e12 : 1e12), kind: y.kind, id: y.id, ref: y.name, text: `${y.name}: ${y.detail}${y.last_error ? ` (${String(y.last_error).slice(0, 120)})` : ''}` });
  }
  if (ageing.length) watch.push({ weight: 1, kind: 'equipment', id: null, ref: null, text: `${plural(ageing.length, 'asset')} still in service past useful life or fully written down` });
  watch.sort((a, b) => b.weight - a.weight);

  const singles = lines.filter((l) => l.single_point).length + siteList.filter((s) => s.single_point).length;
  return {
    as_of: new Date().toISOString(),
    currency,
    scope: trace.scope || null,
    summary: {
      lines: lines.length,
      sites: siteList.length,
      systems: systems ? systems.length : null,
      equipment: assets.length,
      single_points: singles,
      down: lines.filter((l) => l.health === 'down').length + siteList.filter((s) => s.health === 'down').length + (systems || []).filter((y) => y.health === 'down').length,
      orders_checked: orders.length,
      value_open: round(orders.reduce((v, o) => v + (o.value_open || 0), 0)),
    },
    headline: watch[0]?.text
      || `${plural(lines.length, 'line')}, ${plural(siteList.length, 'site')}${systems ? `, ${plural(systems.length, 'system')}` : ''} — no single point of failure under the open orders`,
    watch: watch.slice(0, 8).map(({ weight, ...w }) => w),
    lines,
    sites: siteList,
    systems: systems || undefined,
    systems_note: systems ? undefined : 'Systems (keys, connections, their errors) are shown to managers and admins.',
    equipment,
    method:
      'Lines: routing hours still open on each work centre, the work orders behind them and the customer orders those '
      + 'feed (delivery trace, 45 days). Sites: stock placed at each storage location, orders shipping from it and items '
      + 'open orders need that no other site holds. Equipment is linked by the fixed asset\'s location naming the centre '
      + 'or site. Systems: each one\'s own status, last error and delivery log. Nothing was changed.',
  };
}

/* --------------------------------------------------------------- what if */

async function resolveTarget(companyId, kind, ref) {
  const r = String(ref || '').trim();
  if (!r) return null;
  if (kind === 'work_center') {
    const rows = await q(
      `SELECT id, code, name, status FROM work_centers WHERE company_id = $1 AND deleted_at IS NULL
          AND ${isUuid(r) ? 'id = $2::uuid' : '(code ILIKE $2 OR name ILIKE $2)'} LIMIT 1`, [companyId, r],
    );
    return rows[0] ? { kind, id: rows[0].id, label: `${rows[0].code} · ${rows[0].name}`, short: rows[0].code, row: rows[0] } : null;
  }
  if (kind === 'site') {
    const rows = await q(
      `SELECT id, code, name, city FROM storage_locations WHERE company_id = $1
          AND ${isUuid(r) ? 'id = $2::uuid' : '(code ILIKE $2 OR name ILIKE $2 OR city ILIKE $2)'} LIMIT 1`, [companyId, r],
    );
    return rows[0] ? { kind, id: rows[0].id, label: `${rows[0].name} (${rows[0].code})`, short: rows[0].code, row: rows[0] } : null;
  }
  if (kind === 'supplier') {
    const rows = await q(
      `SELECT id, COALESCE(trade_name, legal_name) AS name FROM suppliers WHERE company_id = $1
          AND ${isUuid(r) ? 'id = $2::uuid' : '(trade_name ILIKE $3 OR legal_name ILIKE $3 OR supplier_code ILIKE $2)'}
        ORDER BY (trade_name ILIKE $2 OR legal_name ILIKE $2) DESC LIMIT 1`, [companyId, r, `%${r}%`],
    );
    return rows[0] ? { kind, id: rows[0].id, label: rows[0].name, short: rows[0].name, row: rows[0] } : null;
  }
  return null;
}

/** Find what a free-text "it" is: a line, a site, a supplier or a system. */
async function guessTarget(companyId, ref) {
  for (const kind of ['work_center', 'site', 'supplier']) {
    const t = await resolveTarget(companyId, kind, ref);
    if (t) return t;
  }
  return null;
}

/**
 * @param {object} opts
 *   companyId, userId, role
 *   kind      work_center | site | supplier | gateway | ai_provider | connector | mcp | webhook | scheduler (optional: guessed from ref)
 *   ref       code, name or id of the thing that stops
 *   days      how long it is out (default 3, max 60)
 */
async function whatIfDown(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  const days = Math.min(Math.max(parseInt(opts.days, 10) || 3, 1), 60);
  const kind = opts.kind ? String(opts.kind).toLowerCase() : null;
  const currency = await readCurrency(companyId);

  // Systems carry no delivery dates; say what runs through them and what waits.
  if (kind && !['work_center', 'site', 'supplier'].includes(kind)) {
    if (opts.userId && !SEES_SYSTEMS.has(opts.role)) return { error: 'Systems are shown to managers and admins.' };
    const all = await readSystems(companyId);
    const r = String(opts.ref || '').toLowerCase();
    const hit = all.filter((y) => y.kind === kind && (!r || String(y.id).toLowerCase() === r || String(y.name).toLowerCase().includes(r)));
    if (!hit.length) return { error: `No ${kind.replace('_', ' ')}${opts.ref ? ` "${opts.ref}"` : ''} is set up in this company.` };
    return {
      as_of: new Date().toISOString(),
      target: { kind, name: hit[0].name, days },
      headline: hit[0].health === 'not_connected'
        ? `${hit[0].name} is not running now: ${hit[0].detail.replace(/^[^:]*: /, '')}.`
        : `If ${hit[0].name} is down for ${plural(days, 'day')}: ${hit[0].if_down.charAt(0).toLowerCase()}${hit[0].if_down.slice(1)}.`,
      systems: hit,
      orders: [],
      proposals: hit[0].health !== 'ok' && hit[0].last_error ? [{ kind: 'fix_system', label: `Fix ${hit[0].name} first: ${String(hit[0].last_error).slice(0, 160)}` }] : [],
      method: 'From the system\'s own status, last error and delivery log. No delivery date depends on it directly. Nothing was changed.',
    };
  }

  const target = kind ? await resolveTarget(companyId, kind, opts.ref) : await guessTarget(companyId, opts.ref);
  if (!target) return { error: `Nothing called "${opts.ref}" among this company's ${kind ? kind.replace('_', ' ') + 's' : 'work centres, sites or suppliers'}.` };

  const horizon = Math.min(Math.max(days + 30, 45), 120);
  const base = { companyId, userId: opts.userId, role: opts.role, horizonDays: horizon, includeCovered: true };
  const [before, after] = await Promise.all([
    traceDeliveryRisk(base),
    traceDeliveryRisk({ ...base, assume: { outages: [{ kind: target.kind, id: target.id, days, label: target.label }] } }),
  ]);
  const was = new Map((before.orders || []).map((o) => [o.sales_order_id, o]));

  const hit = [];
  for (const o of after.orders || []) {
    const b = was.get(o.sales_order_id);
    if (!b) continue;
    const worse = RANK[o.verdict] < RANK[b.verdict];
    const later = o.projected_date && b.projected_date && o.projected_date > b.projected_date;
    const lostDate = !o.projected_date && b.projected_date;
    if (!worse && !later && !lostDate) continue;
    const slip = later ? Math.round((new Date(o.projected_date) - new Date(b.projected_date)) / 86400000) : null;
    hit.push({
      sales_order_id: o.sales_order_id, so_number: o.so_number, customer_name: o.customer_name, due_date: o.due_date,
      before: { verdict: b.verdict, projected_date: b.projected_date, days_late: b.days_late },
      after: { verdict: o.verdict, projected_date: o.projected_date, days_late: o.days_late },
      slip_days: slip,
      value: o.value_open, currency: o.currency || currency,
      penalty_added: round(Math.max((o.penalty?.amount || 0) - (b.penalty?.amount || 0), 0)),
      cause: o.chain.find((s) => /outage/.test(s.kind || '') || /^If /.test(s.text))?.text || o.cause,
      chain: o.chain,
      proposals: o.proposals,
    });
  }
  hit.sort((a, b) => RANK[a.after.verdict] - RANK[b.after.verdict] || b.value - a.value);

  // What the outage holds, from the target's own rows.
  let holds = null;
  const proposals = [];
  if (target.kind === 'work_center') {
    const centres = await readCentres(companyId);
    const c = centres.find((x) => x.id === target.id);
    const alts = (await readFreeCapacity(centres)).filter((f) => f.id !== target.id);
    holds = { open_hours: round(c?.open_hours, 1), work_orders: c?.open_work_orders || 0, hourly_rate: SEES_MARGINS.has(opts.role) || !opts.userId ? round(c?.hourly_rate) : undefined };
    const next = await q(
      `SELECT op.id, op.operation_number, wo.wo_number, wo.id AS work_order_id
         FROM work_order_operations op JOIN work_orders wo ON wo.id = op.work_order_id
        WHERE wo.company_id = $1 AND op.work_center_id = $2 AND op.status = 'PENDING' AND COALESCE(op.actual_hours, 0) = 0
          AND wo.status = ANY($3) AND wo.deleted_at IS NULL
        ORDER BY wo.planned_end_date NULLS LAST LIMIT 3`, [companyId, target.id, OPEN_WO],
    );
    if (alts[0]) {
      for (const op of next) {
        proposals.push({
          kind: 'move_operation', operation_id: op.id, to_work_center_id: alts[0].id, to_code: alts[0].code,
          label: `Move ${op.wo_number} operation ${op.operation_number} to ${alts[0].code} (${alts[0].free_hours} h free this week)`,
          record: { type: 'work_order', id: op.work_order_id, number: op.wo_number },
        });
      }
    } else if (c?.open_hours > 0) {
      proposals.push({ kind: 'single_point', label: `No other running centre has free hours: ${target.short} is a single point of failure. Qualify a second centre or plan maintenance around the queue.` });
    }
  } else if (target.kind === 'site') {
    const [h] = await q(
      `SELECT COUNT(DISTINCT ii.item_master_id)::int AS items, COALESCE(SUM(ism.quantity_in_location), 0)::float AS qty,
              COALESCE(SUM(ism.quantity_in_location * COALESCE(ii.unit_price, 0)), 0)::float AS value
         FROM inventory_storage_mappings ism JOIN inventory_items ii ON ii.id = ism.inventory_item_id AND ii.company_id = $1
        WHERE ism.storage_location_id = $2 AND ism.quantity_in_location > 0`, [companyId, target.id],
    );
    holds = { items: h?.items || 0, units: round(h?.qty, 3), stock_value: SEES_MARGINS.has(opts.role) || !opts.userId ? round(h?.value) : undefined };
  } else if (target.kind === 'supplier') {
    const lines = await q(
      `SELECT pol.item_id, i.name AS item, i.item_code, GREATEST(pol.quantity - COALESCE(pol.quantity_received, 0), 0)::float AS open_qty,
              (GREATEST(pol.quantity - COALESCE(pol.quantity_received, 0), 0) * COALESCE(pol.unit_price, 0))::float AS open_value
         FROM purchase_orders po JOIN purchase_order_line_items pol ON pol.po_id = po.id LEFT JOIN items i ON i.id = pol.item_id
        WHERE po.company_id = $1 AND po.supplier_id = $2 AND pol.quantity - COALESCE(pol.quantity_received, 0) > 0
          AND po.status NOT IN ('DRAFT', 'REJECTED', 'CANCELLED', 'CLOSED', 'FULLY_RECEIVED')`, [companyId, target.id],
    );
    holds = {
      open_lines: lines.length,
      open_value: SEES_MARGINS.has(opts.role) || !opts.userId ? round(lines.reduce((s, l) => s + l.open_value, 0)) : undefined,
    };
    const items = [...new Set(lines.map((l) => l.item_id).filter(Boolean))];
    if (items.length) {
      const others = await q(
        `SELECT pol.item_id, po.supplier_id, COALESCE(s.trade_name, s.legal_name) AS name, MAX(po.po_date) AS last
           FROM purchase_orders po JOIN purchase_order_line_items pol ON pol.po_id = po.id JOIN suppliers s ON s.id = po.supplier_id
          WHERE po.company_id = $1 AND po.supplier_id <> $2 AND pol.item_id = ANY($3) AND po.status NOT IN ('DRAFT', 'REJECTED', 'CANCELLED')
          GROUP BY 1, 2, 3 ORDER BY last DESC`, [companyId, target.id, items],
      );
      for (const itemId of items.slice(0, 5)) {
        const l = lines.find((x) => x.item_id === itemId);
        const alt = others.find((o) => o.item_id === itemId);
        proposals.push(alt
          ? { kind: 'second_source', label: `Order ${l.item || l.item_code} from ${alt.name} instead (bought from them ${iso(alt.last)})`, tool: 'plan_replenishment', args: { item: l.item_code || l.item } }
          : { kind: 'single_source', label: `${l.item || l.item_code} has no other supplier on record: ${target.short} is its single source` });
      }
    }
  }
  for (const o of hit) for (const p of o.proposals || []) proposals.push(p);
  const unique = [...new Map(proposals.map((p) => [p.label, p])).values()].slice(0, 10);

  const value = round(hit.reduce((s, o) => s + (o.value || 0), 0));
  const penalty = round(hit.reduce((s, o) => s + o.penalty_added, 0));
  const worst = hit.reduce((m, o) => Math.max(m, o.slip_days || 0), 0);
  const dependsAtAll = (after.orders || []).filter((o) => o.chain.some((s) => /outage/.test(s.kind || ''))).length;

  return {
    as_of: new Date().toISOString(),
    currency,
    scope: after.scope || null,
    target: { kind: target.kind, id: target.id, name: target.label, days },
    holds,
    summary: {
      orders_checked: (after.orders || []).length,
      orders_hit: hit.length,
      newly_late: hit.filter((o) => ['late', 'uncovered'].includes(o.after.verdict) && !['late', 'uncovered'].includes(o.before.verdict)).length,
      value_hit: value,
      penalty_added: penalty,
      worst_slip_days: worst || null,
    },
    headline: hit.length
      ? `If ${target.label} is out for ${plural(days, 'day')}, ${plural(hit.length, 'customer order')} (${money(value, currency)}) ${hit.length === 1 ? 'comes' : 'come'} out worse`
        + (worst ? `, up to ${plural(worst, 'day')} later` : '')
        + (penalty ? `, ${money(penalty, currency)} in late-delivery penalties` : '')
        + `. First: ${hit[0].so_number} for ${hit[0].customer_name}.`
      : dependsAtAll
        ? `If ${target.label} is out for ${plural(days, 'day')}, ${plural(dependsAtAll, 'order')} wait on it but every one still ships when it would have.`
        : `If ${target.label} is out for ${plural(days, 'day')}, no open customer order in the next ${horizon} days ships later.`,
    orders: hit,
    proposals: unique,
    method:
      `The delivery trace was read twice over ${horizon} days: as things stand, and assuming ${target.label} `
      + (target.kind === 'work_center' ? 'runs no operation' : target.kind === 'site' ? 'ships nothing (its stock comes back when it does)' : 'delivers nothing')
      + ` for ${plural(days, 'day')}. Orders listed are the ones whose verdict or projected date got worse. Nothing was changed.`,
  };
}

module.exports = { mapRunsOn, whatIfDown };
