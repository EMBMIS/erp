/**
 * "Simeli knows which steps actually move." — as a tool.
 *
 * The measurement lives in services/processFlow.js so the Sales and
 * Procurement screens and Simeli read the same answer. It answers as the person
 * asking: roles that see all orders get the company's flow, anyone else the
 * flow of the documents they raised.
 *
 * It is a READ tool. Its proposals name the tool that acts on the stuck step;
 * each of those drafts or previews for a person.
 */

const { mapProcessFlow } = require('../processFlow');

const processFlowTools = [
  {
    name: 'map_process_flow',
    description:
      'Which steps of the business actually move, measured from the company\'s own documents. For order to cash '
      + '(quotation sent → answered, order → approved, approved → goods issued, goods issued → invoiced, invoiced → paid) '
      + 'and procure to pay (requisition → approved, approved requisition → PO, PO → approved, approved → received, '
      + 'received → supplier invoice, supplier invoice → paid): how many documents finished each step, the median and '
      + '80th-percentile days it took, whether it has slowed against the window before, what is waiting in it now, and '
      + 'which documents are stuck (waiting past the step\'s own normal time or past the date they promised), each '
      + 'named. The bottleneck is the step with the most value stuck in it.\n\n'
      + 'Use it for "where do our orders get stuck", "which steps actually move", "why is cash slow to come in", '
      + '"what is holding up purchasing", "how long does order to cash take", "where is the bottleneck". Lead with the '
      + 'headline, then one line per step in order (median days, waiting, stuck), then the stuck documents of the '
      + 'bottleneck by number. Offer the proposals; each names the tool that acts on that step. Nothing is changed.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        flow: { type: 'string', enum: ['all', 'order_to_cash', 'procure_to_pay'], description: 'Which flow. Default all.' },
        window_days: { type: 'number', description: 'Days of finished documents to measure each step on (30–365, default 90).' },
      },
    },
    handler: async (args, ctx = {}) => mapProcessFlow({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, flow: args.flow || 'all', windowDays: args.window_days,
    }),
  },
];

module.exports = { processFlowTools };
