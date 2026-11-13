/**
 * Page rendering: a declared page plus a principal becomes a screen's worth of
 * data, in one request.
 *
 * ===========================================================================
 * WHY THE SERVER RESOLVES THE PAGE
 * ===========================================================================
 * The alternative is a browser that reads the specification, works out that a
 * dashboard needs six metrics and two charts, and issues eight requests. That
 * would work, and it would mean the client deciding what data a page needs —
 * which is the client deciding what data to ask for, which is the client
 * deciding what a role should see. The server would still refuse anything it
 * should not serve, but the SHAPE of the screen would be a client concern, and
 * every new component type would need matching client logic.
 *
 * Resolving here means: one request per page, the client renders what it is
 * given, and a block whose data the principal may not see comes back with an
 * explanation rather than being silently dropped. The renderer stays a
 * renderer.
 *
 * Every block's data goes through the same guarded paths as a direct request —
 * data.list, analytics.run — so a block cannot reach anything a direct request
 * could not.
 */

const resolver = require('./resolver');
const authz = require('./authorization');
const data = require('./data');
const analytics = require('./analytics');
const workflowRuntime = require('./workflow');
const collaboration = require('./collaboration');
const { EXTERNAL_AUDIENCES } = require('../spec/types');

/**
 * @param {object} context   from resolver.resolveApplication
 * @param {object} principal from authorization
 * @param {string} pageKey
 * @param {object} params    { recordId, filters, search, page, pageSize, sort, direction }
 */
async function render(context, principal, pageKey, params = {}) {
  const page = resolver.pageDefinition(context.spec, pageKey);

  // A page belongs to exactly one surface, and a principal reaches exactly one.
  // Serving a page from another surface would be the whole external boundary
  // gone in one line.
  if (page.surface !== principal.surface?.key) {
    const error = new resolver.ResolutionError(
      `Page "${pageKey}" is not on the surface you are using.`, 'PAGE_WRONG_SURFACE', 403
    );
    throw error;
  }

  const blocks = [];
  for (let index = 0; index < (page.layout || []).length; index += 1) {
    blocks.push(await renderBlock(context, principal, page, page.layout[index], index, params));
  }

  return {
    page: {
      key: page.key, title: page.title, kind: page.kind, entity: page.entity,
      description: page.description, surface: page.surface,
    },
    filters: page.filters,
    actions: visibleActions(context, principal, page),
    entity: page.entity ? describeEntity(context, principal, page.entity) : null,
    record: params.recordId && page.entity
      ? await data.get(context, principal, page.entity, params.recordId)
      : null,
    blocks,
  };
}

async function renderBlock(context, principal, page, block, index, params) {
  const base = { index, type: block.type, title: block.title, width: block.width };
  const entityKey = block.entity || page.entity;

  try {
    switch (block.type) {
      case 'metric':
        return { ...base, metrics: await analytics.metrics(context, principal, [block.metric]) };

      case 'metric_group':
        return { ...base, metrics: await analytics.metrics(context, principal, block.metrics) };

      case 'chart_line': case 'chart_bar': case 'chart_area': case 'chart_pie':
      case 'chart_donut': case 'chart_scatter': case 'chart_stacked_bar': case 'stat_ranking':
        return { ...base, data: await analytics.run(context, principal, block.query) };

      case 'table': case 'list': {
        const result = await data.list(context, principal, entityKey, {
          filters: params.filters || [],
          search: params.search || '',
          expression: block.filter || '',
          sort: params.sort, direction: params.direction,
          page: params.page, pageSize: params.pageSize || block.limit,
        });
        return {
          ...base, entity: entityKey, fields: describeFields(context, principal, entityKey, block.fields),
          ...result,
        };
      }

      case 'kanban': {
        const result = await data.list(context, principal, entityKey, {
          filters: params.filters || [], expression: block.filter || '', pageSize: 200,
        });
        const workflow = resolver.workflowForEntity(context.spec, entityKey);
        const columns = workflow
          ? workflow.states.map((s) => ({ key: s.key, label: s.label, color: s.color }))
          : [...new Set(result.rows.map((r) => r[block.group_by]))].map((v) => ({ key: v, label: String(v ?? '') }));
        return {
          ...base, entity: entityKey, groupBy: block.group_by, columns,
          fields: describeFields(context, principal, entityKey, block.fields), rows: result.rows,
        };
      }

      case 'calendar': case 'timeline': {
        const result = await data.list(context, principal, entityKey, {
          filters: params.filters || [], expression: block.filter || '', pageSize: 200,
          sort: block.date_field, direction: 'asc',
        });
        return {
          ...base, entity: entityKey, dateField: block.date_field,
          titleField: entityTitleField(context, entityKey),
          fields: describeFields(context, principal, entityKey, block.fields), rows: result.rows,
        };
      }

      case 'map': {
        const result = await data.list(context, principal, entityKey, {
          filters: params.filters || [], expression: block.filter || '', pageSize: 500,
        });
        return {
          ...base, entity: entityKey, geoField: block.geo_field,
          titleField: entityTitleField(context, entityKey),
          points: result.rows
            .filter((r) => r[`${block.geo_field}_lat`] !== null && r[`${block.geo_field}_lat`] !== undefined)
            .map((r) => ({
              id: r.id,
              label: r[entityTitleField(context, entityKey)] ?? r.id,
              lat: Number(r[`${block.geo_field}_lat`]),
              lng: Number(r[`${block.geo_field}_lng`]),
            })),
        };
      }

      case 'detail_header':
        return {
          ...base, entity: entityKey,
          titleField: entityTitleField(context, entityKey),
          subtitleField: contextEntity(context, entityKey)?.display?.subtitle_field || null,
        };

      case 'field_group':
        return { ...base, entity: entityKey, fields: describeFields(context, principal, entityKey, block.fields) };

      case 'form':
        return {
          ...base, entity: entityKey,
          fields: describeFormFields(context, principal, entityKey, block.fields),
        };

      case 'related_list': {
        if (!params.recordId) return { ...base, entity: entityKey, rows: [], total: 0 };
        const result = await data.related(context, principal, block.entity, block.relationship, params.recordId, {
          pageSize: block.limit,
        });
        return {
          ...base, entity: block.entity, relationship: block.relationship,
          fields: describeFields(context, principal, block.entity, block.fields), ...result,
        };
      }

      case 'workflow_bar': {
        if (!params.recordId) return { ...base, entity: entityKey, transitions: [] };
        const workflow = resolver.workflowDefinition(context.spec, block.workflow);
        const record = await data.get(context, principal, entityKey, params.recordId);
        return {
          ...base, entity: entityKey, workflow: workflow.key, stateField: workflow.state_field,
          states: workflow.states, current: record[workflow.state_field],
          transitions: workflowRuntime.availableTransitions(context.spec, workflow, record, principal),
        };
      }

      case 'approval_panel': {
        if (!params.recordId) return { ...base, entity: entityKey, pending: [] };
        const workflow = resolver.workflowDefinition(context.spec, block.workflow);
        const record = await data.get(context, principal, entityKey, params.recordId);
        const available = workflowRuntime.availableTransitions(context.spec, workflow, record, principal);
        return {
          ...base, entity: entityKey, workflow: workflow.key,
          pending: available.filter((t) => t.requires.includes('approval')),
        };
      }

      case 'activity_feed':
        if (!params.recordId) return { ...base, entity: entityKey, events: [] };
        return { ...base, entity: entityKey, events: await collaboration.activity(context, principal, entityKey, params.recordId) };

      case 'comments':
        if (!params.recordId) return { ...base, entity: entityKey, comments: [] };
        return {
          ...base, entity: entityKey, visibility: block.visibility || 'internal',
          // An external principal can only ever write a shared comment; saying
          // so here means the UI does not offer a choice that does not exist.
          canWriteInternal: principal.kind === 'internal',
          comments: await collaboration.listComments(context, principal, entityKey, params.recordId),
        };

      case 'attachments':
        if (!params.recordId) return { ...base, entity: entityKey, attachments: [] };
        return {
          ...base, entity: entityKey, visibility: block.visibility || 'internal',
          attachments: await collaboration.listAttachments(context, principal, entityKey, params.recordId),
        };

      case 'live_monitor':
        return { ...base, live: await data.liveCanonical(context, principal, block.canonical) };

      case 'markdown':
        return { ...base, text: block.text };

      case 'divider':
        return base;

      default:
        // Unreachable from a validated specification; reported rather than
        // silently dropped so a vocabulary mismatch shows up as a visible gap.
        return { ...base, error: `This build does not know how to render a "${block.type}".` };
    }
  } catch (error) {
    // One block a role cannot see must not take the page down. It comes back
    // with a reason, and the rest of the page renders.
    if (error.status === 403 || error.code === 'FIELD_DENIED' || error.code === 'PERMISSION_DENIED') {
      return { ...base, error: 'Not visible with your role.', denied: true };
    }
    return { ...base, error: error.message };
  }
}

function contextEntity(context, entityKey) {
  return (context.spec.data?.entities || []).find((e) => e.key === entityKey) || null;
}

function entityTitleField(context, entityKey) {
  const entity = contextEntity(context, entityKey);
  return entity?.display?.title_field || 'id';
}

/** Column metadata for a table: label, type, and whether it is a reference. */
function describeFields(context, principal, entityKey, requested) {
  const entity = contextEntity(context, entityKey);
  if (!entity) return [];
  const { readable } = authz.fieldAccess(principal, entityKey, entity);
  const map = resolver.fieldMap(entity);
  const names = (requested && requested.length) ? requested : [...map.keys()];
  return names
    .filter((name) => readable.has(name))
    .map((name) => {
      const field = map.get(name);
      if (!field) return null;
      return {
        name, label: field.label, type: field.type, computed: !!field.computed,
        values: field.values || null,
        reference: field.type === 'reference' ? field.target : null,
      };
    })
    .filter(Boolean);
}

/** Form metadata: only what this principal may actually write. */
function describeFormFields(context, principal, entityKey, requested) {
  const entity = contextEntity(context, entityKey);
  if (!entity) return [];
  const { writable } = authz.fieldAccess(principal, entityKey, entity);
  const map = resolver.fieldMap(entity);
  const names = (requested && requested.length) ? requested : [...map.keys()];
  return names
    .filter((name) => writable.has(name))
    .map((name) => {
      const field = map.get(name);
      if (!field || field.computed) return null;
      return {
        name, label: field.label, type: field.type,
        required: !!field.required, values: field.values || null,
        help: field.help || null,
        default: field.default ?? null,
        reference: field.type === 'reference' ? field.target : null,
      };
    })
    .filter(Boolean);
}

function describeEntity(context, principal, entityKey) {
  const entity = contextEntity(context, entityKey);
  if (!entity) return null;
  const workflow = resolver.workflowForEntity(context.spec, entityKey);
  const permissions = authz.permissionsFor(principal, entityKey);
  return {
    key: entity.key, label: entity.label, singular: entity.singular, description: entity.description,
    titleField: entity.display?.title_field || 'id',
    workflow: workflow ? { key: workflow.key, stateField: workflow.state_field, states: workflow.states } : null,
    permissions: [...permissions],
    fields: describeFields(context, principal, entityKey, null),
  };
}

function visibleActions(context, principal, page) {
  return (page.actions || []).filter((action) => {
    if (action.roles?.length && !action.roles.some((r) => principal.roleKeys.includes(r))) return false;
    if (action.kind === 'export') return authz.can(principal, page.entity, 'export');
    if (action.kind === 'create_record' || (action.kind === 'open_page' && /_new$/.test(action.target || ''))) {
      return authz.can(principal, page.entity, 'create');
    }
    return true;
  });
}

/**
 * The application shell for one principal: which surface, which pages, what
 * they may do. The first request a client makes.
 */
function shell(context, principal) {
  const surface = principal.surface;
  const pages = (context.spec.ui?.pages || []).filter((p) => p.surface === surface.key);
  return {
    application: context.application,
    version: context.instance.version,
    surface: {
      key: surface.key, label: surface.label, audience: surface.audience,
      description: surface.description,
      external: EXTERNAL_AUDIENCES.has(surface.audience),
      defaultPage: surface.default_page || surface.nav[0]?.page || pages[0]?.key,
      nav: surface.nav,
    },
    pages: pages.map((p) => ({ key: p.key, title: p.title, kind: p.kind, entity: p.entity })),
    principal: {
      kind: principal.kind,
      label: principal.label,
      roles: principal.roleKeys,
      anchor: principal.anchor ? { kind: principal.anchor.kind } : null,
    },
    entities: (context.spec.data?.entities || [])
      .filter((e) => authz.can(principal, e.key, 'read'))
      .map((e) => describeEntity(context, principal, e.key)),
  };
}

module.exports = { render, shell, describeFields, describeFormFields, describeEntity };
