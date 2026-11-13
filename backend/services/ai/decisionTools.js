/**
 * "What is waiting on a person, what it is worth, and what it is holding up" —
 * as a tool.
 *
 * The answer lives in services/decisionsHeldOpen.js so the Approval Inbox, My
 * Work and Simeli read the same ranking. It answers as the person asking: they
 * see the decisions their role may see, and only the customer orders their role
 * may see are named.
 *
 * It is a READ tool. Simeli brings the decision with its reason attached; the
 * person makes it on the document's own approval screen, where DoA limits,
 * approval chains and segregation of duties apply.
 */

const { decisionsHeldOpen } = require('../decisionsHeldOpen');

const decisionTools = [
  {
    name: 'explain_pending_decisions',
    description:
      'Everything in the company that is waiting on a person to decide — purchase orders, sales orders, purchase '
      + 'requisitions and supplier contracts pending approval, and anything an agent escalated — with what each is WORTH, '
      + 'how long it has waited and on whom, and what it is HOLDING UP: the customer orders that depend on it, read from '
      + 'the delivery trace (a pending purchase order is supply an order is counting on; a requisition may be the only '
      + 'cover for a line with nothing on order; a pending sales order is itself a customer\'s promise). Each decision says '
      + 'whether approving it is enough to keep those dates or something else on the chain is late too, and whether the '
      + 'person asking can decide it. Ranked by the customer value it holds. The summary gives awaiting, made this week, '
      + 'escalated (waiting over 3 days or escalated by an agent) and exposure held open.\n\n'
      + 'Use it for "what is waiting on me", "what should I approve first", "what are my approvals holding up", "what is '
      + 'PO-0042 blocking", "how much is stuck in approvals", "which decisions are overdue". Lead with the decision that '
      + 'holds the most, give its reason in one sentence (what it is worth, what depends on it, due when), then the rest. '
      + 'You cannot approve or decline anything: say where the person decides it (decide_at, the Approval Inbox). '
      + 'Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        mine: { type: 'boolean', description: 'Only decisions the person asking can make. Default false.' },
        kind: {
          type: 'string',
          enum: ['purchase_order', 'sales_order', 'purchase_requisition', 'contract', 'escalation'],
          description: 'Only one kind of decision.',
        },
        document: { type: 'string', description: 'One pending document, by number (e.g. PO-0042) or id.' },
        limit: { type: 'number', description: 'How many decisions to return, most held first. Default 25.' },
      },
    },
    handler: async (args, ctx = {}) => decisionsHeldOpen({
      companyId: ctx.companyId,
      userId: ctx.userId,
      role: ctx.role,
      mine: !!args.mine,
      kind: args.kind || null,
      document: args.document || null,
      limit: args.limit,
    }),
  },
];

module.exports = { decisionTools };
