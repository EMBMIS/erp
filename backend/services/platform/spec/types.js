/**
 * The closed vocabulary an application specification may use.
 *
 * ===========================================================================
 * WHY EVERYTHING HERE IS A FIXED LIST
 * ===========================================================================
 * A specification is authored by a language model. The only defence that
 * survives a model that has been talked into something is a vocabulary it
 * cannot extend: if `type: "raw_sql"` is not in FIELD_TYPES, no amount of
 * persuasion produces a column of that type, because the compiler's only way
 * to turn a field into DDL is to look its type up here and find nothing.
 *
 * Every table in this file is therefore a whitelist, and every consumer of it
 * must fail closed on a miss. A default branch that "falls back to text" would
 * quietly re-open the vocabulary.
 */

// ---------------------------------------------------------------------------
// Field types. `sql` is the physical column type; nothing else may reach DDL.
// ---------------------------------------------------------------------------
const FIELD_TYPES = {
  text:        { sql: 'TEXT',           js: 'string',  filterable: true,  sortable: true,  aggregatable: false },
  long_text:   { sql: 'TEXT',           js: 'string',  filterable: true,  sortable: false, aggregatable: false },
  email:       { sql: 'TEXT',           js: 'string',  filterable: true,  sortable: true,  aggregatable: false,
                 check: (col) => `${col} IS NULL OR ${col} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'` },
  url:         { sql: 'TEXT',           js: 'string',  filterable: true,  sortable: true,  aggregatable: false,
                 check: (col) => `${col} IS NULL OR ${col} ~ '^https?://'` },
  phone:       { sql: 'TEXT',           js: 'string',  filterable: true,  sortable: true,  aggregatable: false },
  slug:        { sql: 'TEXT',           js: 'string',  filterable: true,  sortable: true,  aggregatable: false },
  integer:     { sql: 'INTEGER',        js: 'number',  filterable: true,  sortable: true,  aggregatable: true },
  bigint:      { sql: 'BIGINT',         js: 'number',  filterable: true,  sortable: true,  aggregatable: true },
  decimal:     { sql: 'NUMERIC(18,4)',  js: 'number',  filterable: true,  sortable: true,  aggregatable: true },
  money:       { sql: 'NUMERIC(18,2)',  js: 'number',  filterable: true,  sortable: true,  aggregatable: true },
  percent:     { sql: 'NUMERIC(7,4)',   js: 'number',  filterable: true,  sortable: true,  aggregatable: true },
  boolean:     { sql: 'BOOLEAN',        js: 'boolean', filterable: true,  sortable: true,  aggregatable: true },
  date:        { sql: 'DATE',           js: 'date',    filterable: true,  sortable: true,  aggregatable: false },
  datetime:    { sql: 'TIMESTAMPTZ',    js: 'date',    filterable: true,  sortable: true,  aggregatable: false },
  duration_hours: { sql: 'NUMERIC(12,2)', js: 'number', filterable: true, sortable: true,  aggregatable: true },
  // A closed set of string values. The allowed values become a CHECK
  // constraint, so an application cannot end up with a status the workflow
  // does not know about — the database refuses it.
  enum:        { sql: 'TEXT',           js: 'string',  filterable: true,  sortable: true,  aggregatable: true,  requiresValues: true },
  // A reference to another entity — application-owned or canonical EMBMIS.
  // The compiler turns this into a UUID column plus a real foreign key.
  reference:   { sql: 'UUID',           js: 'string',  filterable: true,  sortable: false, aggregatable: false, requiresTarget: true },
  // Free-form structured data. Present because some applications genuinely
  // need it (a captured inspection form, an integration payload) — never as
  // the primary way to model a relationship, which is what an entity is for.
  json:        { sql: 'JSONB',          js: 'object',  filterable: false, sortable: false, aggregatable: false },
  // Geographic point, stored as two numerics rather than PostGIS so the
  // platform has no extension dependency.
  geo_point:   { sql: null,             js: 'object',  filterable: false, sortable: false, aggregatable: false, expands: ['_lat', '_lng'] },
};

// Types a computed (non-stored) field may evaluate to.
const COMPUTED_RESULT_TYPES = new Set([
  'text', 'integer', 'decimal', 'money', 'percent', 'boolean', 'date', 'datetime', 'duration_hours',
]);

// ---------------------------------------------------------------------------
// Relationships the compiler understands.
// ---------------------------------------------------------------------------
const RELATIONSHIP_KINDS = new Set(['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']);

// What happens to a child when its parent goes. Restricted to the three that
// have a defensible meaning for business records; CASCADE on a canonical
// reference is deliberately absent — deleting a supplier must not silently
// delete a company's quality history.
const ON_DELETE_ACTIONS = new Set(['restrict', 'set_null', 'cascade']);

// ---------------------------------------------------------------------------
// UI. A page is a typed layout of typed blocks; nothing renders arbitrary HTML.
// ---------------------------------------------------------------------------
const PAGE_KINDS = new Set([
  'dashboard', 'list', 'detail', 'form', 'board', 'calendar', 'timeline', 'map', 'analytics', 'custom',
]);

const COMPONENT_TYPES = {
  // Aggregate figures.
  metric:        { needs: ['metric'] },
  metric_group:  { needs: ['metrics'] },
  // Charts. `chart` names the mark; the data always comes from a declared
  // analytics query, never from an inline expression.
  chart_line:    { needs: ['query'] },
  chart_bar:     { needs: ['query'] },
  chart_area:    { needs: ['query'] },
  chart_pie:     { needs: ['query'] },
  chart_donut:   { needs: ['query'] },
  chart_scatter: { needs: ['query'] },
  chart_stacked_bar: { needs: ['query'] },
  // Record surfaces.
  table:         { needs: ['entity'] },
  list:          { needs: ['entity'] },
  detail_header: { needs: ['entity'] },
  field_group:   { needs: ['entity', 'fields'] },
  form:          { needs: ['entity', 'fields'] },
  related_list:  { needs: ['entity', 'relationship'] },
  kanban:        { needs: ['entity', 'group_by'] },
  calendar:      { needs: ['entity', 'date_field'] },
  timeline:      { needs: ['entity', 'date_field'] },
  map:           { needs: ['entity', 'geo_field'] },
  // Record-adjacent platform features.
  activity_feed: { needs: ['entity'] },
  comments:      { needs: ['entity'] },
  attachments:   { needs: ['entity'] },
  workflow_bar:  { needs: ['entity', 'workflow'] },
  approval_panel:{ needs: ['entity', 'workflow'] },
  // Presentation only.
  markdown:      { needs: ['text'] },
  divider:       { needs: [] },
  stat_ranking:  { needs: ['query'] },
  // Live measures of a canonical entity, computed from the company's own
  // records by the provider the canonical catalogue names. Internal only.
  live_monitor:  { needs: ['canonical'] },
};

const FILTER_OPERATORS = new Set([
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains', 'starts_with',
  'in', 'not_in', 'is_null', 'is_not_null', 'between',
]);

// ---------------------------------------------------------------------------
// Analytics. A metric is an aggregate over one entity, optionally grouped and
// filtered. There is no expression language here on purpose: the shape below
// covers what dashboards actually ask for, and it compiles to SQL the compiler
// wrote rather than SQL a model wrote.
// ---------------------------------------------------------------------------
const AGGREGATIONS = new Set(['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'median', 'percent_of_total']);
const TIME_GRAINS = new Set(['day', 'week', 'month', 'quarter', 'year']);

// ---------------------------------------------------------------------------
// Workflow.
// ---------------------------------------------------------------------------
const TRANSITION_REQUIREMENTS = new Set([
  'role', 'approval', 'condition', 'evidence', 'comment', 'authority',
]);

// ---------------------------------------------------------------------------
// Automation. The action vocabulary IS the sandbox: an automation can do these
// things and nothing else, so "what can a generated application do to my
// business without a person in the loop" has a finite, readable answer.
// ---------------------------------------------------------------------------
const AUTOMATION_TRIGGERS = new Set(['record_created', 'record_updated', 'state_changed', 'schedule', 'manual']);

const AUTOMATION_ACTIONS = {
  notify_role:       { params: ['role', 'subject'], external: false },
  notify_external:   { params: ['surface', 'subject'], external: true },
  set_field:         { params: ['field', 'value'], external: false },
  create_record:     { params: ['entity', 'values'], external: false },
  transition_state:  { params: ['workflow', 'to_state'], external: false },
  add_comment:       { params: ['body'], external: false },
  // Deliberately absent: send_email to an arbitrary address, http_request to
  // an arbitrary URL, run_code. Outbound integrations exist, but they are
  // declared as integrations with named, reviewed endpoints — not as an
  // action an automation can point anywhere.
  emit_integration_event: { params: ['integration'], external: true },
};

const SCHEDULE_CADENCES = new Set(['hourly', 'daily', 'weekly', 'monthly']);

// ---------------------------------------------------------------------------
// Surfaces and security.
// ---------------------------------------------------------------------------
const SURFACE_AUDIENCES = new Set(['internal', 'customer', 'supplier', 'partner', 'public']);
const EXTERNAL_AUDIENCES = new Set(['customer', 'supplier', 'partner', 'public']);

const PERMISSIONS = new Set(['read', 'create', 'update', 'delete', 'export', 'approve', 'administer']);

// How a role's rows are narrowed. `anchor` is the external case: rows are
// limited to those whose anchor field matches the viewer's own identity, which
// is the only visibility rule an external user ever gets.
const RECORD_SCOPES = new Set(['all', 'own', 'team', 'anchor', 'none']);

// ---------------------------------------------------------------------------
// Integrations and AI.
// ---------------------------------------------------------------------------
const INTEGRATION_KINDS = new Set(['embmis_entity', 'outbound_webhook', 'inbound_webhook', 'email', 'file_import', 'file_export']);

const AI_SAFETY_CLASSES = new Set(['read_only', 'suggest', 'act_with_approval', 'act_within_authority']);

const AI_TOOL_KINDS = new Set(['query_entity', 'summarize_records', 'compute_metric', 'draft_record', 'propose_transition']);

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------
const LIFECYCLE_STATES = new Set(['draft', 'preview', 'deployed', 'updating', 'paused', 'deprecated', 'archived']);

module.exports = {
  FIELD_TYPES,
  COMPUTED_RESULT_TYPES,
  RELATIONSHIP_KINDS,
  ON_DELETE_ACTIONS,
  PAGE_KINDS,
  COMPONENT_TYPES,
  FILTER_OPERATORS,
  AGGREGATIONS,
  TIME_GRAINS,
  TRANSITION_REQUIREMENTS,
  AUTOMATION_TRIGGERS,
  AUTOMATION_ACTIONS,
  SCHEDULE_CADENCES,
  SURFACE_AUDIENCES,
  EXTERNAL_AUDIENCES,
  PERMISSIONS,
  RECORD_SCOPES,
  INTEGRATION_KINDS,
  AI_SAFETY_CLASSES,
  AI_TOOL_KINDS,
  LIFECYCLE_STATES,
};
