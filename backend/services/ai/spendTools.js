/**
 * "Why are our costs up?" — as tools.
 *
 * The analysis lives in services/spendDrivers.js so the Procurement and
 * Payables screens and Simeli give the same answer. explain_spend reads;
 * prepare_spend_follow_ups drafts re-quotes for procurement and asks the
 * owners of the orders and bills, and only when the person confirms it.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const periodProps = {
  from: { type: 'string', description: 'YYYY-MM-DD — start of the period to explain. Default: the first of this month.' },
  to: { type: 'string', description: 'YYYY-MM-DD — end of the period. Default: today.' },
  baseline_from: { type: 'string', description: 'YYYY-MM-DD — start of the comparison. Default: three full months before the period.' },
  baseline_to: { type: 'string', description: 'YYYY-MM-DD — end of the comparison.' },
};

function badDate(args) {
  for (const k of ['from', 'to', 'baseline_from', 'baseline_to']) {
    if (args[k] && !ISO.test(String(args[k]))) return { error: `${k} must be YYYY-MM-DD.` };
  }
  return null;
}

const spendTools = [
  {
    name: 'explain_spend',
    description:
      'Why spending and costs moved, split into suppliers from the company\'s own records. Reads what was committed to '
      + 'suppliers in the period (purchase-order lines by order date, plus bills booked with no purchase order) against the '
      + 'usual pace of the baseline (default: this month to date against the three full months before, scaled to the same '
      + 'number of days), and splits the change supplier by supplier so the parts add up to the total: PRICE (the same item '
      + 'from the same supplier at a higher unit price, and whether that is above a contract price in force), VOLUME (more '
      + 'units than usual, items added — and whether customer orders are behind the purchase orders), OFF-PO (bills with no '
      + 'purchase order), NEW suppliers. For each it names who raised the orders, who approved them, who asked for them '
      + '(requisitions, cost centres). For finance roles it adds the ledger lens: expense accounts against the same pace, with '
      + 'the kind of posting behind each (payroll, depreciation, manual journals, supplier bills). Proposals per supplier: a '
      + 're-quote of an item whose price went up to the other suppliers who carry it (create_rfq_draft args), the contract to '
      + 'hold them to, and a question to the person who booked bills without an order or ordered more with no customer order '
      + 'behind it.\n\n'
      + 'Use it for "why are our costs up", "why is spending up", "why did we spend more this month", "where is the money '
      + 'going", "which suppliers are costing us more", "why are expenses up", "who is buying outside purchase orders". Lead '
      + 'with the headline, then one line per supplier: what was committed against their pace, the cause the record shows '
      + '(item price % and the contract, units against pace and the customer orders behind them, bills with no order and who '
      + 'booked them), their share of the rise and who owns it; then the bridge and the ledger accounts that moved. Offer the '
      + 'proposals as proposals. Do not add causes it did not return. A person outside management and finance sees only their '
      + 'own spend; say so when scope is not company. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...periodProps,
        supplier: { type: 'string', description: 'Only suppliers whose name or code contains this.' },
        limit: { type: 'number', description: 'How many suppliers to return on each side. Default 5.' },
      },
    },
    handler: async (args, ctx = {}) => {
      const bad = badDate(args);
      if (bad) return bad;
      const { explainSpend } = require('../spendDrivers');
      return explainSpend({
        companyId: ctx.companyId,
        userId: ctx.userId,
        role: ctx.role,
        from: args.from,
        to: args.to,
        baselineFrom: args.baseline_from,
        baselineTo: args.baseline_to,
        supplier: args.supplier,
        limit: args.limit,
      });
    },
  },
  {
    name: 'prepare_spend_follow_ups',
    description:
      'Prepare what explain_spend proposes, each waiting on its owner: a DRAFT request for quotation for each item whose '
      + 'price went up, to the other suppliers who carry it (procurement reviews and sends it; an award still goes through '
      + 'purchase approval; needs procurement authority), and an in-app question to the person who booked bills with no '
      + 'purchase order ("what were they for; raise an order for what continues") or raised orders with no customer order '
      + 'behind the extra volume ("what is it for"), carrying the evidence. It runs the analysis again and prepares what it '
      + 'proposes now — pass the same period arguments you gave explain_spend — and never drafts or asks the same thing twice. '
      + 'Nothing is sent to a supplier.\n\n'
      + 'Use it when the person says "prepare the follow-ups", "re-quote them", "ask them", "do it" after explain_spend. Report '
      + 'each line: the supplier, what was prepared (RFQ reference, or who was asked) and that each awaits its owner.',
    alwaysConfirm: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...periodProps,
        supplier_ids: { type: 'array', items: { type: 'string' }, description: 'Only these suppliers (ids from explain_spend). Default: every supplier it names as costing more.' },
      },
    },
    handler: async (args, ctx = {}) => {
      const bad = badDate(args);
      if (bad) return bad;
      const { prepareSpendFollowUps } = require('../spendDrivers');
      return prepareSpendFollowUps({
        companyId: ctx.companyId,
        userId: ctx.userId,
        role: ctx.role,
        from: args.from,
        to: args.to,
        baselineFrom: args.baseline_from,
        baselineTo: args.baseline_to,
        supplierIds: Array.isArray(args.supplier_ids) ? args.supplier_ids : null,
      });
    },
  },
];

module.exports = { spendTools };
