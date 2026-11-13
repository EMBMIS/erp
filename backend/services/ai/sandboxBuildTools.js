/**
 * "Describe what you need and Sandbox builds it" — as a tool.
 *
 * The work lives in services/sandboxBuild.js so Simeli and the Capability
 * opportunities screen go through the same pipeline as the Studio. For an
 * administrator it designs a DRAFT application and rehearses it in the
 * sandbox; for anyone else it records the request and tells the
 * administrators. It never deploys: that stays an administrator's approval in
 * the Studio.
 */

const { buildInSandbox } = require('../sandboxBuild');

const sandboxBuildTools = [
  {
    name: 'build_in_sandbox',
    description:
      'Have Sandbox build a new capability this business needs that no module or installed application provides, from '
      + 'the person\'s own sentence — "create a supplier risk monitor", "we need to track customer complaints and the '
      + 'fixes", "build something for equipment inspections". It runs the Capability Studio\'s pipeline on this '
      + 'company\'s real data model: designs the records, workflows, pages and who sees what, wires them to the '
      + 'existing records (suppliers, customers, items, orders…) and live measures (supplier risk, the warehouse twin) '
      + 'they need, and rehearses the design in the sandbox against the real schema. For an administrator it returns '
      + 'the DRAFT design: wires_into, live_measures, records, workflows, seen_by, the rehearsal verdict and the '
      + 'deployment plan with each step\'s safety class, plus `open`, the Studio session to review and deploy it. For '
      + 'anyone else it records the request and notifies the company\'s administrators, and returns who it went to. '
      + 'Nothing is deployed and no table is created by this tool. Use list_applications first when an installed '
      + 'application might already do it, and list_capability_opportunities for what the ledger suggests building.',
    highImpact: true,
    inputSchema: {
      type: 'object',
      properties: {
        requirement: {
          type: 'string',
          description: 'What to build, in the person\'s words, with any detail they gave (records, steps, who is involved). At least a sentence.',
        },
        title: { type: 'string', description: 'Optional short name for it.' },
      },
      required: ['requirement'],
    },
    handler: async (args, ctx = {}) => buildInSandbox({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role,
      requirement: args.requirement, title: args.title || null, channel: 'simeli',
    }),
  },
];

module.exports = { sandboxBuildTools };
