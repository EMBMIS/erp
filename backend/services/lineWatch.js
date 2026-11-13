/**
 * One line slows down, and the system already knows what that will cost.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * The delivery trace (services/deliveryRisk.js) starts at a customer order and
 * walks back to the shop floor. This starts at the shop floor and walks
 * forward: a work centre is achieving less of its routing time than it used
 * to — what does that do to the work queued on it, what does it cost, and
 * which customer orders does it put behind their promise?
 *
 *   Pace         routing hours planned against hours actually taken, on
 *                operations finished in the last 14 days, and — so a slowdown
 *                shows the moment time is booked, not two weeks later —
 *                operations still in progress that have already run past their
 *                plan. Compared with the same measure over the 90 days before.
 *                A drop of 5% or more is a slowdown; a centre set to
 *                MAINTENANCE or INACTIVE with work still queued is a stop.
 *   Hours        the open routing hours on that centre, divided by the pace it
 *                is actually running at rather than the pace it used to run at.
 *                The difference is the time the slowdown will take.
 *   Cost         those hours at the centre's own hourly rate, plus the hours
 *                already lost in the last fortnight.
 *   Orders       the delivery trace, read for every order whose supply runs
 *                through a work order routed on this centre.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It changes nothing on the shop floor. Proposals — overtime, moving an
 * operation to a centre with free hours, telling a customer — come back as
 * proposals, and any action on them goes through the ordinary
 * draft-and-approve path. The only thing it writes is the finding (and the
 * managers' notification) that says the line has slowed.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const { traceDeliveryRisk } = require('./deliveryRisk');

const RECENT_DAYS = 14;
const BASELINE_DAYS = 90;
const SLOWDOWN_PCT = -5;
const OPEN_OP_STATUSES = ['PENDING', 'IN_PROGRESS'];
const COMMITTED_WO_STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS'];

const round = (v, p = 2) => Math.round(v * 10 ** p) / 10 ** p;
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/* ------------------------------------------------------------------ reads */

/**
 * Every centre's pace, recent against baseline, and the load still queued on
 * it. One row per centre that has either a measurable pace or is stopped.
 */
async function readCentres(companyId, workCenterId) {
  const { rows } = await pool.query(
    `WITH pace AS (
       SELECT woo.work_center_id,
              SUM(woo.planned_hours) FILTER (WHERE recent)::float AS recent_planned,
              SUM(woo.actual_hours)  FILTER (WHERE recent)::float AS recent_actual,
              SUM(woo.planned_hours) FILTER (WHERE NOT recent)::float AS base_planned,
              SUM(woo.actual_hours)  FILTER (WHERE NOT recent)::float AS base_actual,
              COUNT(*) FILTER (WHERE recent)::int AS recent_ops,
              COUNT(*) FILTER (WHERE NOT recent)::int AS base_ops,
              COUNT(*) FILTER (WHERE woo.status = 'IN_PROGRESS')::int AS live_overruns
         FROM (
           SELECT o.*,
                  (o.status = 'IN_PROGRESS' OR o.actual_end >= now() - make_interval(days => $3::int)) AS recent
             FROM work_order_operations o
             JOIN work_orders w ON w.id = o.work_order_id AND w.company_id = $1 AND w.deleted_at IS NULL
            WHERE o.planned_hours > 0 AND o.actual_hours > 0
              AND (
                (o.status = 'COMPLETED' AND o.actual_end >= now() - make_interval(days => $3::int + $4::int))
                -- Still running and already past its plan: the slowdown is
                -- visible now, whatever the operation's final figure will be.
                OR (o.status = 'IN_PROGRESS' AND o.actual_hours > o.planned_hours)
              )
         ) woo
        GROUP BY woo.work_center_id
     ),
     load AS (
       SELECT op.work_center_id,
              SUM(GREATEST(op.planned_hours - op.actual_hours, 0))::float AS open_hours,
              COUNT(DISTINCT op.work_order_id)::int AS open_work_orders,
              AVG(NULLIF(op.hourly_rate, 0))::float AS op_rate
         FROM work_order_operations op
         JOIN work_orders wo ON wo.id = op.work_order_id
        WHERE wo.company_id = $1 AND wo.deleted_at IS NULL
          AND wo.status = ANY($5) AND op.status = ANY($6)
        GROUP BY op.work_center_id
     )
     SELECT wc.id, wc.code, wc.name, wc.status,
            wc.daily_capacity_hours::float AS daily_capacity_hours,
            wc.efficiency_pct::float AS rated_efficiency,
            COALESCE(NULLIF(wc.hourly_rate, 0), l.op_rate, 0)::float AS hourly_rate,
            p.recent_planned, p.recent_actual, p.base_planned, p.base_actual,
            COALESCE(p.recent_ops, 0) AS recent_ops, COALESCE(p.base_ops, 0) AS base_ops,
            COALESCE(p.live_overruns, 0) AS live_overruns,
            COALESCE(l.open_hours, 0)::float AS open_hours,
            COALESCE(l.open_work_orders, 0) AS open_work_orders
       FROM work_centers wc
       LEFT JOIN pace p ON p.work_center_id = wc.id
       LEFT JOIN load l ON l.work_center_id = wc.id
      WHERE wc.company_id = $1 AND wc.deleted_at IS NULL
        AND ($2::uuid IS NULL OR wc.id = $2::uuid)
      ORDER BY wc.code`,
    [companyId, workCenterId || null, RECENT_DAYS, BASELINE_DAYS, COMMITTED_WO_STATUSES, OPEN_OP_STATUSES],
  );
  return rows;
}

/** The operations behind the signal: what overran, and what is still queued. */
async function readOperations(companyId, workCenterId) {
  const { rows } = await pool.query(
    `SELECT op.id, op.work_order_id, wo.wo_number, wo.status AS wo_status, wo.planned_end_date, wo.sales_order_id,
            i.name AS item_name, op.operation_number, op.description, op.status,
            op.planned_hours::float AS planned_hours, op.actual_hours::float AS actual_hours,
            op.scheduled_end, op.actual_end
       FROM work_order_operations op
       JOIN work_orders wo ON wo.id = op.work_order_id
       LEFT JOIN items i ON i.id = wo.item_id
      WHERE wo.company_id = $1 AND wo.deleted_at IS NULL AND op.work_center_id = $2
        AND (
          (wo.status = ANY($3) AND op.status = ANY($4))
          OR (op.status = 'COMPLETED' AND op.actual_end >= now() - make_interval(days => $5::int)
              AND op.actual_hours > op.planned_hours AND op.planned_hours > 0)
        )
      ORDER BY wo.planned_end_date NULLS LAST, wo.wo_number, op.operation_number`,
    [companyId, workCenterId, COMMITTED_WO_STATUSES, OPEN_OP_STATUSES, RECENT_DAYS],
  );
  return rows;
}

/** Centres that could take the work: running, with hours free over the next week. */
async function readAlternatives(companyId, excludeId) {
  const { rows } = await pool.query(
    `SELECT wc.id, wc.code, wc.name,
            (wc.daily_capacity_hours * wc.efficiency_pct / 100 * 5)::float AS week_hours,
            COALESCE(SUM(GREATEST(op.planned_hours - op.actual_hours, 0))
                     FILTER (WHERE wo.id IS NOT NULL), 0)::float AS queued_hours
       FROM work_centers wc
       LEFT JOIN work_order_operations op ON op.work_center_id = wc.id AND op.status = ANY($3)
       LEFT JOIN work_orders wo ON wo.id = op.work_order_id AND wo.status = ANY($4) AND wo.deleted_at IS NULL
      WHERE wc.company_id = $1 AND wc.deleted_at IS NULL AND wc.status = 'ACTIVE' AND wc.id <> $2
      GROUP BY wc.id`,
    [companyId, excludeId, OPEN_OP_STATUSES, COMMITTED_WO_STATUSES],
  );
  return rows
    .map((r) => ({ ...r, free_hours: round(Math.max(r.week_hours - r.queued_hours, 0), 1) }))
    .filter((r) => r.free_hours > 0)
    .sort((a, b) => b.free_hours - a.free_hours);
}

async function readCurrency(companyId) {
  const { rows } = await pool.query('SELECT base_currency FROM companies WHERE id = $1', [companyId]);
  return rows[0]?.base_currency || 'USD';
}

/* ------------------------------------------------------------ assessment */

function measure(c) {
  const recent = c.recent_actual ? c.recent_planned / c.recent_actual : null;
  const base = c.base_actual ? c.base_planned / c.base_actual : null;
  const change = recent != null && base ? ((recent - base) / base) * 100 : null;
  return { recent, base, change };
}

function money(v, cur) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(v || 0);
  } catch {
    return `${Math.round(v || 0)} ${cur}`;
  }
}

/**
 * @param {object} opts
 *   companyId, userId, role   who is asking (role decides which customer orders are shown)
 *   workCenter                one centre, by id or code
 *   includeSteady             also return centres running at or above their norm
 */
async function watchLines(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  let workCenterId = null;
  if (opts.workCenter) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(String(opts.workCenter));
    const { rows } = await pool.query(
      `SELECT id FROM work_centers WHERE company_id = $1 AND deleted_at IS NULL
          AND ${isUuid ? 'id = $2::uuid' : '(code ILIKE $2 OR name ILIKE $2)'} LIMIT 1`,
      [companyId, String(opts.workCenter).trim()],
    );
    if (!rows.length) return { error: `No work centre ${opts.workCenter} in this company.` };
    workCenterId = rows[0].id;
  }

  const [centres, currency] = await Promise.all([readCentres(companyId, workCenterId), readCurrency(companyId)]);

  const flagged = [];
  const steady = [];
  for (const c of centres) {
    const m = measure(c);
    const stopped = c.status !== 'ACTIVE' && c.open_hours > 0;
    const slowed = m.change != null && m.change <= SLOWDOWN_PCT;
    const row = {
      work_center_id: c.id,
      code: c.code,
      name: c.name,
      status: c.status,
      recent_performance: m.recent == null ? null : round(m.recent * 100, 1),
      baseline_performance: m.base == null ? null : round(m.base * 100, 1),
      change_pct: m.change == null ? null : round(m.change, 1),
      open_hours: round(c.open_hours, 1),
      open_work_orders: c.open_work_orders,
      hourly_rate: round(c.hourly_rate),
    };
    if (stopped || slowed) flagged.push({ c, m, row, signal: stopped ? 'stopped' : 'slowdown' });
    else steady.push({ ...row, signal: m.change == null ? 'no_history' : 'steady' });
  }

  // The delivery trace is the expensive part: read it once, only if a line is
  // actually flagged, and let each line pick out the orders it touches.
  let trace = null;
  if (flagged.length) {
    trace = await traceDeliveryRisk({
      companyId, userId: opts.userId, role: opts.role, horizonDays: 45, includeCovered: true,
    });
  }

  const lines = [];
  for (const { c, m, row, signal } of flagged) {
    const ops = await readOperations(companyId, c.id);
    const queued = ops.filter((o) => OPEN_OP_STATUSES.includes(o.status));
    const overran = ops.filter((o) => o.actual_hours > o.planned_hours && o.planned_hours > 0);
    const daily = c.daily_capacity_hours || 8;

    // Hours: what the queued work takes at today's pace, against its old pace.
    let extraHours = 0;
    if (signal === 'slowdown' && m.recent > 0 && m.base > 0) {
      extraHours = Math.max(c.open_hours / m.recent - c.open_hours / m.base, 0);
    }
    const lostHours = signal === 'slowdown' && m.base > 0
      ? Math.max((c.recent_actual || 0) - (c.recent_planned || 0) / m.base, 0)
      : 0;
    const slipDays = signal === 'stopped' ? null : extraHours > 0 ? Math.ceil(extraHours / daily) : 0;
    const extraCost = extraHours * c.hourly_rate;
    const lostCost = lostHours * c.hourly_rate;

    // Orders whose supply runs through a work order on this centre.
    const woIds = new Set(queued.map((o) => o.work_order_id));
    const orders = (trace?.orders || []).filter((o) => o.lines.some((l) => l.depends_on.some((d) => d.type === 'work_order' && woIds.has(d.id)))
      || o.chain.some((s) => s.record?.type === 'work_center' && s.record.id === c.id));
    const atRisk = orders.filter((o) => ['late', 'at_risk', 'uncovered'].includes(o.verdict));
    const valueAtRisk = atRisk.reduce((s, o) => s + (o.value_at_risk || 0), 0);

    const workOrders = [...new Map(queued.map((o) => [o.work_order_id, o])).values()].map((o) => ({
      id: o.work_order_id,
      wo_number: o.wo_number,
      item: o.item_name,
      status: o.wo_status,
      planned_end: iso(o.planned_end_date),
      open_hours: round(queued.filter((q) => q.work_order_id === o.work_order_id)
        .reduce((s, q) => s + Math.max(q.planned_hours - q.actual_hours, 0), 0), 1),
    }));

    // The chain, in the order the website draws it: line → production → cost → orders.
    const where = c.code || c.name;
    const chain = [];
    if (signal === 'stopped') {
      chain.push({ layer: 'operations', text: `${where} is ${c.status.toLowerCase()} with ${row.open_hours} h of routing still queued on it`, record: { type: 'work_center', id: c.id, number: where } });
    } else {
      chain.push({
        layer: 'operations',
        text: `${where} efficiency ${row.change_pct}%: achieving ${row.recent_performance}% of routing time over the last ${RECENT_DAYS} days against ${row.baseline_performance}% over the ${BASELINE_DAYS} before`
          + (c.live_overruns ? ` — ${c.live_overruns} operation${c.live_overruns === 1 ? '' : 's'} running past plan right now` : ''),
        record: { type: 'work_center', id: c.id, number: where },
      });
      const worst = overran.sort((a, b) => (b.actual_hours - b.planned_hours) - (a.actual_hours - a.planned_hours))[0];
      if (worst) {
        chain.push({
          layer: 'operations',
          text: `Largest overrun: ${worst.wo_number} operation ${worst.operation_number}${worst.description ? ` (${worst.description})` : ''} took ${round(worst.actual_hours, 1)} h against ${round(worst.planned_hours, 1)} h planned`
            + (worst.status === 'IN_PROGRESS' ? ' and is still running' : ''),
          record: { type: 'work_order', id: worst.work_order_id, number: worst.wo_number },
        });
      }
    }
    if (workOrders.length) {
      chain.push({
        layer: 'production',
        text: signal === 'stopped'
          ? `${workOrders.length} work order${workOrders.length === 1 ? '' : 's'} cannot move past this step until it runs again`
          : `${workOrders.length} work order${workOrders.length === 1 ? '' : 's'} queued here need ${round(extraHours, 1)} h more than planned — about ${slipDays} working day${slipDays === 1 ? '' : 's'} of slip`,
        record: { type: 'work_order', id: workOrders[0].id, number: workOrders[0].wo_number },
      });
    }
    if (c.hourly_rate > 0 && (extraCost > 0 || lostCost > 0)) {
      chain.push({
        layer: 'finance',
        text: `${money(extraCost, currency)} of extra line time on the queued work at ${money(c.hourly_rate, currency)}/h`
          + (lostCost > 0 ? `, on top of ${money(lostCost, currency)} already lost in the last ${RECENT_DAYS} days` : ''),
        record: null,
      });
    }
    for (const o of atRisk.slice(0, 5)) {
      chain.push({
        layer: 'decisions',
        text: o.projected_date && o.days_late
          ? `${o.so_number} for ${o.customer_name} (due ${o.due_date}) now ships around ${o.projected_date}, ${o.days_late} day${o.days_late === 1 ? '' : 's'} late — ${money(o.value_at_risk, o.currency || currency)} at risk`
          : o.verdict === 'at_risk'
            ? `${o.so_number} for ${o.customer_name} (due ${o.due_date}) still makes it only if this line holds — ${money(o.value_at_risk, o.currency || currency)} exposed`
            : `${o.so_number} for ${o.customer_name} (due ${o.due_date}) cannot be covered from stock or supply — ${money(o.value_at_risk, o.currency || currency)} at risk`,
        record: { type: 'sales_order', id: o.sales_order_id, number: o.so_number },
      });
    }

    // Proposals: suggestions for a person. Nothing here is executed.
    const proposals = [];
    if (signal === 'slowdown' && extraHours >= 1) {
      proposals.push({
        kind: 'add_capacity',
        label: `Add ${Math.ceil(extraHours)} h of shift time on ${where} to hold the plan`
          + (c.hourly_rate > 0 ? ` (about ${money(Math.ceil(extraHours) * c.hourly_rate, currency)})` : ''),
        record: { type: 'work_center', id: c.id, number: where },
      });
    }
    if (queued.length) {
      const alts = await readAlternatives(companyId, c.id);
      const alt = alts[0];
      // Only an operation that has not started can change centre.
      const next = queued.find((o) => o.status === 'PENDING' && !(o.actual_hours > 0));
      if (alt && next) {
        proposals.push({
          kind: 'move_operation',
          operation_id: next.id,
          to_work_center_id: alt.id,
          to_code: alt.code,
          label: `Move ${next.wo_number} operation ${next.operation_number} to ${alt.code} (${alt.free_hours} h free this week)`,
          record: { type: 'work_order', id: next.work_order_id, number: next.wo_number },
        });
      }
    }
    proposals.push({
      kind: 'inspect_line',
      label: signal === 'stopped'
        ? `Get a return-to-service date for ${where} from maintenance`
        : `Have maintenance look at ${where} — the overruns started on ${iso(overran.map((o) => o.actual_end).filter(Boolean).sort()[0]) || 'recent operations'}`,
      record: { type: 'work_center', id: c.id, number: where },
    });
    for (const o of atRisk.filter((x) => x.verdict === 'late' || x.verdict === 'uncovered').slice(0, 3)) {
      proposals.push({
        kind: 'tell_customer',
        label: o.projected_date
          ? `Tell ${o.customer_name} ${o.so_number} will arrive around ${o.projected_date}`
          : `Tell ${o.customer_name} ${o.so_number} is at risk before ${o.due_date}`,
        record: { type: 'sales_order', id: o.sales_order_id, number: o.so_number },
      });
    }

    lines.push({
      ...row,
      signal,
      severity: atRisk.length || signal === 'stopped' ? 'HIGH' : 'MEDIUM',
      live_overruns: c.live_overruns,
      extra_hours: round(extraHours, 1),
      slip_days: slipDays,
      extra_cost: round(extraCost),
      lost_hours: round(lostHours, 1),
      lost_cost: round(lostCost),
      currency,
      work_orders: workOrders,
      orders_depending: orders.length,
      orders_at_risk: atRisk.map((o) => ({
        sales_order_id: o.sales_order_id, so_number: o.so_number, customer_name: o.customer_name,
        due_date: o.due_date, projected_date: o.projected_date, days_late: o.days_late,
        verdict: o.verdict, value_at_risk: o.value_at_risk,
      })),
      value_at_risk: round(valueAtRisk),
      headline: signal === 'stopped'
        ? `${where} is ${c.status.toLowerCase()} with ${row.open_hours} h queued`
        : `${where} efficiency ${row.change_pct}%`
          + (c.hourly_rate > 0 && extraCost + lostCost > 0 ? ` — ${money(extraCost + lostCost, currency)} in line time` : '')
          + (atRisk.length ? `, ${atRisk.length} order${atRisk.length === 1 ? '' : 's'} (${money(valueAtRisk, currency)}) at risk` : ''),
      chain,
      proposals,
    });
  }

  lines.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'HIGH' ? -1 : 1)
    || b.value_at_risk - a.value_at_risk || (a.change_pct ?? 0) - (b.change_pct ?? 0));

  return {
    as_of: new Date().toISOString(),
    window: { recent_days: RECENT_DAYS, baseline_days: BASELINE_DAYS, slowdown_threshold_pct: SLOWDOWN_PCT },
    currency,
    scope: trace?.scope || null,
    summary: {
      centres_watched: centres.length,
      slowed: lines.filter((l) => l.signal === 'slowdown').length,
      stopped: lines.filter((l) => l.signal === 'stopped').length,
      extra_cost: round(lines.reduce((s, l) => s + l.extra_cost + l.lost_cost, 0)),
      value_at_risk: round(lines.reduce((s, l) => s + l.value_at_risk, 0)),
    },
    lines,
    steady: opts.includeSteady ? steady : undefined,
    method:
      `Pace is routing hours planned over hours taken, on operations finished in the last ${RECENT_DAYS} days plus `
      + `operations still running past their plan, against the ${BASELINE_DAYS} days before. Extra hours are the open `
      + 'routing on the centre at today\'s pace minus the same work at its old pace, priced at the centre\'s hourly rate. '
      + 'Orders at risk come from the delivery trace. Nothing was changed.',
  };
}

/* --------------------------------------------------------------- finding */

/**
 * Raise (or refresh) the finding for every flagged line, and tell this
 * company's managers about the ones that put orders at risk. Run by the
 * scheduler, by the findings scan, and straight after time is booked or an
 * operation completes — the moment the shop floor says so.
 *
 * Findings are deduplicated per centre while open; a dismissal suppresses
 * re-raising for its window (both handled by upsertFinding).
 */
async function raiseLineFindings(companyId, { workCenter } = {}) {
  const { upsertFinding } = require('./ai/findingsScan');
  const resolved = await resolveCompany(companyId);
  const result = await watchLines({ companyId: resolved, workCenter });
  if (result.error) return { created: [] };

  const created = [];
  for (const l of result.lines) {
    const r = await upsertFinding({
      companyId: resolved,
      finding_type: 'LINE_SLOWDOWN',
      severity: l.severity,
      entity_type: 'WORK_CENTER',
      entity_id: l.work_center_id,
      title: l.headline.slice(0, 255),
      description: l.chain.map((s) => s.text).join(' → '),
      data: {
        code: l.code, change_pct: l.change_pct, extra_hours: l.extra_hours, extra_cost: l.extra_cost,
        lost_cost: l.lost_cost, currency: l.currency, value_at_risk: l.value_at_risk,
        orders_at_risk: l.orders_at_risk.map((o) => o.so_number), proposals: l.proposals.map((p) => p.label),
      },
    });
    if (r.created) {
      created.push(r.id);
      if (l.severity === 'HIGH') await notifyManagers(resolved, l, r.id).catch((e) => console.warn('Line watch notify failed:', e.message));
    }
  }
  return { created, lines: result.lines.length };
}

/** Managers and admins of THIS company only — never another tenant's. */
async function notifyManagers(companyId, line, findingId) {
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
       LEFT JOIN user_companies uc ON uc.user_id = u.id AND uc.company_id = $1
      WHERE COALESCE(uc.role, u.role) IN ('MANAGER', 'ADMIN')
        AND (uc.user_id IS NOT NULL
             OR (NOT EXISTS (SELECT 1 FROM user_companies x WHERE x.user_id = u.id)
                 AND EXISTS (SELECT 1 FROM companies c WHERE c.id = $1 AND c.is_default)))`,
    [companyId],
  );
  for (const u of rows) {
    await pool.query(
      `INSERT INTO notifications (id, type, title, message, data, user_id, company_id, created_at)
       VALUES (gen_random_uuid(), 'AI_FINDING', $1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [
        `Line slowdown: ${line.headline}`.slice(0, 255),
        line.chain.map((s) => s.text).join(' → '),
        JSON.stringify({ finding_id: findingId, work_center_id: line.work_center_id, link: '/manufacturing/work-centers' }),
        u.id,
        companyId,
      ],
    );
  }
}

/**
 * Fire-and-forget check of one centre after the shop floor books time on it.
 * Never throws into the request that triggered it.
 */
function checkAfterBooking(companyId, operationId) {
  setImmediate(async () => {
    try {
      const run = async () => {
        const { rows } = await pool.query('SELECT work_center_id FROM work_order_operations WHERE id = $1', [operationId]);
        if (rows[0]) await raiseLineFindings(companyId, { workCenter: rows[0].work_center_id });
      };
      if (companyId) await companyContext.runWithCompany(companyId, run);
      else await run();
      // A booking can be the moment a line slows: everyone's watch looks again shortly, as themselves.
      require('./simeliWatch').watchSoon(companyId || (await companyContext.getDefaultCompanyId()));
    } catch (e) {
      console.warn('Line watch after booking failed:', e.message);
    }
  });
}

module.exports = { watchLines, raiseLineFindings, checkAfterBooking };
