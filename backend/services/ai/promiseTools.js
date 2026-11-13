/**
 * "Can we ship SO-24117 to Halden Marine on Thursday?" — as a tool.
 *
 * The answer lives in services/promiseCheck.js so the sales order and
 * quotation screens and Simeli read the same thing. It answers as the person
 * asking: only orders their role can see, supplier prices and values only for
 * roles that see margins.
 *
 * It is a READ tool. The purchase order it proposes carries the arguments for
 * create_purchase_order_draft; drafting it is a separate write call that pauses
 * for the person, and the draft goes through purchase approval.
 */

const { checkPromise } = require('../promiseCheck');

const promiseTools = [
  {
    name: 'check_delivery_promise',
    description:
      'Can we ship this on that day? For a customer order (committed or still a draft), a quotation, or items and quantities '
      + 'someone is about to promise, against the date the customer wants. From the company\'s own records: per line how '
      + 'many are needed, how many are free on the day (stock left after earlier orders take theirs, plus what is on order '
      + 'and lands by then), how many are short, and the first day it can go in full. For what is short: free stock at '
      + 'another site, and the supplier who can bring it in time (lead time actually achieved on this company\'s orders, '
      + 'price last paid, on-time record) with a ready purchase_order proposal and who it routes to. Anything not yet '
      + 'committed is served after every order already promised, so it never takes another customer\'s stock.\n\n'
      + 'Use it for "can we ship SO-123 on Thursday", "can we deliver SO-123 by the 14th", "can we promise 240 × 6204 to '
      + 'Halden by Friday", "when can quotation Q-1 go in full", "do we have enough for this order". Pass the date as the '
      + 'person said it (weekday, "tomorrow", or YYYY-MM-DD). Lead with the headline (yes / not in full / no, with the '
      + 'numbers), then one line per short line, then the fix — supplier, lead time, price, the order and who approves — '
      + 'and the first day in full. Never invent a figure it did not return. If the person asks to act, draft the order '
      + 'with create_purchase_order_draft using the proposal\'s args unchanged and say it is a draft that waits for the '
      + 'named approver. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        sales_order: { type: 'string', description: 'The order, by SO number or id.' },
        quotation: { type: 'string', description: 'A sales quotation, by number or id.' },
        items: {
          type: 'array',
          description: 'Instead of an order: what is to be promised.',
          items: { type: 'object', properties: { item: { type: 'string', description: 'Item code, name or words of it.' }, quantity: { type: 'number' } }, required: ['item', 'quantity'] },
        },
        customer: { type: 'string', description: 'With items: the customer it is for.' },
        date: { type: 'string', description: 'The day it has to ship: YYYY-MM-DD, a weekday ("Thursday"), "tomorrow", "in 5 days". Default: the date on the document.' },
      },
    },
    handler: async (args, ctx = {}) => checkPromise({
      companyId: ctx.companyId,
      userId: ctx.userId,
      role: ctx.role,
      salesOrder: args.sales_order,
      quotation: args.quotation,
      items: args.items,
      customer: args.customer,
      date: args.date,
    }),
  },
];

module.exports = { promiseTools };
