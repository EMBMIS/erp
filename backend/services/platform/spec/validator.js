/**
 * The application specification validator.
 *
 * ===========================================================================
 * WHAT THIS IS FOR
 * ===========================================================================
 * A specification arrives as JSON from a language model. Everything downstream
 * — the schema compiler, the runtime, the portal — is written on the
 * assumption that the specification is well-formed, internally consistent, and
 * within the platform's vocabulary. This file is where that assumption is
 * earned.
 *
 * It answers three different kinds of question, and keeping them apart matters:
 *
 *   STRUCTURE   Is this the right shape? Are the keys legal identifiers, the
 *               types in the vocabulary, the numbers numbers?
 *   COHERENCE   Does it refer to itself correctly? Does every page name an
 *               entity that exists, every transition a state that exists,
 *               every role a permission on an entity it can reach?
 *   SAFETY      Would deploying it expose something? An internal canonical
 *               column on a supplier portal, an external role with delete
 *               rights, an anchor-less entity on an external surface.
 *
 * A STRUCTURE failure means the specification is nonsense. A COHERENCE failure
 * means it would render broken. A SAFETY failure means it would leak. All three
 * are errors — the distinction is for the person reading the report, not for
 * whether it deploys.
 *
 * WARNINGS are for things that are legal but probably not what was meant: an
 * entity nothing displays, a metric no page uses, a state nothing can reach.
 *
 * The validator NEVER repairs. `normalize()` fills in omitted optional fields
 * with documented defaults, which is a different thing: it never changes a
 * value that was supplied, and it runs before validation so the report is
 * about the specification as it will actually be compiled.
 */

const {
  FIELD_TYPES, COMPUTED_RESULT_TYPES, ON_DELETE_ACTIONS, PAGE_KINDS, COMPONENT_TYPES,
  FILTER_OPERATORS, AGGREGATIONS, TIME_GRAINS, TRANSITION_REQUIREMENTS,
  AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS, SCHEDULE_CADENCES, SURFACE_AUDIENCES,
  EXTERNAL_AUDIENCES, PERMISSIONS, RECORD_SCOPES, INTEGRATION_KINDS,
  AI_SAFETY_CLASSES, AI_TOOL_KINDS,
} = require('./types');
const canonical = require('./canonical');
const expressions = require('./expressions');
const identifiers = require('../identifiers');

const MAX_ENTITIES = 200;
const MAX_FIELDS_PER_ENTITY = 120;
const MAX_PAGES = 300;

class Report {
  constructor() { this.diagnostics = []; }
  error(code, path, message) { this.diagnostics.push({ level: 'error', code, path, message }); return this; }
  warn(code, path, message) { this.diagnostics.push({ level: 'warning', code, path, message }); return this; }
  get errors() { return this.diagnostics.filter((d) => d.level === 'error'); }
  get warnings() { return this.diagnostics.filter((d) => d.level === 'warning'); }
  get ok() { return this.errors.length === 0; }
  toJSON() {
    return {
      ok: this.ok,
      errorCount: this.errors.length,
      warningCount: this.warnings.length,
      diagnostics: this.diagnostics,
    };
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : '');

// ---------------------------------------------------------------------------
// Normalization. Defaults only; never overrides what was supplied.
// ---------------------------------------------------------------------------
function normalize(input) {
  const spec = isObject(input) ? JSON.parse(JSON.stringify(input)) : {};

  spec.key = str(spec.key);
  spec.name = str(spec.name) || spec.key;
  spec.description = str(spec.description);
  spec.icon = str(spec.icon) || 'layout-grid';
  spec.category = str(spec.category) || 'operations';
  spec.spec_version = 1;

  spec.data = isObject(spec.data) ? spec.data : {};
  spec.data.entities = asArray(spec.data.entities).map((e) => {
    const entity = isObject(e) ? { ...e } : {};
    entity.key = str(entity.key);
    entity.label = str(entity.label) || entity.key;
    entity.singular = str(entity.singular) || entity.label;
    entity.description = str(entity.description);
    entity.fields = asArray(entity.fields).map((f) => {
      const field = isObject(f) ? { ...f } : {};
      field.name = str(field.name);
      field.label = str(field.label) || field.name;
      field.type = str(field.type);
      field.required = field.required === true;
      field.unique = field.unique === true;
      field.indexed = field.indexed === true;
      field.sensitive = field.sensitive === true;
      if (field.type === 'enum') field.values = asArray(field.values).map(str).filter(Boolean);
      if (field.type === 'reference' && isObject(field.target)) {
        field.target = {
          kind: str(field.target.kind) || 'app',
          entity: str(field.target.entity),
          on_delete: str(field.target.on_delete) || 'restrict',
        };
      }
      return field;
    });
    entity.computed = asArray(entity.computed).map((c) => ({
      name: str(c?.name), label: str(c?.label) || str(c?.name),
      expression: str(c?.expression), result_type: str(c?.result_type) || 'decimal',
    }));
    entity.indexes = asArray(entity.indexes).map((i) => ({
      fields: asArray(i?.fields).map(str).filter(Boolean),
      unique: i?.unique === true,
    }));
    entity.constraints = asArray(entity.constraints).map((c) => ({
      key: str(c?.key), expression: str(c?.expression), message: str(c?.message),
    }));
    entity.display = isObject(entity.display) ? entity.display : {};
    entity.display.title_field = str(entity.display.title_field);
    entity.display.subtitle_field = str(entity.display.subtitle_field);
    entity.anchor = isObject(entity.anchor) && str(entity.anchor.field)
      ? { field: str(entity.anchor.field), kind: str(entity.anchor.kind) }
      : null;
    return entity;
  });
  spec.data.canonical_refs = asArray(spec.data.canonical_refs).map(str).filter(Boolean);

  spec.workflows = asArray(spec.workflows).map((w) => ({
    key: str(w?.key),
    label: str(w?.label) || str(w?.key),
    entity: str(w?.entity),
    state_field: str(w?.state_field) || 'status',
    states: asArray(w?.states).map((s) => ({
      key: str(s?.key), label: str(s?.label) || str(s?.key),
      initial: s?.initial === true, terminal: s?.terminal === true,
      color: str(s?.color) || 'slate',
    })),
    transitions: asArray(w?.transitions).map((t) => ({
      key: str(t?.key), label: str(t?.label) || str(t?.key),
      from: str(t?.from), to: str(t?.to),
      condition: str(t?.condition),
      requires: asArray(t?.requires).map((r) => (isObject(r) ? { ...r, type: str(r.type) } : { type: str(r) })),
    })),
    slas: asArray(w?.slas).map((s) => ({
      state: str(s?.state), hours: Number(s?.hours) || 0,
      escalate_to_role: str(s?.escalate_to_role), label: str(s?.label),
    })),
  }));

  spec.security = isObject(spec.security) ? spec.security : {};
  spec.security.roles = asArray(spec.security.roles).map((r) => ({
    key: str(r?.key),
    label: str(r?.label) || str(r?.key),
    audience: str(r?.audience) || 'internal',
    description: str(r?.description),
    permissions: isObject(r?.permissions) ? r.permissions : {},
    record_scope: isObject(r?.record_scope) ? r.record_scope : {},
    field_access: isObject(r?.field_access) ? r.field_access : {},
    approval_authority: asArray(r?.approval_authority).map(str).filter(Boolean),
  }));

  spec.surfaces = asArray(spec.surfaces).map((s) => ({
    key: str(s?.key),
    label: str(s?.label) || str(s?.key),
    audience: str(s?.audience) || 'internal',
    description: str(s?.description),
    roles: asArray(s?.roles).map(str).filter(Boolean),
    default_page: str(s?.default_page),
    nav: asArray(s?.nav).map((n) => ({
      label: str(n?.label), page: str(n?.page), icon: str(n?.icon) || 'circle',
      section: str(n?.section),
    })),
  }));

  spec.ui = isObject(spec.ui) ? spec.ui : {};
  spec.ui.pages = asArray(spec.ui.pages).map((p) => ({
    key: str(p?.key),
    title: str(p?.title) || str(p?.key),
    kind: str(p?.kind) || 'dashboard',
    surface: str(p?.surface),
    entity: str(p?.entity),
    description: str(p?.description),
    filters: asArray(p?.filters).map((f) => ({
      field: str(f?.field), operator: str(f?.operator) || 'eq',
      label: str(f?.label) || str(f?.field), value: f?.value ?? null,
      user_editable: f?.user_editable !== false,
    })),
    actions: asArray(p?.actions).map((a) => ({
      key: str(a?.key), label: str(a?.label) || str(a?.key),
      kind: str(a?.kind) || 'open_page',
      target: str(a?.target), workflow: str(a?.workflow), transition: str(a?.transition),
      roles: asArray(a?.roles).map(str).filter(Boolean),
    })),
    layout: asArray(p?.layout).map((b) => normalizeBlock(b)),
  }));

  spec.analytics = isObject(spec.analytics) ? spec.analytics : {};
  spec.analytics.queries = asArray(spec.analytics.queries).map((q) => ({
    key: str(q?.key),
    label: str(q?.label) || str(q?.key),
    entity: str(q?.entity),
    source: str(q?.source) || 'app',
    aggregation: str(q?.aggregation) || 'count',
    field: str(q?.field),
    group_by: str(q?.group_by),
    time_grain: str(q?.time_grain),
    date_field: str(q?.date_field),
    filter: str(q?.filter),
    limit: Number.isFinite(q?.limit) ? Math.min(Math.max(1, Math.trunc(q.limit)), 500) : 50,
    order: str(q?.order) === 'asc' ? 'asc' : 'desc',
  }));
  spec.analytics.metrics = asArray(spec.analytics.metrics).map((m) => ({
    key: str(m?.key),
    label: str(m?.label) || str(m?.key),
    query: str(m?.query),
    format: str(m?.format) || 'number',
    unit: str(m?.unit),
    target: Number.isFinite(m?.target) ? m.target : null,
    direction: str(m?.direction) === 'lower_is_better' ? 'lower_is_better' : 'higher_is_better',
  }));

  spec.automations = asArray(spec.automations).map((a) => ({
    key: str(a?.key),
    label: str(a?.label) || str(a?.key),
    enabled: a?.enabled !== false,
    trigger: isObject(a?.trigger) ? {
      kind: str(a.trigger.kind),
      entity: str(a.trigger.entity),
      workflow: str(a.trigger.workflow),
      to_state: str(a.trigger.to_state),
      cadence: str(a.trigger.cadence),
      hour: Number.isFinite(a.trigger.hour) ? a.trigger.hour : 8,
    } : { kind: '' },
    condition: str(a?.condition),
    actions: asArray(a?.actions).map((x) => (isObject(x) ? { ...x, kind: str(x.kind) } : { kind: str(x) })),
  }));

  spec.ai = isObject(spec.ai) ? spec.ai : {};
  spec.ai.agents = asArray(spec.ai.agents).map((g) => ({
    key: str(g?.key),
    label: str(g?.label) || str(g?.key),
    purpose: str(g?.purpose),
    safety_class: str(g?.safety_class) || 'read_only',
    entities: asArray(g?.entities).map(str).filter(Boolean),
    tools: asArray(g?.tools).map((t) => ({ kind: str(t?.kind), entity: str(t?.entity), query: str(t?.query) })),
    requires_approval: g?.requires_approval !== false,
    surfaces: asArray(g?.surfaces).map(str).filter(Boolean),
  }));

  spec.integrations = asArray(spec.integrations).map((i) => ({
    key: str(i?.key),
    label: str(i?.label) || str(i?.key),
    kind: str(i?.kind),
    entity: str(i?.entity),
    canonical_entity: str(i?.canonical_entity),
    direction: str(i?.direction) || 'outbound',
    description: str(i?.description),
  }));

  spec.navigation = isObject(spec.navigation) ? spec.navigation : {};
  spec.navigation.sections = asArray(spec.navigation.sections).map((s) => ({
    key: str(s?.key), label: str(s?.label) || str(s?.key), order: Number(s?.order) || 0,
  }));

  return spec;
}

function normalizeBlock(b) {
  const block = isObject(b) ? { ...b } : {};
  return {
    type: str(block.type),
    title: str(block.title),
    width: ['quarter', 'third', 'half', 'two_thirds', 'full'].includes(str(block.width)) ? block.width : 'full',
    entity: str(block.entity),
    canonical: str(block.canonical),
    query: str(block.query),
    metric: str(block.metric),
    metrics: asArray(block.metrics).map(str).filter(Boolean),
    fields: asArray(block.fields).map(str).filter(Boolean),
    relationship: str(block.relationship),
    workflow: str(block.workflow),
    group_by: str(block.group_by),
    date_field: str(block.date_field),
    geo_field: str(block.geo_field),
    text: str(block.text),
    filter: str(block.filter),
    limit: Number.isFinite(block.limit) ? Math.min(Math.max(1, Math.trunc(block.limit)), 200) : 25,
    visibility: str(block.visibility),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function validate(rawSpec) {
  const spec = normalize(rawSpec);
  const report = new Report();

  // -- identity ------------------------------------------------------------
  if (!identifiers.isLogicalKey(spec.key, { maxLength: 47 })) {
    report.error('APP_KEY', 'key',
      `Application key "${spec.key}" must be lowercase snake_case, start with a letter, be at most 47 characters, and not be a reserved word.`);
  }
  if (!spec.name) report.error('APP_NAME', 'name', 'An application needs a name.');
  if (!spec.description) report.warn('APP_DESCRIPTION', 'description', 'An application without a description is hard for anyone — including Simeli — to reason about later.');

  // -- data ----------------------------------------------------------------
  const entities = new Map();
  if (spec.data.entities.length > MAX_ENTITIES) {
    report.error('TOO_MANY_ENTITIES', 'data.entities', `An application may declare at most ${MAX_ENTITIES} entities.`);
  }
  spec.data.entities.forEach((entity, idx) => {
    const path = `data.entities[${idx}]`;
    try {
      identifiers.assertEntityKey(entity.key);
    } catch (err) {
      report.error('ENTITY_KEY', `${path}.key`, err.message);
      return;
    }
    if (entities.has(entity.key)) {
      report.error('ENTITY_DUPLICATE', `${path}.key`, `Entity "${entity.key}" is declared more than once.`);
      return;
    }
    if (canonical.entity(entity.key)) {
      report.error('ENTITY_SHADOWS_CANONICAL', `${path}.key`,
        `"${entity.key}" is a canonical EMBMIS entity. An application references canonical data, it does not redeclare it — use data.canonical_refs and a reference field instead.`);
      return;
    }
    entities.set(entity.key, entity);
    validateEntity(entity, path, report);
  });

  spec.data.canonical_refs.forEach((key, idx) => {
    if (!canonical.entity(key)) {
      report.error('CANONICAL_UNKNOWN', `data.canonical_refs[${idx}]`,
        `"${key}" is not a canonical EMBMIS entity. Available: ${Object.keys(canonical.CANONICAL_ENTITIES).join(', ')}.`);
    }
  });

  if (!entities.size && !spec.data.canonical_refs.length) {
    report.error('NO_DATA', 'data', 'An application must own at least one entity or reference at least one canonical EMBMIS entity. It cannot be built on nothing.');
  }

  // Cross-entity: references must land somewhere real, and a canonical
  // reference must name an entity the application declared it uses.
  entities.forEach((entity, key) => {
    entity.fields.filter((f) => f.type === 'reference').forEach((field) => {
      const path = `data.entities[${key}].fields[${field.name}].target`;
      const target = field.target;
      if (!isObject(target) || !target.entity) {
        report.error('REFERENCE_TARGET', path, `Reference field "${field.name}" must name a target entity.`);
        return;
      }
      if (target.kind === 'canonical') {
        if (!canonical.entity(target.entity)) {
          report.error('REFERENCE_TARGET', path, `"${target.entity}" is not a canonical EMBMIS entity.`);
        } else if (!spec.data.canonical_refs.includes(target.entity)) {
          report.warn('CANONICAL_UNDECLARED', path,
            `"${key}.${field.name}" references canonical entity "${target.entity}" which is not listed in data.canonical_refs. Listing it is how Simeli and the catalogue know this application depends on it.`);
        }
        // Deleting a supplier must not silently delete a company's quality
        // history. Cascade across the canonical boundary is refused outright.
        if (target.on_delete === 'cascade') {
          report.error('REFERENCE_CASCADE', path,
            `A reference to canonical entity "${target.entity}" may not cascade on delete: removing a supplier would silently destroy this application's records about it. Use restrict or set_null.`);
        }
      } else if (target.kind === 'app') {
        if (!entities.has(target.entity)) {
          report.error('REFERENCE_TARGET', path,
            `"${key}.${field.name}" references application entity "${target.entity}", which this application does not declare.`);
        }
      } else {
        report.error('REFERENCE_KIND', path, `Reference target kind must be "app" or "canonical", got "${target.kind}".`);
      }
      if (!ON_DELETE_ACTIONS.has(target.on_delete)) {
        report.error('REFERENCE_ON_DELETE', path, `on_delete must be one of ${[...ON_DELETE_ACTIONS].join(', ')}.`);
      }
    });
  });

  // Reference cycles that cascade would delete unpredictably far. A cycle
  // itself is legal (a record referring to another of its own kind is normal);
  // a cascading cycle is not.
  detectCascadeCycles(entities, report);

  // -- workflows -----------------------------------------------------------
  const workflows = new Map();
  spec.workflows.forEach((wf, idx) => {
    const path = `workflows[${idx}]`;
    if (!identifiers.isLogicalKey(wf.key, { maxLength: 47 })) {
      report.error('WORKFLOW_KEY', `${path}.key`, `Workflow key "${wf.key}" must be lowercase snake_case.`);
      return;
    }
    if (workflows.has(wf.key)) {
      report.error('WORKFLOW_DUPLICATE', `${path}.key`, `Workflow "${wf.key}" is declared more than once.`);
      return;
    }
    workflows.set(wf.key, wf);
    validateWorkflow(wf, entities, path, report);
  });

  // -- security ------------------------------------------------------------
  const roles = new Map();
  spec.security.roles.forEach((role, idx) => {
    const path = `security.roles[${idx}]`;
    if (!identifiers.isLogicalKey(role.key, { maxLength: 47 })) {
      report.error('ROLE_KEY', `${path}.key`, `Role key "${role.key}" must be lowercase snake_case.`);
      return;
    }
    if (roles.has(role.key)) {
      report.error('ROLE_DUPLICATE', `${path}.key`, `Role "${role.key}" is declared more than once.`);
      return;
    }
    roles.set(role.key, role);
    validateRole(role, entities, workflows, path, report);
  });
  if (!roles.size) {
    report.error('NO_ROLES', 'security.roles', 'An application must declare at least one role. Without roles nothing can be authorized, and the runtime refuses every request.');
  }

  // -- surfaces ------------------------------------------------------------
  const surfaces = new Map();
  spec.surfaces.forEach((surface, idx) => {
    const path = `surfaces[${idx}]`;
    if (!identifiers.isLogicalKey(surface.key, { maxLength: 47 })) {
      report.error('SURFACE_KEY', `${path}.key`, `Surface key "${surface.key}" must be lowercase snake_case.`);
      return;
    }
    if (surfaces.has(surface.key)) {
      report.error('SURFACE_DUPLICATE', `${path}.key`, `Surface "${surface.key}" is declared more than once.`);
      return;
    }
    if (!SURFACE_AUDIENCES.has(surface.audience)) {
      report.error('SURFACE_AUDIENCE', `${path}.audience`, `Audience must be one of ${[...SURFACE_AUDIENCES].join(', ')}.`);
    }
    surfaces.set(surface.key, surface);
    surface.roles.forEach((roleKey, ri) => {
      const role = roles.get(roleKey);
      if (!role) {
        report.error('SURFACE_ROLE', `${path}.roles[${ri}]`, `Surface "${surface.key}" grants role "${roleKey}", which is not declared.`);
        return;
      }
      if (role.audience !== surface.audience) {
        report.error('SURFACE_ROLE_AUDIENCE', `${path}.roles[${ri}]`,
          `Surface "${surface.key}" is a ${surface.audience} surface but role "${roleKey}" is a ${role.audience} role. A role reaches exactly one audience; sharing one across the internal and external sides is how an internal permission ends up on a portal.`);
      }
    });
    if (!surface.roles.length) {
      report.error('SURFACE_NO_ROLES', `${path}.roles`, `Surface "${surface.key}" grants no roles, so nobody can open it.`);
    }
  });
  if (!surfaces.size) {
    report.error('NO_SURFACES', 'surfaces', 'An application must declare at least one surface — otherwise it has no way to be used.');
  }
  if (![...surfaces.values()].some((s) => s.audience === 'internal')) {
    report.warn('NO_INTERNAL_SURFACE', 'surfaces', 'This application has no internal surface. The company that runs it will have no way to see its own data.');
  }

  // -- analytics -----------------------------------------------------------
  const queries = new Map();
  spec.analytics.queries.forEach((q, idx) => {
    const path = `analytics.queries[${idx}]`;
    if (!identifiers.isLogicalKey(q.key, { maxLength: 47 })) {
      report.error('QUERY_KEY', `${path}.key`, `Query key "${q.key}" must be lowercase snake_case.`);
      return;
    }
    if (queries.has(q.key)) {
      report.error('QUERY_DUPLICATE', `${path}.key`, `Analytics query "${q.key}" is declared more than once.`);
      return;
    }
    queries.set(q.key, q);
    validateQuery(q, entities, path, report);
  });

  const metrics = new Map();
  spec.analytics.metrics.forEach((m, idx) => {
    const path = `analytics.metrics[${idx}]`;
    if (!identifiers.isLogicalKey(m.key, { maxLength: 47 })) {
      report.error('METRIC_KEY', `${path}.key`, `Metric key "${m.key}" must be lowercase snake_case.`);
      return;
    }
    if (metrics.has(m.key)) {
      report.error('METRIC_DUPLICATE', `${path}.key`, `Metric "${m.key}" is declared more than once.`);
      return;
    }
    if (!queries.has(m.query)) {
      report.error('METRIC_QUERY', `${path}.query`, `Metric "${m.key}" reads query "${m.query}", which is not declared.`);
    }
    metrics.set(m.key, m);
  });

  // -- ui ------------------------------------------------------------------
  const pages = new Map();
  if (spec.ui.pages.length > MAX_PAGES) {
    report.error('TOO_MANY_PAGES', 'ui.pages', `An application may declare at most ${MAX_PAGES} pages.`);
  }
  spec.ui.pages.forEach((page, idx) => {
    const path = `ui.pages[${idx}]`;
    if (!identifiers.isLogicalKey(page.key, { maxLength: 47 })) {
      report.error('PAGE_KEY', `${path}.key`, `Page key "${page.key}" must be lowercase snake_case.`);
      return;
    }
    if (pages.has(page.key)) {
      report.error('PAGE_DUPLICATE', `${path}.key`, `Page "${page.key}" is declared more than once.`);
      return;
    }
    pages.set(page.key, page);
    validatePage(page, { entities, surfaces, queries, metrics, workflows, canonicalRefs: spec.data.canonical_refs }, path, report);
  });

  // Navigation must point at pages that exist and live on the same surface —
  // a customer surface whose nav links an internal page is a broken link at
  // best and an authorization probe at worst.
  surfaces.forEach((surface) => {
    surface.nav.forEach((item, ni) => {
      const page = pages.get(item.page);
      if (!page) {
        report.error('NAV_PAGE', `surfaces[${surface.key}].nav[${ni}]`, `Navigation entry "${item.label || item.page}" points at page "${item.page}", which is not declared.`);
      } else if (page.surface !== surface.key) {
        report.error('NAV_PAGE_SURFACE', `surfaces[${surface.key}].nav[${ni}]`,
          `Surface "${surface.key}" links page "${item.page}", which belongs to surface "${page.surface}".`);
      }
    });
    if (!surface.nav.length) {
      report.error('SURFACE_NO_NAV', `surfaces[${surface.key}].nav`, `Surface "${surface.key}" has no navigation, so none of its pages are reachable.`);
    }
    if (surface.default_page && !pages.has(surface.default_page)) {
      report.error('SURFACE_DEFAULT_PAGE', `surfaces[${surface.key}].default_page`, `Default page "${surface.default_page}" is not declared.`);
    }
  });

  // -- external exposure (the safety pass) ---------------------------------
  validateExternalExposure(spec, { entities, surfaces, pages, roles, queries }, report);

  // -- automations ---------------------------------------------------------
  const automations = new Map();
  spec.automations.forEach((a, idx) => {
    const path = `automations[${idx}]`;
    if (!identifiers.isLogicalKey(a.key, { maxLength: 47 })) {
      report.error('AUTOMATION_KEY', `${path}.key`, `Automation key "${a.key}" must be lowercase snake_case.`);
      return;
    }
    if (automations.has(a.key)) {
      report.error('AUTOMATION_DUPLICATE', `${path}.key`, `Automation "${a.key}" is declared more than once.`);
      return;
    }
    automations.set(a.key, a);
    validateAutomation(a, { entities, workflows, roles, surfaces }, path, report);
  });
  detectAutomationLoops(spec.automations, report);

  // -- ai ------------------------------------------------------------------
  spec.ai.agents.forEach((agent, idx) => {
    const path = `ai.agents[${idx}]`;
    if (!identifiers.isLogicalKey(agent.key, { maxLength: 47 })) {
      report.error('AGENT_KEY', `${path}.key`, `Agent key "${agent.key}" must be lowercase snake_case.`);
      return;
    }
    if (!AI_SAFETY_CLASSES.has(agent.safety_class)) {
      report.error('AGENT_SAFETY', `${path}.safety_class`, `Safety class must be one of ${[...AI_SAFETY_CLASSES].join(', ')}.`);
    }
    agent.entities.forEach((e, ei) => {
      if (!entities.has(e) && !canonical.entity(e)) {
        report.error('AGENT_ENTITY', `${path}.entities[${ei}]`, `Agent "${agent.key}" is given access to "${e}", which is neither an application entity nor a canonical entity.`);
      }
    });
    agent.tools.forEach((tool, ti) => {
      if (!AI_TOOL_KINDS.has(tool.kind)) {
        report.error('AGENT_TOOL', `${path}.tools[${ti}]`, `Agent tool kind "${tool.kind}" is not in the platform vocabulary (${[...AI_TOOL_KINDS].join(', ')}).`);
      }
      if (tool.entity && !agent.entities.includes(tool.entity)) {
        report.error('AGENT_TOOL_SCOPE', `${path}.tools[${ti}]`,
          `Agent "${agent.key}" has a tool over "${tool.entity}" but that entity is not in its declared entity list. An agent's reach is its entity list; a tool cannot widen it.`);
      }
    });
    if (agent.safety_class === 'act_within_authority' && agent.requires_approval === false) {
      report.warn('AGENT_AUTONOMY', `${path}.safety_class`,
        `Agent "${agent.key}" is set to act without approval. Autonomy is granted from measured outcomes and explicit authority, never from a specification asking for it — the runtime will still require approval until an operator raises its authority level.`);
    }
    agent.surfaces.forEach((s, si) => {
      const surface = surfaces.get(s);
      if (!surface) {
        report.error('AGENT_SURFACE', `${path}.surfaces[${si}]`, `Agent "${agent.key}" is placed on surface "${s}", which is not declared.`);
      } else if (EXTERNAL_AUDIENCES.has(surface.audience) && agent.safety_class !== 'read_only') {
        report.error('AGENT_EXTERNAL_AUTONOMY', `${path}.surfaces[${si}]`,
          `Agent "${agent.key}" is on external surface "${s}" with safety class "${agent.safety_class}". An agent reachable by someone outside the company may only read.`);
      }
    });
  });

  // -- integrations --------------------------------------------------------
  spec.integrations.forEach((integration, idx) => {
    const path = `integrations[${idx}]`;
    if (!INTEGRATION_KINDS.has(integration.kind)) {
      report.error('INTEGRATION_KIND', `${path}.kind`, `Integration kind must be one of ${[...INTEGRATION_KINDS].join(', ')}.`);
    }
    if (integration.entity && !entities.has(integration.entity)) {
      report.error('INTEGRATION_ENTITY', `${path}.entity`, `Integration "${integration.key}" names entity "${integration.entity}", which is not declared.`);
    }
    if (integration.canonical_entity && !canonical.entity(integration.canonical_entity)) {
      report.error('INTEGRATION_CANONICAL', `${path}.canonical_entity`, `"${integration.canonical_entity}" is not a canonical EMBMIS entity.`);
    }
  });

  // -- coherence warnings --------------------------------------------------
  const usedEntities = new Set();
  pages.forEach((p) => {
    if (p.entity) usedEntities.add(p.entity);
    p.layout.forEach((b) => { if (b.entity) usedEntities.add(b.entity); });
  });
  queries.forEach((q) => { if (q.source === 'app') usedEntities.add(q.entity); });
  entities.forEach((_, key) => {
    if (!usedEntities.has(key)) {
      report.warn('ENTITY_UNUSED', `data.entities[${key}]`,
        `Entity "${key}" gets a table but no page or query reads it. Nobody will ever see its records.`);
    }
  });
  queries.forEach((q, key) => {
    const used = [...pages.values()].some((p) => p.layout.some((b) => b.query === key))
      || [...metrics.values()].some((m) => m.query === key);
    if (!used) report.warn('QUERY_UNUSED', `analytics.queries[${key}]`, `Analytics query "${key}" is not used by any page or metric.`);
  });

  return { spec, report };
}

// ---------------------------------------------------------------------------
function validateEntity(entity, path, report) {
  if (!entity.fields.length) {
    report.error('ENTITY_NO_FIELDS', `${path}.fields`, `Entity "${entity.key}" declares no fields. Every generated table already has id/company_id/timestamps; an entity that adds nothing to them stores nothing.`);
  }
  if (entity.fields.length > MAX_FIELDS_PER_ENTITY) {
    report.error('ENTITY_TOO_MANY_FIELDS', `${path}.fields`, `Entity "${entity.key}" declares ${entity.fields.length} fields; the limit is ${MAX_FIELDS_PER_ENTITY}.`);
  }

  const fieldTypes = {};
  const seen = new Set();
  entity.fields.forEach((field, fi) => {
    const fpath = `${path}.fields[${fi}]`;
    try {
      identifiers.assertFieldKey(field.name);
    } catch (err) {
      report.error('FIELD_NAME', `${fpath}.name`, err.message);
      return;
    }
    if (seen.has(field.name)) {
      report.error('FIELD_DUPLICATE', `${fpath}.name`, `Field "${field.name}" is declared more than once on "${entity.key}".`);
      return;
    }
    seen.add(field.name);

    if (!Object.prototype.hasOwnProperty.call(FIELD_TYPES, field.type)) {
      report.error('FIELD_TYPE', `${fpath}.type`,
        `Field "${entity.key}.${field.name}" has type "${field.type}", which is not in the platform vocabulary: ${Object.keys(FIELD_TYPES).join(', ')}.`);
      return;
    }
    const type = FIELD_TYPES[field.type];
    fieldTypes[field.name] = field.type;

    if (type.requiresValues) {
      if (!field.values?.length) {
        report.error('FIELD_ENUM_VALUES', `${fpath}.values`, `Enum field "${entity.key}.${field.name}" must list its allowed values.`);
      } else {
        if (field.values.length > 64) {
          report.error('FIELD_ENUM_SIZE', `${fpath}.values`, `Enum "${entity.key}.${field.name}" has ${field.values.length} values; 64 is the limit. Beyond that it is a lookup table, not an enum.`);
        }
        const dupes = field.values.filter((v, i) => field.values.indexOf(v) !== i);
        if (dupes.length) {
          report.error('FIELD_ENUM_DUPLICATE', `${fpath}.values`, `Enum "${entity.key}.${field.name}" repeats value(s): ${[...new Set(dupes)].join(', ')}.`);
        }
        field.values.forEach((v) => {
          if (typeof v !== 'string' || v.length > 64 || !/^[A-Za-z0-9 _\-./]+$/.test(v)) {
            report.error('FIELD_ENUM_VALUE', `${fpath}.values`,
              `Enum value ${JSON.stringify(v)} on "${entity.key}.${field.name}" must be plain text (letters, digits, space, _ - . /) of at most 64 characters — it becomes a CHECK constraint.`);
          }
        });
      }
    }
    if (type.requiresTarget && !isObject(field.target)) {
      report.error('FIELD_REFERENCE', `${fpath}.target`, `Reference field "${entity.key}.${field.name}" must declare a target.`);
    }
    if (field.default !== undefined && field.default !== null) {
      validateDefault(field, `${fpath}.default`, report, entity.key);
    }
  });

  // Computed fields are expressions over the entity's own stored fields.
  const computedSeen = new Set();
  entity.computed.forEach((c, ci) => {
    const cpath = `${path}.computed[${ci}]`;
    if (!identifiers.isLogicalKey(c.name, { maxLength: identifiers.MAX_FIELD_KEY_LENGTH })) {
      report.error('COMPUTED_NAME', `${cpath}.name`, `Computed field name "${c.name}" must be lowercase snake_case.`);
      return;
    }
    if (seen.has(c.name) || computedSeen.has(c.name)) {
      report.error('COMPUTED_DUPLICATE', `${cpath}.name`, `"${entity.key}.${c.name}" collides with an existing field.`);
      return;
    }
    computedSeen.add(c.name);
    if (!COMPUTED_RESULT_TYPES.has(c.result_type)) {
      report.error('COMPUTED_TYPE', `${cpath}.result_type`, `Computed result type must be one of ${[...COMPUTED_RESULT_TYPES].join(', ')}.`);
    }
    try {
      const { type } = expressions.compile(c.expression, fieldTypes);
      const want = expressions.family(c.result_type);
      if (type !== 'any' && type !== want) {
        report.error('COMPUTED_MISMATCH', `${cpath}.expression`, `Computed field "${entity.key}.${c.name}" is declared ${c.result_type} but its expression yields ${type}.`);
      }
    } catch (err) {
      report.error('COMPUTED_EXPRESSION', `${cpath}.expression`, `Computed field "${entity.key}.${c.name}": ${err.message}`);
    }
  });

  entity.indexes.forEach((index, ii) => {
    const ipath = `${path}.indexes[${ii}]`;
    if (!index.fields.length) {
      report.error('INDEX_EMPTY', ipath, `Index ${ii} on "${entity.key}" names no fields.`);
      return;
    }
    if (index.fields.length > 8) {
      report.error('INDEX_WIDTH', ipath, `Index on "${entity.key}" names ${index.fields.length} fields; 8 is the limit.`);
    }
    index.fields.forEach((f) => {
      if (!seen.has(f)) {
        report.error('INDEX_FIELD', ipath, `Index on "${entity.key}" names field "${f}", which is not declared. Computed fields are not stored and cannot be indexed.`);
      }
    });
  });

  entity.constraints.forEach((c, ci) => {
    const cpath = `${path}.constraints[${ci}]`;
    if (!identifiers.isLogicalKey(c.key, { maxLength: 40 })) {
      report.error('CONSTRAINT_KEY', `${cpath}.key`, `Constraint key "${c.key}" must be lowercase snake_case.`);
      return;
    }
    try {
      const { type } = expressions.compile(c.expression, fieldTypes, { allowContext: false });
      if (type !== 'boolean') {
        report.error('CONSTRAINT_TYPE', `${cpath}.expression`, `Constraint "${entity.key}.${c.key}" must be a boolean condition, got ${type}.`);
      }
    } catch (err) {
      report.error('CONSTRAINT_EXPRESSION', `${cpath}.expression`, `Constraint "${entity.key}.${c.key}": ${err.message}`);
    }
  });

  if (entity.display.title_field && !seen.has(entity.display.title_field) && !computedSeen.has(entity.display.title_field)) {
    report.error('DISPLAY_FIELD', `${path}.display.title_field`, `Title field "${entity.display.title_field}" is not a field of "${entity.key}".`);
  }
  if (!entity.display.title_field) {
    report.warn('DISPLAY_MISSING', `${path}.display.title_field`, `Entity "${entity.key}" has no title field, so its records will be listed by id.`);
  }

  // The anchor is the external visibility rule. It must be a reference to the
  // canonical entity that matches the anchor kind — anything else would be a
  // scope the runtime cannot derive.
  if (entity.anchor) {
    const apath = `${path}.anchor`;
    const field = entity.fields.find((f) => f.name === entity.anchor.field);
    if (!field) {
      report.error('ANCHOR_FIELD', apath, `Entity "${entity.key}" anchors on "${entity.anchor.field}", which is not a declared field.`);
    } else if (field.type !== 'reference' || field.target?.kind !== 'canonical') {
      report.error('ANCHOR_TYPE', apath,
        `Anchor field "${entity.key}.${entity.anchor.field}" must be a reference to a canonical entity — that reference is how the runtime derives "records belonging to this supplier".`);
    } else {
      const target = canonical.entity(field.target.entity);
      if (!target?.anchorKind) {
        report.error('ANCHOR_TARGET', apath, `Canonical entity "${field.target.entity}" cannot anchor an external identity. Only ${Object.keys(canonical.ANCHOR_ENTITIES).join(', ')} can.`);
      } else if (entity.anchor.kind && entity.anchor.kind !== target.anchorKind) {
        report.error('ANCHOR_KIND', apath, `Anchor on "${entity.key}" declares kind "${entity.anchor.kind}" but "${field.target.entity}" anchors "${target.anchorKind}" identities.`);
      } else {
        entity.anchor.kind = target.anchorKind;
      }
    }
  }
}

function validateDefault(field, path, report, entityKey) {
  const t = field.type;
  const v = field.default;
  const bad = (why) => report.error('FIELD_DEFAULT', path, `Default for "${entityKey}.${field.name}": ${why}`);
  if (t === 'enum') {
    if (!field.values?.includes(v)) bad(`${JSON.stringify(v)} is not one of the declared values.`);
  } else if (['integer', 'bigint', 'decimal', 'money', 'percent', 'duration_hours'].includes(t)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) bad('must be a finite number.');
  } else if (t === 'boolean') {
    if (typeof v !== 'boolean') bad('must be true or false.');
  } else if (t === 'reference' || t === 'json' || t === 'geo_point') {
    bad(`fields of type ${t} may not have a literal default.`);
  } else if (['date', 'datetime'].includes(t)) {
    if (v !== 'now' && Number.isNaN(Date.parse(v))) bad('must be an ISO date or the literal string "now".');
  } else if (typeof v !== 'string' || v.length > 255) {
    bad('must be a string of at most 255 characters.');
  }
}

function validateWorkflow(wf, entities, path, report) {
  const entity = entities.get(wf.entity);
  if (!entity) {
    report.error('WORKFLOW_ENTITY', `${path}.entity`, `Workflow "${wf.key}" is attached to entity "${wf.entity}", which this application does not declare.`);
    return;
  }
  const stateField = entity.fields.find((f) => f.name === wf.state_field);
  if (!stateField) {
    report.error('WORKFLOW_STATE_FIELD', `${path}.state_field`, `Workflow "${wf.key}" drives field "${wf.state_field}", which "${wf.entity}" does not declare.`);
  } else if (stateField.type !== 'enum') {
    report.error('WORKFLOW_STATE_TYPE', `${path}.state_field`,
      `Workflow "${wf.key}" drives "${wf.entity}.${wf.state_field}", which is ${stateField.type}. A workflow's state field must be an enum so the database itself refuses a state the workflow does not know.`);
  }

  const states = new Map();
  wf.states.forEach((s, si) => {
    if (!s.key) { report.error('STATE_KEY', `${path}.states[${si}]`, 'A workflow state needs a key.'); return; }
    if (states.has(s.key)) { report.error('STATE_DUPLICATE', `${path}.states[${si}]`, `State "${s.key}" appears twice in workflow "${wf.key}".`); return; }
    states.set(s.key, s);
    if (stateField?.type === 'enum' && stateField.values && !stateField.values.includes(s.key)) {
      report.error('STATE_NOT_IN_ENUM', `${path}.states[${si}]`,
        `Workflow "${wf.key}" has state "${s.key}" but "${wf.entity}.${wf.state_field}" does not allow that value. The enum and the workflow must agree, or the database will reject a transition the workflow considers legal.`);
    }
  });
  if (!states.size) {
    report.error('WORKFLOW_NO_STATES', `${path}.states`, `Workflow "${wf.key}" declares no states.`);
    return;
  }
  const initial = [...states.values()].filter((s) => s.initial);
  if (initial.length !== 1) {
    report.error('WORKFLOW_INITIAL', `${path}.states`,
      `Workflow "${wf.key}" has ${initial.length} initial states; exactly one is required so a new record has an unambiguous starting point.`);
  }
  if (![...states.values()].some((s) => s.terminal)) {
    report.warn('WORKFLOW_NO_TERMINAL', `${path}.states`, `Workflow "${wf.key}" has no terminal state, so nothing it tracks ever finishes.`);
  }

  const fieldTypes = Object.fromEntries(entity.fields.map((f) => [f.name, f.type]));
  entity.computed.forEach((c) => { fieldTypes[c.name] = c.result_type; });

  const transitionKeys = new Set();
  wf.transitions.forEach((t, ti) => {
    const tpath = `${path}.transitions[${ti}]`;
    if (!identifiers.isLogicalKey(t.key, { maxLength: 47 })) {
      report.error('TRANSITION_KEY', `${tpath}.key`, `Transition key "${t.key}" must be lowercase snake_case.`);
    } else if (transitionKeys.has(t.key)) {
      report.error('TRANSITION_DUPLICATE', `${tpath}.key`, `Transition "${t.key}" appears twice in workflow "${wf.key}".`);
    }
    transitionKeys.add(t.key);
    if (!states.has(t.from)) report.error('TRANSITION_FROM', `${tpath}.from`, `Transition "${t.key}" starts at "${t.from}", which is not a state of workflow "${wf.key}".`);
    if (!states.has(t.to)) report.error('TRANSITION_TO', `${tpath}.to`, `Transition "${t.key}" ends at "${t.to}", which is not a state of workflow "${wf.key}".`);
    if (t.from === t.to) report.warn('TRANSITION_SELF', tpath, `Transition "${t.key}" goes from "${t.from}" to itself.`);
    if (states.get(t.from)?.terminal) {
      report.error('TRANSITION_FROM_TERMINAL', `${tpath}.from`, `Transition "${t.key}" leaves terminal state "${t.from}". A terminal state is one nothing leaves; make it non-terminal or drop the transition.`);
    }
    if (t.condition) {
      try {
        const { type } = expressions.compile(t.condition, fieldTypes);
        if (type !== 'boolean') report.error('TRANSITION_CONDITION_TYPE', `${tpath}.condition`, `Transition "${t.key}" condition must be boolean, got ${type}.`);
      } catch (err) {
        report.error('TRANSITION_CONDITION', `${tpath}.condition`, `Transition "${t.key}": ${err.message}`);
      }
    }
    t.requires.forEach((r, ri) => {
      if (!TRANSITION_REQUIREMENTS.has(r.type)) {
        report.error('TRANSITION_REQUIRES', `${tpath}.requires[${ri}]`, `Requirement "${r.type}" is not in the vocabulary (${[...TRANSITION_REQUIREMENTS].join(', ')}).`);
      }
      if (r.type === 'role' && !str(r.role)) {
        report.error('TRANSITION_REQUIRES_ROLE', `${tpath}.requires[${ri}]`, `A "role" requirement on transition "${t.key}" must name a role.`);
      }
      if (r.type === 'approval' && !str(r.role)) {
        report.error('TRANSITION_REQUIRES_APPROVAL', `${tpath}.requires[${ri}]`, `An "approval" requirement on transition "${t.key}" must name the approving role.`);
      }
    });
  });

  // Unreachable states. A state nothing can transition into, and that is not
  // the initial state, is dead: records will never be in it.
  const reachable = new Set(initial.map((s) => s.key));
  let grew = true;
  while (grew) {
    grew = false;
    wf.transitions.forEach((t) => {
      if (reachable.has(t.from) && !reachable.has(t.to)) { reachable.add(t.to); grew = true; }
    });
  }
  states.forEach((s, key) => {
    if (!reachable.has(key)) {
      report.error('STATE_UNREACHABLE', `${path}.states`, `State "${key}" of workflow "${wf.key}" cannot be reached from the initial state by any transition.`);
    }
    if (!s.terminal && !wf.transitions.some((t) => t.from === key)) {
      report.warn('STATE_DEAD_END', `${path}.states`, `State "${key}" of workflow "${wf.key}" is not terminal but has no way out. A record that reaches it is stuck.`);
    }
  });

  wf.slas.forEach((sla, si) => {
    if (!states.has(sla.state)) report.error('SLA_STATE', `${path}.slas[${si}].state`, `SLA names state "${sla.state}", which workflow "${wf.key}" does not have.`);
    if (!(sla.hours > 0)) report.error('SLA_HOURS', `${path}.slas[${si}].hours`, 'An SLA needs a positive number of hours.');
  });
}

function validateRole(role, entities, workflows, path, report) {
  if (!SURFACE_AUDIENCES.has(role.audience)) {
    report.error('ROLE_AUDIENCE', `${path}.audience`, `Role audience must be one of ${[...SURFACE_AUDIENCES].join(', ')}.`);
  }
  const external = EXTERNAL_AUDIENCES.has(role.audience);

  Object.entries(role.permissions).forEach(([entityKey, perms]) => {
    const ppath = `${path}.permissions.${entityKey}`;
    const isApp = entities.has(entityKey);
    const isCanonical = !!canonical.entity(entityKey);
    if (!isApp && !isCanonical) {
      report.error('ROLE_PERMISSION_ENTITY', ppath, `Role "${role.key}" is granted permissions on "${entityKey}", which is neither an application entity nor a canonical entity.`);
      return;
    }
    asArray(perms).forEach((p) => {
      if (!PERMISSIONS.has(p)) {
        report.error('ROLE_PERMISSION', ppath, `Permission "${p}" is not in the vocabulary (${[...PERMISSIONS].join(', ')}).`);
        return;
      }
      // Canonical data belongs to EMBMIS, not to a generated application. An
      // application reads it; it does not get to write or delete it through a
      // generic runtime that knows none of the ERP's posting rules.
      if (isCanonical && p !== 'read' && p !== 'export') {
        report.error('ROLE_CANONICAL_WRITE', ppath,
          `Role "${role.key}" is granted "${p}" on canonical entity "${entityKey}". Generated applications may only read canonical EMBMIS data — writing a supplier or an invoice goes through the ERP's own rules, not through an application's generic runtime.`);
      }
      if (external && (p === 'delete' || p === 'administer' || p === 'export')) {
        report.error('ROLE_EXTERNAL_PERMISSION', ppath,
          `External role "${role.key}" is granted "${p}" on "${entityKey}". Someone outside the company may create and update their own records; deleting, exporting and administering are never theirs.`);
      }
    });
  });

  Object.entries(role.record_scope).forEach(([entityKey, scope]) => {
    const spath = `${path}.record_scope.${entityKey}`;
    if (!RECORD_SCOPES.has(scope)) {
      report.error('ROLE_SCOPE', spath, `Record scope "${scope}" is not in the vocabulary (${[...RECORD_SCOPES].join(', ')}).`);
      return;
    }
    if (scope === 'anchor') {
      const entity = entities.get(entityKey);
      if (!entity) {
        report.error('ROLE_SCOPE_ENTITY', spath, `Anchor scope is only meaningful on an application entity; "${entityKey}" is not one.`);
      } else if (!entity.anchor) {
        report.error('ROLE_SCOPE_ANCHOR', spath,
          `Role "${role.key}" gets anchor-scoped access to "${entityKey}", but that entity declares no anchor. Without one the runtime has no way to say which records belong to the viewer, so it would have to show all of them.`);
      }
    }
  });

  // The rule that makes external access safe by construction: an external role
  // reaching an entity must be anchor-scoped on it. Forgetting the scope is the
  // single most likely way to build a portal that shows every supplier every
  // other supplier's findings, so it is an error rather than a default.
  if (external) {
    Object.keys(role.permissions).forEach((entityKey) => {
      if (!entities.has(entityKey)) return;
      const scope = role.record_scope[entityKey];
      if (scope !== 'anchor' && scope !== 'none') {
        report.error('EXTERNAL_SCOPE_REQUIRED', `${path}.record_scope.${entityKey}`,
          `External role "${role.key}" can reach "${entityKey}" with record scope "${scope || 'unset'}". Every entity an external role touches must be anchor-scoped, or that role sees every company record of that kind.`);
      }
    });
  }

  Object.entries(role.field_access).forEach(([entityKey, fields]) => {
    const fpath = `${path}.field_access.${entityKey}`;
    const entity = entities.get(entityKey);
    const canon = canonical.entity(entityKey);
    if (!entity && !canon) {
      report.error('ROLE_FIELD_ENTITY', fpath, `Field access is declared for "${entityKey}", which is not an entity of this application.`);
      return;
    }
    Object.entries(isObject(fields) ? fields : {}).forEach(([fieldName, access]) => {
      if (!['hidden', 'read', 'write'].includes(access)) {
        report.error('ROLE_FIELD_ACCESS', `${fpath}.${fieldName}`, `Field access must be hidden, read or write; got "${access}".`);
      }
      const known = entity
        ? entity.fields.some((f) => f.name === fieldName) || entity.computed.some((c) => c.name === fieldName)
        : !!canonical.column(entityKey, fieldName);
      if (!known) {
        report.error('ROLE_FIELD_UNKNOWN', `${fpath}.${fieldName}`, `Field access names "${entityKey}.${fieldName}", which does not exist.`);
      }
    });
  });

  role.approval_authority.forEach((ref, ai) => {
    const [wfKey, transitionKey] = ref.split('.');
    const wf = workflows.get(wfKey);
    if (!wf) {
      report.error('ROLE_AUTHORITY', `${path}.approval_authority[${ai}]`, `Role "${role.key}" is given approval authority over "${ref}", but workflow "${wfKey}" is not declared.`);
    } else if (!wf.transitions.some((t) => t.key === transitionKey)) {
      report.error('ROLE_AUTHORITY_TRANSITION', `${path}.approval_authority[${ai}]`, `Workflow "${wfKey}" has no transition "${transitionKey}".`);
    }
  });
}

function validateQuery(q, entities, path, report) {
  let fieldTypes = null;
  if (q.source === 'app') {
    const entity = entities.get(q.entity);
    if (!entity) {
      report.error('QUERY_ENTITY', `${path}.entity`, `Query "${q.key}" reads entity "${q.entity}", which this application does not declare.`);
      return;
    }
    fieldTypes = Object.fromEntries(entity.fields.map((f) => [f.name, f.type]));
    entity.computed.forEach((c) => { fieldTypes[c.name] = c.result_type; });
  } else if (q.source === 'canonical') {
    const entity = canonical.entity(q.entity);
    if (!entity) {
      report.error('QUERY_CANONICAL', `${path}.entity`, `Query "${q.key}" reads canonical entity "${q.entity}", which does not exist.`);
      return;
    }
    fieldTypes = Object.fromEntries(Object.entries(entity.columns).map(([n, c]) => [n, c.type]));
  } else {
    report.error('QUERY_SOURCE', `${path}.source`, `Query source must be "app" or "canonical", got "${q.source}".`);
    return;
  }

  if (!AGGREGATIONS.has(q.aggregation)) {
    report.error('QUERY_AGGREGATION', `${path}.aggregation`, `Aggregation "${q.aggregation}" is not in the vocabulary (${[...AGGREGATIONS].join(', ')}).`);
  }
  const needsField = !['count'].includes(q.aggregation);
  if (needsField) {
    if (!q.field) {
      report.error('QUERY_FIELD', `${path}.field`, `Aggregation "${q.aggregation}" on query "${q.key}" needs a field.`);
    } else if (!fieldTypes[q.field]) {
      report.error('QUERY_FIELD_UNKNOWN', `${path}.field`, `Query "${q.key}" aggregates "${q.field}", which "${q.entity}" does not have.`);
    } else if (['sum', 'avg', 'median'].includes(q.aggregation)) {
      const t = FIELD_TYPES[fieldTypes[q.field]];
      if (!t?.aggregatable || expressions.family(fieldTypes[q.field]) !== 'number') {
        report.error('QUERY_FIELD_TYPE', `${path}.field`, `Query "${q.key}" applies ${q.aggregation} to "${q.field}", which is ${fieldTypes[q.field]} — not a number.`);
      }
    }
  }
  if (q.group_by && !fieldTypes[q.group_by]) {
    report.error('QUERY_GROUP_BY', `${path}.group_by`, `Query "${q.key}" groups by "${q.group_by}", which "${q.entity}" does not have.`);
  }
  if (q.time_grain) {
    if (!TIME_GRAINS.has(q.time_grain)) {
      report.error('QUERY_GRAIN', `${path}.time_grain`, `Time grain must be one of ${[...TIME_GRAINS].join(', ')}.`);
    }
    if (!q.date_field) {
      report.error('QUERY_DATE_FIELD', `${path}.date_field`, `Query "${q.key}" declares a time grain but no date field to apply it to.`);
    } else if (!['date', 'datetime'].includes(fieldTypes[q.date_field])) {
      report.error('QUERY_DATE_FIELD_TYPE', `${path}.date_field`, `Query "${q.key}" groups over time using "${q.date_field}", which is ${fieldTypes[q.date_field] || 'missing'}.`);
    }
  }
  if (q.filter) {
    try {
      const { type } = expressions.compile(q.filter, fieldTypes);
      if (type !== 'boolean') report.error('QUERY_FILTER_TYPE', `${path}.filter`, `Query "${q.key}" filter must be boolean, got ${type}.`);
    } catch (err) {
      report.error('QUERY_FILTER', `${path}.filter`, `Query "${q.key}": ${err.message}`);
    }
  }
}

function validatePage(page, ctx, path, report) {
  const { entities, surfaces, queries, metrics, workflows, canonicalRefs = [] } = ctx;
  if (!PAGE_KINDS.has(page.kind)) {
    report.error('PAGE_KIND', `${path}.kind`, `Page kind "${page.kind}" is not in the vocabulary (${[...PAGE_KINDS].join(', ')}).`);
  }
  if (!surfaces.has(page.surface)) {
    report.error('PAGE_SURFACE', `${path}.surface`, `Page "${page.key}" belongs to surface "${page.surface}", which is not declared.`);
  }
  const entity = page.entity ? entities.get(page.entity) : null;
  if (page.entity && !entity) {
    report.error('PAGE_ENTITY', `${path}.entity`, `Page "${page.key}" is bound to entity "${page.entity}", which this application does not declare.`);
  }
  if (['list', 'detail', 'form', 'board', 'calendar', 'timeline', 'map'].includes(page.kind) && !page.entity) {
    report.error('PAGE_ENTITY_REQUIRED', `${path}.entity`, `A ${page.kind} page needs an entity.`);
  }

  const fieldTypes = entity
    ? {
      ...Object.fromEntries(entity.fields.map((f) => [f.name, f.type])),
      ...Object.fromEntries(entity.computed.map((c) => [c.name, c.result_type])),
    }
    : {};

  page.filters.forEach((f, fi) => {
    const fpath = `${path}.filters[${fi}]`;
    if (!FILTER_OPERATORS.has(f.operator)) {
      report.error('FILTER_OPERATOR', `${fpath}.operator`, `Filter operator "${f.operator}" is not in the vocabulary (${[...FILTER_OPERATORS].join(', ')}).`);
    }
    if (!fieldTypes[f.field]) {
      report.error('FILTER_FIELD', `${fpath}.field`, `Page "${page.key}" filters on "${f.field}", which "${page.entity || '(no entity)'}" does not have.`);
    }
  });

  page.actions.forEach((a, ai) => {
    const apath = `${path}.actions[${ai}]`;
    if (!['open_page', 'create_record', 'transition', 'export'].includes(a.kind)) {
      report.error('ACTION_KIND', `${apath}.kind`, `Action kind "${a.kind}" is not supported. Use open_page, create_record, transition or export.`);
    }
    if (a.kind === 'transition') {
      const wf = workflows.get(a.workflow);
      if (!wf) report.error('ACTION_WORKFLOW', `${apath}.workflow`, `Action "${a.key}" runs workflow "${a.workflow}", which is not declared.`);
      else if (a.transition && !wf.transitions.some((t) => t.key === a.transition)) {
        report.error('ACTION_TRANSITION', `${apath}.transition`, `Workflow "${a.workflow}" has no transition "${a.transition}".`);
      }
    }
  });

  if (!page.layout.length) {
    report.warn('PAGE_EMPTY', `${path}.layout`, `Page "${page.key}" has no blocks, so it renders as an empty screen.`);
  }

  page.layout.forEach((block, bi) => {
    const bpath = `${path}.layout[${bi}]`;
    const def = Object.prototype.hasOwnProperty.call(COMPONENT_TYPES, block.type) ? COMPONENT_TYPES[block.type] : null;
    if (!def) {
      report.error('BLOCK_TYPE', `${bpath}.type`, `Component "${block.type}" is not in the platform vocabulary: ${Object.keys(COMPONENT_TYPES).join(', ')}.`);
      return;
    }
    def.needs.forEach((need) => {
      const value = need === 'metrics' || need === 'fields' ? block[need] : block[need];
      const missing = Array.isArray(value) ? value.length === 0 : !value;
      if (missing) report.error('BLOCK_MISSING', `${bpath}.${need}`, `A "${block.type}" block needs "${need}".`);
    });

    if (block.query && !queries.has(block.query)) {
      report.error('BLOCK_QUERY', `${bpath}.query`, `Block on page "${page.key}" reads query "${block.query}", which is not declared.`);
    }
    if (block.metric && !metrics.has(block.metric)) {
      report.error('BLOCK_METRIC', `${bpath}.metric`, `Block on page "${page.key}" shows metric "${block.metric}", which is not declared.`);
    }
    block.metrics.forEach((m) => {
      if (!metrics.has(m)) report.error('BLOCK_METRIC', `${bpath}.metrics`, `Metric "${m}" is not declared.`);
    });
    if (block.workflow && !workflows.has(block.workflow)) {
      report.error('BLOCK_WORKFLOW', `${bpath}.workflow`, `Block references workflow "${block.workflow}", which is not declared.`);
    }

    if (block.type === 'live_monitor' && block.canonical) {
      if (!canonical.live(block.canonical)) {
        report.error('LIVE_UNKNOWN', `${bpath}.canonical`, `Canonical entity "${block.canonical}" has no live measures. Only ${Object.keys(canonical.CANONICAL_ENTITIES).filter((k) => canonical.live(k)).join(', ')} do.`);
      } else if (!canonicalRefs.includes(block.canonical)) {
        report.error('LIVE_UNDECLARED', `${bpath}.canonical`, `Live monitor on page "${page.key}" reads "${block.canonical}", which is not listed in data.canonical_refs.`);
      }
      const surface = surfaces.get(page.surface);
      if (surface && EXTERNAL_AUDIENCES.has(surface.audience)) {
        report.error('LIVE_EXTERNAL', `${bpath}.type`, `Live monitor on page "${page.key}" is on external surface "${page.surface}". Live measures are the company's own assessment and never go to a portal.`);
      }
    }

    const blockEntity = block.entity ? entities.get(block.entity) : entity;
    if (block.entity && !blockEntity) {
      report.error('BLOCK_ENTITY', `${bpath}.entity`, `Block references entity "${block.entity}", which this application does not declare.`);
      return;
    }
    if (blockEntity) {
      const blockFields = {
        ...Object.fromEntries(blockEntity.fields.map((f) => [f.name, f.type])),
        ...Object.fromEntries(blockEntity.computed.map((c) => [c.name, c.result_type])),
      };
      block.fields.forEach((f) => {
        if (!blockFields[f]) {
          report.error('BLOCK_FIELD', `${bpath}.fields`, `Block on page "${page.key}" shows "${blockEntity.key}.${f}", which does not exist.`);
        }
      });
      if (block.type === 'form') {
        block.fields.forEach((f) => {
          if (blockEntity.computed.some((c) => c.name === f)) {
            report.error('FORM_COMPUTED_FIELD', `${bpath}.fields`, `Form on page "${page.key}" offers "${f}" for editing, but it is a computed field — it is derived, not stored.`);
          }
        });
        // A form omitting a required field would reject every submission — with
        // one exception: on an external surface the anchor field is set by the
        // server from the viewer's own identity and MUST NOT be on the form,
        // because offering it would be inviting a portal user to file a record
        // against somebody else.
        const surfaceAudience = surfaces.get(page.surface)?.audience;
        const serverSupplied = new Set();
        if (surfaceAudience && EXTERNAL_AUDIENCES.has(surfaceAudience) && blockEntity.anchor?.field) {
          serverSupplied.add(blockEntity.anchor.field);
        }
        const missingRequired = blockEntity.fields
          .filter((f) => f.required && f.default === undefined
            && !block.fields.includes(f.name) && !serverSupplied.has(f.name))
          .map((f) => f.name);
        if (missingRequired.length) {
          report.error('FORM_MISSING_REQUIRED', `${bpath}.fields`,
            `Form on page "${page.key}" omits required field(s) ${missingRequired.join(', ')} of "${blockEntity.key}" and has no default for them, so every submission would be rejected by the database.`);
        }
      }
      if (block.group_by && !blockFields[block.group_by]) {
        report.error('BLOCK_GROUP_BY', `${bpath}.group_by`, `Block groups by "${block.group_by}", which "${blockEntity.key}" does not have.`);
      }
      if (block.date_field && !['date', 'datetime'].includes(blockFields[block.date_field])) {
        report.error('BLOCK_DATE_FIELD', `${bpath}.date_field`, `Block uses "${block.date_field}" as a date, but it is ${blockFields[block.date_field] || 'missing'}.`);
      }
      if (block.geo_field && blockFields[block.geo_field] !== 'geo_point') {
        report.error('BLOCK_GEO_FIELD', `${bpath}.geo_field`, `Map block uses "${block.geo_field}" as a location, but it is ${blockFields[block.geo_field] || 'missing'}, not geo_point.`);
      }
      if (block.filter) {
        try {
          const { type } = expressions.compile(block.filter, blockFields);
          if (type !== 'boolean') report.error('BLOCK_FILTER_TYPE', `${bpath}.filter`, `Block filter must be boolean, got ${type}.`);
        } catch (err) {
          report.error('BLOCK_FILTER', `${bpath}.filter`, err.message);
        }
      }
      if (block.type === 'related_list') {
        const rel = blockEntity.fields.find((f) => f.name === block.relationship && f.type === 'reference');
        if (!rel) {
          report.error('BLOCK_RELATIONSHIP', `${bpath}.relationship`,
            `Related list on page "${page.key}" joins through "${block.entity}.${block.relationship}", which is not a reference field.`);
        }
      }
    }
  });
}

/**
 * The safety pass: what would this specification expose to someone outside the
 * company that runs it?
 */
function validateExternalExposure(spec, { entities, surfaces, pages, roles, queries }, report) {
  const externalSurfaces = [...surfaces.values()].filter((s) => EXTERNAL_AUDIENCES.has(s.audience));
  if (!externalSurfaces.length) return;

  externalSurfaces.forEach((surface) => {
    const surfaceRoles = surface.roles.map((k) => roles.get(k)).filter(Boolean);
    const surfacePages = [...pages.values()].filter((p) => p.surface === surface.key);

    // Which entities does this surface actually put on screen?
    const exposed = new Map();
    surfacePages.forEach((page) => {
      const add = (key, where) => {
        if (!key) return;
        if (!exposed.has(key)) exposed.set(key, []);
        exposed.get(key).push(where);
      };
      add(page.entity, `page "${page.key}"`);
      page.layout.forEach((b) => add(b.entity, `page "${page.key}"`));
      page.layout.forEach((b) => {
        if (!b.query) return;
        const q = queries.get(b.query);
        if (q) add(q.entity, `query "${b.query}" on page "${page.key}"`);
      });
    });

    exposed.forEach((where, entityKey) => {
      const path = `surfaces[${surface.key}]`;
      const canon = canonical.entity(entityKey);
      if (canon) {
        // A canonical entity on an external surface is allowed, but only its
        // shared columns, and only through blocks that name them.
        surfacePages.forEach((page) => {
          page.layout.filter((b) => b.entity === entityKey).forEach((b, bi) => {
            b.fields.forEach((f) => {
              const col = canonical.column(entityKey, f);
              if (!col) {
                report.error('EXTERNAL_CANONICAL_FIELD', `${path}.pages.${page.key}.layout[${bi}]`,
                  `Page "${page.key}" on external surface "${surface.key}" shows "${entityKey}.${f}", which is not a column this platform exposes at all.`);
              } else if (!col.shared) {
                report.error('EXTERNAL_CANONICAL_INTERNAL', `${path}.pages.${page.key}.layout[${bi}]`,
                  `Page "${page.key}" is on the ${surface.audience} surface "${surface.key}" and shows "${entityKey}.${f}", which is internal EMBMIS data. Shareable columns of ${entityKey}: ${canonical.sharedColumns(entityKey).join(', ') || '(none)'}.`);
              }
            });
          });
        });
        return;
      }

      const entity = entities.get(entityKey);
      if (!entity) return; // already reported as unknown elsewhere

      // Any application entity reachable from an external surface has to be
      // anchor-scoped for every role on that surface.
      if (!entity.anchor) {
        report.error('EXTERNAL_ENTITY_NO_ANCHOR', `${path}`,
          `Entity "${entityKey}" appears on external surface "${surface.key}" (${where.join(', ')}) but declares no anchor. Without one there is no rule that limits a ${surface.audience} to their own records, so every one of them would see all of them.`);
      } else if (surface.audience !== 'public' && entity.anchor.kind && entity.anchor.kind !== surface.audience) {
        report.error('EXTERNAL_ANCHOR_MISMATCH', `${path}`,
          `Entity "${entityKey}" is anchored to a ${entity.anchor.kind} but appears on the ${surface.audience} surface "${surface.key}". A ${surface.audience} identity cannot be matched against a ${entity.anchor.kind} anchor.`);
      }

      surfaceRoles.forEach((role) => {
        const perms = asArray(role.permissions[entityKey]);
        if (!perms.length) {
          report.error('EXTERNAL_NO_PERMISSION', `${path}`,
            `Surface "${surface.key}" shows "${entityKey}" but role "${role.key}" has no permission on it, so the page would render empty for everyone who can open it.`);
        }
        if (role.record_scope[entityKey] !== 'anchor') {
          report.error('EXTERNAL_SCOPE_REQUIRED', `security.roles[${role.key}].record_scope.${entityKey}`,
            `Role "${role.key}" reaches "${entityKey}" from external surface "${surface.key}" without anchor scoping.`);
        }
      });

      // Fields explicitly marked sensitive must be hidden from every external
      // role that can reach the entity. Marking a field sensitive and then not
      // hiding it is exactly the mistake worth catching before deployment.
      const sensitiveFields = entity.fields.filter((f) => f.sensitive).map((f) => f.name);
      sensitiveFields.forEach((fieldName) => {
        surfaceRoles.forEach((role) => {
          const access = role.field_access?.[entityKey]?.[fieldName];
          if (access !== 'hidden') {
            report.error('EXTERNAL_SENSITIVE_FIELD', `security.roles[${role.key}].field_access.${entityKey}.${fieldName}`,
              `"${entityKey}.${fieldName}" is marked sensitive but external role "${role.key}" on surface "${surface.key}" is not denied it. Set field_access.${entityKey}.${fieldName} = "hidden".`);
          }
        });
        surfacePages.forEach((page) => {
          page.layout.forEach((b, bi) => {
            if ((b.entity || page.entity) === entityKey && b.fields.includes(fieldName)) {
              report.error('EXTERNAL_SENSITIVE_BLOCK', `ui.pages[${page.key}].layout[${bi}].fields`,
                `Page "${page.key}" on external surface "${surface.key}" puts sensitive field "${entityKey}.${fieldName}" on screen.`);
            }
          });
        });
      });

      // Internal comments must not be readable from a portal.
      surfacePages.forEach((page) => {
        page.layout.filter((b) => b.type === 'comments').forEach((b, bi) => {
          if (b.visibility !== 'shared') {
            report.error('EXTERNAL_COMMENTS_VISIBILITY', `ui.pages[${page.key}].layout[${bi}].visibility`,
              `The comments block on external page "${page.key}" must set visibility to "shared". Internal notes on a record are not for the ${surface.audience} looking at it.`);
          }
        });
      });
    });
  });
}

/** A cascading reference cycle deletes unpredictably far. Refuse it. */
function detectCascadeCycles(entities, report) {
  const edges = new Map();
  entities.forEach((entity, key) => {
    const targets = entity.fields
      .filter((f) => f.type === 'reference' && f.target?.kind === 'app' && f.target.on_delete === 'cascade')
      .map((f) => f.target.entity);
    edges.set(key, targets);
  });
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(node)), node].join(' -> ');
      report.error('CASCADE_CYCLE', 'data.entities',
        `Cascading delete forms a cycle: ${cycle}. Deleting any record in it would delete an unbounded set. Break it with restrict or set_null.`);
      return;
    }
    state.set(node, 'visiting');
    stack.push(node);
    (edges.get(node) || []).forEach((t) => { if (edges.has(t)) visit(t); });
    stack.pop();
    state.set(node, 'done');
  };
  entities.forEach((_, key) => visit(key));
}

/**
 * An automation whose action re-triggers it (directly or through a chain) would
 * run until the depth limit stopped it. The limit is real and enforced at
 * runtime, but a specification that relies on it is a specification with a bug
 * in it, so it is reported here.
 */
function detectAutomationLoops(automations, report) {
  const writesTo = (a) => {
    const targets = new Set();
    a.actions.forEach((action) => {
      if (action.kind === 'set_field' || action.kind === 'transition_state' || action.kind === 'add_comment') {
        if (a.trigger.entity) targets.add(a.trigger.entity);
      }
      if (action.kind === 'create_record' && str(action.entity)) targets.add(str(action.entity));
    });
    return targets;
  };
  const triggersOn = (a) => (['record_created', 'record_updated', 'state_changed'].includes(a.trigger.kind) && a.trigger.entity
    ? a.trigger.entity : null);

  const graph = new Map(automations.map((a) => [a.key, [...writesTo(a)]]));
  const byEntity = new Map();
  automations.forEach((a) => {
    const e = triggersOn(a);
    if (!e) return;
    if (!byEntity.has(e)) byEntity.set(e, []);
    byEntity.get(e).push(a.key);
  });

  const state = new Map();
  const stack = [];
  const visit = (key) => {
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'visiting') {
      report.error('AUTOMATION_LOOP', 'automations',
        `Automations form a trigger loop: ${[...stack.slice(stack.indexOf(key)), key].join(' -> ')}. Each writes to an entity the next reacts to. The runtime caps the chain, but that cap is a backstop, not a design.`);
      return;
    }
    state.set(key, 'visiting');
    stack.push(key);
    (graph.get(key) || []).forEach((entityKey) => {
      (byEntity.get(entityKey) || []).forEach(visit);
    });
    stack.pop();
    state.set(key, 'done');
  };
  automations.forEach((a) => visit(a.key));
}

function validateAutomation(a, { entities, workflows, roles, surfaces }, path, report) {
  if (!AUTOMATION_TRIGGERS.has(a.trigger.kind)) {
    report.error('AUTOMATION_TRIGGER', `${path}.trigger.kind`, `Trigger kind "${a.trigger.kind}" is not in the vocabulary (${[...AUTOMATION_TRIGGERS].join(', ')}).`);
    return;
  }
  let fieldTypes = {};
  if (['record_created', 'record_updated', 'state_changed'].includes(a.trigger.kind)) {
    const entity = entities.get(a.trigger.entity);
    if (!entity) {
      report.error('AUTOMATION_ENTITY', `${path}.trigger.entity`, `Automation "${a.key}" triggers on "${a.trigger.entity}", which this application does not declare.`);
      return;
    }
    fieldTypes = {
      ...Object.fromEntries(entity.fields.map((f) => [f.name, f.type])),
      ...Object.fromEntries(entity.computed.map((c) => [c.name, c.result_type])),
    };
    if (a.trigger.kind === 'state_changed') {
      const wf = workflows.get(a.trigger.workflow);
      if (!wf) {
        report.error('AUTOMATION_WORKFLOW', `${path}.trigger.workflow`, `Automation "${a.key}" triggers on workflow "${a.trigger.workflow}", which is not declared.`);
      } else if (a.trigger.to_state && !wf.states.some((s) => s.key === a.trigger.to_state)) {
        report.error('AUTOMATION_STATE', `${path}.trigger.to_state`, `Workflow "${a.trigger.workflow}" has no state "${a.trigger.to_state}".`);
      }
    }
  } else if (a.trigger.kind === 'schedule') {
    if (!SCHEDULE_CADENCES.has(a.trigger.cadence)) {
      report.error('AUTOMATION_CADENCE', `${path}.trigger.cadence`, `Schedule cadence must be one of ${[...SCHEDULE_CADENCES].join(', ')}.`);
    }
    // A scheduled automation still operates over an entity — it is the set of
    // records it examines.
    const entity = entities.get(a.trigger.entity);
    if (!entity) {
      report.error('AUTOMATION_ENTITY', `${path}.trigger.entity`, `Scheduled automation "${a.key}" must name the entity it scans.`);
      return;
    }
    fieldTypes = {
      ...Object.fromEntries(entity.fields.map((f) => [f.name, f.type])),
      ...Object.fromEntries(entity.computed.map((c) => [c.name, c.result_type])),
    };
  }

  if (a.condition) {
    try {
      const { type } = expressions.compile(a.condition, fieldTypes);
      if (type !== 'boolean') report.error('AUTOMATION_CONDITION_TYPE', `${path}.condition`, `Automation "${a.key}" condition must be boolean, got ${type}.`);
    } catch (err) {
      report.error('AUTOMATION_CONDITION', `${path}.condition`, `Automation "${a.key}": ${err.message}`);
    }
  }

  if (!a.actions.length) {
    report.error('AUTOMATION_NO_ACTIONS', `${path}.actions`, `Automation "${a.key}" does nothing.`);
  }
  a.actions.forEach((action, ai) => {
    const apath = `${path}.actions[${ai}]`;
    const def = Object.prototype.hasOwnProperty.call(AUTOMATION_ACTIONS, action.kind) ? AUTOMATION_ACTIONS[action.kind] : null;
    if (!def) {
      report.error('AUTOMATION_ACTION', `${apath}.kind`,
        `Action "${action.kind}" is not in the platform vocabulary: ${Object.keys(AUTOMATION_ACTIONS).join(', ')}. There is deliberately no action that runs code or calls an arbitrary URL.`);
      return;
    }
    if (action.kind === 'notify_role' && !roles.has(str(action.role))) {
      report.error('AUTOMATION_ROLE', `${apath}.role`, `Automation "${a.key}" notifies role "${action.role}", which is not declared.`);
    }
    if (action.kind === 'notify_external') {
      const surface = surfaces.get(str(action.surface));
      if (!surface) report.error('AUTOMATION_SURFACE', `${apath}.surface`, `Automation "${a.key}" notifies surface "${action.surface}", which is not declared.`);
      else if (!EXTERNAL_AUDIENCES.has(surface.audience)) {
        report.error('AUTOMATION_SURFACE_AUDIENCE', `${apath}.surface`, `notify_external targets surface "${action.surface}", which is internal. Use notify_role.`);
      }
    }
    if (action.kind === 'set_field') {
      if (!fieldTypes[str(action.field)]) {
        report.error('AUTOMATION_FIELD', `${apath}.field`, `Automation "${a.key}" sets "${action.field}", which the triggering entity does not have.`);
      }
    }
    if (action.kind === 'create_record' && !entities.has(str(action.entity))) {
      report.error('AUTOMATION_CREATE_ENTITY', `${apath}.entity`, `Automation "${a.key}" creates a "${action.entity}", which this application does not declare.`);
    }
    if (action.kind === 'transition_state') {
      const wf = workflows.get(str(action.workflow));
      if (!wf) report.error('AUTOMATION_TRANSITION_WORKFLOW', `${apath}.workflow`, `Automation "${a.key}" transitions workflow "${action.workflow}", which is not declared.`);
      else if (!wf.states.some((s) => s.key === str(action.to_state))) {
        report.error('AUTOMATION_TRANSITION_STATE', `${apath}.to_state`, `Workflow "${action.workflow}" has no state "${action.to_state}".`);
      }
    }
  });
}

module.exports = { validate, normalize, Report };
