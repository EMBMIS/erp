/**
 * "What is hurting our margins this month?" — as a tool, and the one follow-up
 * it can draft.
 *
 * The decomposition lives in services/marginDrivers.js so the Finance screen
 * and Simeli read the same answer. explain_margin answers as the person asking:
 * a role that does not see costs and prices gets told so, not a smaller answer.
 *
 * create_rfq_draft is the write half: an RFQ in DRAFT to the alternative
 * suppliers explain_margin named. It goes out only when someone in procurement
 * sends it, and an award still goes through the purchase approval path.
 */

const { explainMargin } = require('../marginDrivers');
const { pool } = require('../../config/database');

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const marginTools = [
  {
    name: 'explain_margin',
    description:
      'Why gross margin moved, split into causes from the company\'s own records. Reads gross margin for the period from '
      + 'posted revenue and cost-of-goods accounts (or from sales lines at unit cost when the ledger lacks them) against a '
      + 'baseline (default: this month to date against the three full months before), then prices each driver in margin '
      + 'points and as a share of the change: PURCHASE PRICE (an item sold now costs more to buy — supplier, % change, the '
      + 'purchase order where the new price started, contract price if any), DISCOUNTING (a product sold at a deeper '
      + 'discount than its own baseline or a given policy), SCRAP (a work centre scrapping more than its baseline, at the '
      + 'cost of the units lost) and MIX (sales moving to lower-margin products). Returns the headline, the drivers ranked '
      + 'by money lost, what helped, the unexplained remainder, margin by product, and proposals per driver.\n\n'
      + 'Use it for "what is hurting our margins", "why is gross margin down", "why did margin drop in September", '
      + '"what is eating our profit on HF-20", "are we discounting too much". Lead with the headline, then each driver in '
      + 'one line with its points and share, naming the supplier, product or work centre. Do not add causes it did not '
      + 'return. Offer the proposals as proposals: when the person asks, draft them with prepare_margin_follow_ups (all of '
      + 'them, or the kinds asked for) — or one RFQ with create_rfq_draft using its args. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD — start of the period to explain. Default: first of this month.' },
        to: { type: 'string', description: 'YYYY-MM-DD — end of the period. Default: today.' },
        baseline_from: { type: 'string', description: 'YYYY-MM-DD — start of the comparison. Default: three full months before.' },
        baseline_to: { type: 'string', description: 'YYYY-MM-DD — end of the comparison.' },
        discount_policy_pct: { type: 'number', description: 'A discount ceiling to judge against, e.g. 10. Without one, each product is judged against its own baseline.' },
        item: { type: 'string', description: 'Only products whose code or name contains this.' },
        limit: { type: 'number', description: 'How many drivers to return. Default 5.' },
      },
    },
    handler: async (args, ctx = {}) => {
      for (const k of ['from', 'to', 'baseline_from', 'baseline_to']) {
        if (args[k] && !ISO.test(String(args[k]))) return { error: `${k} must be YYYY-MM-DD.` };
      }
      return explainMargin({
        companyId: ctx.companyId,
        userId: ctx.userId,
        role: ctx.role,
        from: args.from,
        to: args.to,
        baselineFrom: args.baseline_from,
        baselineTo: args.baseline_to,
        discountPolicyPct: args.discount_policy_pct,
        item: args.item,
        limit: args.limit,
      });
    },
  },
  {
    name: 'create_rfq_draft',
    description:
      'Draft a request for quotation for one item to one or more suppliers, in DRAFT — nothing is sent. Use it when the '
      + 'person asks to re-quote an item (typically the "rfq" proposal from explain_margin, passing its args unchanged) '
      + 'or to get prices from other suppliers. Procurement reviews and sends it from the RFQ screen; an award still goes '
      + 'through purchase approval.',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'The item master id (items.id).' },
        quantity: { type: 'number', description: 'Quantity to quote for.' },
        supplier_ids: { type: 'array', items: { type: 'string' }, description: 'Suppliers to invite.' },
        title: { type: 'string', description: 'What the RFQ is for, in one line.' },
        response_days: { type: 'number', description: 'Days the suppliers have to answer. Default 7.' },
      },
      required: ['item_id', 'quantity', 'supplier_ids'],
    },
    handler: async (args, ctx = {}) => {
      const RequestForQuotation = require('../../models/RequestForQuotation');
      const qty = Number(args.quantity);
      if (!(qty > 0)) return { error: 'quantity must be more than zero.' };
      const ids = [...new Set((args.supplier_ids || []).map(String))];
      if (!ids.length) return { error: 'At least one supplier is needed.' };

      const { rows: items } = await pool.query(
        'SELECT id, item_code, name, unit_of_measure FROM items WHERE id = $1', [args.item_id],
      );
      if (!items.length) return { error: 'That item does not exist in this company. Use the item_id explain_margin returned.' };
      const { rows: suppliers } = await pool.query(
        'SELECT id, COALESCE(trade_name, legal_name) AS name FROM suppliers WHERE id = ANY($1::uuid[])', [ids],
      );
      if (suppliers.length !== ids.length) return { error: 'One or more suppliers do not exist in this company.' };

      const item = items[0];
      const days = Math.min(Math.max(parseInt(args.response_days, 10) || 7, 1), 60);
      const deadline = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
      const rfq = await RequestForQuotation.create({
        title: String(args.title || `Re-quote ${item.item_code || item.name}`).slice(0, 250),
        description: 'Drafted by Simeli from the margin analysis. Review and send from the RFQ screen.',
        response_deadline: deadline,
        line_items: [{
          item_id: item.id,
          item_description: item.name || item.item_code,
          unit_of_measure: item.unit_of_measure || 'EA',
          quantity: qty,
        }],
        suppliers: ids,
        status: 'DRAFT',
      }, ctx.userId && /^[0-9a-f-]{36}$/i.test(ctx.userId) ? ctx.userId : null);

      return {
        created: 'Request for quotation (draft)',
        id: rfq.id,
        reference: rfq.rfq_number,
        state: 'DRAFT',
        item: item.item_code || item.name,
        quantity: qty,
        suppliers: suppliers.map((s) => s.name),
        response_deadline: deadline,
        next_step: 'It has not been sent. Procurement reviews it and sends it from Procurement → RFQs.',
        open_at: `/procurement/rfqs/${rfq.id}`,
      };
    },
  },
  {
    name: 'prepare_margin_follow_ups',
    description:
      'Draft the follow-ups explain_margin proposes, each waiting on its owner: a DRAFT RFQ to the alternative suppliers '
      + 'of an item that now costs more (procurement sends it), a PROPOSED discount rule "<product> discounts above N% are '
      + 'approved by <the manager who usually approves sales orders>" (it binds nothing until another manager activates '
      + 'it; then a sales order past that discount can only be approved by that person), and an OPEN quality review on a '
      + 'work centre scrapping more than its baseline (production closes it with what they found). It runs the margin '
      + 'analysis again and drafts what it proposes now — pass the same period arguments you gave explain_margin — and '
      + 'reuses a draft that is already waiting rather than making a second.\n\n'
      + 'Use it when the person says "prepare the follow-ups", "do it", "draft those", "set up that approval rule", '
      + '"open the quality review". Report each line: what it is, its reference, who owns it next. Say that each awaits '
      + 'its owner and nothing is sent, enforced or closed yet. A line that says needs_owner was left to that owner.',
    alwaysConfirm: true,
    inputSchema: {
      type: 'object',
      properties: {
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['rfq', 'approval_rule', 'quality_review'] },
          description: 'Only these kinds of follow-up. Default: all three.',
        },
        from: { type: 'string', description: 'YYYY-MM-DD — as given to explain_margin.' },
        to: { type: 'string', description: 'YYYY-MM-DD — as given to explain_margin.' },
        baseline_from: { type: 'string', description: 'YYYY-MM-DD — as given to explain_margin.' },
        baseline_to: { type: 'string', description: 'YYYY-MM-DD — as given to explain_margin.' },
        discount_policy_pct: { type: 'number', description: 'As given to explain_margin.' },
      },
    },
    handler: async (args, ctx = {}) => {
      for (const k of ['from', 'to', 'baseline_from', 'baseline_to']) {
        if (args[k] && !ISO.test(String(args[k]))) return { error: `${k} must be YYYY-MM-DD.` };
      }
      const { prepareFollowUps } = require('../marginFollowUps');
      return prepareFollowUps({
        companyId: ctx.companyId,
        userId: ctx.userId,
        role: ctx.role,
        kinds: args.kinds,
        from: args.from,
        to: args.to,
        baselineFrom: args.baseline_from,
        baselineTo: args.baseline_to,
        discountPolicyPct: args.discount_policy_pct,
      });
    },
  },
];

module.exports = { marginTools };
