/**
 * "Suppliers as relationships — lead times, reliability and exposure" — as a tool.
 *
 * The assessment lives in services/supplierRisk.js so the Procurement screens,
 * applications built in Sandbox and Simeli read the same answer. It answers as
 * the person asking: the customer orders it names are only the ones their role
 * can see.
 *
 * It is a READ tool. Its proposals are proposals; chasing a supplier, raising a
 * purchase elsewhere or qualifying a second source goes through the ordinary
 * draft-and-approve path.
 */

const { assessSupplierRisk } = require('../supplierRisk');

const supplierRiskTools = [
  {
    name: 'monitor_supplier_risk',
    description:
      'Which suppliers are a risk right now, and why — from this company\'s own purchase orders, goods receipts and '
      + 'supplier catalogue. For each supplier: on-time rate and average days late over the last year (and whether the '
      + 'last 90 days are worse), achieved lead time against the catalogue, share of goods received damaged, open '
      + 'purchase lines past their promised date (count, days, value), orders not confirmed, open exposure, items it is '
      + 'the only source for, and the customer orders its lateness puts at risk (from the delivery trace). Each signal '
      + 'adds stated points; HIGH at 50, MEDIUM at 25. Returns SIGNALS, a CHAIN from the supplier to the orders, and '
      + 'proposals.\n\n'
      + 'Use it for "which suppliers are a risk", "how reliable is Acme", "who is late on deliveries", "what is our '
      + 'exposure to this supplier", "where are we single-sourced". Lead with the band and the strongest signal, name '
      + 'each record, then the exposure and the orders at risk. Offer the proposals as proposals — you can draft a '
      + 'purchase requisition only when asked. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        supplier: { type: 'string', description: 'One supplier, by code, name or id. Omit for all.' },
        include_low: { type: 'boolean', description: 'Also list suppliers with no risk signal. Default false.' },
      },
    },
    handler: async (args, ctx = {}) => assessSupplierRisk({
      companyId: ctx.companyId,
      userId: ctx.userId,
      role: ctx.role,
      supplier: args.supplier,
      includeLow: !!args.include_low,
    }),
  },
];

module.exports = { supplierRiskTools };
