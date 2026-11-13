const { pool } = require('../config/database');

/**
 * Payment run optimizer — which supplier bills to pay today, and why.
 *
 * Every open bill carries its terms as free text ("2/10 Net 30", "1.5/15 n/45",
 * "Net 30"). An early-payment discount is a loan the business can make to its
 * supplier at a rate most treasurers never compute: 2/10 net 30 pays 2% for
 * settling 20 days early, which is ~37% annualised. Nobody notices it in an AP
 * list sorted by due date, so the discount window closes and the money is lost.
 *
 * This reads the open payables, prices each discount as an annualised return,
 * and fills a cash budget in priority order:
 *   1. discounts whose window is still open and whose return beats the hurdle
 *      rate (best return first) — every one of these is money left on the table
 *   2. overdue bills (oldest first) — late fees and supplier goodwill
 *   3. bills falling due inside the horizon (soonest first)
 * Anything left is held, with the date it becomes due.
 *
 * It recommends; it does not pay. Settlement still goes through
 * /supplier-payments so approval and GL posting stay where they are.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Parse free-text payment terms. Returns
 *   { discountPct, discountDays, netDays } — discountPct null when none.
 * Accepts "2/10 Net 30", "2/10, n/30", "2% 10 net 30", "1.5/15 N45", "Net 30",
 * "30 days", "Due on receipt". Returns null for text it cannot read.
 */
function parseTerms(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/due on receipt|on receipt|immediate|\bcod\b|cash on delivery/.test(t)) {
    return { discountPct: null, discountDays: null, netDays: 0 };
  }
  const net = t.match(/(?:net|n)\s*\/?\s*(\d{1,3})/) || t.match(/(\d{1,3})\s*days?/);
  const disc = t.match(/(\d{1,2}(?:\.\d+)?)\s*%?\s*[/ ]\s*(\d{1,3})(?=\s*(?:days?)?\s*[, ]*\s*(?:net|n\b|n\/|n\s*\d|$))/);
  const netDays = net ? parseInt(net[1], 10) : null;
  if (disc) {
    const discountPct = parseFloat(disc[1]);
    const discountDays = parseInt(disc[2], 10);
    if (discountPct > 0 && discountPct < 50 && (netDays === null || discountDays < netDays)) {
      return { discountPct, discountDays, netDays: netDays ?? 30 };
    }
  }
  return netDays !== null ? { discountPct: null, discountDays: null, netDays } : null;
}

/** Annualised return of taking a discount: (d / (1 - d)) × 365 / (net - discount days). */
function annualisedReturn(discountPct, discountDays, netDays) {
  const d = discountPct / 100;
  const period = netDays - discountDays;
  if (period <= 0 || d <= 0 || d >= 1) return null;
  return (d / (1 - d)) * (365 / period) * 100;
}

const toDate = (v) => {
  if (v instanceof Date) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
  return new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
};
const iso = (d) => d.toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((b - a) / DAY_MS);

/**
 * Classify a bill and price its discount. Pure — no database — so the planner
 * below and any caller (an agent, a test) see the same arithmetic.
 */
function assessBill(bill, today, { hurdleRate, horizonDays }) {
  const outstanding = Number(bill.outstanding_amount ?? (Number(bill.total_amount) - Number(bill.paid_amount || 0)));
  const invoiceDate = toDate(bill.invoice_date);
  const dueDate = toDate(bill.due_date);
  const terms = parseTerms(bill.payment_terms || bill.supplier_terms);

  const out = {
    id: bill.id,
    bill_number: bill.bill_number,
    supplier_invoice_number: bill.supplier_invoice_number || null,
    supplier_id: bill.supplier_id,
    supplier_name: bill.supplier_name || null,
    currency: bill.currency || 'USD',
    payment_terms: bill.payment_terms || bill.supplier_terms || null,
    invoice_date: iso(invoiceDate),
    due_date: iso(dueDate),
    days_to_due: daysBetween(today, dueDate),
    outstanding: round2(outstanding),
    discount: null,
    category: 'HOLD',
    reason: '',
  };

  // A discount only applies to a bill nobody has started paying — a part
  // payment already missed the "pay the whole thing early" bargain.
  if (terms && terms.discountPct && Number(bill.paid_amount || 0) === 0) {
    const deadline = new Date(invoiceDate.getTime() + terms.discountDays * DAY_MS);
    const daysLeft = daysBetween(today, deadline);
    const apr = annualisedReturn(terms.discountPct, terms.discountDays, terms.netDays);
    const amount = round2(outstanding * terms.discountPct / 100);
    out.discount = {
      pct: terms.discountPct,
      deadline: iso(deadline),
      days_left: daysLeft,
      amount,
      pay_amount: round2(outstanding - amount),
      annualised_return: apr === null ? null : round2(apr),
      open: daysLeft >= 0,
    };
    if (daysLeft >= 0 && apr !== null && apr >= hurdleRate) {
      out.category = 'CAPTURE_DISCOUNT';
      out.reason = `Pay by ${iso(deadline)} to save ${amount.toFixed(2)} ${out.currency} — ${apr.toFixed(1)}% annualised, above the ${hurdleRate}% hurdle`;
      return out;
    }
  }

  if (out.days_to_due < 0) {
    out.category = 'OVERDUE';
    out.reason = `${-out.days_to_due} day${out.days_to_due === -1 ? '' : 's'} past due`;
  } else if (out.days_to_due <= horizonDays) {
    out.category = 'DUE_SOON';
    out.reason = out.days_to_due === 0 ? 'Due today' : `Due in ${out.days_to_due} day${out.days_to_due === 1 ? '' : 's'}`;
  } else {
    out.reason = out.discount && out.discount.open
      ? `Discount returns ${out.discount.annualised_return}% annualised, below the ${hurdleRate}% hurdle — pay at term`
      : `Not due until ${out.due_date}`;
  }
  return out;
}

const PRIORITY = { CAPTURE_DISCOUNT: 0, OVERDUE: 1, DUE_SOON: 2, HOLD: 3 };

/**
 * Build a payment run from assessed bills and a cash budget (null = unlimited).
 * Returns { pay, deferred, hold, totals }.
 */
function planRun(assessed, cashAvailable) {
  const ordered = [...assessed].sort((a, b) => {
    if (PRIORITY[a.category] !== PRIORITY[b.category]) return PRIORITY[a.category] - PRIORITY[b.category];
    if (a.category === 'CAPTURE_DISCOUNT') return (b.discount.annualised_return - a.discount.annualised_return) || (a.discount.days_left - b.discount.days_left);
    return a.days_to_due - b.days_to_due;
  });

  let remaining = cashAvailable == null ? Infinity : cashAvailable;
  const pay = [];
  const deferred = [];
  const hold = [];
  for (const bill of ordered) {
    if (bill.category === 'HOLD') { hold.push(bill); continue; }
    const amount = bill.category === 'CAPTURE_DISCOUNT' ? bill.discount.pay_amount : bill.outstanding;
    if (amount <= remaining) {
      remaining -= amount;
      pay.push({ ...bill, pay_amount: amount });
    } else {
      deferred.push({ ...bill, pay_amount: amount, reason: `${bill.reason} — not enough cash in this run` });
    }
  }

  const sum = (list, f) => round2(list.reduce((s, b) => s + f(b), 0));
  const missed = deferred.filter((b) => b.category === 'CAPTURE_DISCOUNT');
  return {
    pay,
    deferred,
    hold,
    totals: {
      pay_count: pay.length,
      pay_amount: sum(pay, (b) => b.pay_amount),
      discounts_captured: sum(pay.filter((b) => b.category === 'CAPTURE_DISCOUNT'), (b) => b.discount.amount),
      discounts_at_risk: sum(missed, (b) => b.discount.amount),
      overdue_amount: sum([...pay, ...deferred].filter((b) => b.category === 'OVERDUE'), (b) => b.outstanding),
      cash_available: cashAvailable == null ? null : round2(cashAvailable),
      cash_remaining: cashAvailable == null ? null : round2(remaining),
    },
  };
}

/** Load open payables (RLS scopes them to the caller's company) and plan the run. */
async function buildPaymentRun({ cashAvailable = null, hurdleRate = 10, horizonDays = 7, today = new Date() } = {}) {
  const { rows } = await pool.query(`
    SELECT si.id, si.bill_number, si.supplier_invoice_number, si.supplier_id, si.invoice_date, si.due_date,
           si.payment_terms, si.currency, si.total_amount, si.paid_amount, si.outstanding_amount,
           s.legal_name AS supplier_name, s.payment_terms AS supplier_terms
    FROM supplier_invoices si
    LEFT JOIN suppliers s ON s.id = si.supplier_id
    WHERE si.deleted_at IS NULL
      AND si.status IN ('APPROVED', 'PARTIALLY_PAID', 'OVERDUE')
      AND si.outstanding_amount > 0
      AND NOT COALESCE(si.payment_hold, FALSE)
  `);
  const day = toDate(today);
  const assessed = rows.map((b) => assessBill(b, day, { hurdleRate, horizonDays }));
  return {
    as_of: iso(day),
    parameters: { cash_available: cashAvailable, hurdle_rate: hurdleRate, horizon_days: horizonDays },
    ...planRun(assessed, cashAvailable),
  };
}

module.exports = { parseTerms, annualisedReturn, assessBill, planRun, buildPaymentRun };
