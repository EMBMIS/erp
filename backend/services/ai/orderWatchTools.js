/**
 * "The shortage is seen the moment the order lands" — as tools.
 *
 * Every order is checked as it lands (services/orderWatch.js): created, sent
 * for approval, approved, confirmed by the customer, keyed in from a customer
 * PO. A short one raises a finding and notifies its owner and the people who
 * can buy. These let Simeli answer from those findings — re-checked, in the
 * asker's own view — and, when the person says so, draft the purchase order
 * the watch proposed. The draft is a write: it stops for the person's
 * confirmation, is re-measured from the record, and goes through purchase
 * approval like any other.
 */

const { listCaught, draftFromWatch } = require('../orderWatch');

const orderWatchTools = [
  {
    name: 'list_orders_landed_short',
    description:
      'The customer orders that could not ship in full on the day they are wanted at the moment they landed, and are still '
      + 'open — caught by Simeli\'s order watch without anyone asking, each re-checked now. Per order: the customer, what '
      + 'is short, when it was caught and on what (created, approved, confirmed by the customer), the live headline (ready, '
      + 'ordered, short, the supplier who lands in time) and any purchase order already drafted from it.\n\n'
      + 'Use it for "what did you catch on new orders", "which orders came in short", "anything I should know about '
      + 'today\'s orders", "which new orders can\'t we ship". Lead with the headline, then one line per order: number, '
      + 'customer, short items, the fix and who approves it. Offer to draft the purchase order with '
      + 'draft_order_watch_purchase_order. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How far back to look at orders caught (default 14, at most 90).' },
      },
    },
    handler: async (args, ctx = {}) => listCaught({ companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, days: args.days }),
  },
  {
    name: 'draft_order_watch_purchase_order',
    description:
      'Draft the purchase order Simeli\'s order watch (or check_delivery_promise) proposed for a customer order that is '
      + 'short: the supplier who lands in time, the quantity, the price last paid. Re-measured from the record now, so '
      + 'only what is still short is drafted, and never twice for the same item. Created as a DRAFT linked to the order\'s '
      + 'finding; it goes through purchase approval before anything reaches the supplier. Needs procurement authority. '
      + 'Use only when the person asks to act ("draft it", "order the bearings for SO-24117"). Report the PO number, '
      + 'the supplier, quantity and landing day, and that it waits for approval.',
    inputSchema: {
      type: 'object',
      properties: {
        sales_order: { type: 'string', description: 'The customer order, by SO number or id.' },
        item_id: { type: 'string', description: 'When several lines are short: the item to order (its id from the watch). Default: the first short line.' },
      },
      required: ['sales_order'],
    },
    handler: async (args, ctx = {}) => draftFromWatch({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, salesOrder: args.sales_order, itemId: args.item_id || null,
    }),
  },
];

module.exports = { orderWatchTools };
