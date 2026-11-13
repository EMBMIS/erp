/**
 * "We're going to run low on 6204 bearings next week. What should I do?" — as a tool.
 *
 * The plan lives in services/replenishmentPlan.js so the inventory item screen
 * and Simeli read the same answer. It answers as the person asking: budget
 * figures only for roles that read finance, customer orders only the ones
 * their role can see.
 *
 * It is a READ tool. The purchase order it proposes carries the arguments for
 * create_purchase_order_draft; drafting it is a separate write call that pauses
 * for the person, and the draft goes through purchase approval.
 */

const { planReplenishment } = require('../replenishmentPlan');

const replenishmentTools = [
  {
    name: 'plan_replenishment',
    description:
      'What to do about one item that is running low — from the company\'s own stock, goods issues, customer orders, '
      + 'purchase orders, supplier history, budget and delegation of authority. Returns: on hand and the bay it sits in; '
      + 'average weekly demand (goods issues, or the customer orders due if they are faster); open purchase lines and when '
      + 'they really land; WHEN IT RUNS OUT (days, date); each supplier\'s lead time actually achieved, price last paid, '
      + 'on-time record; the supplier chosen (cheapest that lands before the run-out, else fastest); the order-by date; '
      + 'the RECOMMENDED quantity (lead time + one cycle + safety stock, less stock and inbound); the inventory BUDGET left '
      + 'this year and whether the order fits; who the order is ROUTED TO under delegation of authority; the customer '
      + 'orders waiting on the item; and a ready "purchase_order" proposal.\n\n'
      + 'Use it for "we\'re going to run low on X, what should I do", "when do we run out of X", "should I order X", '
      + '"how many X should we buy", "do we have budget for more X". Without an item it takes the one with the shortest '
      + 'cover. Lead with the headline (run-out against lead time, and the action), then the facts — weekly demand, lead '
      + 'time, recommended order — then the recommendation with supplier, value, budget left and who approves. Name the '
      + 'sources it read. Never invent a figure it did not return. If the person asks to act, draft the order with '
      + 'create_purchase_order_draft using the proposal\'s args unchanged and say it is a draft that goes to the named '
      + 'approver. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Item code, name or words of it ("6204 bearings"), or id. Default: the item with the shortest cover.' },
      },
    },
    handler: async (args, ctx = {}) => planReplenishment({
      companyId: ctx.companyId,
      userId: ctx.userId,
      role: ctx.role,
      item: args.item,
    }),
  },
];

module.exports = { replenishmentTools };
