/**
 * company + application key -> a running instance, its specification, and the
 * physical table behind a logical entity.
 *
 * Every runtime entry point starts here. The rule it exists to enforce is
 * short: the caller names things logically, the server resolves them
 * physically, and there is no third option.
 */

const registry = require('../registry');
const canonical = require('../spec/canonical');

class ResolutionError extends Error {
  constructor(message, code = 'NOT_FOUND', status = 404) {
    super(message);
    this.name = 'ResolutionError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @returns {{application, instance, spec, tables: Map<string, {schema, table, qualified}>}}
 */
async function resolveApplication(companyId, appKey, client) {
  const instance = await registry.resolveInstance(companyId, appKey, client);
  if (!instance) {
    throw new ResolutionError(`Your company has no application "${appKey}".`, 'APPLICATION_NOT_INSTALLED');
  }
  if (instance.status === 'disabled') {
    // Not "not found": the data is all still there and an administrator can
    // switch it back on, which is a different thing for the caller to hear.
    throw new ResolutionError(
      `Application "${appKey}" is switched off for your company. Its records are kept; an administrator can switch it back on.`,
      'APPLICATION_DISABLED', 409
    );
  }
  if (instance.status === 'installing' || !instance.spec) {
    throw new ResolutionError(`Application "${appKey}" has not finished deploying.`, 'APPLICATION_NOT_READY', 409);
  }

  const tableRows = await registry.listTables(instance.id, client);
  const tables = new Map(tableRows.map((r) => [r.entity_key, {
    schema: r.table_schema,
    table: r.table_name,
    qualified: r.physical_table_identifier,
  }]));

  return {
    instance: {
      id: instance.id,
      companyId: instance.company_id,
      applicationId: instance.application_id,
      status: instance.status,
      tablePrefix: instance.table_prefix,
      versionId: instance.running_version_id,
      version: instance.spec_version,
      settings: instance.settings,
    },
    application: {
      id: instance.application_id,
      appKey: instance.app_key,
      name: instance.application_name,
      description: instance.application_description,
      icon: instance.icon,
      category: instance.category,
      kind: instance.kind,
    },
    spec: instance.spec,
    tables,
  };
}

/** An application entity from the specification, or a clear refusal. */
function entityDefinition(spec, entityKey) {
  const entity = (spec.data?.entities || []).find((e) => e.key === entityKey);
  if (!entity) {
    throw new ResolutionError(
      `This application has no entity "${entityKey}".`,
      'ENTITY_NOT_FOUND'
    );
  }
  return entity;
}

/**
 * The physical table for a logical entity.
 *
 * Resolves through the registry rather than through the resolved `tables` map
 * when a client is supplied, so a caller inside a transaction sees the
 * transaction's own registry writes. Both paths end at app_instance_tables.
 */
async function entityTable(context, entityKey, client) {
  if (!client) {
    const table = context.tables.get(entityKey);
    if (table) return table;
  }
  const resolved = await registry.resolveTable(context.instance.id, entityKey, client);
  return { schema: resolved.schema, table: resolved.table, qualified: resolved.qualified };
}

function pageDefinition(spec, pageKey) {
  const page = (spec.ui?.pages || []).find((p) => p.key === pageKey);
  if (!page) throw new ResolutionError(`This application has no page "${pageKey}".`, 'PAGE_NOT_FOUND');
  return page;
}

function workflowDefinition(spec, workflowKey) {
  const wf = (spec.workflows || []).find((w) => w.key === workflowKey);
  if (!wf) throw new ResolutionError(`This application has no workflow "${workflowKey}".`, 'WORKFLOW_NOT_FOUND');
  return wf;
}

function queryDefinition(spec, queryKey) {
  const q = (spec.analytics?.queries || []).find((x) => x.key === queryKey);
  if (!q) throw new ResolutionError(`This application has no analytics query "${queryKey}".`, 'QUERY_NOT_FOUND');
  return q;
}

/** The workflow, if any, that governs an entity's state. */
function workflowForEntity(spec, entityKey) {
  return (spec.workflows || []).find((w) => w.entity === entityKey) || null;
}

/** Field metadata for an entity, stored and computed, in one lookup. */
function fieldMap(entity) {
  const map = new Map();
  (entity.fields || []).forEach((f) => map.set(f.name, { ...f, computed: false }));
  (entity.computed || []).forEach((c) => map.set(c.name, {
    name: c.name, label: c.label, type: c.result_type, expression: c.expression, computed: true,
  }));
  return map;
}

/** Logical field types, as the expression compiler wants them. */
function fieldTypes(entity) {
  const types = {};
  (entity.fields || []).forEach((f) => { types[f.name] = f.type; });
  (entity.computed || []).forEach((c) => { types[c.name] = c.result_type; });
  return types;
}

function canonicalEntity(entityKey) {
  const entity = canonical.entity(entityKey);
  if (!entity) throw new ResolutionError(`"${entityKey}" is not a canonical EMBMIS entity.`, 'CANONICAL_NOT_FOUND');
  return entity;
}

module.exports = {
  ResolutionError,
  resolveApplication,
  entityDefinition,
  entityTable,
  pageDefinition,
  workflowDefinition,
  queryDefinition,
  workflowForEntity,
  fieldMap,
  fieldTypes,
  canonicalEntity,
};
