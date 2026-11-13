/**
 * "The brain grows with your business" — as a tool.
 *
 * What the company built in Sandbox, read as part of the business: open records
 * in its own applications that need someone (severe, past due, stuck past the
 * workflow's limit), each tied to the supplier, customer or order it points at
 * and what that reaches. Read as the person asking; changes nothing.
 */

const { builtInTheBusiness } = require('../builtInTheBusiness');

const builtSignalsTools = [
  {
    name: 'what_built_apps_flag',
    description:
      'What the applications this company built for itself in Sandbox (supplier quality, audits, warranty claims, inspections — '
      + 'anything deployed from the Studio) say about the rest of the business right now. Reads every deployed application as the '
      + 'person asking (their role in each application decides what they see) and returns the open records that need someone: '
      + 'critical or high severity, past a due date, or stuck past the workflow\'s own time limit. Each is tied to what already '
      + 'exists — the supplier, customer or order it points at — with the customer orders that reaches, their value, and open '
      + 'purchase orders from that supplier. A supplier that is already a high risk carries its records inside its own item. '
      + 'Returns headline, items (title, cause, at_stake, connects, built_records with links, next_step), applications read '
      + '(and which are not in this person\'s view), and the method.\n\n'
      + 'Use it for "what do our own apps say", "anything open in supplier quality", "does what we built affect any orders", '
      + '"which suppliers have open quality findings", "is anything in <application name> urgent", "how does <application> connect '
      + 'to the business". Lead with the headline, then one line per item: what is open, why it needs someone, what it reaches '
      + '(orders, money) and where to open it. Nothing is changed: a person moves the record\'s workflow in its application.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        application: { type: 'string', description: 'Optional application key or name to narrow to, e.g. "supplier_quality".' },
      },
    },
    handler: async (args, ctx = {}) => builtInTheBusiness({
      companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, application: args.application,
    }),
  },
];

module.exports = { builtSignalsTools };
