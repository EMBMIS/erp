/**
 * The warehouse as it stands — every bay, what is on it, how long it lasts,
 * and which customer order a short one puts at risk.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * "Show me the warehouse", "which bays are short", "what is in C-14 and who is
 * waiting on it" — from the company's own storage locations, bins, stock
 * placed in them, goods issues and the delivery trace. It is the model a
 * digital twin draws: a location is a floor, a bin is a bay, and a bay's
 * height is how many days its stock lasts.
 *
 *   Placed       stock in each bay (inventory_storage_mappings), its share of
 *                the bay's volume and mass capacity.
 *   Pace         how fast each item leaves: goods issued over the last 90 days,
 *                or the orders due inside the horizon if they are faster.
 *   Cover        a bay's stock divided by that pace, in days. For a bay with
 *                several items, the one that runs out first.
 *   Below order  the delivery trace allocates ALL stock to open order lines in
 *                promised-date order; a line that stock cannot cover names its
 *                item, and every bay holding that item is short for it. The
 *                orders and their verdict come from the trace, so a USER role
 *                sees only their own orders — but the shortage is still shown,
 *                because it is a fact about the shelf, not about the reader.
 *   Unplaced     stock the item record says exists that no bay holds.
 *   In transit   transfers on the road into or out of each location.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing. Proposals — expedite, re-plan, count a bay, tell the
 * customer — come back as proposals. The order's own recovery plan (approved
 * by a manager on the order) and Simeli's drafts are where acting happens.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const { traceDeliveryRisk } = require('./deliveryRisk');

const USAGE_DAYS = 90;
const DEFAULT_HORIZON = 21;
const LOW_COVER_DAYS = 7;
const ISSUE_STATUSES = ['POSTED', 'APPROVED'];
const STATUS_RANK = { short: 0, low: 1, ok: 2, idle: 3, empty: 4 };
/** The delivery trace's rule: these roles see every order, others their own. */
const SEES_ALL_ORDERS = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER']);

const round = (v, p = 2) => Math.round(v * 10 ** p) / 10 ** p;
const num = (v) => (v == null ? 0 : Number(v));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

function money(v, cur) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 }).format(v || 0);
  } catch {
    return `${Math.round(v || 0)} ${cur || ''}`.trim();
  }
}

/* ------------------------------------------------------------------ reads */

async function readLocations(companyId, locationRef) {
  const ref = locationRef ? String(locationRef).trim() : null;
  const isUuid = ref && /^[0-9a-f-]{36}$/i.test(ref);
  const { rows } = await pool.query(
    `SELECT id, code, name, city, country, is_active, status,
            max_mass_capacity::float AS max_mass, max_volume_capacity::float AS max_volume,
            current_mass_used::float AS mass_used, current_volume_used::float AS volume_used
       FROM storage_locations
      WHERE company_id = $1
        AND COALESCE(status, 'DRAFT') <> 'DECLINED'
        AND ($2::text IS NULL
             OR ($3 AND id = $2::uuid)
             OR (NOT $3 AND (code ILIKE $2 OR name ILIKE '%' || $2 || '%' OR city ILIKE $2)))
      ORDER BY code`,
    [companyId, ref, !!isUuid],
  );
  return rows;
}

async function readBins(companyId, locationIds) {
  if (!locationIds.length) return [];
  const { rows } = await pool.query(
    `SELECT id, code, description, storage_location_id, is_active, status,
            max_mass_capacity::float AS max_mass, max_volume_capacity::float AS max_volume,
            current_mass_used::float AS mass_used, current_volume_used::float AS volume_used
       FROM bins
      WHERE company_id = $1 AND storage_location_id = ANY($2) AND COALESCE(status, 'DRAFT') <> 'DECLINED'
      ORDER BY code`,
    [companyId, locationIds],
  );
  return rows;
}

/**
 * Stock placed in a location or bay. The mapping table carries no company of
 * its own, so it is reached only through this company's inventory items AND
 * this company's locations.
 */
async function readPlacements(companyId, locationIds) {
  if (!locationIds.length) return [];
  const { rows } = await pool.query(
    `SELECT ism.storage_location_id, ism.bin_id, ism.inventory_item_id,
            ii.item_master_id AS item_id, im.item_code, im.name AS item_name,
            ism.quantity_in_location::float AS qty,
            ii.unit_price::float AS unit_price,
            ii.reorder_point::float AS reorder_point, ii.minimum_stock_level::float AS min_level
       FROM inventory_storage_mappings ism
       JOIN inventory_items ii ON ii.id = ism.inventory_item_id AND ii.company_id = $1
       JOIN storage_locations sl ON sl.id = ism.storage_location_id AND sl.company_id = $1
       LEFT JOIN items im ON im.id = ii.item_master_id AND im.company_id = $1
      WHERE ism.storage_location_id = ANY($2)
        AND COALESCE(ism.status, 'APPROVED') <> 'DECLINED'
        AND COALESCE(ii.status, 'APPROVED') <> 'DECLINED'
        AND ism.quantity_in_location > 0`,
    [companyId, locationIds],
  );
  return rows;
}

/** What the item record says is on hand, company-wide — the trace's own figure. */
async function readOnHand(companyId, itemIds) {
  if (!itemIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT item_master_id AS item_id, SUM(current_stock_quantity)::float AS qty
       FROM inventory_items
      WHERE company_id = $1 AND item_master_id = ANY($2) AND COALESCE(status, 'APPROVED') <> 'DECLINED'
      GROUP BY 1`,
    [companyId, itemIds],
  );
  return new Map(rows.map((r) => [r.item_id, r.qty]));
}

/** Goods issued per item over the last USAGE_DAYS days. */
async function readUsage(companyId, itemIds) {
  if (!itemIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT ii.item_master_id AS item_id,
            SUM(COALESCE(wti.issued_quantity, wti.quantity))::float AS issued
       FROM warehouse_transactions wt
       JOIN warehouse_transaction_items wti ON wti.warehouse_transaction_id = wt.id
       JOIN inventory_items ii ON ii.id = wti.inventory_item_id AND ii.company_id = $1
      WHERE wt.company_id = $1
        AND wt.transaction_type = 'GI'
        AND wt.status = ANY($3)
        AND wt.transaction_date >= CURRENT_DATE - $4::int
        AND ii.item_master_id = ANY($2)
      GROUP BY 1`,
    [companyId, itemIds, ISSUE_STATUSES, USAGE_DAYS],
  );
  return new Map(rows.map((r) => [r.item_id, r.issued]));
}

async function readInTransit(companyId, locationIds) {
  if (!locationIds.length) return [];
  const { rows } = await pool.query(
    `SELECT t.id, t.transfer_number, t.quantity::float AS qty, t.dispatched_at,
            t.source_storage_location_id AS from_id, t.destination_storage_location_id AS to_id,
            t.destination_bin_id AS to_bin_id, t.source_bin_id AS from_bin_id,
            ii.item_master_id AS item_id, im.name AS item_name,
            src.name AS from_name, dst.name AS to_name
       FROM inventory_transfers t
       JOIN inventory_items ii ON ii.id = t.inventory_item_id AND ii.company_id = $1
       LEFT JOIN items im ON im.id = ii.item_master_id
       LEFT JOIN storage_locations src ON src.id = t.source_storage_location_id
       LEFT JOIN storage_locations dst ON dst.id = t.destination_storage_location_id
      WHERE t.company_id = $1 AND t.status = 'IN_TRANSIT'
        AND (t.source_storage_location_id = ANY($2) OR t.destination_storage_location_id = ANY($2))
      ORDER BY t.dispatched_at`,
    [companyId, locationIds],
  );
  return rows;
}

async function readCurrency(companyId) {
  const { rows } = await pool.query('SELECT base_currency FROM companies WHERE id = $1', [companyId]);
  return rows[0]?.base_currency || 'USD';
}

/* -------------------------------------------------------------- the model */

function fillPct(used, max) {
  return max > 0 ? round((num(used) / max) * 100, 1) : null;
}

/** A bay's code as people say it: the bin code, or "floor" for stock with no bin. */
function bayLabel(bin) {
  return bin ? `bay ${bin.code}` : 'floor stock';
}

/**
 * @param {object} opts
 *   companyId, userId, role   who is asking (role decides which customer orders are named)
 *   location                  one storage location, by id, code, name or city
 *   horizonDays               how far ahead orders count (default 21, max 90)
 *   bin                       one bay, by bin code (narrows the answer to it)
 */
async function assessWarehouse(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  const horizon = Math.min(Math.max(parseInt(opts.horizonDays, 10) || DEFAULT_HORIZON, 1), 90);

  const locations = await readLocations(companyId, opts.location);
  if (opts.location && !locations.length) return { error: `No storage location ${opts.location} in this company.` };
  const locationIds = locations.map((l) => l.id);

  const [bins, placements, transit, currency] = await Promise.all([
    readBins(companyId, locationIds),
    readPlacements(companyId, locationIds),
    readInTransit(companyId, locationIds),
    readCurrency(companyId),
  ]);

  const itemIds = [...new Set(placements.map((p) => p.item_id).filter(Boolean))];
  const [onHand, usage] = await Promise.all([readOnHand(companyId, itemIds), readUsage(companyId, itemIds)]);

  // The delivery trace decides what stock is promised to whom. Read it once,
  // and only when something is on a shelf for it to be promised from.
  // It is read for the whole company — whether a shelf is short is a fact
  // about the shelf — and the orders are then narrowed to the ones this
  // reader's role may see, by the trace's own rule.
  let trace = null;
  let visible = () => true;
  if (itemIds.length) {
    trace = await traceDeliveryRisk({ companyId, role: 'ADMIN', horizonDays: horizon, includeCovered: true });
    if (trace?.error) trace = null;
    if (trace && opts.userId && !SEES_ALL_ORDERS.has(opts.role)) {
      const ids = trace.orders.map((o) => o.sales_order_id);
      const { rows } = await pool.query(
        'SELECT id FROM sales_orders WHERE company_id = $1 AND id = ANY($2) AND (created_by IS NULL OR created_by = $3)',
        [companyId, ids, opts.userId],
      );
      const own = new Set(rows.map((r) => r.id));
      visible = (o) => own.has(o.sales_order_id);
    }
  }

  // Per item: demand due in the horizon, what stock cannot cover, and the
  // orders behind it (only those this reader may see).
  const demand = new Map();
  const itemOf = (id) => {
    if (!demand.has(id)) demand.set(id, { due: 0, short: 0, orders: new Map() });
    return demand.get(id);
  };
  for (const o of trace?.orders || []) {
    for (const l of o.lines || []) {
      if (!l.item_id || !itemIds.includes(l.item_id)) continue;
      const d = itemOf(l.item_id);
      d.due += num(l.open_qty);
      const gap = num(l.open_qty) - num(l.from_stock);
      if (gap > 0.0001) {
        d.short += gap;
        if (!visible(o)) { d.hidden = (d.hidden || 0) + 1; continue; }
        const prev = d.orders.get(o.sales_order_id);
        d.orders.set(o.sales_order_id, {
          sales_order_id: o.sales_order_id,
          so_number: o.so_number,
          customer_name: o.customer_name,
          due_date: o.due_date,
          projected_date: o.projected_date,
          verdict: o.verdict,
          short_qty: round((prev?.short_qty || 0) + gap, 3),
          value_at_risk: o.value_at_risk,
          currency: o.currency,
          cause: o.cause,
          proposals: (o.proposals || []).map((p) => p.label),
        });
      }
    }
  }

  const items = new Map();
  for (const id of itemIds) {
    const issued = usage.get(id) || 0;
    const d = demand.get(id) || { due: 0, short: 0, orders: new Map() };
    const histRate = issued / USAGE_DAYS;
    const demandRate = d.due / horizon;
    const rate = Math.max(histRate, demandRate);
    const placed = placements.filter((p) => p.item_id === id).reduce((s, p) => s + p.qty, 0);
    const recorded = onHand.get(id) ?? placed;
    items.set(id, {
      rate,
      rate_source: rate === 0 ? null : (demandRate > histRate ? 'orders due' : `issues over ${USAGE_DAYS} days`),
      due: d.due,
      short: d.short,
      orders: [...d.orders.values()],
      on_hand: recorded,
      cover_days: rate > 0 ? recorded / rate : null,
      // Only meaningful when the whole company is in view.
      unplaced: opts.location ? 0 : Math.max(0, recorded - placed),
    });
  }

  // Bays: each bin, plus one "floor" bay per location for stock with no bin.
  const binById = new Map(bins.map((b) => [b.id, b]));
  const bays = new Map();
  const bayKey = (locId, binId) => `${locId}:${binId || 'floor'}`;
  bins.forEach((b) => bays.set(bayKey(b.storage_location_id, b.id), { bin: b, location_id: b.storage_location_id, stock: [] }));
  placements.forEach((p) => {
    const k = bayKey(p.storage_location_id, p.bin_id && binById.has(p.bin_id) ? p.bin_id : null);
    if (!bays.has(k)) bays.set(k, { bin: null, location_id: p.storage_location_id, stock: [] });
    bays.get(k).stock.push(p);
  });

  const transitIn = (locId, itemId) => transit.filter((t) => t.to_id === locId && (!itemId || t.item_id === itemId));

  const bayModels = [];
  for (const bay of bays.values()) {
    const loc = locations.find((l) => l.id === bay.location_id);
    const where = `${bayLabel(bay.bin)} at ${loc.name}`;
    const stock = bay.stock.map((p) => {
      const it = items.get(p.item_id) || { rate: 0, orders: [], short: 0, due: 0 };
      return {
        inventory_item_id: p.inventory_item_id,
        item_id: p.item_id,
        item_code: p.item_code,
        name: p.item_name || p.item_code || 'Unnamed item',
        qty: round(p.qty, 3),
        value: p.unit_price ? round(p.qty * p.unit_price) : null,
        daily_use: it.rate ? round(it.rate, 3) : 0,
        cover_days: it.rate > 0 ? round(p.qty / it.rate, 1) : null,
        item_cover_days: it.cover_days != null ? round(it.cover_days, 1) : null,
        due_in_horizon: round(it.due, 3),
        short_for_orders: round(it.short, 3),
        below_reorder: p.reorder_point != null && it.on_hand != null && it.on_hand <= p.reorder_point,
        orders: it.orders,
        incoming: transitIn(bay.location_id, p.item_id).map((t) => ({ transfer_number: t.transfer_number, qty: t.qty, from: t.from_name })),
      };
    });

    let status = 'empty';
    if (stock.length) {
      if (stock.some((s) => s.short_for_orders > 0)) status = 'short';
      else if (stock.some((s) => (s.cover_days != null && s.cover_days < LOW_COVER_DAYS) || s.below_reorder)) status = 'low';
      else if (stock.every((s) => !s.daily_use)) status = 'idle';
      else status = 'ok';
    }
    const covers = stock.map((s) => s.cover_days).filter((c) => c != null);
    const cover = covers.length ? Math.min(...covers) : null;

    const signals = [];
    const chain = [];
    const proposals = [];
    const orders = new Map();
    stock.filter((s) => s.short_for_orders > 0).forEach((s) => {
      s.orders.forEach((o) => orders.set(o.sales_order_id, o));
      signals.push(`${where} holds ${s.qty} × ${s.name} — ${s.cover_days != null ? `${s.cover_days} days of cover` : 'no measured pace'}; `
        + `orders due in the next ${horizon} days need ${s.due_in_horizon}, and the company's stock leaves ${s.short_for_orders} short`);
    });
    stock.filter((s) => s.short_for_orders <= 0 && s.cover_days != null && s.cover_days < LOW_COVER_DAYS).forEach((s) => {
      signals.push(`${where} holds ${s.qty} × ${s.name}, ${s.cover_days} days at ${s.daily_use}/day (${items.get(s.item_id)?.rate_source})`);
    });
    stock.filter((s) => s.below_reorder && s.short_for_orders <= 0).forEach((s) => {
      signals.push(`${s.name} is at or below its reorder point across the company`);
    });

    const worst = stock.filter((s) => s.short_for_orders > 0).sort((a, b) => b.short_for_orders - a.short_for_orders)[0];
    if (worst) {
      chain.push({ layer: 'inventory', text: `${where}: ${worst.qty} × ${worst.name}, ${worst.cover_days != null ? `${worst.cover_days} days of cover` : 'cover not measured'}`, record: { type: 'item', id: worst.inventory_item_id, number: worst.item_code } });
      chain.push({ layer: 'data', text: `Orders due in ${horizon} days need ${worst.due_in_horizon}; all stock of it in the company leaves ${worst.short_for_orders} uncovered` });
      worst.orders.slice(0, 3).forEach((o) => {
        chain.push({ layer: 'decisions', text: `${o.so_number} for ${o.customer_name}, due ${o.due_date} — ${String(o.verdict).replace('_', ' ')}${o.projected_date && o.projected_date !== o.due_date ? `, projected ${o.projected_date}` : ''}${o.cause ? `: ${o.cause}` : ''}`, record: { type: 'sales_order', id: o.sales_order_id, number: o.so_number } });
        o.proposals.slice(0, 2).forEach((label) => proposals.push({ label, record: { type: 'sales_order', id: o.sales_order_id, number: o.so_number } }));
        proposals.push({ label: `Open ${o.so_number}'s delivery outlook — if a fix exists, it is ready there for a manager to approve`, record: { type: 'sales_order', id: o.sales_order_id, number: o.so_number } });
      });
      if (!worst.orders.length) {
        chain.push({ layer: 'decisions', text: 'The orders it reaches belong to other people\'s books; your role sees the shortage, not their names' });
      }
      if (worst.incoming.length) {
        chain.push({ layer: 'operations', text: `${worst.incoming.map((t) => `${t.qty} on the way from ${t.from} (${t.transfer_number})`).join(', ')}` });
      }
    }
    const lowItem = !worst && stock.find((s) => s.cover_days != null && s.cover_days < LOW_COVER_DAYS);
    if (lowItem) {
      proposals.push({ label: `Check the reorder for ${lowItem.name} — ${lowItem.cover_days} days of cover in ${bayLabel(bay.bin)}`, tool: 'run_reorder_check' });
    }

    const binFill = bay.bin ? (fillPct(bay.bin.volume_used, bay.bin.max_volume) ?? fillPct(bay.bin.mass_used, bay.bin.max_mass)) : null;
    const valueAtRisk = [...orders.values()].reduce((s, o) => s + num(o.value_at_risk), 0);
    bayModels.push({
      id: bay.bin?.id || `floor-${bay.location_id}`,
      bin_id: bay.bin?.id || null,
      code: bay.bin?.code || null,
      label: bay.bin ? bay.bin.code : 'Floor',
      description: bay.bin?.description || 'Stock placed at the location with no bin',
      location_id: bay.location_id,
      location: loc.name,
      active: bay.bin ? bay.bin.is_active !== false : true,
      status,
      cover_days: cover,
      fill_pct: binFill,
      volume_pct: bay.bin ? fillPct(bay.bin.volume_used, bay.bin.max_volume) : null,
      mass_pct: bay.bin ? fillPct(bay.bin.mass_used, bay.bin.max_mass) : null,
      units: round(stock.reduce((s, x) => s + x.qty, 0), 3),
      value: round(stock.reduce((s, x) => s + num(x.value), 0)),
      items: stock.sort((a, b) => num(b.short_for_orders) - num(a.short_for_orders) || num(a.cover_days ?? 1e9) - num(b.cover_days ?? 1e9)),
      orders_at_risk: [...orders.values()],
      value_at_risk: round(valueAtRisk),
      headline: worst
        ? `${bayLabel(bay.bin)} at ${loc.name} — ${worst.name}, ${worst.cover_days != null ? `cover ${worst.cover_days} days` : 'no pace'} · below the order${worst.orders[0] ? ` (${worst.orders[0].so_number})` : ''}`
        : lowItem ? `${bayLabel(bay.bin)} at ${loc.name} — ${lowItem.name}, cover ${lowItem.cover_days} days` : null,
      signals,
      chain,
      proposals: [...new Map(proposals.map((p) => [p.label, p])).values()],
    });
  }

  bayModels.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]
    || num(a.cover_days ?? 1e9) - num(b.cover_days ?? 1e9)
    || String(a.label).localeCompare(String(b.label)));

  const locationModels = locations.map((l) => {
    const own = bayModels.filter((b) => b.location_id === l.id);
    const count = (s) => own.filter((b) => b.status === s).length;
    const inbound = transit.filter((t) => t.to_id === l.id);
    const outbound = transit.filter((t) => t.from_id === l.id);
    const orderSet = new Map();
    own.forEach((b) => b.orders_at_risk.forEach((o) => orderSet.set(o.sales_order_id, o)));
    return {
      id: l.id,
      code: l.code,
      name: l.name,
      city: l.city,
      country: l.country,
      active: l.is_active !== false,
      fill_pct: fillPct(l.volume_used, l.max_volume) ?? fillPct(l.mass_used, l.max_mass),
      bays: own.length,
      stocked_bays: own.filter((b) => b.status !== 'empty').length,
      short_bays: count('short'),
      low_bays: count('low'),
      units: round(own.reduce((s, b) => s + b.units, 0), 3),
      value: round(own.reduce((s, b) => s + b.value, 0)),
      orders_at_risk: orderSet.size,
      value_at_risk: round([...orderSet.values()].reduce((s, o) => s + num(o.value_at_risk), 0)),
      in_transit_in: inbound.map((t) => ({ transfer_number: t.transfer_number, item: t.item_name, qty: t.qty, from: t.from_name, dispatched_at: t.dispatched_at })),
      in_transit_out: outbound.map((t) => ({ transfer_number: t.transfer_number, item: t.item_name, qty: t.qty, to: t.to_name, dispatched_at: t.dispatched_at })),
      top_signal: own.find((b) => b.headline)?.headline || null,
    };
  });

  const unplaced = [...items.entries()]
    .filter(([, it]) => it.unplaced > 0.0001)
    .map(([id, it]) => {
      const p = placements.find((x) => x.item_id === id);
      return { item_id: id, inventory_item_id: p?.inventory_item_id, name: p?.item_name || p?.item_code, on_record: round(it.on_hand, 3), in_bays: round(it.on_hand - it.unplaced, 3), unplaced: round(it.unplaced, 3) };
    });

  const allOrders = new Map();
  bayModels.forEach((b) => b.orders_at_risk.forEach((o) => allOrders.set(o.sales_order_id, o)));
  const shortBays = bayModels.filter((b) => b.status === 'short');

  let bayFilter = null;
  if (opts.bin) {
    const code = String(opts.bin).trim().toLowerCase().replace(/^bay\s+/, '');
    bayFilter = bayModels.filter((b) => (b.code || '').toLowerCase() === code || (b.code || '').toLowerCase().endsWith(code));
    if (!bayFilter.length) return { error: `No bay ${opts.bin} ${opts.location ? `at ${opts.location}` : 'in this company'}.` };
  }

  return {
    as_of: new Date().toISOString(),
    horizon_days: horizon,
    currency,
    scope: opts.userId && !SEES_ALL_ORDERS.has(opts.role) ? 'orders you created' : 'all company orders',
    summary: {
      locations: locations.length,
      bays: bayModels.filter((b) => b.bin_id).length,
      stocked_bays: bayModels.filter((b) => b.status !== 'empty').length,
      short_bays: shortBays.length,
      low_bays: bayModels.filter((b) => b.status === 'low').length,
      items_short: new Set(shortBays.flatMap((b) => b.items.filter((i) => i.short_for_orders > 0).map((i) => i.item_id))).size,
      orders_at_risk: allOrders.size,
      value_at_risk: round([...allOrders.values()].reduce((s, o) => s + num(o.value_at_risk), 0)),
      in_transit: transit.length,
      unplaced_items: unplaced.length,
    },
    headline: shortBays.length
      ? `${plural(shortBays.length, 'bay')} below the orders due in ${horizon} days${allOrders.size ? `, ${plural(allOrders.size, 'order')} at risk (${money([...allOrders.values()].reduce((s, o) => s + num(o.value_at_risk), 0), currency)})` : ''}`
      : bayModels.length ? `No bay is below the orders due in the next ${horizon} days` : 'No storage locations or placed stock yet',
    locations: locationModels,
    bays: bayFilter || bayModels,
    unplaced,
    method:
      `A bay is a bin (or a location's unbinned floor). Cover is the bay's stock divided by the item's pace — goods issued over `
      + `${USAGE_DAYS} days, or the orders due in ${horizon} days if faster. A bay is short when the delivery trace, which `
      + 'allocates all of the company\'s stock to open order lines in promised-date order, leaves an order line for an item it '
      + `holds uncovered; low under ${LOW_COVER_DAYS} days of cover or at the reorder point. Nothing was changed.`,
  };
}

/**
 * The measures a Sandbox-built application shows for storage locations — one
 * row per location, plus the bay-level model the twin draws. Internal
 * surfaces only; the platform never sends these to a portal.
 */
async function warehouseTwinMeasures({ companyId, userId, role }) {
  const result = await assessWarehouse({ companyId, userId, role });
  if (result.error) return { rows: [], summary: null, currency: null, twin: null };
  return {
    currency: result.currency,
    summary: result.summary,
    rows: result.locations.map((l) => ({
      id: l.id,
      code: l.code,
      name: l.name,
      city: l.city,
      bays: l.bays,
      stocked_bays: l.stocked_bays,
      short_bays: l.short_bays,
      low_bays: l.low_bays,
      fill_pct: l.fill_pct,
      units: l.units,
      orders_at_risk: l.orders_at_risk,
      value_at_risk: l.value_at_risk,
      in_transit: l.in_transit_in.length + l.in_transit_out.length,
      top_signal: l.top_signal,
      risk_band: l.short_bays ? 'HIGH' : l.low_bays ? 'MEDIUM' : 'NONE',
      signals: result.bays.filter((b) => b.location_id === l.id && b.signals.length).flatMap((b) => b.signals).slice(0, 6),
      proposals: result.bays.filter((b) => b.location_id === l.id).flatMap((b) => b.proposals.map((p) => p.label)).slice(0, 4),
    })),
    twin: {
      horizon_days: result.horizon_days,
      headline: result.headline,
      locations: result.locations,
      bays: result.bays,
      unplaced: result.unplaced,
    },
  };
}

module.exports = { assessWarehouse, warehouseTwinMeasures };
