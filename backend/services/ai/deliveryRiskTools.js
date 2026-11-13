/**
 * "Why are we going to miss Friday's delivery?" — as a tool.
 *
 * The trace itself lives in services/deliveryRisk.js so the Sales screen and
 * Simeli read the same answer. This file is only the agent's face on it: the
 * description that tells the model when to reach for it, and the rule that it
 * answers as the person asking — a user whose role sees only their own orders
 * gets only their own orders here too.
 *
 * It is a READ tool. The proposals it returns are proposals; drafting any of
 * them is a separate, ordinary write call that pauses for the person.
 */

const { traceDeliveryRisk } = require('../deliveryRisk');
const { planRecovery, approveRecovery } = require('../deliveryRecovery');

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const deliveryRiskTools = [
  {
    name: 'explain_delivery_risk',
    description:
      'Trace why customer deliveries will be late, or confirm they will not. For every open sales order line due in the '
      + 'window it allocates stock in promised-date order, matches the shortfall to the work orders and purchase orders '
      + 'that are meant to cover it, projects when those really land (work-centre pace, operations behind schedule, '
      + 'short components, supplier lateness from their own delivery record) and returns, per order, a verdict '
      + '(uncovered / late / at_risk / on_track / covered), the projected date, the value at risk, and the CHAIN of '
      + 'causes from the shop floor or supplier to the order, each step naming the record it came from. An order with '
      + 'a ship-from site counts only stock placed at that site (and transfers on their way there); stock free at another '
      + 'site is named in the chain and proposed as a transfer. Where the customer has late-delivery terms, each order '
      + 'carries `penalty` (amount due if it ships as projected, if_late for an order still at risk) and the chain says '
      + 'what the slip costs.\n\n'
      + 'Use it for "why will we miss / be late on ...", "which deliveries are at risk this week", "can we ship SO-123 '
      + 'on time", "what is holding up the order for <customer>". For a day such as "Friday", pass due_from and due_to '
      + 'as that date. Answer by walking the chain in order and naming the root cause first — do not substitute your '
      + 'own reasons. The proposals are suggestions for the person: offer them, and only draft one (e.g. with '
      + 'create_purchase_requisition_draft using the args given) if they ask. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        sales_order: { type: 'string', description: 'One order, by SO number (e.g. SO-2026-0042) or id.' },
        customer: { type: 'string', description: 'Part of a customer name, to narrow the orders.' },
        due_from: { type: 'string', description: 'YYYY-MM-DD — earliest promised date to include.' },
        due_to: { type: 'string', description: 'YYYY-MM-DD — latest promised date to include.' },
        horizon_days: { type: 'number', description: 'How many days ahead to look when no dates are given. Default 14.' },
        include_covered: { type: 'boolean', description: 'Also list orders that are fully covered. Default false.' },
      },
    },
    handler: async (args, ctx = {}) => {
      for (const k of ['due_from', 'due_to']) {
        if (args[k] && !ISO.test(String(args[k]))) return { error: `${k} must be YYYY-MM-DD.` };
      }
      return traceDeliveryRisk({
        companyId: ctx.companyId,
        userId: ctx.userId,
        role: ctx.role,
        salesOrder: args.sales_order,
        customer: args.customer,
        dueFrom: args.due_from,
        dueTo: args.due_to,
        horizonDays: args.horizon_days,
        includeCovered: !!args.include_covered,
      });
    },
  },
  {
    name: 'plan_delivery_recovery',
    description:
      'What would make a late or at-risk customer order hold its date. For one sales order it builds the fixes the '
      + 'company\'s records allow — transfer stock free at another site to the site the order ships from, arriving after '
      + 'the time transfers between those sites have actually taken; move a not-yet-started operation of a work order the order depends on to another '
      + 'active work centre with free hours; buy the short quantity (or a short component) from a supplier that has '
      + 'delivered that item before, landing after the lead time it has actually achieved, at the last price paid — and '
      + 'MEASURES each one by re-running the delivery trace with the fix assumed. Only fixes that bring the order forward '
      + 'come back, each with its effect (holds: true when the order then makes its promise), the new projected date, '
      + 'the cost, the late-delivery penalty it avoids under the customer\'s terms (penalty_avoided, net_benefit), and '
      + 'the evidence. Plans that hold are ranked cheapest first.\n\n'
      + 'Use it after explain_delivery_risk, or directly for "what can we do about SO-123", "how do we save Friday\'s '
      + 'delivery", "fix the late order for <customer>". Lead with the best plan and say plainly whether the order holds '
      + 'with it. Nothing is changed by this tool: a manager or admin approves a plan, either on the sales order screen '
      + 'or by asking you to carry it out with approve_delivery_recovery.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        sales_order: { type: 'string', description: 'The order, by SO number (e.g. SO-2026-0042) or id.' },
      },
      required: ['sales_order'],
    },
    handler: async (args, ctx = {}) => planRecovery({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, salesOrder: args.sales_order,
    }),
  },
  {
    name: 'approve_delivery_recovery',
    description:
      'Carry out ONE recovery plan from plan_delivery_recovery, after the person has chosen it. Always stops for the '
      + 'person\'s confirmation, and only a manager or admin may confirm. The plan is re-measured first and refused if '
      + 'it no longer brings the order forward. A move happens at once; a transfer is dispatched from the source site at '
      + 'once and received at the destination on the Transfers screen; a purchase is raised and submitted into the '
      + 'normal purchase approval, so say that the spend still needs its approver. Never call it unless the person asked '
      + 'for that plan to be carried out.',
    alwaysConfirm: true,
    inputSchema: {
      type: 'object',
      properties: {
        sales_order: { type: 'string', description: 'The order the plan is for (SO number or id).' },
        plan_id: { type: 'string', description: 'The plan\'s id exactly as plan_delivery_recovery returned it.' },
        plan: { type: 'string', description: 'The plan\'s label, so the person sees what they are approving.' },
      },
      required: ['sales_order', 'plan_id'],
    },
    handler: async (args, ctx = {}) => approveRecovery({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, salesOrder: args.sales_order, planId: args.plan_id,
    }),
  },
];

module.exports = { deliveryRiskTools };
