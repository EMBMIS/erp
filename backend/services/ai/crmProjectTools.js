/**
 * CRM and Projects tools.
 *
 * WHY THESE WERE MISSING AND WHY THAT MATTERED
 * ---------------------------------------------------------------------------
 * The agent had 89 tools and not one of them could see a deal or a project.
 * Both modules have full model APIs — pipeline, stage history, duplicate
 * detection, project P&L, budget reports, billing preview — and the agent could
 * reach none of it. So "why did this deal stall?" and "is this project making
 * money?" had no path at all, and the honest answer was "I have no tool for
 * that" on two of the eight modules the product claims to reason across.
 *
 * Every tool here is a thin wrapper over a model method that already exists and
 * is already used by the HTTP routes. Nothing re-implements a query, which
 * matters: the P&L a person sees on the Projects page and the P&L the agent
 * quotes come from the same function, so they cannot disagree.
 *
 * ALL READ-ONLY
 * ---------------------------------------------------------------------------
 * Sight first. A model that can move a deal to Closed Won before it can read
 * the pipeline is the wrong order to build in.
 */

const { Contacts, Deals, Activities } = require('../../models/Crm');
const { Projects, ProjectTasks, TimeEntries, Milestones, ResourceAssignments } = require('../../models/Project');

/** Trim a row set to what the model needs, so a 200-row result is not 200KB. */
const pick = (rows, fields) => (rows || []).map((r) => {
  const out = {};
  for (const f of fields) if (r[f] !== undefined) out[f] = r[f];
  return out;
});

const crmProjectTools = [
  // -------------------------------------------------------------------------
  // CRM
  // -------------------------------------------------------------------------
  {
    name: 'list_deals',
    description:
      'Sales opportunities in the CRM pipeline, with stage, value, probability, expected close date and owner. '
      + 'Filter by stage or owner, or set open_only to exclude Closed Won and Closed Lost. Use this before answering '
      + 'anything about the pipeline, forecast, or a named opportunity.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        stage: { type: 'string', description: 'e.g. QUALIFICATION, PROPOSAL, NEGOTIATION, CLOSED_WON, CLOSED_LOST' },
        owner_id: { type: 'string' },
        customer_id: { type: 'string' },
        open_only: { type: 'boolean', description: 'Exclude closed deals' },
        limit: { type: 'number' },
      },
    },
    handler: async (args) => {
      const rows = await Deals.findAll({ ...args, limit: Math.min(args.limit || 100, 200) });
      return { count: rows.length, deals: rows };
    },
  },
  {
    name: 'get_deal',
    description: 'One deal in full, including its contact and customer. Use get_deal_history for how it got to its current stage.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { deal_id: { type: 'string' } }, required: ['deal_id'] },
    handler: async (args) => {
      const deal = await Deals.findById(args.deal_id);
      if (!deal) return { found: false, error: 'No deal with that id.' };
      return { found: true, deal };
    },
  },
  {
    name: 'get_deal_history',
    description:
      'Every stage this deal has been through, with when it moved and who moved it. This is how you answer "why has this '
      + 'stalled?" — the gap between the last move and today is the evidence, not a guess.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { deal_id: { type: 'string' } }, required: ['deal_id'] },
    handler: async (args) => {
      const history = await Deals.stageHistory(args.deal_id);
      return { count: history.length, history };
    },
  },
  {
    name: 'get_sales_pipeline',
    description:
      'The pipeline by stage: how many deals sit in each, their total value and their probability-weighted value. '
      + 'The weighted figure is the one to quote as a forecast; the raw total assumes every open deal closes.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { owner_id: { type: 'string' } } },
    handler: async (args) => Deals.pipeline({ owner_id: args.owner_id }),
  },
  {
    name: 'search_contacts',
    description: 'People in the CRM, by name, email or the customer they belong to.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        customer_id: { type: 'string' },
        owner_id: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    handler: async (args) => {
      const rows = await Contacts.findAll({ ...args, limit: Math.min(args.limit || 50, 100) });
      return { count: rows.length, contacts: rows };
    },
  },
  {
    name: 'list_crm_activities',
    description:
      'Calls, meetings and tasks logged against deals, contacts and customers. Set overdue_only to find follow-ups that '
      + 'have slipped — a stalled deal usually has one.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string' },
        contact_id: { type: 'string' },
        owner_id: { type: 'string' },
        overdue_only: { type: 'boolean' },
        open_only: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
    handler: async (args) => {
      const rows = await Activities.findAll({ ...args, limit: Math.min(args.limit || 50, 100) });
      return { count: rows.length, activities: rows };
    },
  },

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------
  {
    name: 'list_projects',
    description:
      'Projects with status, customer, billing type, budget and manager. Set open_only for those still running '
      + '(planned, active or on hold).',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        customer_id: { type: 'string' },
        manager_id: { type: 'string' },
        open_only: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
    handler: async (args) => {
      const rows = await Projects.findAll({ ...args, limit: Math.min(args.limit || 100, 200) });
      return { count: rows.length, projects: rows };
    },
  },
  {
    name: 'get_project',
    description: 'One project in full, with its tasks and team.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
    handler: async (args) => {
      const project = await Projects.findById(args.project_id);
      if (!project) return { found: false, error: 'No project with that id.' };
      return { found: true, project };
    },
  },
  {
    name: 'get_project_profitability',
    description:
      'What a project actually cost and what it earned. Cost counts labour valued at each time entry\'s cost rate PLUS '
      + 'anything posted to the ledger against the project. Revenue is only counted once invoiced — recognising it as '
      + 'hours are logged would flatter every project still running, which is exactly when this gets looked at. '
      + 'Includes unbilled work, which is usually the number worth acting on.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
    handler: async (args) => Projects.profitAndLoss(args.project_id),
  },
  {
    name: 'get_project_budget',
    description: 'Budgeted hours and money against what has actually been consumed, per project.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
    handler: async (args) => Projects.budgetReport(args.project_id),
  },
  {
    name: 'list_time_entries',
    description:
      'Time logged against projects and tasks. Set unbilled_only to find work done but not yet invoiced — the most '
      + 'common reason a profitable project looks unprofitable.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        user_id: { type: 'string' },
        task_id: { type: 'string' },
        from_date: { type: 'string', description: 'YYYY-MM-DD' },
        to_date: { type: 'string', description: 'YYYY-MM-DD' },
        unbilled_only: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
    handler: async (args) => {
      const rows = await TimeEntries.findAll({ ...args, limit: Math.min(args.limit || 100, 200) });
      const hours = rows.reduce((s, r) => s + Number(r.hours || 0), 0);
      return { count: rows.length, total_hours: Math.round(hours * 100) / 100, entries: rows };
    },
  },
  {
    name: 'preview_project_billing',
    description:
      'What WOULD be invoiced for a project if you billed it now: the unbilled time entries and what they come to. '
      + 'This changes nothing — it is the preview a person sees before deciding to bill.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        to_date: { type: 'string', description: 'Only count work up to this date, YYYY-MM-DD' },
      },
      required: ['project_id'],
    },
    handler: async (args) => TimeEntries.previewBilling(args.project_id, { to_date: args.to_date }),
  },
  {
    name: 'get_project_milestones',
    description: 'Milestones on a project, whether they have been achieved and whether they have been billed.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
    handler: async (args) => {
      const rows = await Milestones.findByProject(args.project_id);
      return { count: rows.length, milestones: rows };
    },
  },
  {
    name: 'get_resource_load',
    description:
      'How heavily people are committed across projects, as of a date. Use this before answering whether a project can '
      + 'take on more, or who is over-allocated.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        employee_id: { type: 'string', description: 'One person. Omit for everyone.' },
        as_of_date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
      },
    },
    handler: async (args) => {
      const asOf = args.as_of_date || new Date().toISOString().slice(0, 10);
      if (args.employee_id) return ResourceAssignments.loadForEmployee(args.employee_id, asOf);
      const rows = await ResourceAssignments.loadOverview(asOf);
      return { as_of: asOf, count: rows.length, load: rows };
    },
  },

  // -------------------------------------------------------------------------
  // Operations reads that were missing.
  //
  // Each of these answers a question the agent was previously unable to touch
  // even though the page for it exists in the product.
  // -------------------------------------------------------------------------
  {
    name: 'get_budget_vs_actual',
    description:
      'A budget against what has actually posted to the ledger, line by line, with the variance on each. This is the '
      + 'first thing to reach for on "are we over budget?" — the variance is computed from real postings, not estimated.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { budget_id: { type: 'string', description: 'Omit to list the budgets available first' } },
    },
    handler: async (args) => {
      const Budget = require('../../models/Budget');
      if (!args.budget_id) {
        const rows = await Budget.findAll();
        return {
          count: rows.length,
          budgets: rows,
          note: 'No budget_id was given, so these are the budgets available. Call again with one to get its variance.',
        };
      }
      return Budget.getBudgetVsActual(args.budget_id);
    },
  },
  {
    name: 'list_delivery_schedules',
    description:
      'Planned deliveries against sales orders: what is going out, when, and whether it has shipped. Use this for '
      + '"what is due to ship this week?" and for whether a late delivery explains an unhappy customer.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        sales_order_id: { type: 'string' },
        customer_id: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    handler: async (args) => {
      const DeliverySchedule = require('../../models/DeliverySchedule');
      const rows = await DeliverySchedule.findAll({ ...args, limit: Math.min(args.limit || 50, 100) });
      const list = Array.isArray(rows) ? rows : rows?.data || [];
      return { count: list.length, deliveries: list };
    },
  },
  {
    name: 'list_contracts',
    description: 'Contracts with their party, value, dates and status — including which are close to expiry.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, customer_id: { type: 'string' }, limit: { type: 'number' } },
    },
    handler: async (args) => {
      const Contract = require('../../models/Contract');
      const rows = await Contract.findAll({ ...args, limit: Math.min(args.limit || 50, 100) });
      const list = Array.isArray(rows) ? rows : rows?.data || [];
      return { count: list.length, contracts: list };
    },
  },
];

module.exports = { crmProjectTools, pick };
