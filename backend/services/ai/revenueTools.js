/**
 * "Why are sales down?" — as tools.
 *
 * The analysis lives in services/revenueDrivers.js so the Sales screen and
 * Simeli give the same answer. explain_revenue reads; prepare_revenue_follow_ups
 * puts a call on each owner's CRM follow-up list, and only when the person
 * confirms it.
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

const revenueTools = [
  {
    name: 'explain_revenue',
    description:
      'Why sales moved, split into customers from the company\'s own records. Reads the net value of sales-order lines booked '
      + 'in the period (default: this month to date) against the usual pace of the baseline (default: the three full months '
      + 'before, scaled to the same number of days), and splits the change customer by customer so the parts add up to the '
      + 'total: LAPSED customers (bought before, nothing now, and the days since their last order are well past their own '
      + 'usual gap), customers buying LESS (split into volume — fewer units, products dropped — and price), and the NEW or '
      + 'growing customers pulling the other way. For each it names what else the record says: quotations lost (with the '
      + 'reason given) or still open, a credit hold, overdue invoices, a delivery issue they reported, the last order, and the '
      + 'person who owns the account. Also a bridge: no order now / new customers / volume / price. Each falling customer '
      + 'carries a proposal: a follow-up call for their account owner.\n\n'
      + 'Use it for "why are sales down", "why is revenue down this month", "who stopped ordering", "which customers are '
      + 'buying less", "where did our sales go", "why did bookings drop", "what happened with <customer>". Lead with the '
      + 'headline, then one line per customer: the customer, what they booked against their pace, the cause the record shows '
      + '(lapsed for N days against every M; product volume or price; lost quotation and its reason; credit hold; overdue), '
      + 'their share of the drop and who owns them. Then the bridge in one line. Offer the follow-up calls as proposals. Do '
      + 'not add causes it did not return. A person outside management sees only their own book; say so when scope is not '
      + 'company. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...periodProps,
        customer: { type: 'string', description: 'Only customers whose name or code contains this.' },
        limit: { type: 'number', description: 'How many customers to return on each side. Default 5.' },
      },
    },
    handler: async (args, ctx = {}) => {
      const bad = badDate(args);
      if (bad) return bad;
      const { explainRevenue } = require('../revenueDrivers');
      return explainRevenue({
        companyId: ctx.companyId,
        userId: ctx.userId,
        role: ctx.role,
        from: args.from,
        to: args.to,
        baselineFrom: args.baseline_from,
        baselineTo: args.baseline_to,
        customer: args.customer,
        limit: args.limit,
      });
    },
  },
  {
    name: 'prepare_revenue_follow_ups',
    description:
      'Put the follow-up calls explain_revenue proposes on each account owner\'s CRM follow-up list: one CALL per lapsed or '
      + 'shrinking customer, due in two days, owned by the customer\'s sales representative (or whoever enters most of their '
      + 'orders), carrying the evidence — what they booked against their pace, the products, lost and open quotations, a '
      + 'credit hold, overdue invoices. It runs the analysis again and prepares what it proposes now — pass the same period '
      + 'arguments you gave explain_revenue — and reuses a Simeli call already waiting for that customer. Nothing is sent to '
      + 'a customer; the owner makes the call and records what they hear.\n\n'
      + 'Use it when the person says "prepare the calls", "set up the follow-ups", "have the reps call them", "do it". Report '
      + 'each line: the customer, who owns the call and when it is due; say that each owner makes the call.',
    alwaysConfirm: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...periodProps,
        customer_ids: { type: 'array', items: { type: 'string' }, description: 'Only these customers (ids from explain_revenue). Default: every falling customer it names.' },
      },
    },
    handler: async (args, ctx = {}) => {
      const bad = badDate(args);
      if (bad) return bad;
      const { prepareRevenueFollowUps } = require('../revenueDrivers');
      return prepareRevenueFollowUps({
        companyId: ctx.companyId,
        userId: ctx.userId,
        role: ctx.role,
        from: args.from,
        to: args.to,
        baselineFrom: args.baseline_from,
        baselineTo: args.baseline_to,
        customerIds: Array.isArray(args.customer_ids) ? args.customer_ids : null,
      });
    },
  },
];

module.exports = { revenueTools };
