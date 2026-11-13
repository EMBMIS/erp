/**
 * "An invoice arrives twice" — as tools.
 *
 * The check lives in services/billedTwice.js so the Supplier invoices screen
 * and Simeli read the same answer. check_supplier_bill is a READ tool: it
 * answers as the person asking (payables are for finance, managers and admins).
 *
 * hold_supplier_payment and release_supplier_payment_hold change a bill. They
 * always stop for the person's confirmation, the Gateway classifies them as
 * payment actions (escalate: payment tools need a person), and only a finance
 * manager, manager or admin may confirm.
 */

const { checkBill, scanBills, holdPayment, releaseHold } = require('../billedTwice');

const billedTwiceTools = [
  {
    name: 'check_supplier_bill',
    description:
      'Is this supplier invoice a second copy, or does it bill more than was delivered? For ONE bill (by bill number, the '
      + 'supplier\'s own invoice number, or id) it reads the same supplier\'s other live bills with the same vendor reference, '
      + 'the same amount within 45 days, or the same purchase order — with what was paid on each and when — the purchase '
      + 'order (the bill\'s own, or the one the bill it repeats was booked against), what the other bills already claimed on '
      + 'it, and the goods receipts valued at the order\'s prices. Returns a verdict (duplicate / overbilled / '
      + 'possible_duplicate / clear), the headline, the amount at stake and how much of it is still unpaid, the CHAIN of '
      + 'evidence (bill → order → receipts → the earlier bill and its payment), the proposals (hold_payment with ready '
      + 'args, a drafted note to the supplier, cancelling the copy) and sources. With no bill it checks every open bill and '
      + 'returns the ones that look billed twice or beyond what was received, worst first, plus every bill on hold.\n\n'
      + 'Use it for "is INV-7731 a duplicate", "did we already pay this invoice", "are we about to pay anything twice", '
      + '"check the Nordbay bill before we pay it", "any duplicate invoices this month". Lead with the headline, walk the '
      + 'chain in order naming each record, then offer the hold. Only call hold_supplier_payment if the person asks for it. '
      + 'Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        bill: { type: 'string', description: 'The bill: our bill number, the supplier\'s invoice number (e.g. INV-7731) or id. Omit to check every open bill.' },
        limit: { type: 'number', description: 'Without a bill: how many flagged bills to return. Default 25.' },
      },
    },
    handler: async (args, ctx = {}) => {
      const who = { companyId: ctx.companyId, userId: ctx.userId, role: ctx.role };
      return args.bill ? checkBill({ ...who, bill: args.bill }) : scanBills({ ...who, limit: args.limit });
    },
  },
  {
    name: 'hold_supplier_payment',
    description:
      'Put ONE supplier bill on payment hold, after the person has asked for it — usually the hold_payment proposal from '
      + 'check_supplier_bill, passing its args unchanged. Always stops for the person\'s confirmation; only a finance '
      + 'manager, manager or admin may confirm. While held, no payment can be allocated to the bill and the payment run '
      + 'leaves it out. The hold records who, when and why; release_supplier_payment_hold lifts it. Never call it unless '
      + 'the person asked.',
    alwaysConfirm: true,
    inputSchema: {
      type: 'object',
      properties: {
        bill: { type: 'string', description: 'The bill number, the supplier\'s invoice number or id.' },
        reason: { type: 'string', description: 'Why it is held, in one line (e.g. "Second copy of BILL-0007 (INV-7719)").' },
      },
      required: ['bill', 'reason'],
    },
    handler: async (args, ctx = {}) => holdPayment({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, bill: args.bill, reason: args.reason,
    }),
  },
  {
    name: 'release_supplier_payment_hold',
    description:
      'Lift the payment hold on ONE supplier bill, after the person has asked for it (for example once the supplier '
      + 'confirmed the invoice is genuine). Always stops for confirmation; only a finance manager, manager or admin may '
      + 'confirm. The bill can then be paid and appears in the payment run again.',
    alwaysConfirm: true,
    inputSchema: {
      type: 'object',
      properties: {
        bill: { type: 'string', description: 'The bill number, the supplier\'s invoice number or id.' },
      },
      required: ['bill'],
    },
    handler: async (args, ctx = {}) => releaseHold({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, bill: args.bill,
    }),
  },
];

module.exports = { billedTwiceTools };
