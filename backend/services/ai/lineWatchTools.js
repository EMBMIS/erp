/**
 * "One line slows down, and it already knows what that will cost" — as a tool.
 *
 * The watch itself lives in services/lineWatch.js so the Production screens
 * and Simeli read the same answer. It answers as the person asking: the
 * customer orders it names are only the ones their role can see.
 *
 * It is a READ tool. Its proposals are proposals; moving an operation is done
 * by a manager on the Work Centres screen, and anything else goes through the
 * ordinary draft-and-approve path.
 */

const { watchLines } = require('../lineWatch');

const lineWatchTools = [
  {
    name: 'watch_production_lines',
    description:
      'Which production lines (work centres) have slowed down or stopped, and what it will cost. For each work centre '
      + 'it compares the share of routing time achieved over the last 14 days (including operations running past plan '
      + 'right now) with the 90 days before; a drop of 5% or more is a slowdown. For every slowed or stopped line it '
      + 'returns the efficiency change, the extra hours the queued work will take at today\'s pace, their cost at the '
      + 'centre\'s hourly rate, the hours already lost, the work orders affected, the customer orders it puts at risk '
      + '(with value), a CHAIN from the line to the orders, and proposals.\n\n'
      + 'Use it for "is anything slowing down on the shop floor", "what is line ML-03 costing us", "why is production '
      + 'behind", "what happens if the press stays slow". Lead with the line and its efficiency change, then the cost, '
      + 'then the orders at risk, naming each record. Offer the proposals as proposals: moving an operation is done by a '
      + 'manager on the Work Centres screen (/manufacturing/work-centers); you cannot do it. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        work_center: { type: 'string', description: 'One work centre, by code (e.g. ML-03), name or id. Omit for all.' },
        include_steady: { type: 'boolean', description: 'Also list centres running at or above their norm. Default false.' },
      },
    },
    handler: async (args, ctx = {}) => watchLines({
      companyId: ctx.companyId,
      userId: ctx.userId,
      role: ctx.role,
      workCenter: args.work_center,
      includeSteady: !!args.include_steady,
    }),
  },
];

module.exports = { lineWatchTools };
