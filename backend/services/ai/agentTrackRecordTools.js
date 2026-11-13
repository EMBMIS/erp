/**
 * "Read-only by default; authority granted from measured outcomes." — as tools.
 *
 * The measuring lives in services/agentTrackRecord.js so the Agents screen and
 * Simeli read the same record. explain_agent_track_record is a READ tool.
 * grant_earned_authority carries out one of its proposals — a higher mode, a
 * higher limit, or a lower mode — and always stops for a manager's or admin's
 * confirmation; the record is measured again before anything changes.
 */

const { agentTrackRecord, grantEarnedAuthority } = require('../agentTrackRecord');

const agentTrackRecordTools = [
  {
    name: 'explain_agent_track_record',
    description:
      'What each autonomous agent has earned, measured from what actually happened to its work. For every agent it '
      + 'reads, over a window (default 90 days): the escalations it raised and whether a person approved or rejected '
      + 'them, the requisitions it drafted and whether they were approved as drafted, approved with changes, or '
      + 'declined, the findings it reported and whether people resolved or dismissed them, whether the invoices it sent '
      + 'reminders for were paid within 21 days, and how many of its actions failed. Against fixed rules (returned as '
      + '`rules`) it says per agent: earned (with proposals to move observe → propose → act, or to raise its money '
      + 'limit to the largest amount people approved with nothing at or below it rejected), holding, too_early (and how '
      + 'much more decided work it needs), or lose (with a proposal to lower its mode). Each proposal has an id. '
      + 'Use it for "which agents have earned more authority", "can the procurement agent act on its own yet", "should '
      + 'we raise the collections agent\'s limit", "how often do people overrule the agents", "is any agent getting it '
      + 'wrong", "how much can I trust the agents". Lead with the headline, then each agent that earned or should lose '
      + 'authority with its numbers and the examples people rejected or changed. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        agent_key: { type: 'string', description: 'Narrow to one agent by its key.' },
        days: { type: 'number', description: 'How many days back to measure. Default 90.' },
      },
    },
    handler: async (args, ctx = {}) => agentTrackRecord({
      companyId: ctx.companyId, role: ctx.role, agentKey: args.agent_key || null, days: args.days,
    }),
  },
  {
    name: 'grant_earned_authority',
    description:
      'Carry out ONE proposal from explain_agent_track_record, after the person has chosen it: raise an agent\'s mode, '
      + 'raise its money limit, or lower its mode. Always stops for the person\'s confirmation, and only a manager or '
      + 'admin may confirm. The record is measured again first and the proposal refused if it no longer holds. The '
      + 'change and its evidence are written to the audit trail. It does not switch an agent on. Never call it unless '
      + 'the person asked for that proposal to be carried out.',
    alwaysConfirm: true,
    min_role: 'MANAGER',
    inputSchema: {
      type: 'object',
      properties: {
        proposal_id: { type: 'string', description: 'The proposal\'s id exactly as explain_agent_track_record returned it.' },
        proposal: { type: 'string', description: 'The proposal\'s label, so the person sees what they are confirming.' },
      },
      required: ['proposal_id'],
    },
    handler: async (args, ctx = {}) => grantEarnedAuthority({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, proposalId: args.proposal_id,
    }),
  },
];

module.exports = { agentTrackRecordTools };
