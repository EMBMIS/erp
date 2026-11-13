/**
 * Generated applications, exposed to Simeli.
 *
 * ===========================================================================
 * WHY SIMELI HAS TO KNOW ABOUT THESE
 * ===========================================================================
 * Once applications are data rather than code, half of what a company knows
 * lives in tables that did not exist when this file was written. A Simeli that
 * only reads the canonical ERP can answer "what is our cash?" and cannot answer
 * "how many supplier findings are open?" — about a process the same company
 * built inside the same product last week.
 *
 * So these tools ask the same questions the runtime answers, through the same
 * services: the catalogue for "what exists and what does it do", and the
 * generic data and analytics runtimes for the records themselves.
 *
 * ===========================================================================
 * WHAT THEY DELIBERATELY CANNOT DO
 * ===========================================================================
 * Every tool here is read-only, and every one goes through
 * runtime/authorization.js with a principal built for the ASKING USER. That
 * means Simeli sees exactly what the person it is talking to would see — not
 * more, and not a service account's view of everything. A question is not an
 * escalation.
 *
 * There is no tool here that writes an application record, changes a
 * specification, or deploys anything. Those exist in the Studio, behind an
 * administrator and an approval, and natural language is not a security
 * boundary: "deploy it" said to a chat window must not be a deployment.
 * (Drafting a new application from a sentence is build_in_sandbox, in
 * sandboxBuildTools.js: the Studio's own pipeline, for an administrator, and it
 * deploys nothing.)
 */

const companyContext = require('../companyContext');
const catalog = require('../platform/catalog');
const registry = require('../platform/registry');
const resolver = require('../platform/runtime/resolver');
const authz = require('../platform/runtime/authorization');
const data = require('../platform/runtime/data');
const analytics = require('../platform/runtime/analytics');
const { asCompany } = require('../platform/db');

async function companyFor() {
  return companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/**
 * Resolve an application and build a principal for the person asking.
 *
 * `ctx.userId` is the human in the conversation. Falling back to an
 * administrator view when there is no user would make Simeli a way to read
 * past your own permissions, so a context without one is refused instead.
 */
async function contextFor(companyId, appKey, ctx) {
  if (!ctx?.userId) {
    throw new Error('This tool answers as the person asking, so it needs to know who that is.');
  }
  const context = await resolver.resolveApplication(companyId, appKey);
  const principal = await authz.internalPrincipal({
    companyId,
    instance: context.instance,
    spec: context.spec,
    userId: ctx.userId,
    platformRole: ctx.userRole,
    surfaceKey: null,
  });
  return { context, principal };
}

const platformTools = [
  {
    name: 'list_applications',
    description:
      'What applications this company runs inside EMBMIS, what data each one owns, which EMBMIS entities it '
      + 'reads, whether it has a customer or supplier portal, and what it measures. Use this FIRST whenever '
      + 'someone asks about a business process that is not one of the built-in ERP areas — supplier quality, '
      + 'warranty claims, inspections, maintenance, anything a company had built for itself — because those '
      + 'live in generated applications whose tables you cannot query directly and must not guess at.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional words to narrow the list, e.g. "supplier quality" or "warranty".' },
      },
    },
    handler: async (args) => {
      const companyId = await companyFor();
      const applications = args?.search
        ? await catalog.search(companyId, args.search)
        : (await catalog.describe(companyId)).applications;
      return {
        applications: applications.map((a) => ({
          key: a.appKey,
          name: a.name,
          description: a.description,
          owns: a.entities.map((e) => ({ entity: e.key, label: e.label, belongs_to: e.anchoredTo })),
          reads_embmis_data: a.dependsOn,
          external_portals: a.externalAudiences,
          workflows: a.workflows.map((w) => `${w.entity}: ${w.states.join(' → ')}`),
          measures: a.metrics.map((m) => m.label),
        })),
      };
    },
  },

  {
    name: 'query_application_records',
    description:
      'Read records from one of this company\'s generated applications — findings, claims, inspections, whatever '
      + 'that application keeps. Call list_applications first to learn the application key and its entity keys; '
      + 'do not guess either. You see exactly what the person asking would see: their roles, their record '
      + 'visibility, their field access. Read-only.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        application: { type: 'string', description: 'The application key from list_applications, e.g. "supplier_quality".' },
        entity: { type: 'string', description: 'The entity key from list_applications, e.g. "quality_findings".' },
        filters: {
          type: 'array',
          description: 'Optional filters, each {field, operator, value}. Operators: eq, neq, lt, lte, gt, gte, contains, in, is_null, is_not_null.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              operator: { type: 'string' },
              value: {},
            },
            required: ['field', 'operator'],
          },
        },
        search: { type: 'string', description: 'Optional free-text search across the entity\'s text fields.' },
        sort: { type: 'string', description: 'Optional field to sort by.' },
        direction: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'number', description: 'How many records to return (default 25, maximum 100).' },
      },
      required: ['application', 'entity'],
    },
    handler: async (args, ctx) => {
      const companyId = await companyFor();
      return asCompany(companyId, async () => {
        const { context, principal } = await contextFor(companyId, args.application, ctx);
        const result = await data.list(context, principal, args.entity, {
          filters: Array.isArray(args.filters) ? args.filters : [],
          search: args.search || '',
          sort: args.sort || null,
          direction: args.direction === 'asc' ? 'asc' : 'desc',
          pageSize: Math.min(Math.max(1, Number(args.limit) || 25), 100),
        });
        return {
          application: args.application,
          entity: args.entity,
          total: result.total,
          showing: result.rows.length,
          records: result.rows,
        };
      });
    },
  },

  {
    name: 'application_measures',
    description:
      'The figures a generated application keeps about itself — open findings, average resolution time, claims by '
      + 'month, whatever it declares. Computed over the rows the person asking may see, so a portal user\'s '
      + 'numbers are their own. Prefer this to counting records yourself: the application already defines what '
      + 'its measures mean.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        application: { type: 'string', description: 'The application key from list_applications.' },
        measures: {
          type: 'array', items: { type: 'string' },
          description: 'Optional measure keys. Omit for all of them.',
        },
        query: { type: 'string', description: 'Optional analytics query key, for a grouped breakdown rather than a single figure.' },
      },
      required: ['application'],
    },
    handler: async (args, ctx) => {
      const companyId = await companyFor();
      return asCompany(companyId, async () => {
        const { context, principal } = await contextFor(companyId, args.application, ctx);
        if (args.query) {
          const result = await analytics.run(context, principal, args.query);
          return {
            application: args.application, query: result.key, label: result.label,
            grouped: result.grouped, rows: result.rows, total: result.total,
          };
        }
        const measures = await analytics.metrics(context, principal, Array.isArray(args.measures) ? args.measures : []);
        return { application: args.application, measures };
      });
    },
  },

  {
    name: 'explain_application',
    description:
      'How one generated application actually works: its entities and their fields, its workflow states and what '
      + 'each transition requires, who can do what, what its external portal shows, and what it automates. Use '
      + 'this when someone asks how a process runs, who has to approve something, what a supplier can see, or why '
      + 'a record is stuck.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        application: { type: 'string', description: 'The application key from list_applications.' },
      },
      required: ['application'],
    },
    handler: async (args) => {
      const companyId = await companyFor();
      return asCompany(companyId, async () => {
        const application = await registry.getApplicationByKey(args.application);
        if (!application) throw new Error(`This company has no application "${args.application}".`);
        await registry.assertVisible(application.id, companyId);
        const instance = await registry.getInstance(application.id, companyId);
        if (!instance?.version_id) throw new Error(`"${args.application}" is not deployed for this company.`);
        const version = await registry.getVersion(instance.version_id);
        const spec = version.spec;

        return {
          application: { key: spec.key, name: spec.name, description: spec.description, version: version.version },
          data: spec.data.entities.map((e) => ({
            entity: e.key,
            label: e.label,
            belongs_to: e.anchor ? `each record belongs to one ${e.anchor.kind}` : 'company-wide',
            fields: e.fields.map((f) => ({
              name: f.name, label: f.label, type: f.type,
              required: !!f.required,
              // Named explicitly, because "why can't the supplier see the cost?"
              // is a question this answers.
              internal_only: !!f.sensitive,
              references: f.target ? `${f.target.kind}:${f.target.entity}` : undefined,
            })),
            derived: (e.computed || []).map((c) => `${c.name} = ${c.expression}`),
          })),
          reads_embmis_data: spec.data.canonical_refs,
          workflows: spec.workflows.map((w) => ({
            workflow: w.key,
            entity: w.entity,
            states: w.states.map((s) => s.key),
            transitions: w.transitions.map((t) => ({
              from: t.from, to: t.to, label: t.label,
              requires: (t.requires || []).map((r) => (r.role ? `${r.type}:${r.role}` : r.type)),
              only_when: t.condition || undefined,
            })),
            deadlines: (w.slas || []).map((s) => `${s.state} for more than ${s.hours}h escalates to ${s.escalate_to_role || 'nobody'}`),
          })),
          who_uses_it: spec.surfaces.map((s) => ({
            surface: s.key, audience: s.audience, roles: s.roles, screens: s.nav.length,
          })),
          permissions: spec.security.roles.map((r) => ({
            role: r.key, audience: r.audience,
            can: r.permissions,
            sees: r.record_scope,
            can_approve: r.approval_authority,
          })),
          automations: spec.automations.map((a) => ({
            automation: a.key, label: a.label, enabled: a.enabled !== false,
            when: a.trigger.kind, entity: a.trigger.entity,
            only_if: a.condition || undefined,
            does: a.actions.map((x) => x.kind),
          })),
        };
      });
    },
  },

  {
    name: 'list_capability_opportunities',
    description:
      'Capabilities this business appears to need that no installed application provides — detected from counted '
      + 'evidence in the ledger, not from an opinion. Use this when someone asks what EMBMIS could do for them '
      + 'that it is not doing, or where they are working outside the system. Nothing here has been built: each '
      + 'one is a proposal a person opens in the Capability Studio.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['detected', 'proposed', 'accepted', 'dismissed'], description: 'Optional filter. Omit for everything outstanding.' },
      },
    },
    handler: async (args) => {
      const companyId = await companyFor();
      const discovery = require('../platform/discovery');
      const rows = await discovery.list(companyId, { status: args?.status || null });
      return {
        opportunities: rows.map((r) => ({
          title: r.title,
          why: r.reason,
          what_it_would_be: r.description,
          evidence: r.evidence,
          confidence: Number(r.confidence),
          needs_new_data: r.requires_new_data_model,
          status: r.status,
        })),
        note: 'Nothing here is built or scheduled. A person opens one in the Capability Studio, sees the plan, and decides.',
      };
    },
  },
];

module.exports = { platformTools };
