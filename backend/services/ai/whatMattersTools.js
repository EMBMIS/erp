/**
 * "What needs my attention today?" — as a tool.
 *
 * The brief lives in services/whatMattersNow.js so the Home screen and Simeli
 * read the same answer. It runs every watcher as the person asking — their
 * role decides what they see — and changes nothing. Each item names the tool
 * that carries its next step; those draft, hold or ask, and a person approves.
 */

const { whatMattersNow } = require('../whatMattersNow');
const { watchFeed } = require('../simeliWatch');

const whatMattersTools = [
  {
    name: 'what_matters_now',
    description:
      'What needs a person today, across the whole business, most urgent and most money first. Runs every watcher as the '
      + 'person asking: late or short customer deliveries (the delivery trace), production lines running slower than their '
      + 'own norm and what that costs, high-risk suppliers and the orders they reach, decisions waiting on someone and what '
      + 'they hold up, approvers away when a decision is needed, where cash dips in the next 13 weeks, supplier bills about '
      + 'to be paid twice, a gross-margin drop with its causes, and open records in applications the company built in Sandbox '
      + '(severe, past due or stuck), tied to the supplier, customer or order they point at. An order explained by a slow line, a supplier or a '
      + 'waiting decision appears once, under that cause. Returns the headline, the ranked items (each with title, cause, '
      + 'money at stake, the record, and next_step naming the tool and args that carry it out and who approves), and '
      + '"checked" — every watcher that ran and what it found, including the ones that found nothing.\n\n'
      + 'Use it for "what needs my attention today", "what should I look at", "anything I should know", "what is going on", '
      + '"morning brief", "what matters right now", "where are we losing money today". Lead with the headline, then one line '
      + 'per item — what, why (the cause), what is at stake — and its next step with who approves; then one line on what was '
      + 'checked and clear. Go deeper with the tool the item names only when the person picks it. Nothing is changed by this tool.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many items to return (default 7, at most 25).' },
      },
    },
    handler: async (args, ctx = {}) => whatMattersNow({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, limit: args.limit,
    }),
  },
  {
    name: 'what_simeli_noticed',
    description:
      'What Simeli\'s watch noticed for this person without being asked, and what changed since they last looked. Every few '
      + 'minutes, and shortly after an order lands or time is booked on a line, the watch runs every watcher (deliveries, '
      + 'lines, suppliers, decisions, people, cash, bills, margin) as this person and compares with what it found before. '
      + 'Returns the headline, `new` (found since `since`), `worse` (became urgent or more money at stake, with '
      + 'worsened_note), `still_open`, and `cleared` (no longer found, with how long it was open) — each with cause, '
      + 'money at stake now and when first seen, the record, link, and next_step naming the tool and who approves — plus '
      + 'when it last watched. check_now=true watches them first so the answer is current.\n\n'
      + 'Use it for "what did you notice", "anything new", "what changed since this morning / since yesterday", "what '
      + 'happened while I was away", "did anything get worse", "what got fixed", "are you watching". Lead with the headline, '
      + 'then new and worse items first (what, cause, at stake, when it was noticed, next step and who approves), then '
      + 'one line on what cleared. Offer the next step; draft or hold only when the person asks. Nothing in the business is '
      + 'changed by this tool — it only updates the watch\'s own memory.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO date or date-time to compare from. Default: the last 24 hours.' },
        check_now: { type: 'boolean', description: 'Watch now before answering. Default true.' },
      },
    },
    handler: async (args, ctx = {}) => watchFeed({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, since: args.since, checkNow: args.check_now !== false,
    }),
  },
];

module.exports = { whatMattersTools };
