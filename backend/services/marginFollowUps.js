/**
 * "Prepare the three follow-ups" — what the margin analysis proposes, drafted
 * as records that wait on their owners.
 *
 * WHAT THIS DOES
 * ---------------------------------------------------------------------------
 * services/marginDrivers.js splits a margin drop into causes and proposes a
 * follow-up for each: re-quote an item that now costs more to buy, require
 * approval for a product discounted past its usual level, open a quality
 * review on a work centre scrapping more than it used to. This drafts them —
 * one at a time or all at once — and nothing more:
 *
 *   RFQ            a DRAFT request for quotation to the alternative suppliers
 *                  the analysis found. Procurement sends it; an award still
 *                  goes through purchase approval.
 *   Approval rule  a PROPOSED sales discount rule: "<item> discounts above
 *                  N% are approved by <person>". It binds nothing until a
 *                  manager who did not propose it activates it. While ACTIVE,
 *                  a sales order discounting that item further can only be
 *                  approved by the rule's approver or an admin
 *                  (models/SalesOrder.js approveOrder).
 *   Quality review an OPEN review on the work centre with the scrap evidence,
 *                  shown on the Work Centres screen until production closes it
 *                  with what they found.
 *
 * WHO DECIDES
 * ---------------------------------------------------------------------------
 * "Prepare all" never executes what a client sends: it runs the analysis again
 * and drafts what it proposes now. Each draft goes to its owner — procurement,
 * a sales manager, production — and only they make it real. Drafting the RFQ
 * needs PROCUREMENT_WRITE; activating a rule needs SALES_APPROVE and a
 * different person from the one who proposed it; closing a review needs
 * MANUFACTURING_WRITE. Every query is company-scoped.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const { hasPermission } = require('../middleware/rbac');
const { explainMargin, SEES_MARGINS } = require('./marginDrivers');

const KINDS = ['rfq', 'approval_rule', 'quality_review'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const round = (v, p = 2) => Math.round(v * 10 ** p) / 10 ** p;
const can = (role, perm) => !role || hasPermission(String(role).toUpperCase(), perm);
const seesMargins = (role) => !role || SEES_MARGINS.has(String(role).toUpperCase());
const person = (r, prefix) => {
  const name = [r[`${prefix}_first_name`], r[`${prefix}_last_name`]].filter(Boolean).join(' ');
  return name || r[`${prefix}_email`] || null;
};

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/** The person who approves this company's sales orders most often — who a discount rule should route to. */
async function usualSalesApprover(companyId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.first_name, u.last_name, u.email, COUNT(*)::int AS approved
       FROM sales_orders so
       JOIN users u ON u.id = so.approved_by
      WHERE so.company_id = $1 AND so.approved_at >= CURRENT_DATE - INTERVAL '180 days'
        AND u.is_active IS NOT FALSE AND u.role IN ('MANAGER', 'ADMIN')
      GROUP BY u.id ORDER BY approved DESC LIMIT 1`,
    [companyId],
  );
  const r = rows[0];
  return r ? { id: r.id, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email, approved_180d: r.approved } : null;
}

/* ------------------------------------------------------------- RFQ (exists) */

async function draftRfq({ companyId, userId, role, args }) {
  if (!can(role, 'PROCUREMENT_WRITE')) {
    return { kind: 'rfq', state: 'needs_owner', note: 'Procurement drafts the RFQ; your role does not.', owner: 'Procurement' };
  }
  // The same re-quote drafted twice is one RFQ: reuse an open Simeli draft for the item.
  const { rows: open } = await pool.query(
    `SELECT r.id, r.rfq_number FROM request_for_quotations r
       JOIN rfq_line_items l ON l.rfq_id = r.id
      WHERE r.company_id = $1 AND r.status = 'DRAFT' AND l.item_id = $2
        AND r.description LIKE 'Drafted by Simeli from the margin analysis%'
      ORDER BY r.created_at DESC LIMIT 1`,
    [companyId, args.item_id],
  );
  if (open.length) {
    return { kind: 'rfq', state: 'DRAFT', id: open[0].id, reference: open[0].rfq_number, already: true, owner: 'Procurement', open_at: `/procurement/rfqs/${open[0].id}` };
  }
  const tool = require('./ai/marginTools').marginTools.find((t) => t.name === 'create_rfq_draft');
  const out = await tool.handler(args, { companyId, userId, role });
  if (out.error) return { kind: 'rfq', state: 'failed', note: out.error };
  return { kind: 'rfq', state: 'DRAFT', id: out.id, reference: out.reference, owner: 'Procurement', suppliers: out.suppliers, open_at: out.open_at };
}

/* ------------------------------------------------------- discount rules */

async function proposeDiscountRule({ companyId, userId, role, itemId, itemCode, maxDiscountPct, reason, evidence }) {
  if (!seesMargins(role)) return { error: 'Discount rules are proposed from the margin analysis, which your role does not see.' };
  companyId = await resolveCompany(companyId);
  const pct = Number(maxDiscountPct);
  if (!(pct >= 0 && pct < 100)) return { error: 'max_discount_pct must be between 0 and 100.' };

  const { rows: items } = await pool.query(
    `SELECT id, item_code, name FROM items
      WHERE company_id = $1 AND (($2::uuid IS NOT NULL AND id = $2::uuid) OR ($2::uuid IS NULL AND item_code = $3))
      LIMIT 1`,
    [companyId, itemId && UUID.test(itemId) ? itemId : null, itemCode || null],
  );
  if (!items.length) return { error: 'That product is not in this company\'s item master.' };
  const item = items[0];

  const { rows: live } = await pool.query(
    `SELECT id, status, max_discount_pct::float AS max_discount_pct FROM sales_discount_rules
      WHERE company_id = $1 AND item_id = $2 AND status IN ('PROPOSED', 'ACTIVE')`,
    [companyId, item.id],
  );
  if (live.length) {
    return { kind: 'approval_rule', id: live[0].id, state: live[0].status, already: true, item: item.item_code || item.name, max_discount_pct: live[0].max_discount_pct, owner: 'Sales manager', open_at: '/finance' };
  }

  const approver = await usualSalesApprover(companyId);
  const { rows } = await pool.query(
    `INSERT INTO sales_discount_rules (company_id, item_id, max_discount_pct, approver_user_id, reason, evidence, proposed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [companyId, item.id, round(pct, 2), approver?.id || null, reason || null, evidence ? JSON.stringify(evidence) : null,
      userId && UUID.test(userId) ? userId : null],
  );
  return {
    kind: 'approval_rule',
    id: rows[0].id,
    state: 'PROPOSED',
    item: item.item_code || item.name,
    max_discount_pct: round(pct, 2),
    routes_to: approver ? `${approver.name} (approved ${approver.approved_180d} sales orders in 180 days)` : 'the manager who activates it',
    owner: 'Sales manager',
    next_step: 'It binds nothing yet. A manager who did not propose it activates it on the Finance dashboard.',
    open_at: '/finance',
  };
}

async function decideDiscountRule({ companyId, userId, role, bypassSoD = false, id, decision, approverUserId, reason }) {
  if (!can(role, 'SALES_APPROVE')) return { error: 'Activating a discount rule needs sales approval authority.' };
  if (!['activate', 'decline', 'retire'].includes(decision)) return { error: 'decision must be activate, decline or retire.' };
  companyId = await resolveCompany(companyId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT * FROM sales_discount_rules WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, companyId],
    );
    const rule = rows[0];
    if (!rule) { await client.query('ROLLBACK'); return { error: 'Rule not found.' }; }
    const from = { activate: 'PROPOSED', decline: 'PROPOSED', retire: 'ACTIVE' }[decision];
    if (rule.status !== from) { await client.query('ROLLBACK'); return { error: `The rule is ${rule.status.toLowerCase()}, not ${from.toLowerCase()}.` }; }
    if (decision === 'activate' && !bypassSoD && rule.proposed_by && rule.proposed_by === userId) {
      await client.query('ROLLBACK');
      return { error: 'You proposed this rule; another manager activates it.' };
    }
    let approver = rule.approver_user_id || userId;
    if (decision === 'activate' && approverUserId) {
      const { rows: ok } = await client.query(
        `SELECT id FROM users WHERE id = $1 AND role IN ('MANAGER', 'ADMIN') AND is_active IS NOT FALSE`, [approverUserId],
      );
      if (!ok.length || !(await companyContext.userCanAccess(approverUserId, companyId))) {
        await client.query('ROLLBACK');
        return { error: 'The approver must be an active manager of this company.' };
      }
      approver = approverUserId;
    }
    const status = { activate: 'ACTIVE', decline: 'DECLINED', retire: 'RETIRED' }[decision];
    await client.query(
      `UPDATE sales_discount_rules
          SET status = $2::varchar, decided_by = $3, decided_at = CURRENT_TIMESTAMP,
              approver_user_id = CASE WHEN $2::varchar = 'ACTIVE' THEN $4::uuid ELSE approver_user_id END,
              decline_reason = CASE WHEN $2::varchar = 'DECLINED' THEN $5::text ELSE decline_reason END
        WHERE id = $1`,
      [id, status, userId, approver, reason || null],
    );
    await client.query('COMMIT');
    return { id, state: status };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Lines of one sales order that discount a product past an ACTIVE rule — read
 * inside the approval transaction (models/SalesOrder.js), so it takes the
 * transaction's client.
 */
async function discountBreaches(client, orderId) {
  const { rows } = await client.query(
    `SELECT soi.line_number, COALESCE(i.item_code, soi.item_code, soi.item_name) AS item,
            r.max_discount_pct::float AS max_pct, r.approver_user_id,
            u.first_name AS a_first_name, u.last_name AS a_last_name, u.email AS a_email,
            (100 * COALESCE(NULLIF(soi.discount_amount, 0), soi.quantity * soi.unit_price * COALESCE(soi.discount_percentage, 0) / 100)
                 / NULLIF(soi.quantity * soi.unit_price, 0))::float AS pct
       FROM sales_order_items soi
       JOIN sales_orders so ON so.id = soi.sales_order_id
       LEFT JOIN inventory_items ii ON ii.id = soi.inventory_item_id
       JOIN sales_discount_rules r ON r.company_id = so.company_id AND r.status = 'ACTIVE'
       JOIN items i ON i.id = r.item_id
            AND (i.id = ii.item_master_id OR (soi.inventory_item_id IS NULL AND soi.item_code = i.item_code))
       LEFT JOIN users u ON u.id = r.approver_user_id
      WHERE soi.sales_order_id = $1`,
    [orderId],
  );
  return rows
    .filter((r) => r.pct != null && r.pct > r.max_pct + 0.005)
    .map((r) => ({
      line_number: r.line_number, item: r.item, discount_pct: round(r.pct, 1), max_pct: r.max_pct,
      approver_user_id: r.approver_user_id, approver: person(r, 'a'),
    }));
}

/* ------------------------------------------------------- quality reviews */

async function openQualityReview({ companyId, userId, role, workCenterId, title, finding, evidence }) {
  if (!seesMargins(role) && !can(role, 'MANUFACTURING_WRITE')) return { error: 'Your role cannot open a quality review.' };
  companyId = await resolveCompany(companyId);
  const { rows: wcs } = await pool.query(
    'SELECT id, code, name FROM work_centers WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
    [workCenterId && UUID.test(workCenterId) ? workCenterId : null, companyId],
  );
  if (!wcs.length) return { error: 'That work centre is not in this company.' };
  const wc = wcs[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`quality_reviews:${companyId}`]);
    const { rows: open } = await client.query(
      `SELECT id, review_number FROM quality_reviews WHERE company_id = $1 AND work_center_id = $2 AND status = 'OPEN'`,
      [companyId, wc.id],
    );
    if (open.length) {
      await client.query('COMMIT');
      return { kind: 'quality_review', id: open[0].id, reference: open[0].review_number, state: 'OPEN', already: true, work_center: wc.code, owner: 'Production', open_at: '/manufacturing/work-centers' };
    }
    const year = new Date().getUTCFullYear();
    const { rows: n } = await client.query(
      `SELECT COUNT(*)::int + 1 AS n FROM quality_reviews WHERE company_id = $1 AND review_number LIKE $2`,
      [companyId, `QR-${year}-%`],
    );
    const number = `QR-${year}-${String(n[0].n).padStart(4, '0')}`;
    const { rows } = await client.query(
      `INSERT INTO quality_reviews (company_id, review_number, work_center_id, title, finding, evidence, opened_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [companyId, number, wc.id, String(title || `Scrap on ${wc.code}`).slice(0, 250), finding || null,
        evidence ? JSON.stringify(evidence) : null, userId && UUID.test(userId) ? userId : null],
    );
    await client.query('COMMIT');
    return {
      kind: 'quality_review', id: rows[0].id, reference: number, state: 'OPEN', work_center: wc.code, owner: 'Production',
      next_step: 'Production sees it on the Work Centres screen and closes it with what they found.',
      open_at: '/manufacturing/work-centers',
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function closeQualityReview({ companyId, userId, role, id, outcome }) {
  if (!can(role, 'MANUFACTURING_WRITE')) return { error: 'Production closes quality reviews; your role does not.' };
  if (!outcome || !String(outcome).trim()) return { error: 'Say what was found and done.' };
  companyId = await resolveCompany(companyId);
  const { rows } = await pool.query(
    `UPDATE quality_reviews SET status = 'CLOSED', outcome = $3, closed_by = $4, closed_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND company_id = $2 AND status = 'OPEN' RETURNING id, review_number`,
    [id, companyId, String(outcome).trim(), userId],
  );
  if (!rows.length) return { error: 'No open review with that id.' };
  return { id, reference: rows[0].review_number, state: 'CLOSED' };
}

/* ------------------------------------------------------- what is waiting */

async function listFollowUps({ companyId, role, workCenterId = null }) {
  companyId = await resolveCompany(companyId);
  const money = seesMargins(role);
  const [rules, reviews] = await Promise.all([
    money || can(role, 'SALES_APPROVE')
      ? pool.query(
        `SELECT r.id, r.status, r.max_discount_pct::float AS max_discount_pct, r.reason, r.proposed_at, r.decided_at,
                r.proposed_by, i.item_code, i.name AS item_name,
                a.first_name AS a_first_name, a.last_name AS a_last_name, a.email AS a_email,
                p.first_name AS p_first_name, p.last_name AS p_last_name, p.email AS p_email
           FROM sales_discount_rules r
           JOIN items i ON i.id = r.item_id
           LEFT JOIN users a ON a.id = r.approver_user_id
           LEFT JOIN users p ON p.id = r.proposed_by
          WHERE r.company_id = $1 AND r.status IN ('PROPOSED', 'ACTIVE')
          ORDER BY r.status DESC, r.proposed_at DESC`,
        [companyId],
      ).then((r) => r.rows)
      : [],
    pool.query(
      `SELECT q.id, q.review_number, q.status, q.title, q.finding, q.evidence, q.opened_at,
              wc.id AS work_center_id, wc.code AS work_center_code, wc.name AS work_center_name,
              o.first_name AS o_first_name, o.last_name AS o_last_name, o.email AS o_email
         FROM quality_reviews q
         LEFT JOIN work_centers wc ON wc.id = q.work_center_id
         LEFT JOIN users o ON o.id = q.opened_by
        WHERE q.company_id = $1 AND q.status = 'OPEN' AND ($2::uuid IS NULL OR q.work_center_id = $2::uuid)
        ORDER BY q.opened_at DESC`,
      [companyId, workCenterId],
    ).then((r) => r.rows),
  ]);
  return {
    discount_rules: rules.map((r) => ({
      id: r.id, state: r.status, item: r.item_code || r.item_name, item_name: r.item_name, max_discount_pct: r.max_discount_pct,
      reason: r.reason, approver: person(r, 'a'), proposed_by: person(r, 'p'), proposed_by_id: r.proposed_by,
      proposed_at: r.proposed_at, decided_at: r.decided_at,
    })),
    quality_reviews: reviews.map((q) => {
      const ev = q.evidence || {};
      return {
        id: q.id, reference: q.review_number, state: q.status, title: q.title, finding: q.finding,
        work_center: { id: q.work_center_id, code: q.work_center_code, name: q.work_center_name },
        evidence: money ? ev : { scrap_pct_now: ev.scrap_pct_now, scrap_pct_baseline: ev.scrap_pct_baseline, extra_units: ev.extra_units },
        opened_by: person(q, 'o'), opened_at: q.opened_at,
      };
    }),
  };
}

/* ------------------------------------------------- prepare them all at once */

/**
 * Run the margin analysis again and draft every follow-up it proposes now
 * (or only the kinds asked for). Returns what was drafted, what was already
 * there, and what waits on someone else.
 */
async function prepareFollowUps(opts = {}) {
  const { companyId: cid, userId, role } = opts;
  if (!seesMargins(role)) return { error: 'Margins expose costs and prices across every customer; your role does not see them.' };
  const companyId = await resolveCompany(cid);
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds.filter((k) => KINDS.includes(k)) : KINDS;
  const margin = await explainMargin({ ...opts, companyId, limit: opts.limit || 5 });
  if (margin.error) return margin;

  const results = [];
  for (const d of margin.drivers || []) {
    for (const p of d.proposals || []) {
      if (!kinds.includes(p.kind)) continue;
      let r;
      if (p.kind === 'rfq') {
        r = await draftRfq({ companyId, userId, role, args: p.args });
      } else if (p.kind === 'approval_rule') {
        r = await proposeDiscountRule({
          companyId, userId, role, itemId: p.args?.item_id, itemCode: p.args?.item_code,
          maxDiscountPct: p.args?.max_discount_pct, reason: `${d.name}: ${d.detail}`, evidence: d.evidence,
        });
      } else if (p.kind === 'quality_review') {
        r = await openQualityReview({
          companyId, userId, role, workCenterId: p.args?.work_center_id,
          title: p.args?.title, finding: `${d.name}: ${d.detail}`, evidence: d.evidence,
        });
      }
      if (!r) continue;
      results.push({ ...r, kind: p.kind, label: p.label, driver: d.name, state: r.state || (r.error ? 'failed' : undefined), note: r.note || r.error });
    }
  }
  const drafted = results.filter((r) => ['DRAFT', 'PROPOSED', 'OPEN'].includes(r.state) && !r.already);
  return {
    headline: margin.headline,
    prepared: results,
    summary: results.length
      ? `${drafted.length} drafted, ${results.filter((r) => r.already).length} already waiting, ${results.filter((r) => !['DRAFT', 'PROPOSED', 'OPEN', 'ACTIVE'].includes(r.state)).length} left to their owner. Each awaits its owner; nothing is sent, enforced or closed until they act.`
      : 'The margin analysis proposes nothing to draft right now.',
  };
}

module.exports = {
  prepareFollowUps,
  proposeDiscountRule,
  decideDiscountRule,
  discountBreaches,
  openQualityReview,
  closeQualityReview,
  listFollowUps,
};
