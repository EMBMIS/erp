/**
 * "Simeli maps what everything actually runs on" — as tools.
 *
 * The map and the what-if live in services/runsOn.js so the Production and
 * Warehouse screens and Simeli read the same answer. Both answer as the person
 * asking: customer orders are only the ones their role can see, money only for
 * roles that see margins, systems only for managers and admins.
 *
 * Both are READ tools. The what-if is never written; its proposals are
 * proposals, and acting on any of them goes through the ordinary
 * draft-and-approve path.
 */

const { mapRunsOn, whatIfDown } = require('../runsOn');

const runsOnTools = [
  {
    name: 'map_what_the_business_runs_on',
    description:
      'What the business actually runs on, from this company\'s own records: every production line (work centre) with the '
      + 'routing hours queued on it, the work orders and customer orders that depend on it, the equipment registered there and '
      + 'whether another centre could take the work; every site (storage location) with the orders shipping from it and the '
      + 'items no other site holds; the systems Simeli and the automations run through (EMBMIS Gateway, AI provider key, '
      + 'connected services, MCP servers, webhooks, mailboxes, the unattended scheduler, failing agents) with their health; '
      + 'and equipment past its useful life. Returns a ranked WATCH list — single points of failure by the value of the '
      + 'orders behind them, then anything down or failing.\n\n'
      + 'Use it for "what do we run on", "what is our single point of failure", "what would hurt most if it broke", '
      + '"map our infrastructure", "which systems are failing", "what depends on the Oslo warehouse". Lead with the headline '
      + 'and the first watch items, naming each line, site or system and the value behind it. To test one of them, call '
      + 'what_if_it_stops. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx = {}) => mapRunsOn({ companyId: ctx.companyId, userId: ctx.userId, role: ctx.role }),
  },
  {
    name: 'what_if_it_stops',
    description:
      'What stops if one thing the business runs on is out for N days. For a production line (work centre), a site '
      + '(storage location) or a supplier it reads the delivery trace twice — as things stand and with that line running '
      + 'nothing, that site shipping nothing or that supplier delivering nothing for the given days — and returns the '
      + 'customer orders that come out worse: verdict and projected date before and after, days of slip, value, the '
      + 'late-delivery penalty added under the customer\'s terms, the chain from the outage to the order, and proposals '
      + '(move an operation to a centre with free hours, transfer stock, a second source, tell the customer). For a system '
      + '(gateway, ai_provider, connector, mcp, webhook, scheduler) it says what runs through it and what would wait.\n\n'
      + 'Use it for "what if ML-03 goes down for three days", "if the Oslo warehouse closes for a week who do we let down", '
      + '"what happens if Nordbay stops delivering", "what if the Gateway is down". Lead with the headline, then each order '
      + 'hit with its before and after date and value, naming each record. Offer the proposals as proposals: moving an '
      + 'operation is a manager\'s click on the Work Centres screen; anything else you draft only when asked, for a person '
      + 'to approve. The what-if is never written.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The thing that stops: a work centre code or name (e.g. ML-03), a site code or name, a supplier name, or a system name.' },
        kind: { type: 'string', enum: ['work_center', 'site', 'supplier', 'gateway', 'ai_provider', 'connector', 'mcp', 'webhook', 'scheduler'], description: 'What ref is. Omit to look it up among work centres, sites and suppliers.' },
        days: { type: 'integer', minimum: 1, maximum: 60, description: 'How long it is out. Default 3.' },
      },
      required: ['ref'],
    },
    handler: async (args, ctx = {}) => whatIfDown({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role,
      ref: args.ref, kind: args.kind, days: args.days,
    }),
  },
];

module.exports = { runsOnTools };
