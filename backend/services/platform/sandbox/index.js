/**
 * The application sandbox: "will this application work, and is it safe?"
 *
 * ===========================================================================
 * TWO DIFFERENT SANDBOXES, DELIBERATELY KEPT APART
 * ===========================================================================
 * EMBMIS has a second thing called a sandbox — the ledger-grounded
 * counterfactual engine (services/ai/counterfactual/), which answers "what
 * happens to this business if we take this action?" by applying real writes to
 * real rows inside a transaction it always rolls back.
 *
 * This one answers a different question: "will this APPLICATION work safely?"
 * It never touches business data, never writes anything, and produces a report
 * about a specification rather than about a company. Conflating the two would
 * be a category error with security consequences — one of them is allowed to
 * touch the ledger and one of them is not.
 *
 * ===========================================================================
 * WHAT IT CHECKS
 * ===========================================================================
 * Seven sections, each independently reportable so a failure in one is legible
 * rather than a wall of text:
 *
 *   data        schema, relationships, constraints, indexes
 *   security    roles, permissions, tenant isolation, external visibility
 *   workflows   state validity, unreachable states, invalid transitions
 *   automation  triggers, actions, loops, dangerous behaviour
 *   ui          references, missing data, invalid components
 *   ai          tools, permissions, bounded actions
 *   database    migration safety, destructive changes, conflicts
 *
 * The first six come from the specification validator, sorted into sections by
 * diagnostic code — one set of rules, reported two ways, so the sandbox and the
 * deployment gate can never disagree about what is valid. The seventh needs the
 * live database and is only present when one is available.
 */

const validator = require('../spec/validator');
const planner = require('../compiler/planner');
const registry = require('../registry');
const deployer = require('../deployer');
const { pool, applicationRole } = require('../db');
const sampleData = require('./sampleData');
const { EXTERNAL_AUDIENCES } = require('../spec/types');

const SECTION_BY_PREFIX = [
  [/^(ENTITY|FIELD|REFERENCE|INDEX|CONSTRAINT|COMPUTED|CANONICAL|CASCADE|DISPLAY|ANCHOR|NO_DATA|TOO_MANY_ENTITIES)/, 'data'],
  [/^(ROLE|SURFACE|EXTERNAL|NO_ROLES|NO_SURFACES)/, 'security'],
  [/^(WORKFLOW|STATE|TRANSITION|SLA)/, 'workflows'],
  [/^AUTOMATION/, 'automation'],
  [/^(PAGE|BLOCK|NAV|FILTER|ACTION|FORM|QUERY|METRIC|TOO_MANY_PAGES)/, 'ui'],
  [/^AGENT/, 'ai'],
  [/^(APP_|INTEGRATION)/, 'application'],
];

function sectionFor(code) {
  const found = SECTION_BY_PREFIX.find(([re]) => re.test(code));
  return found ? found[1] : 'application';
}

/**
 * Run every check available. `companyId` and `applicationId` are optional: with
 * them the database section runs against the real current schema, without them
 * the report covers everything that can be known from the specification alone.
 *
 * @returns {{ok, sections, summary, preview}}
 */
async function run({ spec: rawSpec, companyId = null, applicationId = null, withPreview = true }) {
  const { spec, report } = validator.validate(rawSpec);

  const sections = {
    application: emptySection('Application', 'Identity, description and integrations.'),
    data: emptySection('Data', 'Entities, fields, relationships, constraints and indexes.'),
    security: emptySection('Security', 'Roles, permissions, record visibility and what leaves the company.'),
    workflows: emptySection('Workflows', 'States, transitions, approvals and deadlines.'),
    automation: emptySection('Automation', 'Triggers, conditions, actions and loops.'),
    ui: emptySection('Interface', 'Pages, blocks, navigation and the data they read.'),
    ai: emptySection('AI', 'Agents, their tools and how far they may act.'),
    database: emptySection('Database', 'What deploying this would do to the schema.'),
  };

  report.diagnostics.forEach((d) => {
    const section = sections[sectionFor(d.code)] || sections.application;
    section.diagnostics.push(d);
    if (d.level === 'error') section.errors += 1; else section.warnings += 1;
  });

  // -- extra security assertions the validator states differently ---------
  // Restating them here, as sandbox findings rather than validation errors,
  // makes the report answer "what would this expose?" directly rather than
  // leaving a reader to infer it from the absence of errors.
  sections.security.notes.push(...describeExposure(spec));
  sections.data.notes.push(...describeData(spec));
  sections.workflows.notes.push(...describeWorkflows(spec));

  // -- database ----------------------------------------------------------
  if (companyId && applicationId) {
    try {
      const instance = await registry.getInstance(applicationId, companyId);
      if (!instance) {
        sections.database.notes.push('This company has no instance of this application yet, so deploying it would create every table fresh.');
        const planResult = planner.plan({
          spec,
          instance: { id: '00000000-0000-0000-0000-000000000000', companyId, tablePrefix: 'app_00000000_00000000' },
          current: new Map(),
          appRole: await applicationRole(),
        });
        sections.database.notes.push(`${planResult.operations.filter((o) => o.kind === 'create_table').length} table(s) would be created.`);
        sections.database.plan = deployer.serializePlan(planResult);
        // A first install creates and destroys nothing, so it is "safe" — but
        // it has to SAY so, or the report reads as though the safety of the
        // deployment was never assessed.
        sections.database.safety = planResult.safety;
      } else {
        const deployedVersion = instance.version_id ? await registry.getVersion(instance.version_id) : null;
        const { state, drift } = await deployer.currentState(pool, instance, deployedVersion?.spec || null);
        drift.forEach((d) => {
          sections.database.diagnostics.push({ level: 'error', code: 'REGISTRY_DRIFT', path: 'database', message: d.issue });
          sections.database.errors += 1;
        });
        const planResult = planner.plan({
          spec,
          instance: { id: instance.id, companyId, tablePrefix: instance.table_prefix },
          current: state,
          appRole: await applicationRole(),
        });
        sections.database.plan = deployer.serializePlan(planResult);
        sections.database.safety = planResult.safety;
        planResult.notes.forEach((n) => {
          sections.database.diagnostics.push({ level: n.level, code: n.code, path: 'database', message: n.message });
          if (n.level === 'error') sections.database.errors += 1; else sections.database.warnings += 1;
        });
        planResult.summary.destructive.forEach((d) => {
          sections.database.diagnostics.push({ level: 'warning', code: 'DESTRUCTIVE', path: 'database', message: d });
          sections.database.warnings += 1;
        });
        sections.database.notes.push(
          planResult.operations.length
            ? `${planResult.operations.length} schema operation(s), classified "${planResult.safety}".`
            : 'No schema change: the database already matches this version.'
        );
      }
    } catch (error) {
      sections.database.diagnostics.push({
        level: 'error', code: 'PLAN_FAILED', path: 'database',
        message: `The migration plan could not be produced: ${error.message}`,
      });
      sections.database.errors += 1;
    }
  } else {
    sections.database.notes.push('No company was named, so the schema plan was not computed.');
  }

  const preview = withPreview && report.ok ? sampleData.buildPreview(spec) : null;

  const errors = Object.values(sections).reduce((n, s) => n + s.errors, 0);
  const warnings = Object.values(sections).reduce((n, s) => n + s.warnings, 0);

  return {
    ok: errors === 0,
    spec,
    sections,
    summary: {
      errors,
      warnings,
      entities: spec.data.entities.length,
      pages: spec.ui.pages.length,
      surfaces: spec.surfaces.length,
      externalSurfaces: spec.surfaces.filter((s) => EXTERNAL_AUDIENCES.has(s.audience)).map((s) => s.key),
      workflows: spec.workflows.length,
      automations: spec.automations.length,
      databaseSafety: sections.database.safety || 'unknown',
    },
    preview,
  };
}

function emptySection(label, description) {
  return { label, description, errors: 0, warnings: 0, diagnostics: [], notes: [] };
}

/** Plain sentences about what leaves the company, for a person to read. */
function describeExposure(spec) {
  const notes = [];
  const external = spec.surfaces.filter((s) => EXTERNAL_AUDIENCES.has(s.audience));
  if (!external.length) {
    notes.push('No external surface: nothing in this application is reachable from outside the company.');
    return notes;
  }
  external.forEach((surface) => {
    const roles = spec.security.roles.filter((r) => surface.roles.includes(r.key));
    const entities = new Set();
    spec.ui.pages.filter((p) => p.surface === surface.key).forEach((page) => {
      if (page.entity) entities.add(page.entity);
      (page.layout || []).forEach((b) => { if (b.entity) entities.add(b.entity); });
    });
    const anchored = [...entities].filter((k) => spec.data.entities.find((e) => e.key === k)?.anchor);
    const hidden = roles.flatMap((r) => Object.entries(r.field_access || {}).flatMap(
      ([entityKey, fields]) => Object.entries(fields).filter(([, a]) => a === 'hidden').map(([f]) => `${entityKey}.${f}`)
    ));
    const writable = roles.flatMap((r) => Object.entries(r.permissions || {})
      .filter(([, perms]) => perms.includes('create') || perms.includes('update'))
      .map(([k]) => k));

    notes.push(
      `${surface.label} (${surface.audience}): shows ${anchored.length ? anchored.join(', ') : 'nothing'}, `
      + `each limited to the viewer's own records by their anchor. `
      + `${writable.length ? `They may add or edit: ${[...new Set(writable)].join(', ')}. ` : 'They may only read. '}`
      + `${hidden.length ? `Hidden from them: ${[...new Set(hidden)].join(', ')}.` : 'No field is explicitly hidden.'}`
    );
  });
  return notes;
}

function describeData(spec) {
  const notes = [];
  spec.data.entities.forEach((entity) => {
    const refs = entity.fields.filter((f) => f.type === 'reference');
    const canonicalRefs = refs.filter((f) => f.target?.kind === 'canonical');
    notes.push(
      `${entity.label}: ${entity.fields.length} field(s), ${refs.length} relationship(s)`
      + `${canonicalRefs.length ? ` (${canonicalRefs.map((f) => f.target.entity).join(', ')} from EMBMIS)` : ''}`
      + `${entity.anchor ? `, anchored to a ${entity.anchor.kind}` : ''}.`
    );
  });
  if (spec.data.canonical_refs.length) {
    notes.push(`Reads existing EMBMIS data: ${spec.data.canonical_refs.join(', ')}. It never writes any of it.`);
  }
  return notes;
}

function describeWorkflows(spec) {
  return spec.workflows.map((wf) => {
    const approvals = wf.transitions.filter((t) => (t.requires || []).some((r) => r.type === 'approval'));
    const fourEyes = wf.transitions.filter((t) => (t.requires || []).some((r) => r.type === 'authority'));
    return `${wf.label}: ${wf.states.length} states, ${wf.transitions.length} transitions`
      + `${approvals.length ? `, ${approvals.length} needing approval` : ''}`
      + `${fourEyes.length ? `, ${fourEyes.length} that the raiser cannot do themselves` : ''}`
      + `${wf.slas?.length ? `, ${wf.slas.length} deadline(s)` : ''}.`;
  });
}

module.exports = { run, sectionFor };
