/**
 * Requirement in, validated application specification out.
 *
 * ===========================================================================
 * THE DIVISION OF LABOUR
 * ===========================================================================
 * A model is asked for the part of an application that requires judgement
 * about a business:
 *
 *     WHAT the records are      entities, fields, types, relationships
 *     HOW the process runs      states and transitions, what each requires
 *     WHO is involved           which external audiences, what they may see
 *
 * Everything else — pages, navigation, charts, roles, permissions, automations
 * — is derived from those by composer.js, deterministically. That is not the
 * model being distrusted; it is the model being asked ten questions instead of
 * two hundred, where the extra hundred and ninety are all mechanical and every
 * one of them is a chance to reference a page that does not exist.
 *
 * A model that returns a COMPLETE specification (with its own pages and
 * surfaces) is taken at its word and validated as-is. That path exists because
 * an application with a genuinely unusual information architecture should not
 * be flattened into the composer's default shape.
 *
 * ===========================================================================
 * WHAT HAPPENS WHEN THE MODEL IS WRONG
 * ===========================================================================
 *   1. Generate. Validate. If it passes, done.
 *   2. If it fails, hand the diagnostics back and ask for a correction, once.
 *      The diagnostics are specific and machine-generated ("state UNDER_REVIEW
 *      of workflow claim_flow cannot be reached from the initial state"), which
 *      is exactly the kind of feedback a model can act on.
 *   3. If it still fails, fall back to the analyzer and say so. A working
 *      generic application the user can iterate on beats an error message.
 *
 * With no model configured at all, step 3 is the only step, and the Studio says
 * that in the plan rather than pretending otherwise.
 */

const { isAIEnabled, getAIClient, getAIProvider, resolveDefaultModel } = require('../../../config/aiConfig');
const { safeJsonParse } = require('../../aiJson');
const analyzer = require('./analyzer');
const composer = require('./composer');
const validator = require('../spec/validator');
const studioContext = require('./context');
const { FIELD_TYPES, TRANSITION_REQUIREMENTS, EXTERNAL_AUDIENCES } = require('../spec/types');
const progress = require('./progress');
const canonical = require('../spec/canonical');

const MAX_REPAIR_ROUNDS = 1;

/**
 * The plan a user sees before anything is built.
 *
 * Deliberately produced from the same brief the build will use, not from a
 * separate "planning" call — a plan that describes something other than what
 * gets built is worse than no plan.
 */
function renderPlan({ brief, spec, context, source, matchedPacks = [] }) {
  const usedCanonical = (spec.data.canonical_refs || []).map((key) => {
    const known = context?.canonical?.find((c) => c.key === key);
    return { key, label: known?.label || key, count: known?.count ?? null, populated: !!known?.populated };
  });

  const newData = spec.data.entities.map((e) => ({
    key: e.key,
    label: e.label,
    fields: e.fields.length,
    anchored: !!e.anchor,
    description: e.description,
  }));

  const surfaces = spec.surfaces.map((s) => ({
    key: s.key, label: s.label, audience: s.audience, pages: s.nav.length,
  }));

  const screens = spec.ui.pages.map((p) => ({ key: p.key, title: p.title, kind: p.kind, surface: p.surface }));

  const workflows = spec.workflows.map((w) => ({
    key: w.key,
    label: w.label,
    entity: w.entity,
    path: w.states.map((s) => s.key),
    approvals: w.transitions.filter((t) => (t.requires || []).some((r) => r.type === 'approval')).map((t) => t.label),
  }));

  return {
    application: { key: spec.key, name: spec.name, description: spec.description, icon: spec.icon },
    existingData: usedCanonical,
    newData,
    surfaces,
    screens,
    workflows,
    metrics: (spec.analytics?.metrics || []).map((m) => m.label),
    automations: (spec.automations || []).map((a) => a.label),
    roles: (spec.security?.roles || []).map((r) => ({ key: r.key, label: r.label, audience: r.audience })),
    source,
    matchedPacks,
    generic: !!brief.generic,
  };
}

/**
 * Design an application for a requirement. Produces a validated specification
 * and the plan that describes it. Writes nothing.
 */
async function design({ companyId, requirement, preferredKey = null, onProgress = null }) {
  const emit = progress.reporter(onProgress);

  emit('reading_context');
  const context = await studioContext.gather(companyId);
  emit.done('reading_context', describeContext(context));

  if (isAIEnabled()) {
    try {
      const fromModel = await designWithModel({ requirement, context, preferredKey, emit });
      if (fromModel) return { ...fromModel, context };
    } catch (error) {
      // A model failure is a fallback, not an outage. It is recorded on the
      // result so the Studio can tell the user which path produced their
      // application rather than quietly presenting a generic one as bespoke.
      console.warn('[studio] model-authored design failed, falling back to the analyzer:', error.message);
      emit('fallback', error.message);
      const fallback = designWithAnalyzer({ requirement, context, preferredKey, emit });
      emit.done('fallback', error.message);
      return { ...fallback, context, modelError: error.message };
    }
  }
  return { ...designWithAnalyzer({ requirement, context, preferredKey, emit }), context };
}

/** One line about the company's data, for the progress log. */
function describeContext(context) {
  const populated = (context?.canonical || []).filter((c) => c.populated);
  if (!populated.length) return 'No EMBMIS records yet — the application will own all of its data.';
  const total = populated.reduce((sum, c) => sum + (c.count || 0), 0);
  return `${populated.length} kinds of existing data, ${total.toLocaleString('en-US')} records.`;
}

function designWithAnalyzer({ requirement, context, preferredKey, emit = progress.reporter(null) }) {
  emit('designing', 'Matching the requirement against the built-in process patterns.');
  const { brief, matchedPacks, generic } = analyzer.analyze(requirement);
  if (preferredKey) brief.identity.key = preferredKey;
  brief.generic = generic;
  emit.done('designing', generic
    ? 'No specific pattern matched — designing a general tracker.'
    : `Matched: ${matchedPacks.join(', ')}.`);

  emit('composing');
  const spec = composer.compose(brief);
  emit.done('composing', describeSpec(spec));

  emit('validating');
  const { spec: normalized, report } = validator.validate(spec);
  emit.done('validating', describeReport(report));

  emit('planning');
  const plan = renderPlan({ brief, spec: normalized, context, source: 'analyzer', matchedPacks });
  emit.done('planning');

  return {
    brief,
    spec: normalized,
    validation: report.toJSON(),
    plan,
    source: 'analyzer',
  };
}

/** One line about what was built, for the progress log. */
function describeSpec(spec) {
  const parts = [
    `${spec.data.entities.length} ${spec.data.entities.length === 1 ? 'entity' : 'entities'}`,
    `${spec.ui.pages.length} screens`,
    `${spec.surfaces.length} ${spec.surfaces.length === 1 ? 'surface' : 'surfaces'}`,
  ];
  if (spec.workflows.length) parts.push(`${spec.workflows.length} workflow${spec.workflows.length === 1 ? '' : 's'}`);
  return parts.join(', ') + '.';
}

function describeReport(report) {
  if (report.ok) return 'No problems found.';
  return `${report.errors.length} problem${report.errors.length === 1 ? '' : 's'} to correct.`;
}

async function designWithModel({ requirement, context, preferredKey, emit = progress.reporter(null) }) {
  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userPrompt(requirement, context) },
  ];

  let lastReport = null;
  for (let round = 0; round <= MAX_REPAIR_ROUNDS; round += 1) {
    const step = round === 0 ? 'designing' : 'repairing';
    emit(step, round === 0
      ? `Asking ${getAIProvider()} for the data model, the process and the audiences.`
      : `Handing back ${lastReport.errors.length} diagnostic${lastReport.errors.length === 1 ? '' : 's'}.`);
    const raw = await callModel(messages);
    const parsed = safeJsonParse(raw, null);
    if (!parsed) throw new Error('The model did not return usable JSON.');

    const brief = coerceBrief(parsed, requirement);
    if (preferredKey) brief.identity.key = preferredKey;
    emit.done(step, describeBrief(brief));

    // A model that returned a whole specification is taken at its word; one
    // that returned only the data model gets the rest composed for it.
    emit('composing');
    const candidate = parsed.ui && parsed.surfaces && parsed.security
      ? parsed
      : composer.compose(brief);
    emit.done('composing', parsed.ui && parsed.surfaces && parsed.security
      ? 'The model designed its own screens — keeping them.'
      : null);

    emit('validating');
    const { spec, report } = validator.validate(candidate);
    emit.done('validating', describeReport(report));
    if (report.ok) {
      emit('planning');
      const plan = renderPlan({ brief, spec, context, source: 'model' });
      emit.done('planning', describeSpec(spec));
      return {
        brief,
        spec,
        validation: report.toJSON(),
        plan,
        source: round === 0 ? 'model' : 'model_repaired',
      };
    }
    lastReport = report;

    messages.push({ role: 'assistant', content: raw });
    messages.push({
      role: 'user',
      content: `That specification did not validate. Fix exactly these problems and return the corrected JSON, nothing else:\n\n${
        report.errors.map((e) => `- [${e.code}] ${e.path}: ${e.message}`).join('\n')
      }`,
    });
  }

  throw new Error(
    `The model's design still had ${lastReport.errors.length} validation error(s) after a correction round.`
  );
}

/** One line about what the model came back with, for the progress log. */
function describeBrief(brief) {
  const entities = (brief.entities || []).length;
  const workflows = (brief.workflows || []).length;
  const audiences = (brief.audiences || []).length;
  const parts = [`${entities} ${entities === 1 ? 'entity' : 'entities'}`];
  if (workflows) parts.push(`${workflows} workflow${workflows === 1 ? '' : 's'}`);
  if (audiences) parts.push(`external: ${brief.audiences.join(', ')}`);
  return `${brief.identity.name} — ${parts.join(', ')}.`;
}

async function callModel(messages) {
  const client = getAIClient();
  const provider = getAIProvider();
  const model = resolveDefaultModel();

  if (provider === 'anthropic') {
    const adapter = require('../../ai/anthropicAdapter');
    const system = adapter.extractSystemPrompt(messages);
    const response = await client.messages.create({
      model,
      max_tokens: 8000,
      system,
      messages: adapter.messagesToAnthropic(messages),
    });
    return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }

  const completion = await client.chat.completions.create({
    model,
    messages,
    max_tokens: 8000,
    response_format: { type: 'json_object' },
  });
  return completion.choices[0]?.message?.content || '';
}

/**
 * Bring whatever the model returned into the brief shape.
 *
 * Not validation — validation happens on the composed specification, against
 * the real rules. This is just enough coercion that a missing optional key
 * does not crash the composer before the validator gets a chance to produce a
 * useful diagnostic.
 */
function coerceBrief(parsed, requirement) {
  const identity = parsed.identity || {
    key: parsed.key, name: parsed.name, description: parsed.description,
    icon: parsed.icon, category: parsed.category,
  };
  const entities = Array.isArray(parsed.entities) ? parsed.entities
    : Array.isArray(parsed.data?.entities) ? parsed.data.entities : [];
  const canonicalRefs = Array.isArray(parsed.canonical_refs) ? parsed.canonical_refs
    : Array.isArray(parsed.data?.canonical_refs) ? parsed.data.canonical_refs : [];

  return {
    identity: {
      key: identity?.key || analyzer.snake(identity?.name || 'application'),
      name: identity?.name || 'Application',
      description: identity?.description || requirement.slice(0, 400),
      icon: identity?.icon || 'layout-grid',
      category: identity?.category || 'operations',
    },
    canonicalRefs,
    liveMonitors: Array.isArray(parsed.live_monitors) ? parsed.live_monitors : [],
    audiences: Array.isArray(parsed.audiences) ? parsed.audiences : [],
    entities,
    workflows: Array.isArray(parsed.workflows) ? parsed.workflows : [],
    externalEntities: parsed.external_entities || {},
    externalWritable: parsed.external_writable || {},
    externalNotifyStates: parsed.external_notify_states || {},
  };
}

function systemPrompt() {
  return `You design business applications for EMBMIS, a business operating system.

You produce JSON ONLY. No prose, no markdown fences.

You decide three things and nothing else:
  1. The DATA the application owns — entities, their fields and their relationships.
  2. The WORKFLOW each main entity moves through.
  3. The AUDIENCES that use it, and which entities each external audience may see.

Screens, dashboards, charts, navigation, roles and permissions are DERIVED from
your answer by a deterministic compiler. Do not invent them.

RETURN THIS SHAPE:
{
  "identity": { "key": "snake_case_key", "name": "Human Name", "description": "...", "icon": "lucide-icon-name", "category": "operations|procurement|sales|service|finance|hr" },
  "canonical_refs": ["suppliers", ...],
  "live_monitors": ["suppliers"],
  "audiences": ["supplier"],
  "entities": [{
    "key": "quality_findings",
    "label": "Quality Findings",
    "singular": "Quality Finding",
    "description": "...",
    "primary": true,
    "display": { "title_field": "title" },
    "anchor": { "field": "supplier_id", "kind": "supplier" },
    "fields": [
      { "name": "title", "label": "Summary", "type": "text", "required": true },
      { "name": "severity", "label": "Severity", "type": "enum", "required": true, "default": "MEDIUM", "values": ["LOW","MEDIUM","HIGH"] },
      { "name": "supplier_id", "label": "Supplier", "type": "reference", "required": true,
        "target": { "kind": "canonical", "entity": "suppliers", "on_delete": "restrict" } },
      { "name": "cost_impact", "label": "Cost impact", "type": "money", "sensitive": true }
    ],
    "computed": [{ "name": "days_open", "label": "Days open", "expression": "days_since(raised_on)", "result_type": "integer" }],
    "indexes": [{ "fields": ["supplier_id", "status"] }],
    "constraints": [{ "key": "due_after_raised", "expression": "response_due = null or response_due >= raised_on", "message": "..." }]
  }],
  "workflows": [{
    "key": "finding_flow", "label": "Finding lifecycle", "entity": "quality_findings", "state_field": "status",
    "states": [{ "key": "OPEN", "label": "Open", "initial": true }, { "key": "CLOSED", "label": "Closed", "terminal": true }],
    "transitions": [{ "key": "close", "label": "Close", "from": "OPEN", "to": "CLOSED",
      "requires": [{ "type": "approval", "role": "manager" }], "condition": "severity != 'CRITICAL'" }],
    "slas": [{ "state": "OPEN", "hours": 72, "escalate_to_role": "manager", "label": "..." }]
  }],
  "external_entities": { "supplier": ["quality_findings"] },
  "external_writable": { "supplier": ["corrective_actions"] },
  "external_notify_states": { "finding_flow": ["ASSIGNED"] }
}

RULES YOU MUST FOLLOW — a specification that breaks one of these is rejected:

FIELD TYPES. Only: ${Object.keys(FIELD_TYPES).join(', ')}.
  enum needs "values". reference needs "target" {kind:"app"|"canonical", entity, on_delete:"restrict"|"set_null"|"cascade"}.
  Never cascade across a canonical reference.

NAMES. Entity keys and field names are lowercase snake_case, at most 40 and 48
  characters, no reserved SQL words, no double underscores. Never declare
  id, company_id, created_at, updated_at, created_by_* — every table has them.

CANONICAL DATA. Never redeclare a canonical entity as your own. Reference it.
  Applications READ canonical data and never write it.

LIVE MEASURES. Some canonical entities carry measures EMBMIS computes live from
  the company's own records: ${canonical.list().filter((e) => e.live).map((e) => `${e.key} (${e.live.columns.join(', ')})`).join('; ')}.
  When the requirement asks to monitor, watch, score or assess one of these,
  list it in "live_monitors" — the application then shows those measures live.
  Never create fields to hold numbers a live measure already computes; the
  application's own entities hold what PEOPLE decide about them (reviews,
  mitigations, actions).

WORKFLOW. The state field must be an enum whose values are EXACTLY the workflow
  state keys. Exactly one state is initial. Every state must be reachable from
  it. Nothing transitions out of a terminal state.
  Transition requirements: ${[...TRANSITION_REQUIREMENTS].join(', ')}.

EXTERNAL AUDIENCES (${[...EXTERNAL_AUDIENCES].join(', ')}). An entity an external
  audience can see MUST declare an anchor: a reference field to the canonical
  entity that audience is (suppliers for supplier, customers for customer). That
  anchor is how the server limits them to their own records.
  Mark "sensitive": true on any field the external audience must never see —
  internal assessments, costs, margins, scores, internal notes.
  Only add an audience the requirement actually asks for.

EXPRESSIONS (computed fields, conditions, constraints) use only:
  field names of the same entity; and or not; = != < <= > >= in contains;
  + - * /; 'string' literals; numbers; true false null;
  functions now() today() coalesce(a,b) lower(x) upper(x) length(x) abs(x)
  round(x) days_between(a,b) days_since(a) is_empty(x);
  context variables $now $today $user.id $user.role $surface.
  No SQL. No other functions.

Design a real application: several related entities where the process has them,
a workflow with the approvals the process actually needs, and sensible field
types. Do not produce one table with three fields.`;
}

function userPrompt(requirement, context) {
  return `${studioContext.toPromptContext(context)}

REQUIREMENT:
${requirement}

Design the application. Return only the JSON object.`;
}

module.exports = { design, renderPlan, designWithAnalyzer, systemPrompt };
