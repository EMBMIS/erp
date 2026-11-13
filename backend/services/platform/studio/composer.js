/**
 * The composer: a data model plus a workflow plus an audience list becomes a
 * complete application.
 *
 * ===========================================================================
 * WHY THIS EXISTS BETWEEN THE MODEL AND THE SPECIFICATION
 * ===========================================================================
 * The hard part of "build me a supplier quality system" is not the screens. It
 * is deciding what a finding IS, which of it a supplier may see, and what has
 * to happen before one can be closed. Those are judgements about a business,
 * and they are what the model is for.
 *
 * Everything downstream of those judgements is mechanical and always the same:
 * an entity needs a list, a detail page, a form, a place on the navigation, a
 * count, a breakdown by status, a trend over time, and a role that can read it.
 * Making the model produce all of that too is asking it to be right about a
 * hundred things where being right about ten would do, and every one of the
 * ninety is a place for it to reference a page that does not exist.
 *
 * So the model (or, with no model configured, the analyzer) decides the DATA,
 * the WORKFLOW and the AUDIENCES. This file derives the rest — deterministically,
 * identically every time, and consistently with the validator, because the
 * derivation and the rules were written against each other.
 *
 * A consequence worth stating: an application composed here is never
 * "one table with a form". Every entity gets a real detail page with its
 * relationships, its history and its conversation; every application gets a
 * dashboard with figures that mean something; every external audience gets a
 * portal that is a portal rather than a filtered copy of the internal screens.
 */

const { EXTERNAL_AUDIENCES } = require('../spec/types');
const canonical = require('../spec/canonical');

const INTERNAL_ROLES = [
  {
    key: 'administrator',
    label: 'Administrator',
    description: 'Full control of this application, including deletion and configuration.',
    permissions: ['read', 'create', 'update', 'delete', 'export', 'approve', 'administer'],
  },
  {
    key: 'manager',
    label: 'Manager',
    description: 'Runs the process day to day and approves what needs approving.',
    permissions: ['read', 'create', 'update', 'export', 'approve'],
  },
  {
    key: 'contributor',
    label: 'Contributor',
    description: 'Does the work: raises and updates records, but does not approve them.',
    permissions: ['read', 'create', 'update'],
  },
];

/**
 * @param {object} brief
 * @param {object} brief.identity  { key, name, description, icon, category }
 * @param {Array}  brief.entities  Entity definitions (fields, anchor, display).
 * @param {Array}  brief.workflows Workflow definitions.
 * @param {Array}  brief.canonicalRefs
 * @param {Array}  brief.audiences  e.g. ['internal', 'supplier']
 * @param {object} brief.externalEntities  audience -> [entityKey] the portal shows
 * @param {object} brief.externalWritable  audience -> [entityKey] the portal may add to
 */
function compose(brief) {
  const identity = brief.identity || {};
  const entities = (brief.entities || []).map(normalizeEntity);
  const workflows = (brief.workflows || []).filter((w) => entities.some((e) => e.key === w.entity));
  const canonicalRefs = [...new Set((brief.canonicalRefs || []).filter((k) => canonical.entity(k)))];
  // Live measures the application watches. Asking to monitor one is also a
  // dependency on it, so it joins the canonical references.
  const liveMonitors = [...new Set((brief.liveMonitors || []).filter((k) => canonical.live(k)))];
  liveMonitors.forEach((k) => { if (!canonicalRefs.includes(k)) canonicalRefs.push(k); });
  const audiences = [...new Set(['internal', ...(brief.audiences || [])])];
  const externalAudiences = audiences.filter((a) => EXTERNAL_AUDIENCES.has(a));

  const workflowFor = (entityKey) => workflows.find((w) => w.entity === entityKey) || null;
  const primary = entities.find((e) => e.primary) || entities[0];

  // ---- analytics -------------------------------------------------------
  const queries = [];
  const metrics = [];
  entities.forEach((entity) => {
    const wf = workflowFor(entity.key);
    const dateField = defaultDateField(entity);
    const openStates = wf ? wf.states.filter((s) => !s.terminal).map((s) => s.key) : [];

    queries.push({
      key: `${entity.key}_total`, label: `Total ${entity.label}`,
      entity: entity.key, source: 'app', aggregation: 'count',
    });
    metrics.push({
      key: `${entity.key}_total`, label: `Total ${entity.label}`,
      query: `${entity.key}_total`, format: 'number',
    });

    if (wf && openStates.length && openStates.length < wf.states.length) {
      queries.push({
        key: `${entity.key}_open`, label: `Open ${entity.label}`,
        entity: entity.key, source: 'app', aggregation: 'count',
        filter: `${wf.state_field} in [${openStates.map((s) => `'${s}'`).join(', ')}]`,
      });
      metrics.push({
        key: `${entity.key}_open`, label: `Open ${entity.label}`,
        query: `${entity.key}_open`, format: 'number', direction: 'lower_is_better',
      });
      queries.push({
        key: `${entity.key}_by_state`, label: `${entity.label} by status`,
        entity: entity.key, source: 'app', aggregation: 'count',
        group_by: wf.state_field, limit: 20,
      });
    }

    if (dateField) {
      queries.push({
        key: `${entity.key}_trend`, label: `${entity.label} over time`,
        entity: entity.key, source: 'app', aggregation: 'count',
        date_field: dateField, time_grain: 'month', limit: 24, order: 'asc',
      });
    }

    // A second enum makes a natural breakdown — severity, category, type.
    const dimension = entity.fields.find(
      (f) => f.type === 'enum' && (!wf || f.name !== wf.state_field)
    );
    if (dimension) {
      queries.push({
        key: `${entity.key}_by_${dimension.name}`,
        label: `${entity.label} by ${dimension.label.toLowerCase()}`,
        entity: entity.key, source: 'app', aggregation: 'count',
        group_by: dimension.name, limit: 20,
      });
    }

    // A reference to a canonical entity is the most useful ranking a business
    // dashboard can show: which supplier, which customer, which product.
    const ranking = entity.fields.find((f) => f.type === 'reference' && f.target?.kind === 'canonical');
    if (ranking) {
      queries.push({
        key: `${entity.key}_by_${ranking.name}`,
        label: `${entity.label} by ${ranking.label.toLowerCase()}`,
        entity: entity.key, source: 'app', aggregation: 'count',
        group_by: ranking.name, limit: 10,
      });
    }

    const numeric = entity.fields.find((f) => ['decimal', 'money', 'percent', 'integer', 'duration_hours'].includes(f.type));
    if (numeric) {
      queries.push({
        key: `${entity.key}_avg_${numeric.name}`,
        label: `Average ${numeric.label.toLowerCase()}`,
        entity: entity.key, source: 'app', aggregation: 'avg', field: numeric.name,
      });
      metrics.push({
        key: `${entity.key}_avg_${numeric.name}`,
        label: `Average ${numeric.label.toLowerCase()}`,
        query: `${entity.key}_avg_${numeric.name}`, format: numeric.type === 'money' ? 'currency' : 'number',
      });
    }
  });

  // ---- security --------------------------------------------------------
  const roles = INTERNAL_ROLES.map((role) => ({
    key: role.key,
    label: role.label,
    audience: 'internal',
    description: role.description,
    permissions: {
      ...Object.fromEntries(entities.map((e) => [e.key, role.permissions])),
      ...Object.fromEntries(canonicalRefs.map((k) => [k, ['read']])),
    },
    record_scope: Object.fromEntries(entities.map((e) => [e.key, 'all'])),
    field_access: {},
    approval_authority: role.permissions.includes('approve')
      ? workflows.flatMap((w) => w.transitions
        .filter((t) => (t.requires || []).some((r) => r.type === 'approval'))
        .map((t) => `${w.key}.${t.key}`))
      : [],
  }));

  externalAudiences.forEach((audience) => {
    const visible = (brief.externalEntities?.[audience] || [])
      .filter((k) => entities.some((e) => e.key === k && e.anchor?.kind === audience));
    const writable = (brief.externalWritable?.[audience] || []).filter((k) => visible.includes(k));
    const anchorEntityKey = canonical.ANCHOR_ENTITIES[audience];

    roles.push({
      key: `${audience}_user`,
      label: `${capitalize(audience)} portal user`,
      audience,
      description: `Someone from a ${audience} organisation, seeing only what belongs to them.`,
      permissions: {
        ...Object.fromEntries(visible.map((k) => [k, writable.includes(k) ? ['read', 'create', 'update'] : ['read']])),
        // The portal user may read the canonical record they ARE, and nothing
        // else of that kind — canonicalScopeClause narrows it to their own id.
        ...(anchorEntityKey && canonicalRefs.includes(anchorEntityKey) ? { [anchorEntityKey]: ['read'] } : {}),
      },
      // Every application entity an external role touches is anchor-scoped.
      // The validator enforces this; the composer never produces anything else.
      record_scope: Object.fromEntries(visible.map((k) => [k, 'anchor'])),
      field_access: Object.fromEntries(visible.map((entityKey) => {
        const entity = entities.find((e) => e.key === entityKey);
        const hidden = {};
        (entity.fields || []).filter((f) => f.sensitive).forEach((f) => { hidden[f.name] = 'hidden'; });
        (entity.fields || []).forEach((f) => {
          if (f.sensitive) return;
          if (!writable.includes(entityKey)) return;
          // A portal user may fill in what they are being asked for, and may
          // not touch the state field (that is what transitions are for) or the
          // anchor (that is whose record it is).
          const workflow = workflowFor(entityKey);
          if (workflow && f.name === workflow.state_field) { hidden[f.name] = 'read'; return; }
          if (entity.anchor && f.name === entity.anchor.field) { hidden[f.name] = 'read'; return; }
          if (f.externalWritable) hidden[f.name] = 'write';
        });
        return [entityKey, hidden];
      })),
      approval_authority: [],
    });
  });

  // ---- ui --------------------------------------------------------------
  const pages = [];
  const internalNav = [];

  pages.push(dashboardPage({
    key: 'overview', surface: 'internal', title: `${identity.name || 'Application'} overview`,
    metrics, queries, primary, workflowFor, liveMonitors,
  }));
  internalNav.push({ label: 'Overview', page: 'overview', icon: 'layout-dashboard', section: 'Overview' });
  liveMonitors.forEach((k) => {
    const live = canonical.live(k);
    pages.push({
      key: `${k}_live`, title: `${live.label} — live`, kind: 'dashboard', surface: 'internal',
      description: live.description,
      layout: [{ type: 'live_monitor', title: live.label, canonical: k, width: 'full' }],
    });
    internalNav.push({ label: live.label, page: `${k}_live`, icon: 'activity', section: 'Overview' });
  });

  entities.forEach((entity) => {
    const wf = workflowFor(entity.key);
    pages.push(listPage({ entity, surface: 'internal', wf, external: false, metrics }));
    pages.push(detailPage({ entity, entities, surface: 'internal', wf, external: false }));
    pages.push(formPage({ entity, surface: 'internal', external: false, fields: writableFields(entity, wf) }));
    internalNav.push({ label: entity.label, page: `${entity.key}_list`, icon: 'list', section: 'Records' });

    if (wf) {
      pages.push(boardPage({ entity, surface: 'internal', wf }));
      internalNav.push({ label: `${entity.label} board`, page: `${entity.key}_board`, icon: 'columns-3', section: 'Records' });
    }
    const dateField = defaultDateField(entity);
    if (dateField && entity.primary) {
      pages.push(calendarPage({ entity, surface: 'internal', dateField }));
      internalNav.push({ label: `${entity.label} calendar`, page: `${entity.key}_calendar`, icon: 'calendar', section: 'Records' });
    }
    const geoField = entity.fields.find((f) => f.type === 'geo_point');
    if (geoField) {
      pages.push(mapPage({ entity, surface: 'internal', geoField: geoField.name }));
      internalNav.push({ label: `${entity.label} map`, page: `${entity.key}_map`, icon: 'map', section: 'Records' });
    }
  });

  // A dedicated analytics page, because a dashboard with twelve charts on it is
  // not a dashboard.
  const analyticsBlocks = queries
    .filter((q) => q.group_by || q.time_grain)
    .map((q) => ({
      type: q.time_grain ? 'chart_line' : (q.group_by && entities.some((e) => e.fields.some((f) => f.name === q.group_by && f.type === 'reference')) ? 'stat_ranking' : 'chart_bar'),
      title: q.label, query: q.key, width: 'half',
    }));
  if (analyticsBlocks.length) {
    pages.push({
      key: 'analytics', title: 'Analytics', kind: 'analytics', surface: 'internal',
      description: 'Every measure this application keeps.',
      layout: analyticsBlocks,
    });
    internalNav.push({ label: 'Analytics', page: 'analytics', icon: 'chart-line', section: 'Insight' });
  }

  const surfaces = [{
    key: 'internal',
    label: `${identity.name || 'Application'} (company)`,
    audience: 'internal',
    description: 'What the company sees: everything.',
    roles: INTERNAL_ROLES.map((r) => r.key),
    default_page: 'overview',
    nav: internalNav,
  }];

  externalAudiences.forEach((audience) => {
    const visible = (brief.externalEntities?.[audience] || [])
      .filter((k) => entities.some((e) => e.key === k && e.anchor?.kind === audience));
    if (!visible.length) return;
    const writable = (brief.externalWritable?.[audience] || []).filter((k) => visible.includes(k));
    const surfaceKey = `${audience}_portal`;
    const nav = [];

    const portalEntities = visible.map((k) => entities.find((e) => e.key === k));
    const portalMetrics = metrics.filter((m) => visible.some((k) => m.key.startsWith(`${k}_`)));

    pages.push({
      key: `${audience}_home`,
      title: 'Your dashboard',
      kind: 'dashboard',
      surface: surfaceKey,
      description: `What is currently open with you.`,
      layout: [
        ...(portalMetrics.length ? [{ type: 'metric_group', title: 'At a glance', metrics: portalMetrics.map((m) => m.key), width: 'full' }] : []),
        ...portalEntities.map((entity) => ({
          type: 'table',
          title: `Your ${entity.label.toLowerCase()}`,
          entity: entity.key,
          fields: externalVisibleFields(entity).slice(0, 6),
          limit: 10,
          width: 'full',
        })),
      ],
    });
    nav.push({ label: 'Dashboard', page: `${audience}_home`, icon: 'layout-dashboard', section: 'Overview' });

    portalEntities.forEach((entity) => {
      const wf = workflowFor(entity.key);
      pages.push(listPage({ entity, surface: surfaceKey, wf, external: true }));
      pages.push(detailPage({ entity, entities, surface: surfaceKey, wf, external: true, visibleKeys: visible }));
      nav.push({ label: entity.label, page: `${entity.key}_${surfaceKey}_list`, icon: 'list', section: 'Records' });
      if (writable.includes(entity.key)) {
        pages.push(formPage({
          entity, surface: surfaceKey, external: true,
          fields: externalWritableFields(entity, wf),
        }));
        nav.push({ label: `New ${entity.singular.toLowerCase()}`, page: `${entity.key}_${surfaceKey}_new`, icon: 'plus', section: 'Actions' });
      }
    });

    surfaces.push({
      key: surfaceKey,
      label: `${capitalize(audience)} portal`,
      audience,
      description: `What a ${audience} sees: their own records and nothing else.`,
      roles: [`${audience}_user`],
      default_page: `${audience}_home`,
      nav,
    });
  });

  // ---- automations -----------------------------------------------------
  const automations = [];
  if (primary) {
    automations.push({
      key: `${primary.key}_raised`,
      label: `Tell the team when a ${primary.singular.toLowerCase()} is raised`,
      enabled: true,
      trigger: { kind: 'record_created', entity: primary.key },
      actions: [{
        kind: 'notify_role', role: 'manager',
        subject: `New ${primary.singular.toLowerCase()}`,
        body: `A new ${primary.singular.toLowerCase()} was raised.`,
      }],
    });
  }
  workflows.forEach((wf) => {
    const entity = entities.find((e) => e.key === wf.entity);
    if (!entity?.anchor) return;
    const audience = entity.anchor.kind;
    const surfaceKey = `${audience}_portal`;
    if (!surfaces.some((s) => s.key === surfaceKey)) return;
    (brief.externalNotifyStates?.[wf.key] || []).forEach((stateKey) => {
      if (!wf.states.some((s) => s.key === stateKey)) return;
      automations.push({
        key: `${wf.key}_notify_${stateKey}`.toLowerCase(),
        label: `Tell the ${audience} when a ${entity.singular.toLowerCase()} reaches "${stateKey}"`,
        enabled: true,
        trigger: { kind: 'state_changed', entity: entity.key, workflow: wf.key, to_state: stateKey },
        actions: [{
          kind: 'notify_external', surface: surfaceKey,
          subject: `A ${entity.singular.toLowerCase()} needs your attention`,
          body: `A ${entity.singular.toLowerCase()} has moved to ${stateKey} and is waiting on you.`,
        }],
      });
    });
  });
  entities.forEach((entity) => {
    const due = entity.fields.find((f) => ['date', 'datetime'].includes(f.type) && /due|deadline|target/.test(f.name));
    const wf = workflowFor(entity.key);
    if (!due || !wf) return;
    const openStates = wf.states.filter((s) => !s.terminal).map((s) => s.key);
    if (!openStates.length) return;
    automations.push({
      key: `${entity.key}_overdue`,
      label: `Chase overdue ${entity.label.toLowerCase()}`,
      enabled: true,
      trigger: { kind: 'schedule', entity: entity.key, cadence: 'daily', hour: 8 },
      condition: `${due.name} < $today and ${wf.state_field} in [${openStates.map((s) => `'${s}'`).join(', ')}]`,
      actions: [{
        kind: 'notify_role', role: 'manager',
        subject: `Overdue ${entity.singular.toLowerCase()}`,
        body: `A ${entity.singular.toLowerCase()} passed its ${due.label.toLowerCase()} and is still open.`,
      }],
    });
  });

  // ---- ai --------------------------------------------------------------
  const agents = primary ? [{
    key: `${identity.key || 'app'}_analyst`.slice(0, 47),
    label: `${identity.name || 'Application'} analyst`,
    purpose: `Answer questions about ${identity.name || 'this application'} from its own records, and explain what the figures mean.`,
    safety_class: 'read_only',
    entities: entities.map((e) => e.key),
    tools: [
      ...entities.map((e) => ({ kind: 'query_entity', entity: e.key })),
      ...entities.slice(0, 3).map((e) => ({ kind: 'summarize_records', entity: e.key })),
    ],
    requires_approval: true,
    surfaces: ['internal'],
  }] : [];

  return {
    key: identity.key,
    name: identity.name,
    description: identity.description,
    icon: identity.icon || 'layout-grid',
    category: identity.category || 'operations',
    data: { entities, canonical_refs: canonicalRefs },
    workflows,
    security: { roles },
    surfaces,
    ui: { pages },
    analytics: { queries, metrics },
    automations,
    ai: { agents },
    integrations: canonicalRefs.map((key) => ({
      key: `embmis_${key}`,
      label: `EMBMIS ${canonical.entity(key).label}`,
      kind: 'embmis_entity',
      canonical_entity: key,
      direction: 'inbound',
      description: `Reads ${canonical.entity(key).label.toLowerCase()} from EMBMIS. Read-only.`,
    })),
    navigation: {
      sections: [
        { key: 'overview', label: 'Overview', order: 1 },
        { key: 'records', label: 'Records', order: 2 },
        { key: 'insight', label: 'Insight', order: 3 },
        { key: 'actions', label: 'Actions', order: 4 },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Page builders
// ---------------------------------------------------------------------------

function dashboardPage({ key, surface, title, metrics, queries, primary, workflowFor, liveMonitors = [] }) {
  const layout = [];
  // What the application is watching comes first: it is live, and it is the
  // reason the application exists.
  liveMonitors.forEach((k) => {
    layout.push({ type: 'live_monitor', title: canonical.live(k).label, canonical: k, width: 'full' });
  });
  if (metrics.length) {
    layout.push({ type: 'metric_group', title: 'Key figures', metrics: metrics.slice(0, 6).map((m) => m.key), width: 'full' });
  }
  const trend = queries.find((q) => q.time_grain && (!primary || q.entity === primary.key));
  if (trend) layout.push({ type: 'chart_line', title: trend.label, query: trend.key, width: 'two_thirds' });
  const byState = queries.find((q) => q.key.endsWith('_by_state'));
  if (byState) layout.push({ type: 'chart_donut', title: byState.label, query: byState.key, width: 'third' });
  const ranking = queries.find((q) => q.group_by && q.key.includes('_by_') && !q.key.endsWith('_by_state') && q.limit <= 10);
  if (ranking) layout.push({ type: 'stat_ranking', title: ranking.label, query: ranking.key, width: 'half' });
  const dimension = queries.find((q) => q.group_by && q !== byState && q !== ranking);
  if (dimension) layout.push({ type: 'chart_bar', title: dimension.label, query: dimension.key, width: 'half' });

  if (primary) {
    layout.push({
      type: 'table',
      title: `Latest ${primary.label.toLowerCase()}`,
      entity: primary.key,
      fields: listFields(primary, workflowFor(primary.key)),
      limit: 10,
      width: 'full',
    });
  }
  return { key, title, kind: 'dashboard', surface, description: 'The state of this application at a glance.', layout };
}

function listPage({ entity, surface, wf, external, metrics = [] }) {
  const key = external ? `${entity.key}_${surface}_list` : `${entity.key}_list`;
  const fields = external ? externalVisibleFields(entity) : listFields(entity, wf);
  // Like every built-in list: the entity's own figures above the filters.
  // Internal only — a portal list shows a counterparty their own records,
  // not the company's totals.
  const own = external ? [] : metrics.filter((m) => m.key.startsWith(`${entity.key}_`)).slice(0, 4);
  const layout = [];
  if (own.length) layout.push({ type: 'metric_group', metrics: own.map((m) => m.key), width: 'full' });
  layout.push({ type: 'table', title: entity.label, entity: entity.key, fields, limit: 50, width: 'full' });
  return {
    key,
    title: external ? `Your ${entity.label.toLowerCase()}` : entity.label,
    kind: 'list',
    surface,
    entity: entity.key,
    description: entity.description,
    filters: filtersFor(entity, wf),
    actions: external ? [] : [
      { key: `new_${entity.key}`, label: `New ${entity.singular.toLowerCase()}`, kind: 'open_page', target: `${entity.key}_new` },
      { key: `export_${entity.key}`, label: 'Export', kind: 'export' },
    ],
    layout,
  };
}

function detailPage({ entity, entities, surface, wf, external, visibleKeys = null }) {
  const key = external ? `${entity.key}_${surface}_detail` : `${entity.key}_detail`;
  const fields = external ? externalVisibleFields(entity) : allReadableFields(entity);
  const layout = [
    { type: 'detail_header', entity: entity.key, width: 'full' },
  ];
  if (wf) {
    layout.push({ type: 'workflow_bar', entity: entity.key, workflow: wf.key, width: 'full' });
  }
  layout.push({ type: 'field_group', title: 'Details', entity: entity.key, fields, width: external ? 'full' : 'two_thirds' });

  if (!external) {
    layout.push({ type: 'activity_feed', title: 'History', entity: entity.key, width: 'third' });
  }

  // Children: every other entity that references this one.
  entities.forEach((other) => {
    if (other.key === entity.key) return;
    const link = (other.fields || []).find((f) => f.type === 'reference' && f.target?.kind === 'app' && f.target.entity === entity.key);
    if (!link) return;
    // On a portal, a related list may only show an entity this audience is
    // actually granted. An anchored child the role has no permission on would
    // render as an empty box at best and, without its own anchor scope, as
    // somebody else's records at worst.
    if (external && (!other.anchor || !visibleKeys || !visibleKeys.includes(other.key))) return;
    layout.push({
      type: 'related_list',
      title: other.label,
      entity: other.key,
      relationship: link.name,
      fields: external ? externalVisibleFields(other).slice(0, 5) : listFields(other, null).slice(0, 5),
      width: 'full',
    });
  });

  layout.push({ type: 'attachments', title: 'Documents', entity: entity.key, visibility: external ? 'shared' : 'internal', width: 'half' });
  layout.push({
    type: 'comments', title: external ? 'Messages' : 'Discussion', entity: entity.key,
    // An internal page shows both conversations; an external page shows only
    // the shared one, and the validator refuses anything else here.
    visibility: external ? 'shared' : 'internal',
    width: 'half',
  });

  return {
    key,
    title: entity.singular,
    kind: 'detail',
    surface,
    entity: entity.key,
    description: `Everything about one ${entity.singular.toLowerCase()}.`,
    layout,
  };
}

function formPage({ entity, surface, external, fields }) {
  const key = external ? `${entity.key}_${surface}_new` : `${entity.key}_new`;
  return {
    key,
    title: `New ${entity.singular.toLowerCase()}`,
    kind: 'form',
    surface,
    entity: entity.key,
    description: `Raise a new ${entity.singular.toLowerCase()}.`,
    layout: [{ type: 'form', title: entity.singular, entity: entity.key, fields, width: 'full' }],
  };
}

function boardPage({ entity, surface, wf }) {
  return {
    key: `${entity.key}_board`,
    title: `${entity.label} board`,
    kind: 'board',
    surface,
    entity: entity.key,
    description: `${entity.label} arranged by where they have got to.`,
    layout: [{ type: 'kanban', entity: entity.key, group_by: wf.state_field, fields: listFields(entity, wf).slice(0, 4), width: 'full' }],
  };
}

function calendarPage({ entity, surface, dateField }) {
  return {
    key: `${entity.key}_calendar`,
    title: `${entity.label} calendar`,
    kind: 'calendar',
    surface,
    entity: entity.key,
    description: `${entity.label} by date.`,
    layout: [{ type: 'calendar', entity: entity.key, date_field: dateField, width: 'full' }],
  };
}

function mapPage({ entity, surface, geoField }) {
  return {
    key: `${entity.key}_map`,
    title: `${entity.label} map`,
    kind: 'map',
    surface,
    entity: entity.key,
    description: `Where ${entity.label.toLowerCase()} are.`,
    layout: [{ type: 'map', entity: entity.key, geo_field: geoField, width: 'full' }],
  };
}

// ---------------------------------------------------------------------------
// Field selection
// ---------------------------------------------------------------------------

function normalizeEntity(entity) {
  const fields = (entity.fields || []).map((f) => ({ ...f }));
  // Every entity gets a date it can be counted over. Without one there is no
  // trend line, and a dashboard without a trend line is a table with a border.
  if (!fields.some((f) => ['date', 'datetime'].includes(f.type))) {
    fields.push({
      name: 'recorded_at', label: 'Recorded', type: 'datetime',
      required: false, default: 'now', indexed: true,
    });
  }
  const title = entity.display?.title_field
    || fields.find((f) => ['text', 'slug'].includes(f.type))?.name
    || fields[0]?.name;
  return {
    ...entity,
    fields,
    computed: entity.computed || [],
    indexes: entity.indexes || [],
    constraints: entity.constraints || [],
    display: { title_field: title, subtitle_field: entity.display?.subtitle_field || '' },
  };
}

function defaultDateField(entity) {
  const explicit = entity.fields.find((f) => ['date', 'datetime'].includes(f.type) && !/due|deadline|closed|resolved/.test(f.name));
  return (explicit || entity.fields.find((f) => ['date', 'datetime'].includes(f.type)))?.name || null;
}

/** Columns worth putting in a list: identity, status, the people, the dates. */
function listFields(entity, wf) {
  const picked = [];
  const push = (name) => { if (name && !picked.includes(name)) picked.push(name); };
  push(entity.display?.title_field);
  if (wf) push(wf.state_field);
  entity.fields.filter((f) => f.type === 'enum' && (!wf || f.name !== wf.state_field)).slice(0, 2).forEach((f) => push(f.name));
  entity.fields.filter((f) => f.type === 'reference').slice(0, 2).forEach((f) => push(f.name));
  entity.fields.filter((f) => ['date', 'datetime'].includes(f.type)).slice(0, 2).forEach((f) => push(f.name));
  entity.fields.filter((f) => ['money', 'decimal', 'percent', 'integer'].includes(f.type)).slice(0, 1).forEach((f) => push(f.name));
  return picked.slice(0, 8);
}

function allReadableFields(entity) {
  return [
    ...entity.fields.filter((f) => f.type !== 'geo_point').map((f) => f.name),
    ...(entity.computed || []).map((c) => c.name),
  ];
}

/** What a portal user may see: everything not marked sensitive. */
function externalVisibleFields(entity) {
  return [
    ...entity.fields.filter((f) => !f.sensitive && f.type !== 'geo_point').map((f) => f.name),
    ...(entity.computed || []).filter((c) => !c.sensitive).map((c) => c.name),
  ];
}

/** What a form offers: everything stored except the workflow's own state. */
function writableFields(entity, wf) {
  return entity.fields
    .filter((f) => !wf || f.name !== wf.state_field)
    .filter((f) => f.type !== 'geo_point')
    .map((f) => f.name);
}

/**
 * What a portal user may fill in.
 *
 * Never the state field (transitions do that), never the anchor (the server
 * sets it), never a sensitive field. Anything required that is left out would
 * make the form unsubmittable, so a required field without a default is
 * included even if it was not marked externally writable — the alternative is a
 * portal with a form that always fails.
 */
function externalWritableFields(entity, wf) {
  return entity.fields
    .filter((f) => !f.sensitive)
    .filter((f) => !wf || f.name !== wf.state_field)
    .filter((f) => !entity.anchor || f.name !== entity.anchor.field)
    .filter((f) => f.type !== 'geo_point')
    .filter((f) => f.externalWritable !== false || (f.required && f.default === undefined))
    .map((f) => f.name);
}

function filtersFor(entity, wf) {
  const filters = [];
  if (wf) filters.push({ field: wf.state_field, operator: 'in', label: 'Status', user_editable: true });
  entity.fields.filter((f) => f.type === 'enum' && (!wf || f.name !== wf.state_field)).slice(0, 2)
    .forEach((f) => filters.push({ field: f.name, operator: 'eq', label: f.label, user_editable: true }));
  entity.fields.filter((f) => f.type === 'reference').slice(0, 1)
    .forEach((f) => filters.push({ field: f.name, operator: 'eq', label: f.label, user_editable: true }));
  const date = entity.fields.find((f) => ['date', 'datetime'].includes(f.type));
  if (date) filters.push({ field: date.name, operator: 'between', label: date.label, user_editable: true });
  return filters;
}

const capitalize = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

module.exports = { compose, INTERNAL_ROLES, listFields, externalVisibleFields };
