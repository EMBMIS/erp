/**
 * "Your business, with a brain" — as a tool.
 *
 * The map lives in services/businessMap.js so the Home screen and Simeli read
 * the same answer. It reads every part of the business as the person asking —
 * their role decides what they see — and changes nothing.
 */

const { businessMap } = require('../businessMap');

const businessMapTools = [
  {
    name: 'map_the_business',
    description:
      'The whole business on one map, from this company\'s own records: ten parts — people, processes, software, data, '
      + 'operations, infrastructure, decisions, suppliers, production and Sandbox — each with what is on record (employees and '
      + 'roles, timed process steps, modules / built applications / connected systems, records in the ledger, signals from the '
      + 'watchers, lines / sites / systems, decisions awaiting a person, suppliers watched, lines against their pace, capabilities '
      + 'built or proposed), what Simeli sees in it now and its state (clear, watch, alert). Then the relationships — which part '
      + 'depends on which and what flows along each — and the TRACE: the late or at-risk customer order whose cause crosses the '
      + 'most parts of the business, walked step by step (a slow line → a work order behind plan → stock cover short → a late '
      + 'supplier → the customer order), each step naming its record, with the question to ask about it and the next step. '
      + 'Finally "grown": what was built in Sandbox and which parts it is wired into. Read as the person asking.\n\n'
      + 'Use it for "show me the business", "show me the brain", "how does everything connect", "give me the whole picture", '
      + '"how is the business doing overall", "what depends on what", "where is the problem coming from", "walk me through what '
      + 'is going wrong". Lead with the headline; if there is a trace, walk it one line per step naming the part of the business '
      + 'and the record; then one line per part that is on alert or watch with its signal; then the next step and who approves. '
      + 'Go deeper with the tool a part names only when the person picks it. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async (args, ctx = {}) => businessMap({ companyId: ctx.companyId, userId: ctx.userId, role: ctx.role }),
  },
];

module.exports = { businessMapTools };
