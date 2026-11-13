/**
 * An invoice arrives twice — and is not paid twice.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * The website's homepage scenario: "INV-7731 from Nordbay posted · €3,212.40 →
 * matches PO-2240, already invoiced once → GRN-5521, goods received once, not
 * twice → INV-7719 paid 6 days ago, same supplier, same amount → Simeli
 * proposes hold_payment → the Gateway escalates: payment tools need a person."
 *
 * For one supplier bill it reads, from this company's own records:
 *
 *   Siblings   the same supplier's other live bills that carry the same vendor
 *              reference, the same amount within 45 days, or the same purchase
 *              order — each with what has been paid on it and when.
 *   Order      the purchase order the bill is for (its own link, or the link of
 *              the sibling it duplicates), what was ordered, what the other
 *              bills have already claimed against it.
 *   Receipts   the goods receipts on that order and what they are worth at the
 *              order's prices (tax in the order's proportion) — what the
 *              supplier has actually delivered, once.
 *
 * and comes back with a verdict — duplicate / overbilled / possible_duplicate /
 * clear — the amount that would be paid for nothing, the chain of evidence
 * (each step naming its record), and proposals.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It moves no money and changes no bill. The hold is a proposal: a finance
 * manager, manager or admin places it (holdPayment), on the Supplier invoices
 * screen or by approving Simeli's hold_supplier_payment — which the Gateway
 * classifies as a payment action and escalates to a person. While a hold is
 * on, SupplierPayment refuses to allocate to the bill and the payment run
 * leaves it out. The only thing written without a person is the finding (and
 * the finance approvers' notification) when a bill that looks like a second
 * copy is recorded.
 *
 * Company-scoped throughout; only roles that see payables (admin, manager,
 * finance manager, finance user) read it.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');

const SEES_PAYABLES = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER', 'FINANCE_USER']);
const HOLDERS = new Set(['ADMIN', 'MANAGER', 'FINANCE_MANAGER']);
const DAY_WINDOW = 45;
const TOLERANCE_PCT = 0.01;
const TOLERANCE_ABS = 0.05;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const daysBetween = (a, b) => Math.round(Math.abs(new Date(a) - new Date(b)) / 86400000);

function money(v, cur) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur || 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v) || 0);
  } catch {
    return `${round2(v).toFixed(2)} ${cur || ''}`.trim();
  }
}

function ago(d, today = new Date()) {
  if (!d) return null;
  const n = Math.round((new Date(iso(today)) - new Date(iso(d))) / 86400000);
  if (n === 0) return 'today';
  if (n === 1) return 'yesterday';
  return n > 0 ? `${n} days ago` : `in ${-n} days`;
}

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

const sameRef = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase() && String(a).trim() !== '';

/* ------------------------------------------------------------------ reads */

const BILL_COLS = `
  si.id, si.bill_number, si.supplier_invoice_number, si.supplier_id, si.purchase_order_id, si.invoice_date,
  si.due_date, si.currency, si.total_amount::float AS total, si.paid_amount::float AS paid,
  si.outstanding_amount::float AS outstanding, si.status, si.created_at,
  si.payment_hold, si.payment_hold_reason, si.payment_held_at,
  NULLIF(trim(concat_ws(' ', hu.first_name, hu.last_name)), '') AS held_by_name,
  s.legal_name AS supplier_name, po.po_number`;

const BILL_FROM = `
  FROM supplier_invoices si
  LEFT JOIN suppliers s ON s.id = si.supplier_id
  LEFT JOIN purchase_orders po ON po.id = si.purchase_order_id AND po.company_id = si.company_id
  LEFT JOIN users hu ON hu.id = si.payment_held_by`;

async function readBill(companyId, ref) {
  const r = String(ref || '').trim();
  if (!r) return null;
  const { rows } = await pool.query(
    `SELECT ${BILL_COLS} ${BILL_FROM}
      WHERE si.company_id = $1 AND si.deleted_at IS NULL
        AND ${UUID.test(r) ? 'si.id = $2::uuid' : '(si.bill_number ILIKE $2 OR si.supplier_invoice_number ILIKE $2)'}
      ORDER BY si.created_at DESC LIMIT 1`,
    [companyId, r],
  );
  return rows[0] || null;
}

/** The same supplier's other live bills that could be this one again. */
async function readSiblings(companyId, bill) {
  const { rows } = await pool.query(
    `SELECT ${BILL_COLS},
            (SELECT MAX(sp.payment_date) FROM supplier_payment_allocations spa
               JOIN supplier_payments sp ON sp.id = spa.payment_id AND sp.deleted_at IS NULL
              WHERE spa.bill_id = si.id) AS last_paid_on
       ${BILL_FROM}
      WHERE si.company_id = $1 AND si.deleted_at IS NULL AND si.status <> 'CANCELLED'
        AND si.id <> $2 AND si.supplier_id = $3
        AND (
          (NULLIF(trim(si.supplier_invoice_number), '') IS NOT NULL
             AND lower(trim(si.supplier_invoice_number)) = lower(trim(COALESCE($4, ''))))
          OR (si.total_amount = $5 AND ABS(si.invoice_date - $6::date) <= $7)
          OR ($8::uuid IS NOT NULL AND si.purchase_order_id = $8::uuid)
        )
      ORDER BY si.invoice_date, si.created_at
      LIMIT 20`,
    [companyId, bill.id, bill.supplier_id, bill.supplier_invoice_number, bill.total, iso(bill.invoice_date), DAY_WINDOW, bill.purchase_order_id],
  );
  return rows;
}

/** What was ordered, what was received (valued at the order's prices) and what has been billed on it. */
async function readOrder(companyId, poId, billId) {
  const { rows: [po] } = await pool.query(
    `SELECT id, po_number, status, currency, subtotal::float AS subtotal, tax_amount::float AS tax, total_amount::float AS total
       FROM purchase_orders WHERE id = $1 AND company_id = $2`,
    [poId, companyId],
  );
  if (!po) return null;
  const [{ rows: [rec] }, { rows: grns }, { rows: [billed] }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(gr.quantity_received * l.unit_price), 0)::float AS net,
              COALESCE(SUM(gr.quantity_received), 0)::float AS qty
         FROM goods_receipts gr JOIN purchase_order_line_items l ON l.id = gr.po_line_item_id
        WHERE gr.po_id = $1 AND gr.company_id = $2`,
      [poId, companyId],
    ),
    pool.query(
      `SELECT gr.id, gr.received_date, gr.quantity_received::float AS qty, l.item_description
         FROM goods_receipts gr LEFT JOIN purchase_order_line_items l ON l.id = gr.po_line_item_id
        WHERE gr.po_id = $1 AND gr.company_id = $2 ORDER BY gr.received_date`,
      [poId, companyId],
    ),
    pool.query(
      `SELECT COALESCE(SUM(total_amount), 0)::float AS other_billed, COUNT(*)::int AS other_bills,
              COALESCE(SUM(paid_amount), 0)::float AS other_paid
         FROM supplier_invoices
        WHERE purchase_order_id = $1 AND company_id = $2 AND id <> $3 AND deleted_at IS NULL AND status <> 'CANCELLED'`,
      [poId, companyId, billId],
    ),
  ]);
  // Receipts are valued net at the order's line prices; bills carry tax, so
  // gross them up in the order's own proportion.
  const gross = po.subtotal > 0 ? po.total / po.subtotal : 1;
  return {
    ...po,
    received_qty: rec.qty,
    received_value: round2(rec.net * gross),
    receipts: grns.map((g) => ({ id: g.id, date: iso(g.received_date), qty: g.qty, item: g.item_description })),
    other_billed: round2(billed.other_billed),
    other_bills: billed.other_bills,
    other_paid: round2(billed.other_paid),
  };
}

/* ------------------------------------------------------------------ check */

/**
 * One bill: is it a second copy, does it bill more than was delivered, and
 * what would paying it cost for nothing.
 */
async function checkBill(opts = {}) {
  const role = String(opts.role || '').toUpperCase();
  if (opts.userId && role && !SEES_PAYABLES.has(role)) {
    return { error: 'Supplier bills are visible to finance, managers and admins only.', status: 403 };
  }
  const companyId = await resolveCompany(opts.companyId);
  const today = opts.today || new Date();
  const bill = opts.billRow || (await readBill(companyId, opts.bill));
  if (!bill) return { error: `No supplier bill "${opts.bill}" in this company.`, status: 404 };

  const cur = bill.currency || 'USD';
  const siblings = (await readSiblings(companyId, bill)).map((s) => {
    const reasons = [];
    if (sameRef(s.supplier_invoice_number, bill.supplier_invoice_number)) reasons.push('same_reference');
    const apart = daysBetween(s.invoice_date, bill.invoice_date);
    if (round2(s.total) === round2(bill.total) && apart <= DAY_WINDOW) reasons.push('same_amount');
    if (bill.purchase_order_id && s.purchase_order_id === bill.purchase_order_id) reasons.push('same_order');
    // The copy is the one recorded second: an earlier bill is never the
    // duplicate of a later one.
    const earlier = new Date(s.created_at) < new Date(bill.created_at);
    return { ...s, reasons, days_apart: apart, earlier };
  }).filter((s) => s.reasons.length);

  const copies = siblings.filter((s) => s.earlier && (s.reasons.includes('same_reference')
    || (s.reasons.includes('same_amount') && (s.reasons.includes('same_order') || s.days_apart === 0))));
  const sameAmount = siblings.filter((s) => s.earlier && s.reasons.includes('same_amount'));
  const laterCopies = siblings.filter((s) => !s.earlier && (s.reasons.includes('same_reference') || s.reasons.includes('same_amount')));

  // The order: the bill's own, or — for a bill booked without one — the order
  // of the bill it repeats.
  const twin = copies[0] || sameAmount[0] || null;
  const poId = bill.purchase_order_id || twin?.purchase_order_id || null;
  const order = poId ? await readOrder(companyId, poId, bill.id) : null;
  const orderInferred = !!order && !bill.purchase_order_id;

  // Billed against what was delivered. For an inferred order, the bill being
  // checked is counted on top of everything already billed on it.
  let excess = 0;
  let billedTotal = null;
  if (order) {
    billedTotal = round2(order.other_billed + bill.total);
    const allowance = Math.max(order.received_value * TOLERANCE_PCT, TOLERANCE_ABS);
    if (billedTotal > order.received_value + allowance) excess = round2(Math.min(bill.total, billedTotal - order.received_value));
  }
  const alreadyBilledInFull = !!order && order.other_billed > 0 && order.other_billed + Math.max(order.received_value * TOLERANCE_PCT, TOLERANCE_ABS) >= order.received_value;
  if (!copies.length && alreadyBilledInFull && sameAmount.length) copies.push(sameAmount[0]);

  let verdict = 'clear';
  if (copies.length) verdict = 'duplicate';
  else if (excess > 0) verdict = 'overbilled';
  else if (sameAmount.length) verdict = 'possible_duplicate';

  const atStake = verdict === 'duplicate' ? round2(bill.total) : verdict === 'overbilled' ? excess : verdict === 'possible_duplicate' ? round2(bill.total) : 0;
  const unpaidAtStake = round2(Math.min(atStake, bill.outstanding));
  const alreadyPaidTwice = verdict !== 'clear' && verdict !== 'possible_duplicate' && bill.paid > 0
    && (copies.some((c) => c.paid > 0) || verdict === 'overbilled');

  /* ---- the chain, in the order the website walks it ---- */
  const chain = [];
  const billRec = { type: 'supplier_invoice', id: bill.id, label: bill.bill_number };
  chain.push({
    layer: 'finance',
    text: `${bill.supplier_invoice_number || bill.bill_number} from ${bill.supplier_name || 'the supplier'} recorded · ${money(bill.total, cur)}${bill.supplier_invoice_number ? ` (${bill.bill_number})` : ''}`,
    record: billRec,
  });
  if (order) {
    const claimed = order.other_bills
      ? `already billed ${money(order.other_billed, cur)} on ${order.other_bills} other bill${order.other_bills === 1 ? '' : 's'}`
      : 'nothing else billed on it yet';
    chain.push({
      layer: 'procurement',
      text: `${orderInferred ? `Matches ${order.po_number} through ${twin.bill_number}` : `Against ${order.po_number}`} · ordered ${money(order.total, cur)}, ${claimed}`,
      record: { type: 'purchase_order', id: order.id, label: order.po_number },
      tone: order.other_bills && alreadyBilledInFull ? 'warn' : undefined,
    });
    chain.push({
      layer: 'warehouse',
      text: order.receipts.length
        ? `${order.receipts.length} goods receipt${order.receipts.length === 1 ? '' : 's'} on ${order.po_number} · ${order.received_qty} received, worth ${money(order.received_value, cur)}${billedTotal != null && billedTotal > order.received_value ? ` — billed ${money(billedTotal, cur)}` : ''}`
        : `Nothing received on ${order.po_number} yet — the goods have not been confirmed as delivered`,
      record: { type: 'purchase_order', id: order.id, label: order.po_number },
      tone: excess > 0 || !order.receipts.length ? 'risk' : undefined,
    });
  }
  for (const s of (copies.length ? copies : sameAmount).slice(0, 3)) {
    const why = [
      s.reasons.includes('same_reference') ? `same vendor reference ${s.supplier_invoice_number}` : null,
      s.reasons.includes('same_amount') ? 'same amount' : null,
      s.reasons.includes('same_order') ? 'same order' : null,
    ].filter(Boolean).join(', ');
    const paidTxt = s.paid > 0
      ? `${s.outstanding > 0 ? 'part paid' : 'paid'} ${ago(s.last_paid_on, today) || ''}`.trim()
      : s.status === 'APPROVED' || s.status === 'OVERDUE' ? 'approved, waiting to be paid' : s.status.toLowerCase().replace('_', ' ');
    chain.push({
      layer: 'finance',
      text: `${s.supplier_invoice_number && s.supplier_invoice_number !== bill.supplier_invoice_number ? `${s.supplier_invoice_number} (${s.bill_number})` : s.bill_number} ${paidTxt} · ${why}`,
      record: { type: 'supplier_invoice', id: s.id, label: s.bill_number },
      tone: s.paid > 0 ? 'risk' : 'warn',
    });
  }

  /* ---- headline ---- */
  let headline;
  if (verdict === 'duplicate') {
    const c = copies[0];
    headline = `${bill.bill_number} looks like a second copy of ${c.bill_number}${c.paid > 0 ? `, which was paid ${ago(c.last_paid_on, today)}` : ''}. ${unpaidAtStake > 0 ? `${money(unpaidAtStake, cur)} would be paid for goods already billed.` : bill.paid > 0 ? `It has already been paid — ${money(bill.paid, cur)} to recover.` : ''}`.trim();
  } else if (verdict === 'overbilled') {
    headline = `${bill.bill_number} takes billing on ${order.po_number} to ${money(billedTotal, cur)} against ${money(order.received_value, cur)} received — ${money(excess, cur)} more than was delivered.`;
  } else if (verdict === 'possible_duplicate') {
    headline = `${bill.bill_number} has the same amount as ${sameAmount[0].bill_number} from ${bill.supplier_name || 'the same supplier'}, ${sameAmount[0].days_apart} day${sameAmount[0].days_apart === 1 ? '' : 's'} apart, with a different reference. Worth a look before paying.`;
  } else {
    headline = order
      ? `${bill.bill_number} is the only claim on what ${order.po_number} delivered. Nothing points to it being billed twice.`
      : `${bill.bill_number}: no other bill from ${bill.supplier_name || 'this supplier'} with the same reference or amount.`;
  }
  if (verdict === 'clear' && laterCopies.length) {
    headline += ` ${laterCopies.map((c) => c.bill_number).join(', ')}, recorded later, ${laterCopies.length === 1 ? 'repeats' : 'repeat'} it — check ${laterCopies.length === 1 ? 'that one' : 'those'} before paying.`;
  }
  if (bill.payment_hold) headline += ` Payment is on hold${bill.held_by_name ? ` (${bill.held_by_name})` : ''}.`;

  /* ---- proposals: AI proposes, a person decides ---- */
  const proposals = [];
  if (verdict !== 'clear' && !bill.payment_hold && bill.outstanding > 0 && bill.status !== 'CANCELLED') {
    const reason = verdict === 'duplicate'
      ? `Second copy of ${copies[0].bill_number}${copies[0].supplier_invoice_number ? ` (${copies[0].supplier_invoice_number})` : ''}`
      : verdict === 'overbilled'
        ? `Billed ${money(excess, cur)} beyond what was received on ${order.po_number}`
        : `Same amount as ${sameAmount[0].bill_number} — confirm with the supplier`;
    proposals.push({
      action: 'hold_payment',
      tool: 'hold_supplier_payment',
      label: `Hold payment on ${bill.bill_number}`,
      args: { bill: bill.bill_number, reason },
      who_approves: 'A finance manager, manager or admin',
    });
  }
  if (verdict === 'duplicate' || verdict === 'overbilled' || verdict === 'possible_duplicate') {
    const ref = bill.supplier_invoice_number || bill.bill_number;
    const prior = (copies[0] || sameAmount[0]);
    proposals.push({
      action: 'ask_supplier',
      label: alreadyPaidTwice ? `Ask ${bill.supplier_name || 'the supplier'} for a credit note` : `Ask ${bill.supplier_name || 'the supplier'} to confirm`,
      draft: {
        subject: `Invoice ${ref}${prior ? ` and ${prior.supplier_invoice_number || prior.bill_number}` : ''}`,
        body: verdict === 'overbilled'
          ? `Hello,\n\nYour invoice ${ref} brings what we have been billed on ${order.po_number} to ${money(billedTotal, cur)}, while we have received goods worth ${money(order.received_value, cur)} on it. Could you check the invoice, or tell us which delivery it covers?\n\nWe have held payment on it until we hear from you.\n\nThank you.`
          : `Hello,\n\nWe have received invoice ${ref} for ${money(bill.total, cur)}. It appears to repeat invoice ${prior.supplier_invoice_number || prior.bill_number}${prior.invoice_date ? ` of ${iso(prior.invoice_date)}` : ''}, for the same amount${prior.paid > 0 ? ', which we have already paid' : ''}.${alreadyPaidTwice ? ' Both have been paid; please send a credit note for the second.' : ' Could you confirm whether it is a duplicate, and cancel it if so?'}\n\nWe have held payment on it until we hear from you.\n\nThank you.`,
      },
    });
  }
  if (verdict === 'duplicate' && bill.paid === 0 && bill.status !== 'CANCELLED') {
    proposals.push({
      action: 'cancel_bill',
      label: `Cancel ${bill.bill_number} once the supplier confirms`,
      where: 'Supplier invoices → status Cancelled (manager or admin)',
    });
  }

  const sources = [
    `supplier_invoices: ${bill.bill_number} and ${siblings.length} other bill${siblings.length === 1 ? '' : 's'} from the same supplier (same reference, same amount within ${DAY_WINDOW} days, or same order)`,
    order ? `purchase_orders / purchase_order_line_items: ${order.po_number}` : null,
    order ? `goods_receipts: ${order.receipts.length} on ${order.po_number}, valued at the order's line prices` : null,
    'supplier_payment_allocations / supplier_payments: what was paid on each bill and when',
  ].filter(Boolean);

  return {
    bill: {
      id: bill.id, bill_number: bill.bill_number, vendor_ref: bill.supplier_invoice_number, supplier: bill.supplier_name,
      supplier_id: bill.supplier_id, invoice_date: iso(bill.invoice_date), status: bill.status, currency: cur,
      total: round2(bill.total), paid: round2(bill.paid), outstanding: round2(bill.outstanding),
      payment_hold: !!bill.payment_hold, hold_reason: bill.payment_hold_reason || null,
      held_by: bill.held_by_name || null, held_at: bill.payment_held_at || null,
    },
    verdict,
    headline,
    at_stake: atStake,
    unpaid_at_stake: unpaidAtStake,
    already_paid_twice: alreadyPaidTwice,
    order: order && {
      id: order.id, po_number: order.po_number, inferred: orderInferred, ordered: round2(order.total),
      received_value: order.received_value, received_qty: order.received_qty, receipts: order.receipts.length,
      billed_on_other_bills: order.other_billed, billed_including_this: billedTotal,
    },
    others: siblings.map((s) => ({
      id: s.id, bill_number: s.bill_number, vendor_ref: s.supplier_invoice_number, invoice_date: iso(s.invoice_date),
      total: round2(s.total), paid: round2(s.paid), status: s.status, last_paid_on: iso(s.last_paid_on),
      days_apart: s.days_apart, reasons: s.reasons, po_number: s.po_number, recorded: s.earlier ? 'earlier' : 'later',
    })),
    chain,
    proposals,
    sources,
  };
}

/**
 * Every open bill that looks like a second copy or bills beyond what was
 * delivered, worst first — and every bill on hold, so a held bill never drops
 * out of sight.
 */
async function scanBills(opts = {}) {
  const role = String(opts.role || '').toUpperCase();
  if (opts.userId && role && !SEES_PAYABLES.has(role)) {
    return { error: 'Supplier bills are visible to finance, managers and admins only.', status: 403 };
  }
  const companyId = await resolveCompany(opts.companyId);
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 25, 1), 100);
  // Candidates: open or awaiting approval, and either sharing a reference,
  // an amount (within the window) or an order with another live bill of the
  // same supplier, or on hold. One query; the full check runs only on these.
  const { rows } = await pool.query(
    `SELECT ${BILL_COLS} ${BILL_FROM}
      WHERE si.company_id = $1 AND si.deleted_at IS NULL
        AND (si.payment_hold OR (si.outstanding_amount > 0 AND si.status NOT IN ('CANCELLED', 'PAID')))
        AND (si.payment_hold OR si.purchase_order_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM supplier_invoices o
           WHERE o.company_id = si.company_id AND o.supplier_id = si.supplier_id AND o.id <> si.id
             AND o.deleted_at IS NULL AND o.status <> 'CANCELLED'
             AND ((NULLIF(trim(o.supplier_invoice_number), '') IS NOT NULL
                   AND lower(trim(o.supplier_invoice_number)) = lower(trim(COALESCE(si.supplier_invoice_number, ''))))
                  OR (o.total_amount = si.total_amount AND ABS(o.invoice_date - si.invoice_date) <= $2))))
      ORDER BY si.payment_hold DESC, si.due_date ASC
      LIMIT 300`,
    [companyId, DAY_WINDOW],
  );
  const flagged = [];
  for (const b of rows) {
    const r = await checkBill({ companyId, billRow: b, today: opts.today });
    if (r.error) continue;
    if (r.verdict !== 'clear' || r.bill.payment_hold) flagged.push(r);
  }
  const rank = { duplicate: 0, overbilled: 1, possible_duplicate: 2, clear: 3 };
  flagged.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.unpaid_at_stake - a.unpaid_at_stake);
  const open = flagged.filter((f) => f.verdict !== 'clear');
  const byCur = {};
  for (const f of open) {
    if (f.bill.payment_hold) continue;
    byCur[f.bill.currency] = round2((byCur[f.bill.currency] || 0) + f.unpaid_at_stake);
  }
  const unheld = open.filter((f) => !f.bill.payment_hold);
  return {
    checked: rows.length,
    flagged: flagged.length,
    unheld: unheld.length,
    at_stake_unheld: byCur,
    headline: !open.length
      ? `Checked ${rows.length} open bill${rows.length === 1 ? '' : 's'}: none looks like a second copy or bills more than was delivered.`
      : `${open.length} bill${open.length === 1 ? '' : 's'} look${open.length === 1 ? 's' : ''} billed twice or beyond what was received${unheld.length ? ` — ${unheld.length} not on hold, ${Object.entries(byCur).map(([c, v]) => money(v, c)).join(' + ')} still payable` : ', all on hold'}.`,
    bills: flagged.slice(0, limit),
  };
}

/* ------------------------------------------------------------------ act */

async function holdPayment({ companyId: given, userId, role, bill: ref, reason }) {
  if (!HOLDERS.has(String(role || '').toUpperCase())) {
    return { error: 'Only a finance manager, manager or admin can hold a supplier payment.', status: 403 };
  }
  const companyId = await resolveCompany(given);
  const bill = await readBill(companyId, ref);
  if (!bill) return { error: `No supplier bill "${ref}" in this company.`, status: 404 };
  if (bill.payment_hold) return { already: true, bill_number: bill.bill_number, message: `${bill.bill_number} is already on hold${bill.payment_hold_reason ? `: ${bill.payment_hold_reason}` : ''}.` };
  if (bill.status === 'CANCELLED') return { error: `${bill.bill_number} is cancelled; there is nothing to hold.`, status: 409 };
  const why = String(reason || '').trim().slice(0, 500) || 'Held for review';
  await pool.query(
    `UPDATE supplier_invoices
        SET payment_hold = TRUE, payment_hold_reason = $3, payment_held_by = $4, payment_held_at = CURRENT_TIMESTAMP,
            payment_hold_released_by = NULL, payment_hold_released_at = NULL, updated_by = $4, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND company_id = $2`,
    [bill.id, companyId, why, userId || null],
  );
  // The finding that raised it, if any, is now handled.
  await pool.query(
    `UPDATE ai_findings SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP, acknowledged_by = $3, acknowledged_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND entity_type = 'SUPPLIER_INVOICE' AND entity_id = $2 AND finding_type = 'BILLED_TWICE' AND status = 'OPEN'`,
    [companyId, bill.id, userId || null],
  ).catch(() => {});
  return {
    held: true,
    bill_number: bill.bill_number,
    reason: why,
    message: `Payment on ${bill.bill_number} (${money(bill.outstanding, bill.currency)} outstanding) is on hold: ${why}. No payment can be allocated to it, and the payment run leaves it out, until it is released.`,
  };
}

async function releaseHold({ companyId: given, userId, role, bill: ref }) {
  if (!HOLDERS.has(String(role || '').toUpperCase())) {
    return { error: 'Only a finance manager, manager or admin can release a payment hold.', status: 403 };
  }
  const companyId = await resolveCompany(given);
  const bill = await readBill(companyId, ref);
  if (!bill) return { error: `No supplier bill "${ref}" in this company.`, status: 404 };
  if (!bill.payment_hold) return { already: true, bill_number: bill.bill_number, message: `${bill.bill_number} is not on hold.` };
  await pool.query(
    `UPDATE supplier_invoices
        SET payment_hold = FALSE, payment_hold_released_by = $3, payment_hold_released_at = CURRENT_TIMESTAMP,
            updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND company_id = $2`,
    [bill.id, companyId, userId || null],
  );
  return { released: true, bill_number: bill.bill_number, message: `${bill.bill_number} can be paid again.` };
}

/* ------------------------------------------------------------- the watch */

/** Finance approvers of THIS company only — never another tenant's. */
async function notifyApprovers(companyId, result, findingId) {
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
       LEFT JOIN user_companies uc ON uc.user_id = u.id AND uc.company_id = $1
      WHERE COALESCE(uc.role, u.role) IN ('MANAGER', 'ADMIN', 'FINANCE_MANAGER')
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
        `Billed twice? ${result.bill.bill_number}`.slice(0, 255),
        result.headline,
        JSON.stringify({ finding_id: findingId, bill_id: result.bill.id, link: `/finance/supplier-invoices?invoice=${result.bill.id}` }),
        u.id,
        companyId,
      ],
    );
  }
}

/**
 * Raise the finding for one bill when it looks like a second copy or bills
 * beyond what was received. Called when a bill is recorded and by the scan.
 */
async function raiseBillFinding(companyId, billId) {
  const resolved = await resolveCompany(companyId);
  const r = await checkBill({ companyId: resolved, bill: billId });
  if (r.error || r.verdict === 'clear' || r.verdict === 'possible_duplicate' || r.bill.payment_hold) return { created: false };
  const { upsertFinding } = require('./ai/findingsScan');
  const f = await upsertFinding({
    companyId: resolved,
    finding_type: 'BILLED_TWICE',
    severity: r.unpaid_at_stake > 0 ? 'HIGH' : 'MEDIUM',
    entity_type: 'SUPPLIER_INVOICE',
    entity_id: r.bill.id,
    title: r.headline.slice(0, 255),
    description: r.chain.map((s) => s.text).join(' → '),
    data: { verdict: r.verdict, at_stake: r.at_stake, unpaid_at_stake: r.unpaid_at_stake, currency: r.bill.currency, proposals: r.proposals.map((p) => p.label) },
  });
  if (f.created) await notifyApprovers(resolved, r, f.id).catch((e) => console.warn('Billed-twice notify failed:', e.message));
  return { created: f.created, id: f.id };
}

/** Fire-and-forget after a bill is recorded. Never throws into the request. */
function checkAfterRecording(companyId, billId) {
  setImmediate(async () => {
    try {
      const run = () => raiseBillFinding(companyId, billId);
      if (companyId) await companyContext.runWithCompany(companyId, run);
      else await run();
    } catch (e) {
      console.warn('Billed-twice check after recording failed:', e.message);
    }
  });
}

module.exports = { checkBill, scanBills, holdPayment, releaseHold, raiseBillFinding, checkAfterRecording, SEES_PAYABLES, HOLDERS };
