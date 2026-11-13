/**
 * "Simeli understands your people." — who the business is waiting on, and
 * what happens when they are not there.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * An employee register says who works here. A leave calendar says who is off.
 * Neither says what the business loses on the day they are off. The answer is
 * in the joins nobody makes: a purchase order waits on a manager, a customer
 * order due Friday waits on that purchase order, and the only two managers who
 * can approve it are both on leave from Thursday.
 *
 * So, over the next working days, for every person in the company who decides
 * or owns something:
 *
 *   decides      the pending decisions they may make (services/decisionsHeldOpen.js:
 *                the approval-chain step that names them or the role the approve
 *                endpoint requires, never the person who raised it), what each is
 *                worth and the customer orders it holds up
 *   away         approved and requested leave from the HR module, and employees
 *                marked on leave, through the employee record linked to the user
 *   covered by   an active delegation (approval_delegations), which the approval
 *                engine applies when it routes a named approver
 *   owns         open customer orders they raised that fall due while they are
 *                away, and purchase orders they raised due to land then
 *
 * and for every pending decision, whether someone who may make it is actually
 * in before the date it is needed: covered, only one person can (single), the
 * last day anyone who can is in comes before it is needed (decide_by), or nobody
 * who can is in at all until after (gap). A requested leave is measured both
 * ways, so the manager deciding it sees what approving it does to the business
 * before they click. A what-if absence ("what if Anna is off next week") is
 * measured the same way without anything being recorded.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It decides nothing and moves no authority. The proposals — ask the people who
 * can decide it to decide before the window closes, hand an absent person's
 * orders over, record a delegation for a named approver who is away — are
 * carried out by actOnCoverage only when a manager or admin confirms one, and
 * only after it is re-measured. Approving stays on each document's own screen;
 * leave is approved on the Leave screen.
 *
 * VISIBILITY
 * ---------------------------------------------------------------------------
 * Every query is filtered by company_id on top of RLS. Decisions come from
 * decisionsHeldOpen as the person asking. Managers, finance managers and admins
 * see everyone; anyone else sees themselves and the decisions they may see. The
 * kind of leave and its reason are never returned — that someone is away is
 * operational, why is theirs.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const moduleService = require('./moduleService');
const { decisionsHeldOpen } = require('./decisionsHeldOpen');

const SEES_ALL = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER']);
/** Who may confirm a proposal: the same roles that approve the documents. */
const ACTORS = new Set(['ADMIN', 'MANAGER']);
/** The roles each document's approve endpoint accepts when no chain step names anyone. */
const DECIDERS = ['MANAGER', 'ADMIN'];
const OPEN_ORDER_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'SENT_TO_CUSTOMER', 'CONFIRMED', 'CUSTOMER_ACCEPTED', 'IN_PRODUCTION'];
const OPEN_PO_STATUSES = ['APPROVED', 'SENT_TO_SUPPLIER', 'CONFIRMED', 'PREPARING_DELIVERY', 'IN_TRANSIT'];
const DEFAULT_HORIZON = 14;

const DAY = 86400000;
const iso = (d) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);
const round = (v, p = 2) => Math.round((Number(v) || 0) * 10 ** p) / 10 ** p;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDay = (s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
};
const fmtMoney = (v, cur) => `${cur ? `${cur} ` : ''}${Math.round(Number(v) || 0).toLocaleString('en-US')}`;
const names = (list) => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
const span = (a) => (a.from === a.to ? fmtDay(a.from) : `${fmtDay(a.from)} – ${a.to ? fmtDay(a.to) : 'further notice'}`);

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/** Working days (Mon–Fri) from today through `days` calendar days ahead. */
function workdays(today, days) {
  const out = [];
  for (let i = 0; i <= days; i++) {
    const d = new Date(today.getTime() + i * DAY);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(iso(d));
  }
  return out.length ? out : [iso(today)];
}

/* ------------------------------------------------------------------ reads */

/** Everyone with a login in this company, their role here and their employee record if one is linked. */
async function readPeople(companyId) {
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, u.email,
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), u.email) AS name,
            COALESCE(uc.role, u.role) AS role,
            e.id AS employee_id, e.department, e.position, e.status AS employee_status
       FROM users u
       LEFT JOIN user_companies uc ON uc.user_id = u.id AND uc.company_id = $1
       LEFT JOIN LATERAL (
         SELECT e.id, e.department, e.position, e.status FROM employees e
          WHERE e.user_id = u.id AND e.company_id = $1 AND e.deleted_at IS NULL
          ORDER BY e.created_at DESC LIMIT 1
       ) e ON true
      WHERE u.deleted_at IS NULL AND COALESCE(u.is_active, true)
        AND (uc.user_id IS NOT NULL
             OR (NOT EXISTS (SELECT 1 FROM user_companies x WHERE x.user_id = u.id)
                 AND EXISTS (SELECT 1 FROM companies c WHERE c.id = $1 AND c.is_default)))`,
    [companyId],
  );
  return rows;
}

/** Approved and requested leave overlapping the window, for employees who have a login. */
async function readAbsences(companyId, from, to) {
  const { rows } = await pool.query(
    `SELECT lr.id, e.user_id, lr.start_date, lr.end_date, lr.status, lr.total_days::float AS days
       FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id AND e.company_id = $1 AND e.deleted_at IS NULL
      WHERE lr.company_id = $1 AND lr.deleted_at IS NULL AND e.user_id IS NOT NULL
        AND lr.status IN ('APPROVED', 'PENDING')
        AND lr.start_date <= $3::date AND lr.end_date >= $2::date
      ORDER BY lr.start_date`,
    [companyId, from, to],
  );
  return rows.map((r) => ({ id: r.id, user_id: r.user_id, from: iso(r.start_date), to: iso(r.end_date), status: r.status, days: r.days }));
}

async function readDelegations(companyId, from, to) {
  const { rows } = await pool.query(
    `SELECT d.id, d.delegator_id, d.delegate_id, d.start_date, d.end_date
       FROM approval_delegations d
      WHERE d.company_id = $1 AND d.status = 'ACTIVE'
        AND d.start_date::date <= $3::date AND (d.end_date IS NULL OR d.end_date::date >= $2::date)`,
    [companyId, from, to],
  );
  return rows.map((r) => ({ ...r, from: iso(r.start_date), to: r.end_date ? iso(r.end_date) : null }));
}

/** Open customer orders and incoming purchase orders due in the window, by the person who raised them. */
async function readOwned(companyId, modules, from, to) {
  const reads = [];
  if (modules.has('sales')) {
    reads.push(pool.query(
      `SELECT 'sales_order' AS type, so.id, so.so_number AS number, so.customer_name AS party, so.delivery_date AS due,
              so.total_amount::float AS value, so.currency, so.created_by
         FROM sales_orders so
        WHERE so.company_id = $1 AND so.deleted_at IS NULL AND so.status = ANY($2)
          AND so.delivery_date BETWEEN $3::date AND $4::date AND so.created_by IS NOT NULL`,
      [companyId, OPEN_ORDER_STATUSES, from, to],
    ));
  }
  if (modules.has('procurement')) {
    reads.push(pool.query(
      `SELECT 'purchase_order' AS type, po.id, po.po_number AS number, COALESCE(s.trade_name, s.legal_name) AS party,
              po.delivery_date AS due, po.total_amount::float AS value, po.currency, po.created_by
         FROM purchase_orders po
         LEFT JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.company_id = $1 AND po.status = ANY($2)
          AND po.delivery_date BETWEEN $3::date AND $4::date AND po.created_by IS NOT NULL`,
      [companyId, OPEN_PO_STATUSES, from, to],
    ));
  }
  const results = await Promise.all(reads);
  return results.flatMap((r) => r.rows).map((r) => ({ ...r, due: iso(r.due), value: round(r.value) }));
}

/* ---------------------------------------------------------------- measure */

/** Who may make this decision: the named approver, else everyone holding the role, never the person who raised it. */
function eligibleFor(d, people) {
  if (d.approver_user_id) return people.filter((p) => p.user_id === d.approver_user_id);
  const roles = d.approver_role ? new Set([d.approver_role, 'ADMIN']) : new Set(DECIDERS);
  return people.filter((p) => roles.has(p.role) && p.user_id !== d.raised_by);
}

/** The date the decision is needed by: the first customer order it holds that falls due. */
function neededBy(d) {
  return d.holding_up.reduce((m, h) => (h.due_date && (!m || h.due_date < m) ? h.due_date : m), null);
}

/**
 * Is someone who may decide `d` in on a working day before it is needed?
 * `awayOn(userId, day)` answers for one person on one day under the absences
 * being counted; a delegation from a named approver puts the delegate in their
 * place on the days it covers.
 */
function coverage(d, eligible, days, awayOn, delegateOn) {
  const needed = neededBy(d);
  let window = needed ? days.filter((x) => x <= needed) : days;
  if (!window.length) window = [days[0]];
  let delegated = false;
  const present = window.map((day) => {
    const who = [];
    for (const p of eligible) {
      if (!awayOn(p.user_id, day)) who.push(p);
      else {
        const sub = d.approver_user_id ? delegateOn(p.user_id, day) : null;
        if (sub && !awayOn(sub.user_id, day)) { who.push(sub); delegated = true; }
      }
    }
    return { day, who };
  });
  const covered = present.filter((x) => x.who.length);
  const absent = (day) => eligible.filter((p) => awayOn(p.user_id, day));
  if (!eligible.length) return { state: 'nobody', needed_by: needed };
  if (!covered.length) return { state: 'gap', needed_by: needed, uncovered_from: window[0], absent: absent(window[0]) };
  const last = covered[covered.length - 1];
  if (needed && last.day < window[window.length - 1]) {
    const next = window[window.indexOf(last.day) + 1];
    return { state: 'decide_by', needed_by: needed, decide_by: last.day, who: last.who, uncovered_from: next, absent: absent(next) };
  }
  if (eligible.length === 1 && !delegated) return { state: 'single', needed_by: needed, who: eligible };
  return { state: 'covered', needed_by: needed };
}

const SEVERITY = { gap: 4, nobody: 3, decide_by: 2, single: 1, covered: 0 };

function holdsText(d) {
  const h = d.holding_up[0];
  if (!h) return '';
  const more = d.holding_up.length > 1 ? ` and ${d.holding_up.length - 1} more` : '';
  return `${h.so_number} for ${h.customer_name} (${fmtMoney(h.value, h.currency)}, due ${fmtDay(h.due_date)})${more}`;
}

function reasonFor(d, c, absenceOf, dayText = fmtDay) {
  const holds = holdsText(d);
  const head = `${d.number}${d.party ? ` (${d.party})` : ''}`;
  const away = (list) => names(list.map((p) => {
    const a = absenceOf(p.user_id, c.uncovered_from);
    return a ? `${p.name} (away ${span(a)})` : p.name;
  }));
  switch (c.state) {
    case 'gap':
      return `Nobody who can approve ${head} is in before ${c.needed_by ? fmtDay(c.needed_by) : 'the end of the window'}: ${away(c.absent)}.${holds ? ` It holds ${holds}.` : ''}`;
    case 'decide_by':
      return `${head} has to be decided by ${dayText(c.decide_by)}. From ${fmtDay(c.uncovered_from)} nobody who can approve it is in — ${away(c.absent)} — and it holds ${holds}.`;
    case 'nobody':
      return `Only the person who raised ${head} holds the role that approves it, and they may not approve their own document.${holds ? ` It holds ${holds}.` : ''}`;
    case 'single':
      return `Only ${c.who[0].name} can approve ${head}.${holds ? ` It holds ${holds}.` : ''}`;
    default:
      return null;
  }
}

/**
 * @param {object} opts
 *   companyId, userId, role   who is asking
 *   horizonDays               how far ahead (default 14, max 60)
 *   person                    narrow to one person, by part of their name or email
 *   whatIf                    { person, from, to } — measure an absence that is not on record
 */
async function peopleCoverage(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  const userId = opts.userId || null;
  const role = opts.role || null;
  const seesAll = !userId || SEES_ALL.has(role);
  const horizon = Math.min(Math.max(parseInt(opts.horizonDays, 10) || DEFAULT_HORIZON, 1), 60);
  const today = new Date(`${iso(new Date())}T00:00:00Z`);
  const end = iso(new Date(today.getTime() + horizon * DAY));
  const days = workdays(today, horizon);
  const dayText = (s) => (s === iso(today) ? `today (${fmtDay(s)})` : fmtDay(s));

  const modules = await moduleService.getEnabledModuleKeys(companyId);
  const hrOn = modules.has('hr');
  const [people, absences, delegations, owned, held, { rows: [co] }] = await Promise.all([
    readPeople(companyId),
    hrOn ? readAbsences(companyId, iso(today), end) : [],
    readDelegations(companyId, iso(today), end),
    readOwned(companyId, modules, iso(today), end),
    decisionsHeldOpen({ companyId, userId, role, limit: 100 }),
    pool.query('SELECT base_currency FROM companies WHERE id = $1', [companyId]),
  ]);
  const byId = new Map(people.map((p) => [p.user_id, p]));
  const currency = co?.base_currency || held.summary?.currency || null;

  // Marked on leave in the employee record with no dates on file: away until further notice.
  for (const p of people) {
    if (p.employee_status === 'ON_LEAVE' && !absences.some((a) => a.user_id === p.user_id && a.status === 'APPROVED' && a.from <= iso(today))) {
      absences.push({ id: null, user_id: p.user_id, from: iso(today), to: null, status: 'ON_LEAVE', days: null });
    }
  }

  // A what-if absence: measured like a requested leave, recorded nowhere.
  let whatIf = null;
  if (opts.whatIf?.person) {
    const q = String(opts.whatIf.person).trim().toLowerCase();
    const who = people.find((p) => p.name.toLowerCase().includes(q) || String(p.email).toLowerCase().includes(q));
    if (!who) return { error: `Nobody called "${opts.whatIf.person}" has a login in this company.` };
    if (!seesAll && who.user_id !== userId) return { error: 'You can measure an absence for yourself; a manager can measure one for anyone.' };
    const from = iso(opts.whatIf.from) || iso(today);
    const to = iso(opts.whatIf.to) || from;
    if (to < from) return { error: 'The last day of the absence is before the first.' };
    whatIf = { id: 'what-if', user_id: who.user_id, from, to, status: 'WHAT_IF', days: null };
  }

  const covers = (a, day) => a.from <= day && (!a.to || a.to >= day);
  const absenceOn = (statuses) => (uid, day) => absences.find((a) => a.user_id === uid && statuses.has(a.status) && covers(a, day))
    || (statuses.has('WHAT_IF') && whatIf && whatIf.user_id === uid && covers(whatIf, day) ? whatIf : null);
  const ON_RECORD = new Set(['APPROVED', 'ON_LEAVE']);
  const awayRecorded = absenceOn(ON_RECORD);
  const delegateOn = (uid, day) => {
    const del = delegations.find((x) => x.delegator_id === uid && covers(x, day));
    return del ? byId.get(del.delegate_id) || null : null;
  };

  // Every pending decision, measured against the absences on record.
  const measured = held.decisions.map((d) => {
    const eligible = eligibleFor(d, people);
    const c = coverage(d, eligible, days, (uid, day) => !!awayRecorded(uid, day), delegateOn);
    return { d, eligible, c };
  });

  /* What a requested (or imagined) absence would do, measured against the record without it. */
  const candidates = [...(seesAll ? absences.filter((a) => a.status === 'PENDING') : []), ...(whatIf ? [whatIf] : [])];
  const leaveImpact = [];
  for (const a of candidates) {
    const p = byId.get(a.user_id);
    if (!p) continue;
    const withIt = (uid, day) => !!awayRecorded(uid, day) || (uid === a.user_id && covers(a, day));
    const worse = [];
    for (const m of measured) {
      const covering = delegations.some((x) => x.delegate_id === a.user_id && m.eligible.some((e) => e.user_id === x.delegator_id));
    if (!covering && !m.eligible.some((e) => e.user_id === a.user_id)) continue;
      const after = coverage(m.d, m.eligible, days, withIt, delegateOn);
      const sharper = SEVERITY[after.state] > SEVERITY[m.c.state]
        || (after.state === 'decide_by' && m.c.state === 'decide_by' && after.decide_by < m.c.decide_by);
      if (sharper && SEVERITY[after.state] >= 2) worse.push({ m, after });
    }
    const theirs = owned.filter((o) => o.created_by === a.user_id && covers(a, o.due));
    if (!worse.length && !theirs.length) continue;
    const parts = [];
    if (worse.length) {
      const first = worse[0];
      parts.push(first.after.state === 'decide_by'
        ? `${first.m.d.number} would have to be decided by ${dayText(first.after.decide_by)}, because from ${fmtDay(first.after.uncovered_from)} nobody else who can approve it is in; it holds ${holdsText(first.m.d) || 'no customer order'}`
        : `nobody who can approve ${first.m.d.number} would be in before ${first.after.needed_by ? fmtDay(first.after.needed_by) : 'the end of the window'}${holdsText(first.m.d) ? `; it holds ${holdsText(first.m.d)}` : ''}`);
      if (worse.length > 1) parts.push(`${worse.length - 1} more decision${worse.length === 2 ? '' : 's'} would lose ${worse.length === 2 ? 'its' : 'their'} last approver`);
    }
    if (theirs.length) {
      const value = theirs.reduce((s, o) => s + (o.value || 0), 0);
      parts.push(`${theirs.length} order${theirs.length === 1 ? '' : 's'} ${p.name} raised fall${theirs.length === 1 ? 's' : ''} due while they are away (${theirs.map((o) => o.number).slice(0, 3).join(', ')}${theirs.length > 3 ? '…' : ''}, ${fmtMoney(value, currency)})`);
    }
    leaveImpact.push({
      leave_request_id: a.status === 'WHAT_IF' ? null : a.id,
      what_if: a.status === 'WHAT_IF',
      user_id: a.user_id,
      person: p.name,
      from: a.from,
      to: a.to,
      reason: `${a.status === 'WHAT_IF' ? `If ${p.name} is away` : `Approving ${p.name}'s leave`} ${span(a)}: ${parts.join('; ')}.`,
      decisions: worse.map(({ m, after }) => ({
        id: m.d.id, number: m.d.number, kind: m.d.kind, value: m.d.value, currency: m.d.currency,
        state: after.state, decide_by: after.decide_by || null, needed_by: after.needed_by,
        holding_up: m.d.holding_up.map((h) => ({ so_number: h.so_number, customer_name: h.customer_name, due_date: h.due_date, value: h.value })),
        decide_at: m.d.decide_at,
      })),
      orders: theirs.map((o) => ({ type: o.type, id: o.id, number: o.number, party: o.party, due: o.due, value: o.value, currency: o.currency })),
      held_value: round(worse.reduce((s, w) => s + w.m.d.held_value, 0)),
    });
  }

  /* Decisions at risk on the record as it stands. */
  const absenceOf = (uid, day) => (day ? awayRecorded(uid, day) : null);
  const atRisk = measured
    .filter((m) => m.c.state !== 'covered' && (m.c.state !== 'single' || m.d.held_value > 0))
    .map(({ d, eligible, c }) => ({
      id: d.id,
      kind: d.kind,
      kind_label: d.kind_label,
      number: d.number,
      party: d.party,
      value: d.value,
      currency: d.currency,
      state: c.state,
      needed_by: c.needed_by,
      decide_by: c.decide_by || null,
      can_decide: eligible.map((p) => p.name),
      in_before_it_is_needed: (c.who || []).map((p) => p.name),
      away: (c.absent || []).map((p) => {
        const a = absenceOf(p.user_id, c.uncovered_from);
        return { name: p.name, from: a?.from || null, to: a?.to || null };
      }),
      holding_up: d.holding_up,
      held_value: d.held_value,
      yours_to_decide: d.yours_to_decide,
      decide_at: d.decide_at,
      reason: reasonFor(d, c, absenceOf, dayText),
      _eligible: eligible,
      _c: c,
    }))
    .sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state] || b.held_value - a.held_value || String(a.needed_by).localeCompare(String(b.needed_by)));

  /* People: what each one decides, holds and owns, and when they are away. */
  const q = opts.person ? String(opts.person).trim().toLowerCase() : null;
  const peopleOut = [];
  for (const p of people) {
    if (!seesAll && p.user_id !== userId) continue;
    if (q && !p.name.toLowerCase().includes(q) && !String(p.email).toLowerCase().includes(q)) continue;
    const mine = measured.filter((m) => m.eligible.some((e) => e.user_id === p.user_id));
    const onlyThem = mine.filter((m) => m.eligible.length === 1);
    const away = [...absences.filter((a) => a.user_id === p.user_id), ...(whatIf && whatIf.user_id === p.user_id ? [whatIf] : [])]
      .map((a) => ({ from: a.from, to: a.to, status: a.status, leave_request_id: a.status === 'WHAT_IF' ? null : a.id }));
    const ownsWhileAway = owned.filter((o) => o.created_by === p.user_id && away.some((a) => a.from <= o.due && (!a.to || a.to >= o.due)));
    const del = delegations.filter((x) => x.delegator_id === p.user_id).map((x) => ({ to: byId.get(x.delegate_id)?.name || null, from_date: x.from, to_date: x.to }));
    if (!mine.length && !away.length && !ownsWhileAway.length && !q && p.user_id !== userId) continue;
    peopleOut.push({
      user_id: p.user_id,
      name: p.name,
      role: p.role,
      department: p.department || null,
      position: p.position || null,
      in_today: !awayRecorded(p.user_id, days[0]),
      away,
      delegated_to: del,
      decides: {
        count: mine.length,
        value: round(mine.reduce((s, m) => s + (m.d.value || 0), 0)),
        holding_value: round(mine.reduce((s, m) => s + (m.d.held_value || 0), 0)),
        only_them: onlyThem.map((m) => m.d.number),
      },
      owns_while_away: ownsWhileAway.map((o) => ({ type: o.type, id: o.id, number: o.number, party: o.party, due: o.due, value: o.value, currency: o.currency })),
    });
  }
  peopleOut.sort((a, b) => b.decides.holding_value - a.decides.holding_value || b.decides.count - a.decides.count || a.name.localeCompare(b.name));

  /* Who is in, day by day: the people who approve. */
  const deciders = people.filter((p) => DECIDERS.includes(p.role));
  const dayRows = days.map((day) => {
    const out = deciders.filter((p) => awayRecorded(p.user_id, day));
    const requested = deciders.filter((p) => !awayRecorded(p.user_id, day) && absences.some((a) => a.user_id === p.user_id && a.status === 'PENDING' && covers(a, day)));
    return {
      date: day,
      label: fmtDay(day),
      deciders_in: deciders.length - out.length,
      deciders_total: deciders.length,
      away: seesAll ? out.map((p) => p.name) : undefined,
      requested_off: seesAll ? requested.map((p) => p.name) : undefined,
    };
  });
  const thin = dayRows.filter((x) => x.deciders_total > 1 && x.deciders_in <= 1);

  /* Proposals. Each one is carried out by actOnCoverage when a manager or admin confirms it. */
  const proposals = [];
  for (const r of atRisk) {
    if (r.state === 'decide_by') {
      const to = r._c.who;
      proposals.push({
        id: `nudge:${r.id}`,
        kind: 'nudge',
        label: `Ask ${names(to.map((p) => p.name))} to decide ${r.number} by ${dayText(r.decide_by)}`,
        title: `Decide ${r.number} by ${dayText(r.decide_by)}`,
        recipients: to.map((p) => ({ user_id: p.user_id, name: p.name })),
        message: `${r.reason} Decide it at ${r.decide_at}.`,
        link: r.decide_at,
        record: { type: r.kind, id: r.id, number: r.number },
      });
    } else if (r.state === 'gap') {
      const named = r._eligible.length === 1 && r._eligible[0].user_id && held.decisions.find((d) => d.id === r.id)?.approver_user_id;
      const cover = named ? bestCover(r._eligible[0], r._c.uncovered_from, r.needed_by || end, people, awayRecorded, days, held.decisions.find((d) => d.id === r.id)) : null;
      if (cover) {
        const a = awayRecorded(r._eligible[0].user_id, r._c.uncovered_from);
        proposals.push({
          id: `delegate:${r._eligible[0].user_id}:${cover.user_id}:${a?.from || r._c.uncovered_from}`,
          kind: 'delegate',
          label: `Let ${cover.name} approve for ${r._eligible[0].name} ${span({ from: a?.from || r._c.uncovered_from, to: a?.to || r.needed_by || end })}`,
          delegator: { user_id: r._eligible[0].user_id, name: r._eligible[0].name },
          delegate: { user_id: cover.user_id, name: cover.name },
          from: a?.from || r._c.uncovered_from,
          to: a?.to || r.needed_by || end,
          record: { type: r.kind, id: r.id, number: r.number },
        });
      } else {
        proposals.push({
          id: `nudge:${r.id}`,
          kind: 'nudge',
          label: `Tell ${names(r._eligible.map((p) => p.name))} that ${r.number} needs a decision before ${r.needed_by ? fmtDay(r.needed_by) : 'they are back'}`,
          title: `${r.number} needs a decision before ${r.needed_by ? fmtDay(r.needed_by) : 'you are back'}`,
          recipients: r._eligible.map((p) => ({ user_id: p.user_id, name: p.name })),
          message: `${r.reason} Decide it at ${r.decide_at}, or agree who covers.`,
          link: r.decide_at,
          record: { type: r.kind, id: r.id, number: r.number },
        });
      }
    }
  }
  for (const p of peopleOut) {
    if (!p.owns_while_away.length) continue;
    const a = p.away.find((x) => ['APPROVED', 'ON_LEAVE'].includes(x.status));
    if (!a) continue;
    const started = a.from <= days[0];
    const to = started
      ? people.filter((x) => DECIDERS.includes(x.role) && x.user_id !== p.user_id && !awayRecorded(x.user_id, days[0]))
      : [byId.get(p.user_id)];
    if (!to.length) continue;
    const list = p.owns_while_away.map((o) => `${o.number}${o.party ? ` (${o.party})` : ''} due ${fmtDay(o.due)}`).join(', ');
    proposals.push({
      id: `handover:${p.user_id}:${a.from}`,
      kind: 'hand_over',
      label: started ? `Ask ${names(to.map((x) => x.name))} to pick up ${p.name}'s ${p.owns_while_away.length} order${p.owns_while_away.length === 1 ? '' : 's'} due while they are away`
        : `Ask ${p.name} to hand over ${p.owns_while_away.length} order${p.owns_while_away.length === 1 ? '' : 's'} before ${fmtDay(a.from)}`,
      recipients: to.map((x) => ({ user_id: x.user_id, name: x.name })),
      title: started ? `Pick up ${p.name}'s orders while they are away` : `Hand over your orders before ${fmtDay(a.from)}`,
      message: started
        ? `${p.name} is away ${span(a)}. These are theirs and fall due meanwhile: ${list}.`
        : `You are away ${span(a)}. These are yours and fall due meanwhile: ${list}. Hand them over before you go.`,
      link: p.owns_while_away[0].type === 'sales_order' ? `/sales/sales-orders/${p.owns_while_away[0].id}` : `/procurement/purchase-orders/${p.owns_while_away[0].id}`,
      record: { type: 'person', id: p.user_id, number: p.name },
    });
  }

  /* Headline. */
  const top = atRisk.find((r) => r.state === 'gap' || r.state === 'decide_by' || r.state === 'nobody');
  const awayNow = dayRows[0] && seesAll ? dayRows[0].away : [];
  let headline;
  const imagined = leaveImpact.find((l) => l.what_if);
  if (whatIf) headline = imagined ? imagined.reason : `If ${byId.get(whatIf.user_id)?.name} is away ${span(whatIf)}, nothing they decide or own is left without cover.`;
  else if (top) headline = top.reason;
  else if (leaveImpact.length) headline = leaveImpact[0].reason;
  else if (deciders.length === 1) headline = `${deciders[0].name} is the only person here who approves: while they are away, nothing can be approved.`;
  else if (thin.length) headline = `On ${thin.length} of the next ${days.length} working days only ${thin[0].deciders_in === 0 ? 'nobody' : 'one person'} who approves is in (first: ${thin[0].label}).`;
  else if (!hrOn) headline = 'The HR module is off, so no leave is on record: every decision is measured as if everyone is in.';
  else headline = `Everyone who decides is in when they are needed over the next ${days.length} working days${awayNow?.length ? ` (${names(awayNow)} away today)` : ''}.`;

  return {
    as_of: new Date().toISOString(),
    scope: seesAll ? 'everyone in the company' : 'you, and the decisions you can see',
    horizon: { from: days[0], to: end, working_days: days.length },
    hr_on: hrOn,
    what_if: whatIf ? { person: byId.get(whatIf.user_id)?.name, from: whatIf.from, to: whatIf.to } : null,
    headline,
    summary: {
      people: people.length,
      deciders: deciders.length,
      deciders_in_today: dayRows[0]?.deciders_in ?? 0,
      away_in_window: new Set(absences.filter((a) => ON_RECORD.has(a.status)).map((a) => a.user_id)).size,
      leave_requested: absences.filter((a) => a.status === 'PENDING').length,
      decisions_pending: held.decisions.length,
      decisions_at_risk: atRisk.filter((r) => SEVERITY[r.state] >= 2).length,
      held_value_at_risk: round(atRisk.filter((r) => SEVERITY[r.state] >= 2).reduce((s, r) => s + r.held_value, 0)),
      single_approver: atRisk.filter((r) => r.state === 'single').length,
      thin_days: thin.length,
      currency,
    },
    at_risk: atRisk.map(({ _eligible, _c, ...r }) => r),
    leave_impact: leaveImpact,
    people: peopleOut,
    days: dayRows,
    proposals,
    method:
      `Over the working days from ${days[0]} to ${end}: pending decisions and the customer orders they hold come from the `
      + 'approval inbox and the delivery trace; who may decide each one is the approval-chain step that names a person, '
      + 'else every user holding the role its approve endpoint requires, never the person who raised it; who is away comes '
      + 'from approved leave and employees marked on leave (requested leave is measured separately, as what approving it '
      + 'would do); an active delegation puts the delegate in place of a named approver. A decision is at risk when the '
      + 'last working day someone who can decide it is in comes before the first customer order it holds falls due. '
      + 'Nothing was changed.',
  };
}

/** A manager or admin who is in on every working day of the gap and did not raise the document. */
function bestCover(absent, from, to, people, awayOn, days, decision) {
  const window = days.filter((d) => d >= from && d <= to);
  return people
    .filter((p) => p.user_id !== absent.user_id && p.user_id !== decision?.raised_by && DECIDERS.includes(p.role))
    .find((p) => window.every((d) => !awayOn(p.user_id, d))) || null;
}

/* ------------------------------------------------------------------- act */

/**
 * Carry out one proposal, after a manager or admin has confirmed it. The
 * situation is re-measured first; a proposal that no longer applies is refused.
 */
async function actOnCoverage({ companyId: given, userId, role, proposalId, horizonDays }) {
  if (!ACTORS.has(role)) return { error: 'Only a manager or an admin can act on who covers what.', status: 403 };
  if (!proposalId) return { error: 'proposal_id is required.', status: 400 };
  const companyId = await resolveCompany(given);
  const fresh = await peopleCoverage({ companyId, userId, role, horizonDays });
  if (fresh.error) return { error: fresh.error, status: 400 };
  const p = fresh.proposals.find((x) => x.id === proposalId);
  if (!p) return { error: 'That proposal no longer applies — the decision was made, someone came back, or the leave changed. Look again to see what holds now.', status: 409 };

  return companyContext.runWithCompany(companyId, async () => {
    if (p.kind === 'delegate') {
      const { rows: [dup] } = await pool.query(
        `SELECT id FROM approval_delegations WHERE company_id = $1 AND delegator_id = $2 AND delegate_id = $3 AND status = 'ACTIVE'
            AND start_date::date <= $5::date AND (end_date IS NULL OR end_date::date >= $4::date)`,
        [companyId, p.delegator.user_id, p.delegate.user_id, p.from, p.to],
      );
      if (dup) return { done: `${p.delegate.name} already approves for ${p.delegator.name} then.`, delegation_id: dup.id };
      const { rows: [row] } = await pool.query(
        `INSERT INTO approval_delegations (delegator_id, delegate_id, start_date, end_date, status, created_by, company_id)
         VALUES ($1, $2, $3::date, ($4::date + interval '1 day' - interval '1 second'), 'ACTIVE', $5, $6) RETURNING id`,
        [p.delegator.user_id, p.delegate.user_id, p.from, p.to, userId, companyId],
      );
      await notify(companyId, [p.delegate, p.delegator], `${p.delegate.name} approves for ${p.delegator.name} ${span({ from: p.from, to: p.to })}`,
        `${p.label}. Recorded so ${p.record.number} and anything else routed to ${p.delegator.name} reaches ${p.delegate.name} meanwhile.`, { link: '/approvals/unified', proposal: p.id });
      return { done: `Delegation recorded: ${p.label}.`, delegation_id: row.id, next: `${p.record.number} is decided on its own approval screen.` };
    }
    const sent = await notify(companyId, p.recipients, p.title || p.label, p.message, { link: p.link, proposal: p.id, record: p.record });
    return { done: `Sent to ${names(p.recipients.map((r) => r.name))}.`, notified: sent, next: 'Nothing else changed; the decision is still theirs to make.' };
  });
}

async function notify(companyId, recipients, title, message, data) {
  let n = 0;
  for (const r of recipients) {
    if (!r?.user_id) continue;
    await pool.query(
      `INSERT INTO notifications (id, type, title, message, data, user_id, company_id, created_at)
       VALUES (gen_random_uuid(), 'AI_FINDING', $1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [String(title).slice(0, 255), message, JSON.stringify(data || {}), r.user_id, companyId],
    );
    n++;
  }
  return n;
}

module.exports = { peopleCoverage, actOnCoverage };
