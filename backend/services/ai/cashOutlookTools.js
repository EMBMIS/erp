/**
 * "Will we have the cash?" — as tools.
 *
 * The outlook lives in services/cashOutlook.js so the Cash forecast screen and
 * Simeli read the same answer. It answers as the person asking: only finance,
 * managers and admins see cash.
 *
 * explain_cash_outlook is a READ tool. send_cash_reminders is the one action
 * it can take — payment reminders for the invoices the person picked — and it
 * always stops for the person's confirmation first.
 */

const { explainCashOutlook, sendReminders } = require('../cashOutlook');

const cashOutlookTools = [
  {
    name: 'explain_cash_outlook',
    description:
      'Where cash dips in the next 13 weeks, why, and what lifts it — from the company\'s own records. Starts from the '
      + 'behavioural 13-week forecast (open invoices and bills settled on the days actually taken to pay, payroll, '
      + 'recurring invoices, loans, tax) and adds purchase orders not yet billed, customer orders not yet invoiced and '
      + 'bills on payment hold. Returns a verdict (covered / at_risk / under_floor / short), the headline, the low point '
      + '(week, date, expected and pessimistic balance), the first week under the floor (default: the next payroll), '
      + 'the causes (the largest outflows before the low point, and customers whose payment habit moves money past it, '
      + 'with their invoices), and proposals each measured at the low point: remind named customers (args for '
      + 'send_cash_reminders), pay named bills on their due date instead of early, and re-time purchase orders still '
      + 'waiting for approval.\n\n'
      + 'Use it for "will we have enough cash", "when do we run out of cash", "can we make payroll", "where does cash '
      + 'dip", "why is cash going to be tight", "what should we do about cash". Lead with the headline, then each cause '
      + 'in one line naming the record or customer, then the proposals with how much each lifts the low point and who '
      + 'owns it. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        floor: { type: 'number', description: 'The least cash the company wants to hold. Default: the next payroll.' },
      },
    },
    handler: async (args, ctx = {}) => explainCashOutlook({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role,
      floor: args.floor != null ? Number(args.floor) : null,
    }),
  },
  {
    name: 'send_cash_reminders',
    description:
      'Send payment reminders for the customer invoices the person picked — usually a "remind" proposal from '
      + 'explain_cash_outlook, passing its args unchanged. Always stops for the person\'s confirmation; only finance, '
      + 'managers and admins may confirm. Each invoice is emailed to the customer (courtesy note before the due date, '
      + 'reminder or notice after it) and recorded on the customer as an activity owned by their sales rep; when the '
      + 'email cannot go, a follow-up call is put on that owner\'s list instead. Never call it unless the person asked.',
    alwaysConfirm: true,
    inputSchema: {
      type: 'object',
      properties: {
        invoice_ids: { type: 'array', items: { type: 'string' }, description: 'Customer invoice ids from the proposal.' },
      },
      required: ['invoice_ids'],
    },
    handler: async (args, ctx = {}) => sendReminders({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, invoiceIds: args.invoice_ids,
    }),
  },
];

module.exports = { cashOutlookTools };
