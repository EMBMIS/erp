/**
 * "Point at an order. See the whole business behind it." — as a tool.
 *
 * The chain itself lives in services/orderChain.js so the sales order screen
 * and Simeli read the same answer. It answers as the person asking: a role that
 * sees only its own orders gets only those, and costs and margin only reach
 * roles that see margins.
 *
 * It is a READ tool. Its proposals name the tool that would draft them; each
 * of those pauses for the person.
 */

const { traceOrderChain } = require('../orderChain');

const orderChainTools = [
  {
    name: 'show_order_chain',
    description:
      'Everything behind one customer order, read from the company\'s own records as one chain: the customer (credit '
      + 'used against the limit, days they actually take to pay), the product and its discount against policy, stock '
      + '(free after earlier orders, short, which locations hold it), the supplier who refills it (lead time achieved, '
      + 'last price, price change), the purchase or work order it depends on and when it really lands, the invoice, '
      + 'and the order\'s margin with the reason it is where it is (supplier price, discount past policy, a PO waiting '
      + 'for approval). Each link names the record it came from.\n\n'
      + 'Use it for "show me everything behind SO-123", "what is the story on the order for <customer>", "is SO-123 '
      + 'healthy", "what does this order make us", "walk me through this order". Lead with the headline, then walk the '
      + 'chain in order, one line per link, then the margin and its note. Offer the proposals; draft one only when the '
      + 'person asks, with the tool and args given. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        sales_order: { type: 'string', description: 'The order, by SO number (e.g. SO-2026-0042) or id.' },
      },
      required: ['sales_order'],
    },
    handler: async (args, ctx = {}) => traceOrderChain({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, salesOrder: args.sales_order,
    }),
  },
];

module.exports = { orderChainTools };
