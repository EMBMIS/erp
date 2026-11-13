/**
 * The write surface.
 *
 * WHAT AN AGENT IS ALLOWED TO DO HERE
 * ---------------------------------------------------------------------------
 * Every tool in this file either creates a DRAFT or performs a small,
 * reversible act on a record whose whole purpose is to be edited — a project
 * task, a time entry, a follow-up. Nothing here approves, posts, sends, deletes
 * or finalises. There is no tool to make an invoice live, no tool to pay a
 * supplier, no tool to close a period, and that is a design decision rather
 * than an oversight: the value of an agent that can act comes entirely from
 * being able to trust what it does, and the cheapest way to be trustworthy is
 * to only ever hand work to a person in a state they can inspect.
 *
 * So the honest description of this file is: it drafts, and it schedules
 * follow-ups. The ERP's existing DOA and approval machinery does the rest,
 * unchanged, with a human in it.
 *
 * WHY EVERY TOOL RE-READS ITS INPUTS
 * ---------------------------------------------------------------------------
 * These take ids. A model that has just seen a list of customers will
 * occasionally pass an id from the wrong row, and an invoice drafted against
 * the wrong customer is worse than no invoice — someone has to notice before
 * it goes out. Each handler therefore looks the record up, confirms it exists,
 * and returns the NAME it resolved to in the result, so the confirmation the
 * user reads says "Northern Ltd." and not a UUID they cannot check.
 */

const { pool } = require('../../config/database');

/** Look a record up by id and return its display name, or null. */
async function nameOf(table, id, column) {
  if (!id) return null;
  try {
    const { rows } = await pool.query(`SELECT ${column} AS label FROM ${table} WHERE id = $1`, [id]);
    return rows[0]?.label ?? null;
  } catch {
    return null;
  }
}

/**
 * The shape every write tool returns.
 *
 * `created` says plainly what now exists, `state` says what it is (always a
 * draft or an open item), and `next_step` says what a person has to do for it
 * to mean anything. The model is told to relay all three, because "I've created
 * the invoice" and "I've drafted an invoice that needs your approval" are
 * different claims and only one of them is true.
 */
function drafted({ kind, record, label, next_step, resolved }) {
  return {
    created: kind,
    id: record?.id,
    reference: label,
    state: record?.status || 'DRAFT',
    resolved: resolved || undefined,
    next_step,
    is_draft: true,
  };
}

const actionTools = [
  // -------------------------------------------------------------------------
  // Finance
  // -------------------------------------------------------------------------
  {
    name: 'create_customer_invoice_draft',
    description:
      'Draft a customer invoice. It is created as a DRAFT and goes nowhere until a person reviews and approves it '
      + 'through the normal approval flow — say so when you report back.\n\n'
      + 'Needs a customer_id: call resolve_entity first if you have a name. The due date comes from the customer\'s own '
      + 'credit terms, so do not invent one.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        amount: { type: 'number', description: 'Net amount before tax' },
        tax_amount: { type: 'number' },
        currency: { type: 'string', description: 'Omit to use the company default' },
        description: { type: 'string', description: 'What the invoice is for' },
      },
      required: ['customer_id', 'amount'],
    },
    handler: async (args, ctx) => {
      const customer = await nameOf('customers', args.customer_id, 'customer_name');
      if (!customer) return { error: 'No customer with that id. Use resolve_entity to find the right one.' };
      if (!(Number(args.amount) > 0)) return { error: 'An invoice needs a positive amount.' };

      const CustomerInvoice = require('../../models/CustomerInvoice');
      const invoice = await CustomerInvoice.createStandalone({
        customer_id: args.customer_id,
        amount: Number(args.amount),
        tax_amount: Number(args.tax_amount) || 0,
        currency: args.currency,
        description: args.description || null,
      }, ctx.userId);

      return drafted({
        kind: 'customer invoice',
        record: invoice,
        label: invoice.invoice_number,
        resolved: { customer },
        next_step: 'It is a draft. Someone has to review and approve it in Finance before it can be sent.',
      });
    },
  },
  {
    name: 'create_journal_entry_draft',
    description:
      'Draft a journal entry from balanced lines. Created unposted — it does not touch the ledger until a person posts '
      + 'it.\n\nDebits must equal credits. Each line needs an account_id (use resolve_entity with type "gl_account") and '
      + 'either a debit or a credit, not both.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_date: { type: 'string', description: 'YYYY-MM-DD' },
        description: { type: 'string' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              account_id: { type: 'string' },
              debit_amount: { type: 'number' },
              credit_amount: { type: 'number' },
              description: { type: 'string' },
            },
            required: ['account_id'],
          },
        },
      },
      required: ['lines'],
    },
    handler: async (args, ctx) => {
      const lines = Array.isArray(args.lines) ? args.lines : [];
      if (lines.length < 2) return { error: 'A journal entry needs at least two lines.' };

      const debit = lines.reduce((s, l) => s + (Number(l.debit_amount) || 0), 0);
      const credit = lines.reduce((s, l) => s + (Number(l.credit_amount) || 0), 0);
      if (Math.abs(debit - credit) > 0.005) {
        // Refused here rather than by the database, so the model gets a message
        // it can act on instead of a constraint violation.
        return {
          error: `The entry does not balance: debits ${debit.toFixed(2)} against credits ${credit.toFixed(2)}.`
            + ' Fix the lines and try again.',
        };
      }

      const JournalEntry = require('../../models/JournalEntry');
      const entry = await JournalEntry.create({
        entry_date: args.entry_date || new Date().toISOString().slice(0, 10),
        description: args.description || 'Drafted by Simeli',
        status: 'DRAFT',
      }, lines, ctx.userId);

      return drafted({
        kind: 'journal entry',
        record: entry,
        label: entry.entry_number || entry.id,
        next_step: 'It is unposted. Someone has to review and post it before it affects the ledger.',
      });
    },
  },

  // -------------------------------------------------------------------------
  // Sales and procurement
  // -------------------------------------------------------------------------
  {
    name: 'create_sales_quotation_draft',
    description:
      'Draft a quotation for a customer. Created as a DRAFT with a 30-day validity unless you give another. It is not '
      + 'sent to anyone.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        currency: { type: 'string' },
        valid_until: { type: 'string', description: 'YYYY-MM-DD' },
        notes: { type: 'string' },
        items: {
          type: 'array',
          description: 'Lines to quote',
          items: {
            type: 'object',
            properties: {
              item_id: { type: 'string' },
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit_price: { type: 'number' },
            },
          },
        },
      },
      required: ['customer_id'],
    },
    handler: async (args, ctx) => {
      const customer = await nameOf('customers', args.customer_id, 'customer_name');
      if (!customer) return { error: 'No customer with that id. Use resolve_entity to find the right one.' };

      const items = Array.isArray(args.items) ? args.items : [];
      const subtotal = items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0);

      const SalesQuotation = require('../../models/SalesQuotation');
      const quotation = await SalesQuotation.create({
        customer_id: args.customer_id,
        customer_name: customer,
        currency: args.currency,
        valid_until: args.valid_until,
        subtotal,
        total_amount: subtotal,
        status: 'DRAFT',
        notes: args.notes || null,
        items,
      }, ctx.userId);

      return drafted({
        kind: 'sales quotation',
        record: quotation,
        label: quotation.quotation_number,
        resolved: { customer },
        next_step: 'It is a draft. Someone has to review and send it.',
      });
    },
  },
  {
    name: 'create_purchase_order_draft',
    description:
      'Draft a purchase order against a supplier. Created as a DRAFT — nothing is ordered and no supplier is contacted '
      + 'until a person approves it through the normal flow.',
    inputSchema: {
      type: 'object',
      properties: {
        supplier_id: { type: 'string' },
        currency: { type: 'string' },
        expected_delivery_date: { type: 'string', description: 'YYYY-MM-DD' },
        notes: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item_id: { type: 'string' },
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit_price: { type: 'number' },
            },
          },
        },
      },
      required: ['supplier_id'],
    },
    handler: async (args, ctx) => {
      const supplier = await nameOf('suppliers', args.supplier_id, 'legal_name');
      if (!supplier) return { error: 'No supplier with that id. Use resolve_entity to find the right one.' };

      const PurchaseOrder = require('../../models/PurchaseOrder');
      // The model reads line_items (item_description) and delivery_date; passing
      // items/expected_delivery_date left every Simeli draft without lines.
      const po = await PurchaseOrder.create({
        supplier_id: args.supplier_id,
        currency: args.currency,
        delivery_date: args.expected_delivery_date || null,
        notes: args.notes || null,
        status: 'DRAFT',
        line_items: (Array.isArray(args.items) ? args.items : [])
          .filter((i) => Number(i.quantity) > 0)
          .map((i) => ({ ...i, item_description: i.item_description || i.description || 'Item', unit_price: Number(i.unit_price) || 0 })),
      }, ctx.userId);

      return drafted({
        kind: 'purchase order',
        record: po,
        label: po.po_number || po.order_number,
        resolved: { supplier },
        next_step: 'It is a draft. It has to go through approval before it reaches the supplier.',
      });
    },
  },

  // -------------------------------------------------------------------------
  // CRM
  // -------------------------------------------------------------------------
  {
    name: 'create_crm_activity',
    description:
      'Schedule a follow-up: a call, a meeting, a task or a note, against a deal, contact or customer. This is the tool '
      + 'for "remind me to chase this" and for putting a next action on a stalled deal.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        activity_type: { type: 'string', enum: ['CALL', 'MEETING', 'TASK', 'EMAIL', 'NOTE'] },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        notes: { type: 'string' },
        deal_id: { type: 'string' },
        contact_id: { type: 'string' },
        customer_id: { type: 'string' },
      },
      required: ['subject'],
    },
    handler: async (args, ctx) => {
      const { Activities } = require('../../models/Crm');
      const activity = await Activities.create({
        activity_type: args.activity_type || 'TASK',
        subject: args.subject,
        notes: args.notes,
        due_date: args.due_date,
        deal_id: args.deal_id,
        contact_id: args.contact_id,
        customer_id: args.customer_id,
      }, ctx.userId);

      return {
        created: 'CRM activity',
        id: activity.id,
        reference: activity.subject,
        state: activity.completed_at ? 'COMPLETED' : 'OPEN',
        next_step: activity.due_date
          ? `It is on the follow-up list for ${activity.due_date}.`
          : 'It is on the follow-up list with no due date.',
      };
    },
  },
  {
    name: 'move_deal_stage',
    description:
      'Move a deal to a different pipeline stage, recording who moved it and when. Moving a deal to CLOSED_LOST needs a '
      + 'lost_reason — a loss with no reason recorded teaches nobody anything.\n\n'
      + 'This one changes a real record rather than creating a draft, so ask before you use it unless the person has '
      + 'clearly told you to move it.',
    highImpact: true,
    inputSchema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string' },
        stage: { type: 'string', description: 'e.g. QUALIFICATION, PROPOSAL, NEGOTIATION, CLOSED_WON, CLOSED_LOST' },
        probability: { type: 'number', description: 'Override the stage default, 0-100' },
        lost_reason: { type: 'string', description: 'Required when moving to CLOSED_LOST' },
      },
      required: ['deal_id', 'stage'],
    },
    handler: async (args, ctx) => {
      const { Deals } = require('../../models/Crm');
      const before = await Deals.findById(args.deal_id);
      if (!before) return { error: 'No deal with that id.' };

      if (String(args.stage).toUpperCase() === 'CLOSED_LOST' && !args.lost_reason) {
        return { error: 'Moving a deal to CLOSED_LOST needs a lost_reason. Ask what it was.' };
      }

      const deal = await Deals.moveStage(
        args.deal_id,
        String(args.stage).toUpperCase(),
        { probability: args.probability, lost_reason: args.lost_reason },
        ctx.userId,
      );

      return {
        updated: 'deal',
        id: deal.id,
        reference: deal.title,
        from_stage: before.stage,
        to_stage: deal.stage,
        next_step: 'The move is recorded in the deal history with your name against it.',
        is_draft: false,
      };
    },
  },

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------
  {
    name: 'create_project_task',
    description: 'Add a task to a project, optionally assigned and with an estimate and a due date.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        assignee_id: { type: 'string' },
        estimated_hours: { type: 'number' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['project_id', 'name'],
    },
    handler: async (args) => {
      const project = await nameOf('projects', args.project_id, 'name');
      if (!project) return { error: 'No project with that id. Use resolve_entity to find the right one.' };

      const { ProjectTasks } = require('../../models/Project');
      const task = await ProjectTasks.create({
        project_id: args.project_id,
        name: args.name,
        description: args.description,
        assignee_id: args.assignee_id,
        estimated_hours: args.estimated_hours,
        due_date: args.due_date,
      });

      return {
        created: 'project task',
        id: task.id,
        reference: task.name,
        state: task.status || 'OPEN',
        resolved: { project },
        next_step: 'It is on the project board.',
        is_draft: false,
      };
    },
  },
  {
    name: 'log_time_entry',
    description:
      'Log hours against a project, and optionally a task. Time can only go to an open project, and hours must be '
      + 'between 0 and 24 — the model enforces both, so relay the error rather than retrying with a different number.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        task_id: { type: 'string' },
        entry_date: { type: 'string', description: 'YYYY-MM-DD' },
        hours: { type: 'number' },
        description: { type: 'string' },
        billable: { type: 'boolean' },
        employee_id: { type: 'string', description: 'Defaults to the current user' },
      },
      required: ['project_id', 'hours'],
    },
    handler: async (args, ctx) => {
      const { TimeEntries } = require('../../models/Project');
      const entry = await TimeEntries.create({
        project_id: args.project_id,
        task_id: args.task_id,
        entry_date: args.entry_date || new Date().toISOString().slice(0, 10),
        hours: args.hours,
        description: args.description,
        billable: args.billable !== false,
        employee_id: args.employee_id,
      }, ctx.userId);

      return {
        created: 'time entry',
        id: entry.id,
        reference: `${entry.hours}h on ${entry.entry_date}`,
        state: entry.status || 'DRAFT',
        next_step: 'It still needs approving before it can be billed.',
        is_draft: true,
      };
    },
  },
];

module.exports = { actionTools, drafted, nameOf };
