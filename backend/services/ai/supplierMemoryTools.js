/**
 * "Nordbay is late again. What did we do last time?" — as a tool.
 *
 * The memory lives in services/supplierMemory.js so the supplier screen and
 * Simeli read the same answer. It answers as the person asking: the customer
 * orders it names are only the ones their role can see.
 *
 * It is a READ tool. The split order it proposes carries the arguments for
 * create_purchase_order_draft; drafting it is a separate write call that pauses
 * for the person, and the draft goes through purchase approval.
 */

const { recallSupplierPrecedent } = require('../supplierMemory');

const supplierMemoryTools = [
  {
    name: 'recall_supplier_precedent',
    description:
      'What the company did the last times a supplier delivered late, whether it worked, and what to do now — from its '
      + 'own purchase orders, goods receipts, approvals and customer shipments. For each late delivery in the last two '
      + 'years: the purchase order and days late, then the RESPONSE (what was bought of the same items in the weeks after: '
      + 'split to another supplier and its share, switched, stayed, or nothing), who raised and approved it and any reason '
      + 'recorded, and the OUTCOME (did the other supplier deliver on time, at what price against this one; how many '
      + 'customer orders shipped late). Then TODAY: the open purchase order that is late or projected late and the '
      + 'customer orders waiting on it, and a RECOMMENDATION that repeats what worked (quantity, supplier, cost impact, '
      + 'orders kept) with a ready "split_order" proposal.\n\n'
      + 'Use it for "<supplier> is late again, what did we do last time", "what worked when <supplier> was late before", '
      + '"have we had this problem with <supplier>", "should we split the order". Without a supplier it takes the one most '
      + 'overdue now. Lead with the headline, then the timeline one line per episode with its date, then the '
      + 'recommendation. Never invent a precedent it did not return. If the person asks to act, draft the split order with '
      + 'create_purchase_order_draft using the proposal\'s args unchanged and say it is a draft awaiting approval and '
      + 'that the late order still carries the full quantity. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        supplier: { type: 'string', description: 'Supplier name, code or id. Default: the supplier most overdue now.' },
      },
    },
    handler: async (args, ctx = {}) => recallSupplierPrecedent({
      companyId: ctx.companyId,
      userId: ctx.userId,
      role: ctx.role,
      supplier: args.supplier,
    }),
  },
];

module.exports = { supplierMemoryTools };
