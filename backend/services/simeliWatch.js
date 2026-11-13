/**
 * "Simeli watches what is happening and surfaces what matters. One line slows
 * down, and it already knows what that will cost."
 *
 * WHAT THIS DOES
 * ---------------------------------------------------------------------------
 * The brief (services/whatMattersNow.js) runs every watcher — deliveries,
 * lines, suppliers, decisions, people, cash, bills, margin — but only when
 * somebody asks. This asks it FOR them: every few minutes, and shortly after
 * an order lands or the shop floor books time, it runs the brief as each
 * person who uses the system, compares it with what that person was already
 * shown, and keeps the difference:
 *
 *   NEW       a problem the watchers had not found before    → notify if urgent
 *   WORSE     became urgent, or the money at stake grew      → notify
 *   CLEARED   the watchers no longer find it                 → kept, with when
 *
 * So a slow line reaches the production manager as "Simeli noticed: WC-02 is
 * running 38% under its own pace — €4,100 in line time, SO-24117 at risk —
 * next: move the operation to WC-03, a manager approves", without anyone
 * asking, and "what did you notice?" in Simeli (or the Home card) answers with
 * what changed since they last looked.
 *
 * THE RULES IT KEEPS
 * ---------------------------------------------------------------------------
 *   • Company isolation: every read and write runs inside the company, and the
 *     people watched are the people of THAT company.
 *   • Role-based visibility: each person is watched with their own role, so a
 *     sales rep's watch holds their own orders and never a cash or margin
 *     number; what is stored for them is what their role would be shown.
 *   • AI proposes, people approve: nothing here changes a business record. It
 *     stores what it noticed and sends in-app notifications. Each item's next
 *     step names the tool that drafts, holds or asks, and who approves it.
 *   • It does not shout twice: one notification per problem per person, again
 *     only if it gets worse, never one for a record another watcher already
 *     told them about in the last day, and at most three at a time.
 *
 * Off with SIMELI_WATCH_ENABLED=false; the interval is SIMELI_WATCH_MINUTES
 * (default 15).
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const { whatMattersNow } = require('./whatMattersNow');

const MINUTES = Math.max(parseInt(process.env.SIMELI_WATCH_MINUTES, 10) || 15, 1);
const MAX_PEOPLE = 50;
const MAX_ALERTS = 3;
const AREA_OF = { deliveries: 'Deliveries', lines: 'Production', suppliers: 'Suppliers', decisions: 'Decisions', people: 'People', cash: 'Cash', bills: 'Payables', margin: 'Margin', built: 'Built in Sandbox' };

const round = (v) => Math.round((Number(v) || 0) * 100) / 100;
function money(v, cur) {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur || 'EUR', maximumFractionDigits: 0 }).format(v || 0);
  } catch {
    return `${Math.round(v || 0)} ${cur || ''}`.trim();
  }
}

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/** The people of THIS company who use the system, each with their role here. */
async function peopleToWatch(companyId) {
  const { rows } = await pool.query(
    `SELECT u.id, COALESCE(uc.role, u.role) AS role
       FROM users u
       LEFT JOIN user_companies uc ON uc.user_id = u.id AND uc.company_id = $1
      WHERE COALESCE(u.is_active, true) AND u.deleted_at IS NULL
        AND COALESCE(u.last_login, u.created_at) > CURRENT_TIMESTAMP - INTERVAL '30 days'
        AND (uc.user_id IS NOT NULL
             OR (NOT EXISTS (SELECT 1 FROM user_companies x WHERE x.user_id = u.id)
                 AND EXISTS (SELECT 1 FROM companies c WHERE c.id = $1 AND c.is_default)))
      ORDER BY u.last_login DESC NULLS LAST
      LIMIT ${MAX_PEOPLE}`,
    [companyId],
  );
  return rows;
}

/** A record another watcher (order watch, line watch, findings) already told this person about today. */
async function toldToday(companyId, userId, recordId) {
  if (!recordId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM notifications
      WHERE company_id = $1 AND user_id = $2 AND created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
        AND data::text LIKE '%' || $3 || '%'
      LIMIT 1`,
    [companyId, userId, String(recordId)],
  );
  return rows.length > 0;
}

async function notify(companyId, userId, title, message, data) {
  await pool.query(
    `INSERT INTO notifications (id, type, title, message, data, user_id, company_id, created_at)
     VALUES (gen_random_uuid(), 'AI_FINDING', $1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
    [String(title).slice(0, 255), message, JSON.stringify({ kind: 'simeli_watch', ...data }), userId, companyId],
  );
}

function alertText(item, worse) {
  const step = item.next_step?.label ? `Next: ${item.next_step.label}${item.next_step.approver ? ` (${item.next_step.approver})` : ''}.` : '';
  return {
    title: `${worse ? 'Simeli: worse' : 'Simeli noticed'} — ${item.title}`,
    message: [item.cause && `Cause: ${item.cause}.`, item.at_stake?.what && `At stake: ${item.at_stake.what}.`, worse, step].filter(Boolean).join(' ').trim(),
  };
}

/**
 * Watch one person: run the brief as them, compare with what they were shown,
 * store the difference and (if `notify`) tell them what is new or worse.
 */
async function watchPerson({ companyId, userId, role, notifyPerson = true }) {
  const brief = await whatMattersNow({ companyId, userId, role, all: true, fresh: true });
  if (brief.error) return { error: brief.error };

  const { rows: open } = await pool.query(
    "SELECT * FROM simeli_watch_items WHERE company_id = $1 AND user_id = $2 AND status = 'OPEN'",
    [companyId, userId],
  );
  const { rows: [lastSweep] } = await pool.query(
    'SELECT swept_at FROM simeli_watch_sweeps WHERE company_id = $1 AND user_id = $2',
    [companyId, userId],
  );
  const known = new Map(open.map((r) => [r.item_key, r]));
  const seen = new Set();
  const fresh = [];
  const worse = [];

  for (const item of brief.items) {
    seen.add(item.id);
    const stake = round(item.at_stake?.amount);
    const prev = known.get(item.id);
    if (!prev) {
      const { rows: [row] } = await pool.query(
        `INSERT INTO simeli_watch_items
           (company_id, user_id, item_key, area, severity, title, cause, at_stake, first_at_stake, currency, stake_what, record, link, next_step, ask)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (company_id, user_id, item_key) WHERE status = 'OPEN' DO NOTHING
         RETURNING id`,
        [companyId, userId, item.id, item.area, item.severity, item.title, item.cause, stake, item.at_stake?.currency || null,
          item.at_stake?.what || null, JSON.stringify(item.record || null), item.link || null, JSON.stringify(item.next_step || null), item.ask || null],
      );
      if (row) fresh.push({ ...item, watch_id: row.id });
      continue;
    }
    let note = null;
    if (prev.severity === 'MEDIUM' && item.severity === 'HIGH') note = 'Now urgent.';
    else if (stake - Number(prev.at_stake) >= Math.max(100, Number(prev.at_stake) * 0.2)) {
      note = `At stake up from ${money(prev.at_stake, prev.currency)} to ${money(stake, item.at_stake?.currency)}.`;
    }
    await pool.query(
      `UPDATE simeli_watch_items
          SET severity = $2, title = $3, cause = $4, at_stake = $5, currency = $6, stake_what = $7, record = $8, link = $9,
              next_step = $10, ask = $11, last_seen_at = CURRENT_TIMESTAMP,
              worsened_at = CASE WHEN $12::text IS NOT NULL THEN CURRENT_TIMESTAMP ELSE worsened_at END,
              worsened_note = COALESCE($12::text, worsened_note)
        WHERE id = $1`,
      [prev.id, item.severity, item.title, item.cause, stake, item.at_stake?.currency || null, item.at_stake?.what || null,
        JSON.stringify(item.record || null), item.link || null, JSON.stringify(item.next_step || null), item.ask || null, note],
    );
    if (note) worse.push({ ...item, watch_id: prev.id, note, notified_at: prev.notified_at });
  }

  // Clear only what a watcher that RAN no longer finds: a watcher that failed or is
  // outside the person's view this time says nothing about whether the problem is gone.
  const ran = new Set((brief.checked || []).filter((c) => c.status === 'clear' || c.status === 'flagged').map((c) => AREA_OF[c.key]));
  const cleared = [];
  for (const r of open) {
    if (seen.has(r.item_key) || !ran.has(r.area)) continue;
    await pool.query("UPDATE simeli_watch_items SET status = 'CLEARED', cleared_at = CURRENT_TIMESTAMP WHERE id = $1", [r.id]);
    cleared.push(r);
  }

  // Tell them. The first sweep for a person is one summary, not a burst.
  let sent = 0;
  if (notifyPerson) {
    if (!lastSweep && brief.items.length) {
      const top = brief.items[0];
      await notify(companyId, userId, `Simeli is watching for you: ${brief.summary.items} thing${brief.summary.items === 1 ? ' needs' : 's need'} a person`,
        brief.headline, { link: '/', ask: 'What have you noticed for me, and what is new since I last looked?', watch_item_key: top.id });
      await pool.query(
        "UPDATE simeli_watch_items SET notified_at = CURRENT_TIMESTAMP WHERE company_id = $1 AND user_id = $2 AND status = 'OPEN'",
        [companyId, userId],
      );
      sent = 1;
    } else if (lastSweep) {
      const due = [
        ...worse.filter((w) => !w.notified_at || Date.now() - new Date(w.notified_at).getTime() > 24 * 3600 * 1000),
        ...fresh.filter((f) => f.severity === 'HIGH'),
      ];
      const out = [];
      for (const item of due) {
        if (await toldToday(companyId, userId, item.record?.id)) continue;
        out.push(item);
      }
      for (const item of out.slice(0, MAX_ALERTS)) {
        const t = alertText(item, item.note || null);
        await notify(companyId, userId, t.title, t.message, { watch_item_id: item.watch_id, link: item.link || '/', ask: item.ask });
        sent += 1;
      }
      if (out.length > MAX_ALERTS) {
        const rest = out.slice(MAX_ALERTS);
        await notify(companyId, userId, `Simeli noticed ${rest.length} more thing${rest.length === 1 ? '' : 's'}`,
          rest.map((i) => i.title).join(' · '), { link: '/', ask: 'What have you noticed for me, and what is new since I last looked?' });
        sent += 1;
      }
      if (out.length) {
        await pool.query('UPDATE simeli_watch_items SET notified_at = CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[])', [out.map((i) => i.watch_id)]);
      }
    }
  }

  await pool.query(
    `INSERT INTO simeli_watch_sweeps (company_id, user_id, swept_at, open_items, new_items, worse_items, cleared, headline, checked)
     VALUES ($1, $2, CURRENT_TIMESTAMP, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (company_id, user_id) DO UPDATE
       SET swept_at = EXCLUDED.swept_at, open_items = EXCLUDED.open_items, new_items = EXCLUDED.new_items,
           worse_items = EXCLUDED.worse_items, cleared = EXCLUDED.cleared, headline = EXCLUDED.headline, checked = EXCLUDED.checked`,
    [companyId, userId, brief.items.length, fresh.length, worse.length, cleared.length, brief.headline, JSON.stringify(brief.checked || [])],
  );

  return { open: brief.items.length, new: fresh.length, worse: worse.length, cleared: cleared.length, notified: sent, headline: brief.headline };
}

const running = new Set();

/** Watch every person of one company, as themselves. */
async function watchCompany(companyId) {
  const resolved = await resolveCompany(companyId);
  if (!resolved || running.has(resolved)) return { skipped: true };
  running.add(resolved);
  try {
    return await companyContext.runWithCompany(resolved, async () => {
      const people = await peopleToWatch(resolved);
      const out = { people: people.length, new: 0, worse: 0, cleared: 0, notified: 0 };
      for (const p of people) {
        try {
          const r = await watchPerson({ companyId: resolved, userId: p.id, role: p.role });
          if (r.error) continue;
          out.new += r.new; out.worse += r.worse; out.cleared += r.cleared; out.notified += r.notified;
        } catch (err) {
          console.warn(`[simeliWatch] ${p.id} failed:`, err.message);
        }
      }
      return out;
    });
  } finally {
    running.delete(resolved);
  }
}

/** Something just happened (an order landed, time was booked): look again soon, once. */
const soon = new Map();
function watchSoon(companyId, delayMs = 30 * 1000) {
  if (!companyId || process.env.SIMELI_WATCH_ENABLED === 'false' || process.env.NODE_ENV === 'test') return;
  if (soon.has(companyId)) return;
  const t = setTimeout(() => {
    soon.delete(companyId);
    watchCompany(companyId).catch((e) => console.warn('[simeliWatch] sweep failed:', e.message));
  }, delayMs);
  t.unref?.();
  soon.set(companyId, t);
}

let timer = null;
function startWatch() {
  if (process.env.SIMELI_WATCH_ENABLED === 'false') return { started: false, reason: 'SIMELI_WATCH_ENABLED is "false"' };
  if (process.env.NODE_ENV === 'test') return { started: false, reason: 'test environment' };
  if (timer) return { started: true };
  const tick = () => companyContext.forEachCompany((id) => watchCompany(id || companyContext.currentCompanyId()))
    .catch((e) => console.warn('[simeliWatch] tick failed:', e.message));
  const first = setTimeout(tick, 2 * 60 * 1000);
  first.unref?.();
  timer = setInterval(tick, MINUTES * 60 * 1000);
  timer.unref?.();
  return { started: true, every_minutes: MINUTES };
}

const shape = (r) => ({
  key: r.item_key,
  area: r.area,
  severity: r.severity,
  title: r.title,
  cause: r.cause,
  at_stake: { amount: Number(r.at_stake), currency: r.currency, what: r.stake_what, when_first_seen: Number(r.first_at_stake) },
  record: r.record,
  link: r.link,
  next_step: r.next_step,
  ask: r.ask,
  first_seen_at: r.first_seen_at,
  last_seen_at: r.last_seen_at,
  worsened_at: r.worsened_at,
  worsened_note: r.worsened_note,
  notified_at: r.notified_at,
  cleared_at: r.cleared_at,
  open_for: r.status === 'CLEARED' && r.cleared_at
    ? ((h) => (h < 1 ? 'cleared within the hour' : `${Math.round(h)}h until it cleared`))((new Date(r.cleared_at) - new Date(r.first_seen_at)) / 3600000)
    : null,
});

/**
 * What Simeli noticed for this person: new, worse, still open and cleared since `since`
 * (default: the last day). With `checkNow`, it watches them first, without notifying —
 * they are reading the answer.
 */
async function watchFeed({ companyId, userId, role, since, checkNow = false } = {}) {
  const resolved = await resolveCompany(companyId);
  if (!resolved) return { error: 'No company to read.' };
  if (!userId) return { error: 'The watch is kept per person; sign in as one to read it.' };
  return companyContext.runWithCompany(resolved, async () => {
    if (checkNow) await watchPerson({ companyId: resolved, userId, role, notifyPerson: false });
    const from = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : new Date(Date.now() - 24 * 3600 * 1000);
    const { rows } = await pool.query(
      `SELECT * FROM simeli_watch_items
        WHERE company_id = $1 AND user_id = $2
          AND (status = 'OPEN' OR cleared_at >= $3)
        ORDER BY (severity = 'HIGH') DESC, at_stake DESC, first_seen_at DESC
        LIMIT 100`,
      [resolved, userId, from],
    );
    const { rows: [sweep] } = await pool.query(
      'SELECT swept_at, headline, checked FROM simeli_watch_sweeps WHERE company_id = $1 AND user_id = $2',
      [resolved, userId],
    );
    const open = rows.filter((r) => r.status === 'OPEN');
    const isNew = open.filter((r) => new Date(r.first_seen_at) >= from);
    const isWorse = open.filter((r) => !isNew.includes(r) && r.worsened_at && new Date(r.worsened_at) >= from);
    const still = open.filter((r) => !isNew.includes(r) && !isWorse.includes(r));
    const cleared = rows.filter((r) => r.status === 'CLEARED');

    const stake = {};
    for (const r of open) if (Number(r.at_stake) > 0) stake[r.currency || 'EUR'] = round((stake[r.currency || 'EUR'] || 0) + Number(r.at_stake));
    const stakeText = Object.entries(stake).map(([c, v]) => money(v, c)).join(' + ');
    const sinceText = from.toISOString().slice(0, 16).replace('T', ' ');
    const headline = !sweep
      ? 'Simeli has not watched for you yet; ask it to check now.'
      : !open.length && !cleared.length
        ? `Nothing needs you. Simeli last watched at ${new Date(sweep.swept_at).toISOString().slice(11, 16)} UTC.`
        : [`Since ${sinceText} UTC: ${isNew.length} new`, isWorse.length && `${isWorse.length} worse`, `${cleared.length} cleared`,
          `${open.length} open${stakeText ? `, ${stakeText} at stake` : ''}`].filter(Boolean).join(', ') + '.';

    return {
      watching: process.env.SIMELI_WATCH_ENABLED !== 'false',
      every_minutes: MINUTES,
      last_watched_at: sweep?.swept_at || null,
      since: from.toISOString(),
      headline,
      new: isNew.map(shape),
      worse: isWorse.map(shape),
      still_open: still.map(shape),
      cleared: cleared.map(shape),
      checked: sweep?.checked || [],
      method:
        `Every ${MINUTES} minutes, and shortly after an order lands or time is booked on a line, Simeli runs every watcher as you `
        + '(your role, your company) and compares with what it showed you before: new problems, ones that became urgent or put '
        + 'more money at stake, and ones the watchers no longer find. Urgent new or worse items are sent to you once as a '
        + 'notification. Nothing was changed: each next step drafts, holds or asks, and a person approves it.',
    };
  });
}

module.exports = { watchPerson, watchCompany, watchSoon, startWatch, watchFeed };
