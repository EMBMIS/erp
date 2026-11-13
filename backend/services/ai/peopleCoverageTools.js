/**
 * "Simeli understands your people." — as tools.
 *
 * The answer lives in services/peopleCoverage.js so the HR screens and Simeli
 * read the same thing. It answers as the person asking: managers see everyone,
 * anyone else sees themselves and the decisions they may see.
 *
 * explain_people_coverage is a READ tool. act_on_people_coverage carries out
 * one of its proposals — a message to the people who can decide, a hand-over
 * request, or a delegation for a named approver who is away — and always stops
 * for a manager's or admin's confirmation.
 */

const { peopleCoverage, actOnCoverage } = require('../peopleCoverage');

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const peopleCoverageTools = [
  {
    name: 'explain_people_coverage',
    description:
      'Who the business is waiting on, and what happens when they are not there. Over the next working days it joins '
      + 'the people in the company (role, department, position from the linked employee record), approved and requested '
      + 'leave from HR, active approval delegations, every pending decision with the customer orders it holds up (the '
      + 'same ranking as explain_pending_decisions), and the open orders each person raised that fall due while they are '
      + 'away. For every pending decision it says whether someone who may decide it is in before the first order it '
      + 'holds is due: covered, single (only one person can), decide_by (the last day anyone who can is in comes first — '
      + 'decide by then), gap (nobody who can is in) or nobody (only the person who raised it holds the role). It '
      + 'measures each requested leave as what approving it would do (leave_impact), and can measure an absence that is '
      + 'not on record (what_if_person, what_if_from, what_if_to). It returns people, a day-by-day count of approvers '
      + 'in, at_risk decisions with a reason, and proposals, each with an id.\n\n'
      + 'Use it for "who are we waiting on", "who is away next week and what does it hold up", "what happens if Anna is '
      + 'off from Thursday", "can I approve this leave", "is anyone a single point of failure", "who covers approvals '
      + 'while Mark is away", "who owns what", "understand our people". For a day such as "next week", pass what_if_from '
      + 'and what_if_to as dates. Lead with the headline, then the decisions at risk by number with the date they must '
      + 'be decided by and the customer order they hold, then the people. Never state why someone is away. Offer the '
      + 'proposals; carry one out with act_on_people_coverage only when the person asks. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        person: { type: 'string', description: 'Narrow to one person, by part of their name or email.' },
        horizon_days: { type: 'number', description: 'How many days ahead to look. Default 14.' },
        what_if_person: { type: 'string', description: 'Measure an absence that is not on record for this person (name or email).' },
        what_if_from: { type: 'string', description: 'YYYY-MM-DD — first day of the what-if absence.' },
        what_if_to: { type: 'string', description: 'YYYY-MM-DD — last day of the what-if absence.' },
      },
    },
    handler: async (args, ctx = {}) => {
      for (const k of ['what_if_from', 'what_if_to']) {
        if (args[k] && !ISO.test(String(args[k]))) return { error: `${k} must be YYYY-MM-DD.` };
      }
      return peopleCoverage({
        companyId: ctx.companyId,
        userId: ctx.userId,
        role: ctx.role,
        person: args.person || null,
        horizonDays: args.horizon_days,
        whatIf: args.what_if_person ? { person: args.what_if_person, from: args.what_if_from, to: args.what_if_to } : null,
      });
    },
  },
  {
    name: 'act_on_people_coverage',
    description:
      'Carry out ONE proposal from explain_people_coverage, after the person has chosen it. Always stops for the '
      + 'person\'s confirmation, and only a manager or admin may confirm. The situation is re-measured first and the '
      + 'proposal refused if it no longer applies. A nudge or hand-over sends an in-app notification to the people it '
      + 'names — it decides nothing; a delegation records that the delegate approves for the absent named approver over '
      + 'those dates, which the approval engine applies when it routes. Never call it unless the person asked for that '
      + 'proposal to be carried out.',
    alwaysConfirm: true,
    inputSchema: {
      type: 'object',
      properties: {
        proposal_id: { type: 'string', description: 'The proposal\'s id exactly as explain_people_coverage returned it.' },
        proposal: { type: 'string', description: 'The proposal\'s label, so the person sees what they are confirming.' },
      },
      required: ['proposal_id'],
    },
    handler: async (args, ctx = {}) => actOnCoverage({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, proposalId: args.proposal_id,
    }),
  },
];

module.exports = { peopleCoverageTools };
