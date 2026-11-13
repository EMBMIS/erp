/**
 * "One order touches everything — so the shortage is seen the moment the order lands."
 *
 * WHAT THIS DOES
 * ---------------------------------------------------------------------------
 * The promise check (services/promiseCheck.js) answers "can we ship it on the
 * day?" when somebody asks — on the order screen, or in Simeli. This asks it
 * for them, the moment an order lands: when it is created, sent for approval,
 * approved, confirmed by the customer, or keyed in from a customer's PO. Nobody
 * has to open the order or think of the question.
 *
 *   SO-24117 lands  →  184 free, 240 ordered, 56 short on the day it is wanted
 *                   →  Nordbay Industrial lands in 5 days (lead time it achieved here)
 *                   →  a purchase order for 300 is ready to draft, and who approves it
 *                   →  the finding and a notification reach the order's owner and
 *                      the people who can buy
 *
 * When the order can ship in full, nothing is raised. When it later becomes
 * shippable — stock arrived, a purchase order was approved, the order was
 * cancelled — the next look resolves the finding by itself.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It orders nothing. The purchase order is a proposal. A person with
 * procurement authority drafts it from the order screen or asks Simeli to;
 * the draft is re-measured from the record at that moment (nothing the client
 * sends is used as given) and goes through purchase approval like any other.
 * What is stored and sent in notifications carries quantities, suppliers and
 * dates, never prices: prices are only shown live, to roles that see margins.
 * Every read and write is scoped to the order's own company.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const { checkPromise } = require('./promiseCheck');
const { hasPermission } = require('../middleware/rbac');

const FINDING = 'ORDER_SHORT';
const SEES_ALL_ORDERS = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER']);
const CLOSED = new Set(['SHIPPED', 'DELIVERED', 'WAITING_CUSTOMER_DELIVERY_CONFIRMATION', 'COMPLETED', 'CANCELLED', 'REJECTED', 'CUSTOMER_REJECTED', 'GOODS_ISSUED']);
const UUID = /^[0-9a-f-]{36}$/i;

const fmtQty = (v) => new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(v || 0);
const shortDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : null);

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

async function readOrder(companyId, ref) {
  const byId = UUID.test(String(ref || ''));
  const { rows: [so] } = await pool.query(
    `SELECT so.id, so.so_number, so.status, so.created_by, so.delivery_date, so.company_id, so.customer_name
       FROM sales_orders so
      WHERE so.company_id = $1 AND so.deleted_at IS NULL AND ${byId ? 'so.id = $2::uuid' : 'so.so_number ILIKE $2'}`,
    [companyId, String(ref || '')],
  );
  return so || null;
}

async function openFinding(companyId, orderId) {
  const { rows: [f] } = await pool.query(
    `SELECT id, severity, title, description, data, status, created_at
       FROM ai_findings
      WHERE company_id = $1 AND finding_type = $2 AND entity_type = 'SALES_ORDER' AND entity_id = $3 AND status = 'OPEN'`,
    [companyId, FINDING, orderId],
  );
  return f || null;
}

async function resolveFinding(companyId, orderId, why) {
  const { rows } = await pool.query(
    `UPDATE ai_findings
        SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP,
            data = COALESCE(data, '{}'::jsonb) || jsonb_build_object('resolved_because', $4::text)
      WHERE company_id = $1 AND finding_type = $2 AND entity_type = 'SALES_ORDER' AND entity_id = $3 AND status = 'OPEN'
      RETURNING id`,
    [companyId, FINDING, orderId, why],
  );
  return rows.length > 0;
}

/** What is kept on the finding: quantities, suppliers and dates — never prices. */
function summarise(so, check, trigger) {
  const short = check.lines.filter((l) => l.short > 0);
  return {
    so_number: so.so_number,
    customer: so.customer_name || null,
    wanted: check.date,
    verdict: check.verdict,
    verdict_label: check.verdict_label,
    in_time_with_order: check.in_time_with_order,
    earliest_in_full: check.earliest_in_full,
    earliest_if_ordered_today: check.earliest_if_ordered_today,
    needed: check.needed,
    ready_by_date: check.ready_by_date,
    short_lines: short.map((l) => ({ line_number: l.line_number, item_id: l.item_id, item: l.item, needed: l.needed, ready: l.ready_by_date, short: l.short })),
    suppliers: check.fixes.filter((f) => f.supplier).map((f) => ({
      line_number: f.line_number, item: f.item, supplier_id: f.supplier.supplier_id, name: f.supplier.name,
      lead_days: f.supplier.lead_days, lead_basis: f.supplier.lead_basis, lands: f.supplier.lands, in_time: f.supplier.in_time,
      quantity: f.supplier.quantity, routed_to: f.supplier.routed_to,
    })),
    transfers: check.fixes.filter((f) => f.transfer).map((f) => ({ item: f.item, qty: f.transfer.qty, from: f.transfer.from?.name || null })),
    proposals: check.proposals.map((p) => p.label),
    trigger,
    checked_at: new Date().toISOString(),
  };
}

/** The order's owner, and the people in THIS company who can buy (procurement authority). */
async function recipients(companyId, so) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
       FROM users u
       LEFT JOIN user_companies uc ON uc.user_id = u.id AND uc.company_id = $1
      WHERE COALESCE(u.is_active, true)
        AND (u.id = $2 OR COALESCE(uc.role, u.role) IN ('MANAGER', 'ADMIN'))
        AND (uc.user_id IS NOT NULL
             OR (NOT EXISTS (SELECT 1 FROM user_companies x WHERE x.user_id = u.id)
                 AND EXISTS (SELECT 1 FROM companies c WHERE c.id = $1 AND c.is_default)))`,
    [companyId, so.created_by || null],
  );
  return rows.map((r) => r.id);
}

async function notify(companyId, so, findingId, data, headline) {
  for (const userId of await recipients(companyId, so)) {
    await pool.query(
      `INSERT INTO notifications (id, type, title, message, data, user_id, company_id, created_at)
       VALUES (gen_random_uuid(), 'AI_FINDING', $1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [
        `${so.so_number} landed short: ${data.short_lines.map((l) => `${fmtQty(l.short)} × ${l.item}`).join(', ')}`.slice(0, 255),
        headline,
        JSON.stringify({ finding_id: findingId, sales_order_id: so.id, link: `/sales/sales-orders/${so.id}` }),
        userId,
        companyId,
      ],
    );
  }
}

/**
 * Look at one order as it lands. Runs as the system (every order of the
 * company is visible to the allocation), but reads the answer price-free.
 */
async function watchOrder({ companyId, salesOrder, trigger = 'landed' } = {}) {
  const resolved = await resolveCompany(companyId);
  const so = await readOrder(resolved, salesOrder);
  if (!so) return { error: 'No such sales order in this company.' };

  if (CLOSED.has(so.status)) {
    const done = await resolveFinding(resolved, so.id, `${so.so_number} is ${so.status.toLowerCase().replace(/_/g, ' ')}`);
    return { so_number: so.so_number, status: so.status, resolved: done, watched: false };
  }

  // Role USER with no user id: sees every order (it is the company's own
  // allocation), but supplier prices and order values are left out.
  const check = await checkPromise({ companyId: resolved, role: 'USER', salesOrder: so.id });
  if (check.error) return { so_number: so.so_number, error: check.error };

  if (check.verdict === 'yes') {
    const done = await resolveFinding(resolved, so.id, `Can ship in full on ${shortDate(check.date)}`);
    return { so_number: so.so_number, verdict: 'yes', headline: check.headline, resolved: done, raised: false };
  }

  const data = summarise(so, check, trigger);
  const severity = check.in_time_with_order ? 'MEDIUM' : 'HIGH';
  const title = `${so.so_number}${so.customer_name ? ` for ${so.customer_name}` : ''}: ${check.verdict_label.toLowerCase()} on ${shortDate(check.date)} — `
    + data.short_lines.map((l) => `${fmtQty(l.short)} × ${l.item} short`).join(', ');
  const existing = await openFinding(resolved, so.id);
  if (existing) {
    // Keep the open finding current; anything already drafted from it stays on it.
    const keep = { trigger: existing.data?.trigger || trigger, ...(existing.data?.drafted ? { drafted: existing.data.drafted } : {}) };
    await pool.query(
      'UPDATE ai_findings SET severity = $2, title = $3, description = $4, data = $5 WHERE id = $1',
      [existing.id, severity, title.slice(0, 255), check.headline, JSON.stringify({ ...data, ...keep, first_seen: existing.data?.first_seen || existing.created_at })],
    );
    return { so_number: so.so_number, verdict: check.verdict, headline: check.headline, finding_id: existing.id, raised: false, updated: true };
  }

  const { upsertFinding } = require('./ai/findingsScan');
  const r = await upsertFinding({
    companyId: resolved,
    finding_type: FINDING,
    severity,
    entity_type: 'SALES_ORDER',
    entity_id: so.id,
    title: title.slice(0, 255),
    description: check.headline,
    data: { ...data, first_seen: data.checked_at },
  });
  if (r.created) await notify(resolved, so, r.id, data, check.headline).catch((e) => console.warn('Order watch notify failed:', e.message));
  return { so_number: so.so_number, verdict: check.verdict, headline: check.headline, finding_id: r.id, raised: r.created, suppressed: !!r.suppressed };
}

/**
 * Fire-and-forget: called right after an order is written. Never throws into
 * the request that landed the order, and never holds it up.
 */
function onOrderLanded(companyId, salesOrderId, trigger = 'landed') {
  if (!salesOrderId) return;
  setImmediate(async () => {
    try {
      const run = () => watchOrder({ companyId, salesOrder: salesOrderId, trigger });
      if (companyId) await companyContext.runWithCompany(companyId, run);
      else await run();
      // Everyone's watch looks again shortly: the order may put a line, a supplier or the cash behind.
      require('./simeliWatch').watchSoon(companyId || (await companyContext.getDefaultCompanyId()));
    } catch (e) {
      console.warn(`Order watch failed for ${salesOrderId}:`, e.message);
    }
  });
}

/** Can this person see this order? Same rule as the delivery trace. */
function maySee(so, { userId, role }) {
  return !userId || SEES_ALL_ORDERS.has(String(role || '').toUpperCase()) || !so.created_by || so.created_by === userId;
}

/**
 * What Simeli caught when this order landed, read as the person asking: the
 * finding (open or settled), plus the live answer in their own view (prices
 * only for roles that see margins). Re-checks, so a finding that no longer
 * holds is resolved here rather than shown stale.
 */
async function readWatch({ companyId, userId, role, salesOrder }) {
  const resolved = await resolveCompany(companyId);
  const so = await readOrder(resolved, salesOrder);
  if (!so) return { error: 'No such sales order in this company.', status: 404 };
  if (!maySee(so, { userId, role })) return { error: `${so.so_number} belongs to someone else's book, and your role only sees your own orders.`, status: 403 };

  const { rows: [finding] } = await pool.query(
    `SELECT id, severity, title, description, data, status, created_at, resolved_at, dismiss_reason
       FROM ai_findings
      WHERE company_id = $1 AND finding_type = $2 AND entity_type = 'SALES_ORDER' AND entity_id = $3
      ORDER BY (status = 'OPEN') DESC, created_at DESC
      LIMIT 1`,
    [resolved, FINDING, so.id],
  );
  if (!finding) return { so_number: so.so_number, finding: null };

  let live = null;
  if (finding.status === 'OPEN') {
    if (CLOSED.has(so.status)) {
      await resolveFinding(resolved, so.id, `${so.so_number} is ${so.status.toLowerCase().replace(/_/g, ' ')}`);
      finding.status = 'RESOLVED';
    } else {
      live = await checkPromise({ companyId: resolved, userId, role, salesOrder: so.id });
      if (live.error) live = null;
      else if (live.verdict === 'yes') {
        await resolveFinding(resolved, so.id, `Can ship in full on ${shortDate(live.date)}`);
        finding.status = 'RESOLVED';
        finding.resolved_at = new Date().toISOString();
      }
    }
  }
  const canDraft = !!userId && hasPermission(String(role || '').toUpperCase(), 'PROCUREMENT_WRITE');
  return {
    so_number: so.so_number,
    finding: {
      id: finding.id, status: finding.status, severity: finding.severity, title: finding.title,
      caught_at: finding.data?.first_seen || finding.created_at, resolved_at: finding.resolved_at,
      resolved_because: finding.data?.resolved_because || null, dismiss_reason: finding.dismiss_reason,
      trigger: finding.data?.trigger || null, short_lines: finding.data?.short_lines || [], drafted: finding.data?.drafted || [],
    },
    live: live && {
      headline: live.headline, verdict: live.verdict, verdict_label: live.verdict_label, tone: live.tone, date: live.date,
      fixes: live.fixes, proposals: live.proposals.map((p) => ({ kind: p.kind, label: p.label, item_id: p.args?.items?.[0]?.item_id || null, draftable: p.kind === 'purchase_order' && canDraft })),
      read: live.read, visibility: live.visibility,
    },
    can_draft: canDraft,
  };
}

/**
 * A person drafts the purchase order the watch proposed. The proposal is
 * measured again from the record now; only an item the check still proposes
 * a purchase order for can be drafted. The draft goes through purchase
 * approval — nothing reaches the supplier from here.
 */
async function draftFromWatch({ companyId, userId, role, salesOrder, itemId }) {
  if (!userId) return { error: 'A person drafts purchase orders.', status: 403 };
  if (!hasPermission(String(role || '').toUpperCase(), 'PROCUREMENT_WRITE')) {
    return { error: 'Your role cannot raise purchase orders. Someone with procurement authority can draft it.', status: 403 };
  }
  const resolved = await resolveCompany(companyId);
  const so = await readOrder(resolved, salesOrder);
  if (!so) return { error: 'No such sales order in this company.', status: 404 };
  if (!maySee(so, { userId, role })) return { error: `${so.so_number} belongs to someone else's book.`, status: 403 };

  const check = await checkPromise({ companyId: resolved, userId, role, salesOrder: so.id });
  if (check.error) return { error: check.error, status: 409 };
  const proposal = check.proposals.find((p) => p.kind === 'purchase_order' && (!itemId || p.args?.items?.[0]?.item_id === itemId));
  if (!proposal) return { error: `${so.so_number} no longer needs a purchase order${itemId ? ' for that item' : ''}: ${check.headline}`, status: 409 };

  const finding = await openFinding(resolved, so.id);
  const already = (finding?.data?.drafted || []).find((d) => d.item_id === proposal.args.items[0].item_id);
  if (already) return { error: `${already.po_number} was already drafted for this by ${already.by_name || 'someone'}; it is waiting for approval.`, status: 409, po: already };

  const { actionTools } = require('./ai/actionTools');
  const tool = actionTools.find((t) => t.name === 'create_purchase_order_draft');
  const args = { ...proposal.args, notes: `${proposal.args.notes} Drafted from Simeli's order watch on ${so.so_number}.` };
  const out = await companyContext.runWithCompany(resolved, () => tool.handler(args, { userId, companyId: resolved, role }));
  if (out?.error) return { error: out.error, status: 400 };

  const { rows: [po] } = await pool.query(
    'SELECT id, po_number, status FROM purchase_orders WHERE id = $1 AND company_id = $2',
    [out.id, resolved],
  );
  const { rows: [me] } = await pool.query("SELECT COALESCE(NULLIF(TRIM(CONCAT(first_name, ' ', last_name)), ''), email) AS name FROM users WHERE id = $1", [userId]);
  const record = { item_id: proposal.args.items[0].item_id, po_id: po?.id || out.id, po_number: po?.po_number || out.reference, by: userId, by_name: me?.name || null, at: new Date().toISOString() };
  if (finding) {
    await pool.query(
      `UPDATE ai_findings SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{drafted}', COALESCE(data->'drafted', '[]'::jsonb) || $2::jsonb)
        WHERE id = $1`,
      [finding.id, JSON.stringify([record])],
    );
  }
  return {
    so_number: so.so_number,
    purchase_order: { id: record.po_id, po_number: record.po_number, status: po?.status || 'DRAFT' },
    label: proposal.label,
    done: `${record.po_number} drafted for ${so.so_number}: ${proposal.label.replace(/^Prepare purchase order: /, '')}. It is a draft — it goes through purchase approval before anything reaches the supplier.`,
  };
}

/**
 * For Simeli: the orders that landed short and are still open, newest first,
 * as the person asking may see them. Each is re-checked, so what comes back is
 * the state now, not the state when it was caught.
 */
async function listCaught({ companyId, userId, role, days = 14, limit = 8 } = {}) {
  const resolved = await resolveCompany(companyId);
  const seesAll = !userId || SEES_ALL_ORDERS.has(String(role || '').toUpperCase());
  const { rows } = await pool.query(
    `SELECT f.id, f.severity, f.created_at, f.data, so.id AS sales_order_id, so.so_number, so.status, so.created_by
       FROM ai_findings f
       JOIN sales_orders so ON so.id = f.entity_id AND so.company_id = f.company_id AND so.deleted_at IS NULL
      WHERE f.company_id = $1 AND f.finding_type = $2 AND f.entity_type = 'SALES_ORDER' AND f.status = 'OPEN'
        AND f.created_at >= CURRENT_TIMESTAMP - make_interval(days => $3::int)
        AND ($4::boolean OR so.created_by = $5::uuid)
      ORDER BY (f.severity = 'HIGH') DESC, f.created_at DESC
      LIMIT $6`,
    [resolved, FINDING, Math.max(1, Math.min(Number(days) || 14, 90)), seesAll, userId || null, Math.max(1, Math.min(Number(limit) || 8, 20))],
  );
  const orders = [];
  let settled = 0;
  for (const r of rows) {
    const w = await readWatch({ companyId: resolved, userId, role, salesOrder: r.sales_order_id });
    if (w.error || !w.finding) continue;
    if (w.finding.status !== 'OPEN') { settled += 1; continue; }
    orders.push({
      sales_order_id: r.sales_order_id, so_number: r.so_number, customer: r.data?.customer || null, status: r.status,
      caught_at: w.finding.caught_at, trigger: w.finding.trigger, severity: r.severity,
      headline: w.live?.headline || null, short_lines: w.finding.short_lines, drafted: w.finding.drafted,
      proposals: w.live?.proposals || [], link: `/sales/sales-orders/${r.sales_order_id}`,
    });
  }
  return {
    days: Number(days) || 14,
    orders,
    settled_since: settled,
    headline: orders.length
      ? `${orders.length} order${orders.length === 1 ? '' : 's'} landed short and ${orders.length === 1 ? 'is' : 'are'} still open${settled ? ` (${settled} more settled since)` : ''}.`
      : `No open order landed short in the last ${Number(days) || 14} days${settled ? ` — ${settled} that did are settled now` : ''}.`,
    visibility: seesAll ? 'every order in the company' : 'your own orders',
    method: 'Every order is checked the moment it is created, sent for approval, approved or confirmed: the promise check against '
      + 'the day it is wanted, with stock allocated in promised-date order across the company. A short order raises a finding '
      + 'and notifies its owner and the people who can buy. Each is re-checked here. Nothing was changed.',
  };
}

/** Scheduler: re-look at every open order-watch finding of one company, so settled ones close by themselves. */
async function recheckOpen(companyId) {
  const resolved = await resolveCompany(companyId);
  const { rows } = await pool.query(
    `SELECT entity_id FROM ai_findings WHERE company_id = $1 AND finding_type = $2 AND entity_type = 'SALES_ORDER' AND status = 'OPEN' LIMIT 50`,
    [resolved, FINDING],
  );
  let resolvedCount = 0;
  for (const r of rows) {
    const out = await watchOrder({ companyId: resolved, salesOrder: r.entity_id, trigger: 'recheck' }).catch(() => null);
    if (out?.resolved) resolvedCount += 1;
  }
  return { checked: rows.length, resolved: resolvedCount };
}

module.exports = { watchOrder, onOrderLanded, readWatch, draftFromWatch, listCaught, recheckOpen, FINDING };
