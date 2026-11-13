/**
 * Specification patches: the closed vocabulary of changes an iteration can make.
 *
 * ===========================================================================
 * WHY A PATCH AND NOT A REGENERATION
 * ===========================================================================
 * "Add a 90-day risk trend" must not rebuild the application. Regenerating
 * would produce a specification that differs in a hundred incidental ways from
 * the one running in production, and the migration planner would then propose a
 * hundred incidental schema changes — dropping and recreating columns whose
 * names the model happened to phrase differently this time. Everything that
 * makes versioning useful (a readable diff, a small migration, an approval a
 * person can actually read) depends on an iteration changing only what was
 * asked for.
 *
 * So an iteration produces a list of operations from this vocabulary, applied
 * to the previous version. The operations are:
 *
 *   • Enumerable, so the user can be shown exactly what will change before it
 *     is applied.
 *   • Reversible in principle, since each names its target precisely.
 *   • Refused if they name something that does not exist — a patch is checked
 *     against the specification it is being applied to, not hoped over.
 *
 * A model that wants to make a change with no operation for it cannot make that
 * change. That is the same trade as everywhere else in this platform: the
 * vocabulary is the safety property.
 */

const validator = require('../spec/validator');

class PatchError extends Error {
  constructor(message, code = 'PATCH_ERROR') {
    super(message);
    this.name = 'PatchError';
    this.code = code;
  }
}

const clone = (v) => JSON.parse(JSON.stringify(v));

const findEntity = (spec, key) => {
  const entity = spec.data.entities.find((e) => e.key === key);
  if (!entity) throw new PatchError(`This application has no entity "${key}".`, 'ENTITY_NOT_FOUND');
  return entity;
};
const findPage = (spec, key) => {
  const page = spec.ui.pages.find((p) => p.key === key);
  if (!page) throw new PatchError(`This application has no page "${key}".`, 'PAGE_NOT_FOUND');
  return page;
};
const findWorkflow = (spec, key) => {
  const wf = spec.workflows.find((w) => w.key === key);
  if (!wf) throw new PatchError(`This application has no workflow "${key}".`, 'WORKFLOW_NOT_FOUND');
  return wf;
};
const findRole = (spec, key) => {
  const role = spec.security.roles.find((r) => r.key === key);
  if (!role) throw new PatchError(`This application has no role "${key}".`, 'ROLE_NOT_FOUND');
  return role;
};
const findSurface = (spec, key) => {
  const surface = spec.surfaces.find((s) => s.key === key);
  if (!surface) throw new PatchError(`This application has no surface "${key}".`, 'SURFACE_NOT_FOUND');
  return surface;
};

/**
 * Every operation. Each returns a human sentence describing what it did, which
 * becomes the change summary on the new version.
 */
const OPERATIONS = {
  set_identity(spec, op) {
    ['name', 'description', 'icon', 'category'].forEach((k) => {
      if (op[k] !== undefined) spec[k] = op[k];
    });
    return `Renamed or re-described the application.`;
  },

  add_entity(spec, op) {
    if (spec.data.entities.some((e) => e.key === op.entity?.key)) {
      throw new PatchError(`Entity "${op.entity.key}" already exists.`, 'ENTITY_EXISTS');
    }
    spec.data.entities.push(op.entity);
    return `Added a new entity "${op.entity.key}".`;
  },

  add_field(spec, op) {
    const entity = findEntity(spec, op.entity);
    if (entity.fields.some((f) => f.name === op.field?.name)) {
      throw new PatchError(`"${op.entity}" already has a field "${op.field.name}".`, 'FIELD_EXISTS');
    }
    entity.fields.push(op.field);
    return `Added ${op.entity}.${op.field.name} (${op.field.type}).`;
  },

  update_field(spec, op) {
    const entity = findEntity(spec, op.entity);
    const field = entity.fields.find((f) => f.name === op.field);
    if (!field) throw new PatchError(`"${op.entity}" has no field "${op.field}".`, 'FIELD_NOT_FOUND');
    Object.assign(field, op.changes || {});
    return `Changed ${op.entity}.${op.field}.`;
  },

  remove_field(spec, op) {
    const entity = findEntity(spec, op.entity);
    const before = entity.fields.length;
    entity.fields = entity.fields.filter((f) => f.name !== op.field);
    if (entity.fields.length === before) throw new PatchError(`"${op.entity}" has no field "${op.field}".`, 'FIELD_NOT_FOUND');
    // A removed field must also leave every page, filter and query that used
    // it, or the specification stops validating for a reason the user would
    // find baffling.
    spec.ui.pages.forEach((page) => {
      page.filters = (page.filters || []).filter((f) => f.field !== op.field);
      (page.layout || []).forEach((b) => {
        if ((b.entity || page.entity) === op.entity) b.fields = (b.fields || []).filter((f) => f !== op.field);
      });
    });
    spec.analytics.queries = spec.analytics.queries.filter(
      (q) => !(q.entity === op.entity && (q.field === op.field || q.group_by === op.field || q.date_field === op.field))
    );
    const queryKeys = new Set(spec.analytics.queries.map((q) => q.key));
    spec.analytics.metrics = spec.analytics.metrics.filter((m) => queryKeys.has(m.query));
    spec.ui.pages.forEach((page) => {
      page.layout = (page.layout || []).filter((b) => !b.query || queryKeys.has(b.query));
    });
    return `Removed ${op.entity}.${op.field} and everything that referenced it.`;
  },

  add_computed(spec, op) {
    const entity = findEntity(spec, op.entity);
    entity.computed = entity.computed || [];
    if (entity.computed.some((c) => c.name === op.computed?.name)) {
      throw new PatchError(`"${op.entity}" already has "${op.computed.name}".`, 'FIELD_EXISTS');
    }
    entity.computed.push(op.computed);
    return `Added the computed field ${op.entity}.${op.computed.name}.`;
  },

  add_index(spec, op) {
    const entity = findEntity(spec, op.entity);
    entity.indexes = entity.indexes || [];
    entity.indexes.push({ fields: op.fields, unique: !!op.unique });
    return `Indexed ${op.entity}(${op.fields.join(', ')}).`;
  },

  add_query(spec, op) {
    if (spec.analytics.queries.some((q) => q.key === op.query?.key)) {
      throw new PatchError(`Query "${op.query.key}" already exists.`, 'QUERY_EXISTS');
    }
    spec.analytics.queries.push(op.query);
    return `Added the analytics query "${op.query.key}".`;
  },

  add_metric(spec, op) {
    if (spec.analytics.metrics.some((m) => m.key === op.metric?.key)) {
      throw new PatchError(`Metric "${op.metric.key}" already exists.`, 'METRIC_EXISTS');
    }
    spec.analytics.metrics.push(op.metric);
    return `Added the metric "${op.metric.label || op.metric.key}".`;
  },

  add_page(spec, op) {
    if (spec.ui.pages.some((p) => p.key === op.page?.key)) {
      throw new PatchError(`Page "${op.page.key}" already exists.`, 'PAGE_EXISTS');
    }
    spec.ui.pages.push(op.page);
    return `Added the page "${op.page.title || op.page.key}".`;
  },

  add_block(spec, op) {
    const page = findPage(spec, op.page);
    page.layout = page.layout || [];
    const at = Number.isInteger(op.at) ? Math.max(0, Math.min(op.at, page.layout.length)) : page.layout.length;
    page.layout.splice(at, 0, op.block);
    return `Added a ${op.block.type} to "${page.title || page.key}".`;
  },

  remove_block(spec, op) {
    const page = findPage(spec, op.page);
    const before = (page.layout || []).length;
    page.layout = (page.layout || []).filter((b, i) => {
      if (Number.isInteger(op.at)) return i !== op.at;
      if (op.query) return b.query !== op.query;
      if (op.blockType) return b.type !== op.blockType;
      return true;
    });
    if (page.layout.length === before) throw new PatchError('That block is not on that page.', 'BLOCK_NOT_FOUND');
    return `Removed a block from "${page.title || page.key}".`;
  },

  add_nav_item(spec, op) {
    const surface = findSurface(spec, op.surface);
    findPage(spec, op.page);
    if (surface.nav.some((n) => n.page === op.page)) return `"${op.page}" is already in the ${op.surface} navigation.`;
    surface.nav.push({ label: op.label, page: op.page, icon: op.icon || 'circle', section: op.section || '' });
    return `Put "${op.label || op.page}" in the ${op.surface} navigation.`;
  },

  set_default_page(spec, op) {
    const surface = findSurface(spec, op.surface);
    const page = findPage(spec, op.page);
    if (page.surface !== surface.key) {
      throw new PatchError(`Page "${op.page}" is not on surface "${op.surface}".`, 'PAGE_WRONG_SURFACE');
    }
    surface.default_page = op.page;
    return `"${page.title}" is now what opens first on the ${surface.label}.`;
  },

  add_workflow_state(spec, op) {
    const wf = findWorkflow(spec, op.workflow);
    if (wf.states.some((s) => s.key === op.state?.key)) throw new PatchError(`State "${op.state.key}" already exists.`, 'STATE_EXISTS');
    wf.states.push(op.state);
    // The enum and the workflow have to agree, or the database refuses a state
    // the workflow considers legal. Keeping them in step is the patch's job,
    // not the author's.
    const entity = findEntity(spec, wf.entity);
    const field = entity.fields.find((f) => f.name === wf.state_field);
    if (field && field.type === 'enum' && !field.values.includes(op.state.key)) field.values.push(op.state.key);
    return `Added the state "${op.state.key}" to ${wf.label}.`;
  },

  add_transition(spec, op) {
    const wf = findWorkflow(spec, op.workflow);
    if (wf.transitions.some((t) => t.key === op.transition?.key)) {
      throw new PatchError(`Transition "${op.transition.key}" already exists.`, 'TRANSITION_EXISTS');
    }
    wf.transitions.push(op.transition);
    return `Added the transition "${op.transition.label || op.transition.key}".`;
  },

  set_transition_requirements(spec, op) {
    const wf = findWorkflow(spec, op.workflow);
    const transition = wf.transitions.find((t) => t.key === op.transition);
    if (!transition) throw new PatchError(`Workflow "${op.workflow}" has no transition "${op.transition}".`, 'TRANSITION_NOT_FOUND');
    transition.requires = op.requires || [];
    if (op.condition !== undefined) transition.condition = op.condition;
    return `Changed what "${transition.label}" requires.`;
  },

  add_sla(spec, op) {
    const wf = findWorkflow(spec, op.workflow);
    wf.slas = wf.slas || [];
    wf.slas.push({ state: op.state, hours: op.hours, escalate_to_role: op.escalate_to_role || '', label: op.label || '' });
    return `Added a ${op.hours}-hour deadline on "${op.state}".`;
  },

  add_automation(spec, op) {
    if (spec.automations.some((a) => a.key === op.automation?.key)) {
      throw new PatchError(`Automation "${op.automation.key}" already exists.`, 'AUTOMATION_EXISTS');
    }
    spec.automations.push(op.automation);
    return `Added the automation "${op.automation.label || op.automation.key}".`;
  },

  set_automation_enabled(spec, op) {
    const automation = spec.automations.find((a) => a.key === op.automation);
    if (!automation) throw new PatchError(`No automation "${op.automation}".`, 'AUTOMATION_NOT_FOUND');
    automation.enabled = !!op.enabled;
    return `${op.enabled ? 'Enabled' : 'Disabled'} "${automation.label}".`;
  },

  set_record_scope(spec, op) {
    const role = findRole(spec, op.role);
    findEntity(spec, op.entity);
    role.record_scope = role.record_scope || {};
    role.record_scope[op.entity] = op.scope;
    return `"${role.label}" now sees ${op.scope === 'anchor' ? 'only their own' : op.scope} ${op.entity}.`;
  },

  set_field_access(spec, op) {
    const role = findRole(spec, op.role);
    role.field_access = role.field_access || {};
    role.field_access[op.entity] = role.field_access[op.entity] || {};
    role.field_access[op.entity][op.field] = op.access;
    return `"${role.label}" can now ${op.access === 'hidden' ? 'no longer see' : op.access} ${op.entity}.${op.field}.`;
  },

  set_permissions(spec, op) {
    const role = findRole(spec, op.role);
    role.permissions = role.permissions || {};
    role.permissions[op.entity] = op.permissions;
    return `Changed what "${role.label}" may do with ${op.entity}.`;
  },

  add_role(spec, op) {
    if (spec.security.roles.some((r) => r.key === op.role?.key)) throw new PatchError(`Role "${op.role.key}" already exists.`, 'ROLE_EXISTS');
    spec.security.roles.push(op.role);
    return `Added the role "${op.role.label || op.role.key}".`;
  },

  add_surface(spec, op) {
    if (spec.surfaces.some((s) => s.key === op.surface?.key)) throw new PatchError(`Surface "${op.surface.key}" already exists.`, 'SURFACE_EXISTS');
    spec.surfaces.push(op.surface);
    return `Added the "${op.surface.label || op.surface.key}" surface.`;
  },

  add_agent(spec, op) {
    spec.ai = spec.ai || {};
    spec.ai.agents = spec.ai.agents || [];
    if (spec.ai.agents.some((a) => a.key === op.agent?.key)) throw new PatchError(`Agent "${op.agent.key}" already exists.`, 'AGENT_EXISTS');
    spec.ai.agents.push(op.agent);
    return `Added the AI agent "${op.agent.label || op.agent.key}".`;
  },
};

/**
 * Apply operations to a specification, in order.
 *
 * All-or-nothing: operations are applied to a copy, and a failure anywhere
 * throws with nothing changed. A half-applied iteration would produce a version
 * that is neither what the user asked for nor what they had.
 */
function apply(spec, operations) {
  const next = clone(spec);
  const applied = [];

  operations.forEach((op, index) => {
    const handler = Object.prototype.hasOwnProperty.call(OPERATIONS, op.op) ? OPERATIONS[op.op] : null;
    if (!handler) {
      throw new PatchError(
        `"${op.op}" is not a change this platform knows how to make. Supported: ${Object.keys(OPERATIONS).join(', ')}.`,
        'UNKNOWN_OPERATION'
      );
    }
    try {
      applied.push({ op: op.op, summary: handler(next, op) });
    } catch (error) {
      throw new PatchError(`Change ${index + 1} (${op.op}) could not be applied: ${error.message}`, error.code || 'PATCH_FAILED');
    }
  });

  const { spec: normalized, report } = validator.validate(next);
  return { spec: normalized, report, applied };
}

/** A readable diff between two specifications, for the approval screen. */
function diff(before, after) {
  const changes = [];
  const entityKeys = new Set([
    ...before.data.entities.map((e) => e.key),
    ...after.data.entities.map((e) => e.key),
  ]);
  entityKeys.forEach((key) => {
    const b = before.data.entities.find((e) => e.key === key);
    const a = after.data.entities.find((e) => e.key === key);
    if (!b) { changes.push({ kind: 'entity_added', entity: key, detail: `New entity "${key}" with ${a.fields.length} field(s).` }); return; }
    if (!a) { changes.push({ kind: 'entity_removed', entity: key, detail: `Entity "${key}" removed.` }); return; }
    const bf = new Map(b.fields.map((f) => [f.name, f]));
    const af = new Map(a.fields.map((f) => [f.name, f]));
    af.forEach((field, name) => {
      if (!bf.has(name)) changes.push({ kind: 'field_added', entity: key, field: name, detail: `${key}.${name} (${field.type})` });
      else if (bf.get(name).type !== field.type) changes.push({ kind: 'field_type_changed', entity: key, field: name, detail: `${key}.${name}: ${bf.get(name).type} → ${field.type}` });
      else if (!!bf.get(name).required !== !!field.required) changes.push({ kind: 'field_requirement_changed', entity: key, field: name, detail: `${key}.${name} is now ${field.required ? 'required' : 'optional'}` });
    });
    bf.forEach((_, name) => {
      if (!af.has(name)) changes.push({ kind: 'field_removed', entity: key, field: name, detail: `${key}.${name} removed` });
    });
  });

  const countChange = (label, beforeList, afterList, keyOf) => {
    const b = new Set((beforeList || []).map(keyOf));
    const a = new Set((afterList || []).map(keyOf));
    a.forEach((k) => { if (!b.has(k)) changes.push({ kind: `${label}_added`, detail: `${label} "${k}" added` }); });
    b.forEach((k) => { if (!a.has(k)) changes.push({ kind: `${label}_removed`, detail: `${label} "${k}" removed` }); });
  };
  countChange('page', before.ui.pages, after.ui.pages, (p) => p.key);
  countChange('query', before.analytics.queries, after.analytics.queries, (q) => q.key);
  countChange('metric', before.analytics.metrics, after.analytics.metrics, (m) => m.key);
  countChange('automation', before.automations, after.automations, (a) => a.key);
  countChange('surface', before.surfaces, after.surfaces, (s) => s.key);
  countChange('role', before.security.roles, after.security.roles, (r) => r.key);
  countChange('workflow', before.workflows, after.workflows, (w) => w.key);

  return changes;
}

module.exports = { apply, diff, OPERATIONS, PatchError };
