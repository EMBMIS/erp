/**
 * "Add a 90-day risk trend." -> a new application version.
 *
 * ===========================================================================
 * HOW AN ITERATION WORKS
 * ===========================================================================
 *     previous version's specification
 *       + a sentence
 *       -> a list of patch operations   (model, or the intent rules below)
 *       -> applied to a COPY of the previous specification
 *       -> validated
 *       -> a new version, with a diff and a migration plan
 *
 * The specification is never regenerated. See studio/patch.js for why that
 * matters: a regeneration would rewrite a hundred incidental details and turn
 * a one-column change into a hundred-operation migration.
 *
 * ===========================================================================
 * THE INTENT RULES
 * ===========================================================================
 * The rules below handle the changes people actually ask for, without a model:
 * add a trend, add a field, tighten a portal's visibility, require an approval,
 * chase something that is overdue, put a page on the front. They exist for the
 * same reason analyzer.js does — the platform has to work when the model is not
 * there — and they are honest about their limits: a request no rule recognises
 * and no model is available for is reported as "I do not know how to do that",
 * never guessed at.
 */

const { isAIEnabled, getAIClient, getAIProvider, resolveDefaultModel } = require('../../../config/aiConfig');
const { safeJsonParse } = require('../../aiJson');
const patch = require('./patch');
const { OPERATIONS } = require('./patch');
const progress = require('./progress');

class IterationError extends Error {
  constructor(message, code = 'ITERATION_FAILED', status = 422, detail = null) {
    super(message);
    this.name = 'IterationError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * @returns {{spec, report, applied, operations, diff, source}}
 */
async function iterate({ spec, instruction, onProgress = null }) {
  const emit = progress.reporter(onProgress);
  const text = String(instruction || '').trim();
  if (!text) throw new IterationError('Say what you would like changed.', 'EMPTY_INSTRUCTION', 400);

  if (isAIEnabled()) {
    try {
      emit('interpreting', 'Turning your instruction into changes to the design.');
      const operations = await operationsFromModel(spec, text);
      emit.done('interpreting', describeOperations(operations));

      emit('applying');
      const result = patch.apply(spec, operations);
      emit.done('applying', describeReport(result.report));
      if (result.report.ok) {
        return { ...result, operations, diff: patch.diff(spec, result.spec), source: 'model' };
      }

      emit('repairing', `${result.report.errors.length} problem(s) to correct.`);
      const repaired = await operationsFromModel(spec, text, result.report.errors);
      const second = patch.apply(spec, repaired);
      emit.done('repairing', describeReport(second.report));
      if (second.report.ok) {
        return { ...second, operations: repaired, diff: patch.diff(spec, second.spec), source: 'model_repaired' };
      }
      throw new IterationError(
        `That change produced an invalid application: ${second.report.errors[0].message}`,
        'VALIDATION_FAILED', 422, second.report.toJSON()
      );
    } catch (error) {
      if (error instanceof IterationError) throw error;
      console.warn('[studio] model iteration failed, trying the intent rules:', error.message);
      emit('fallback', error.message);
      emit.done('fallback', error.message);
    }
  }

  emit('interpreting', 'Matching your instruction against the changes this platform can make on its own.');
  const { operations, satisfied } = operationsFromRules(spec, text);
  emit.done('interpreting', operations.length ? describeOperations(operations) : satisfied || 'No change matched.');

  // A request for something that is ALREADY true is not a failure and must not
  // be reported as one. "Make the portal show only their own findings" against
  // an application that is already anchor-scoped is a question answered, not a
  // change refused — and producing an empty new version for it would be worse
  // than saying so.
  if (!operations.length && satisfied) {
    return {
      spec, report: { ok: true, errorCount: 0, warningCount: 0, diagnostics: [], toJSON: () => ({ ok: true, errorCount: 0, warningCount: 0, diagnostics: [] }) },
      applied: [], operations: [], diff: [], source: 'rules', noChange: true, note: satisfied,
    };
  }

  if (!operations.length) {
    throw new IterationError(
      isAIEnabled()
        ? 'I could not turn that into a change to this application. Try naming the entity, field or page you mean.'
        : 'No language model is configured, and that request does not match any of the changes this platform can make on its own. Try: "add a field <name> to <entity>", "add a trend of <entity> over time", "require manager approval before <transition>", "make <page> the default page", or "chase overdue <entity>".',
      'NO_OPERATIONS', 422
    );
  }
  emit('applying');
  const result = patch.apply(spec, operations);
  emit.done('applying', describeReport(result.report));
  if (!result.report.ok) {
    throw new IterationError(
      `That change produced an invalid application: ${result.report.errors[0].message}`,
      'VALIDATION_FAILED', 422, result.report.toJSON()
    );
  }
  return { ...result, operations, diff: patch.diff(spec, result.spec), source: 'rules' };
}

/** One line about the change, for the progress log. */
function describeOperations(operations) {
  if (!operations?.length) return 'Nothing to change.';
  const n = operations.length;
  return `${n} change${n === 1 ? '' : 's'}: ${operations.map((o) => o.op).join(', ')}.`;
}

function describeReport(report) {
  if (report.ok) return 'The changed design checks out.';
  return `${report.errors.length} problem${report.errors.length === 1 ? '' : 's'} with the changed design.`;
}

// ---------------------------------------------------------------------------
// Model path
// ---------------------------------------------------------------------------
async function operationsFromModel(spec, instruction, errors = null) {
  const client = getAIClient();
  const provider = getAIProvider();
  const model = resolveDefaultModel();

  const messages = [
    { role: 'system', content: iterationSystemPrompt() },
    { role: 'user', content: `CURRENT APPLICATION SPECIFICATION:\n${JSON.stringify(summarizeForModel(spec), null, 1)}\n\nCHANGE REQUESTED:\n${instruction}\n\n${
      errors ? `A previous attempt failed validation:\n${errors.map((e) => `- ${e.message}`).join('\n')}\n\n` : ''
    }Return {"operations": [...]} and nothing else.` },
  ];

  let raw;
  if (provider === 'anthropic') {
    const adapter = require('../../ai/anthropicAdapter');
    const response = await client.messages.create({
      model, max_tokens: 4000,
      system: adapter.extractSystemPrompt(messages),
      messages: adapter.messagesToAnthropic(messages),
    });
    raw = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  } else {
    const completion = await client.chat.completions.create({
      model, messages, max_tokens: 4000, response_format: { type: 'json_object' },
    });
    raw = completion.choices[0]?.message?.content || '';
  }

  const parsed = safeJsonParse(raw, null);
  const operations = Array.isArray(parsed) ? parsed : parsed?.operations;
  if (!Array.isArray(operations) || !operations.length) {
    throw new Error('The model returned no operations.');
  }
  return operations;
}

/**
 * The specification, trimmed to what an iteration needs to know.
 *
 * Sending the whole thing would be mostly page layouts the model does not need
 * in order to add a field, and would crowd out the parts it does.
 */
function summarizeForModel(spec) {
  return {
    key: spec.key,
    name: spec.name,
    entities: spec.data.entities.map((e) => ({
      key: e.key, label: e.label, anchor: e.anchor,
      fields: e.fields.map((f) => ({ name: f.name, type: f.type, required: f.required, sensitive: f.sensitive, values: f.values })),
      computed: (e.computed || []).map((c) => c.name),
    })),
    canonical_refs: spec.data.canonical_refs,
    workflows: spec.workflows.map((w) => ({
      key: w.key, entity: w.entity, state_field: w.state_field,
      states: w.states.map((s) => s.key),
      transitions: w.transitions.map((t) => ({ key: t.key, from: t.from, to: t.to, requires: t.requires })),
    })),
    surfaces: spec.surfaces.map((s) => ({ key: s.key, audience: s.audience, default_page: s.default_page, pages: s.nav.map((n) => n.page) })),
    pages: spec.ui.pages.map((p) => ({ key: p.key, kind: p.kind, surface: p.surface, entity: p.entity, blocks: (p.layout || []).map((b) => b.type) })),
    queries: spec.analytics.queries.map((q) => q.key),
    metrics: spec.analytics.metrics.map((m) => m.key),
    roles: spec.security.roles.map((r) => ({ key: r.key, audience: r.audience })),
    automations: spec.automations.map((a) => a.key),
  };
}

function iterationSystemPrompt() {
  return `You modify an existing EMBMIS application by emitting patch operations.

Return JSON only: {"operations": [ ... ]}

Emit the SMALLEST set of operations that achieves the request. Never rewrite the
application. Never emit an operation for something already true.

AVAILABLE OPERATIONS (the "op" field):
${Object.keys(OPERATIONS).map((k) => `  - ${k}`).join('\n')}

SHAPES:
  {"op":"add_field","entity":"quality_findings","field":{"name":"root_cause","label":"Root cause","type":"long_text"}}
  {"op":"remove_field","entity":"x","field":"y"}
  {"op":"update_field","entity":"x","field":"y","changes":{"required":true}}
  {"op":"add_computed","entity":"x","computed":{"name":"days_open","label":"Days open","expression":"days_since(raised_on)","result_type":"integer"}}
  {"op":"add_query","query":{"key":"k","label":"L","entity":"x","source":"app","aggregation":"count","date_field":"raised_on","time_grain":"month","limit":24,"order":"asc"}}
  {"op":"add_metric","metric":{"key":"k","label":"L","query":"k","format":"number"}}
  {"op":"add_block","page":"overview","block":{"type":"chart_line","title":"T","query":"k","width":"half"}}
  {"op":"set_default_page","surface":"internal","page":"overview"}
  {"op":"set_transition_requirements","workflow":"finding_flow","transition":"close","requires":[{"type":"approval","role":"manager"}],"condition":"severity = 'CRITICAL'"}
  {"op":"add_automation","automation":{"key":"k","label":"L","trigger":{"kind":"schedule","entity":"x","cadence":"daily"},"condition":"due_date < $today","actions":[{"kind":"notify_role","role":"manager","subject":"S","body":"B"}]}}
  {"op":"set_record_scope","role":"supplier_user","entity":"quality_findings","scope":"anchor"}
  {"op":"set_field_access","role":"supplier_user","entity":"x","field":"cost_impact","access":"hidden"}

RULES:
  - Field types, expression syntax and workflow rules are the same as when the
    application was designed. An enum's values and its workflow's states must
    stay identical.
  - An entity shown on an external surface must be anchored and anchor-scoped.
  - A new chart needs a query first, then a block that names it.
  - Never emit raw SQL, code, or a table name.`;
}

// ---------------------------------------------------------------------------
// Intent rules
// ---------------------------------------------------------------------------

const RULES = [
  // "Add a 90-day risk trend", "show findings over time", "add a monthly trend"
  {
    key: 'trend',
    match: /\b(trend|over time|by month|monthly|per month|history chart|last \d+.?days?)\b/i,
    build(spec, text) {
      const entity = pickEntity(spec, text) || primaryEntity(spec);
      if (!entity) return [];
      const dateField = entity.fields.find((f) => ['date', 'datetime'].includes(f.type));
      if (!dateField) return [];
      const days = Number((/(\d+)\s*-?\s*day/i.exec(text) || [])[1]) || null;
      const grain = days && days <= 60 ? 'day' : days && days <= 120 ? 'week' : 'month';
      const key = `${entity.key}_trend_${grain}`.slice(0, 47);
      if (spec.analytics.queries.some((q) => q.key === key)) return [];
      const label = days ? `${entity.label} over the last ${days} days` : `${entity.label} over time`;
      const ops = [{
        op: 'add_query',
        query: {
          key, label, entity: entity.key, source: 'app', aggregation: 'count',
          date_field: dateField.name, time_grain: grain, limit: days || 24, order: 'asc',
          filter: days ? `days_since(${dateField.name}) <= ${days}` : '',
        },
      }];
      const dashboard = spec.ui.pages.find((p) => p.kind === 'dashboard' && p.surface === 'internal');
      if (dashboard) {
        ops.push({ op: 'add_block', page: dashboard.key, block: { type: 'chart_line', title: label, query: key, width: 'half' } });
      }
      return ops;
    },
  },

  // "Add a map of supplier locations", "show them on a map"
  {
    key: 'map',
    match: /\bmap\b|\blocation(s)?\b|\bgeo(graph)?\b/i,
    build(spec, text) {
      const entity = pickEntity(spec, text) || primaryEntity(spec);
      if (!entity) return [];
      const existing = entity.fields.find((f) => f.type === 'geo_point');
      const ops = [];
      const fieldName = existing?.name || 'location';
      if (!existing) {
        ops.push({ op: 'add_field', entity: entity.key, field: { name: fieldName, label: 'Location', type: 'geo_point' } });
      }
      const pageKey = `${entity.key}_map`.slice(0, 47);
      if (spec.ui.pages.some((p) => p.key === pageKey)) return ops;
      ops.push({
        op: 'add_page',
        page: {
          key: pageKey, title: `${entity.label} map`, kind: 'map', surface: 'internal', entity: entity.key,
          description: `Where ${entity.label.toLowerCase()} are.`,
          layout: [{ type: 'map', entity: entity.key, geo_field: fieldName, width: 'full' }],
        },
      });
      ops.push({ op: 'add_nav_item', surface: 'internal', page: pageKey, label: `${entity.label} map`, icon: 'map', section: 'Records' });
      return ops;
    },
  },

  // "Require manager approval before closing a high-risk finding"
  {
    key: 'approval',
    match: /\b(require|need).*(approval|sign.?off|authoris|authoriz)/i,
    build(spec, text) {
      const wf = pickWorkflow(spec, text);
      if (!wf) return [];
      const verb = /clos(e|ing)/i.test(text) ? 'clos'
        : /approv/i.test(text) ? 'approv'
          : /verif/i.test(text) ? 'verif'
            : /complet/i.test(text) ? 'complet' : null;
      const transition = verb
        ? wf.transitions.find((t) => new RegExp(verb, 'i').test(t.key) || new RegExp(verb, 'i').test(t.to))
        : wf.transitions.find((t) => wf.states.find((s) => s.key === t.to)?.terminal);
      if (!transition) return [];
      const role = /\b(manager|supervisor|lead)\b/i.test(text) ? 'manager'
        : /\badmin/i.test(text) ? 'administrator' : 'manager';

      const requires = [...(transition.requires || []).filter((r) => r.type !== 'approval'),
        { type: 'approval', role }];

      // "before closing a HIGH-RISK finding" — the qualifier becomes a
      // condition on the transition, so the approval is required exactly where
      // the person asked for it and not everywhere.
      let condition = transition.condition || '';
      const entity = spec.data.entities.find((e) => e.key === wf.entity);
      const qualifier = /\b(high|critical|major)[- ]?(risk|severity|priority)?\b/i.exec(text);
      if (qualifier && entity) {
        const enumField = entity.fields.find(
          (f) => f.type === 'enum' && f.name !== wf.state_field
            && f.values.some((v) => /^(HIGH|CRITICAL|MAJOR)$/i.test(v))
        );
        if (enumField) {
          const values = enumField.values.filter((v) => /^(HIGH|CRITICAL|MAJOR)$/i.test(v));
          condition = `${enumField.name} in [${values.map((v) => `'${v}'`).join(', ')}]`;
        }
      }
      return [{
        op: 'set_transition_requirements',
        workflow: wf.key, transition: transition.key, requires, condition,
      }];
    },
  },

  // "Add notifications when a corrective action is overdue"
  {
    key: 'overdue',
    match: /\boverdue\b|\bpast due\b|\blate\b.*\b(notif|remind|chase|alert)|\b(notif|remind|chase|alert)\b.*\b(overdue|late|past due)\b/i,
    build(spec, text) {
      const entity = pickEntity(spec, text) || primaryEntity(spec);
      if (!entity) return [];
      const due = entity.fields.find((f) => ['date', 'datetime'].includes(f.type) && /due|deadline|target/.test(f.name))
        || entity.fields.find((f) => ['date', 'datetime'].includes(f.type));
      if (!due) return [];
      const wf = spec.workflows.find((w) => w.entity === entity.key);
      const open = wf ? wf.states.filter((s) => !s.terminal).map((s) => s.key) : [];
      const key = `${entity.key}_overdue_alert`.slice(0, 47);
      if (spec.automations.some((a) => a.key === key)) return [];
      return [{
        op: 'add_automation',
        automation: {
          key,
          label: `Chase overdue ${entity.label.toLowerCase()}`,
          enabled: true,
          trigger: { kind: 'schedule', entity: entity.key, cadence: 'daily', hour: 8 },
          condition: open.length
            ? `${due.name} < $today and ${wf.state_field} in [${open.map((s) => `'${s}'`).join(', ')}]`
            : `${due.name} < $today`,
          actions: [{
            kind: 'notify_role', role: 'manager',
            subject: `Overdue ${entity.singular.toLowerCase()}`,
            body: `A ${entity.singular.toLowerCase()} passed its ${due.label.toLowerCase()} and is still open.`,
          }],
        },
      }];
    },
  },

  // "Make the supplier portal show only their own findings"
  {
    key: 'portal_scope',
    match: /\b(only|just)\b.*\b(their own|own)\b|\bown\b.*\b(records|findings|claims|data)\b/i,
    build(spec, text) {
      const audience = /supplier/i.test(text) ? 'supplier' : /customer/i.test(text) ? 'customer' : /partner/i.test(text) ? 'partner' : null;
      const roles = spec.security.roles.filter((r) => r.audience !== 'internal' && (!audience || r.audience === audience));
      const ops = [];
      const alreadyScoped = [];
      roles.forEach((role) => {
        Object.keys(role.permissions || {}).forEach((entityKey) => {
          const entity = spec.data.entities.find((e) => e.key === entityKey);
          if (!entity?.anchor) return;
          if (role.record_scope?.[entityKey] === 'anchor') { alreadyScoped.push(`${role.key} → ${entityKey}`); return; }
          ops.push({ op: 'set_record_scope', role: role.key, entity: entityKey, scope: 'anchor' });
        });
      });
      if (ops.length) return ops;
      return {
        operations: [],
        satisfied: alreadyScoped.length
          ? `That is already how it works: ${alreadyScoped.join(', ')} is anchor-scoped, so each account only ever sees its own records. The server derives that from the identity, so it is not something the page can get wrong.`
          : null,
      };
    },
  },

  // "Add an explanation of why each supplier received its risk score"
  {
    key: 'explanation_field',
    match: /\b(explanation|reason|rationale|why)\b/i,
    build(spec, text) {
      const entity = pickEntity(spec, text) || primaryEntity(spec);
      if (!entity) return [];
      const name = /score|rating|risk/i.test(text) ? 'score_explanation' : 'explanation';
      if (entity.fields.some((f) => f.name === name)) return [];
      const ops = [{
        op: 'add_field',
        entity: entity.key,
        field: { name, label: 'Explanation', type: 'long_text' },
      }];
      const detail = spec.ui.pages.find((p) => p.kind === 'detail' && p.entity === entity.key && p.surface === 'internal');
      if (detail) {
        const group = (detail.layout || []).find((b) => b.type === 'field_group');
        if (group) {
          ops.push({ op: 'remove_block', page: detail.key, blockType: 'field_group' });
          ops.push({ op: 'add_block', page: detail.key, at: 1, block: { ...group, fields: [...group.fields, name] } });
        }
      }
      return ops;
    },
  },

  // "Make this dashboard the default company landing page"
  {
    key: 'default_page',
    match: /\b(default|landing|home|first)\b.*\bpage\b|\bmake (this|the) .*(dashboard|page).*(default|landing|home)/i,
    build(spec, text) {
      const page = pickPage(spec, text)
        || spec.ui.pages.find((p) => p.kind === 'dashboard' && p.surface === 'internal');
      if (!page) return [];
      const surface = spec.surfaces.find((s) => s.key === page.surface);
      if (!surface) return [];
      if (surface.default_page === page.key) {
        return { operations: [], satisfied: `"${page.title}" is already what opens first on the ${surface.label}.` };
      }
      return [{ op: 'set_default_page', surface: surface.key, page: page.key }];
    },
  },

  // "Add a field called root cause to corrective actions"
  {
    key: 'add_field',
    match: /\badd (a |an )?(field|column|property)\b/i,
    build(spec, text) {
      const entity = pickEntity(spec, text) || primaryEntity(spec);
      if (!entity) return [];
      const named = /\b(?:field|column|property)\s+(?:called\s+|named\s+)?["']?([a-zA-Z][a-zA-Z0-9 _-]{1,40}?)["']?(?:\s+(?:to|on|for)\b|$)/i.exec(text);
      if (!named) return [];
      const label = named[1].trim();
      const name = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      if (!name || entity.fields.some((f) => f.name === name)) return [];
      const type = /\bdate\b/i.test(text) ? 'date'
        : /\b(amount|cost|price|value)\b/i.test(text) ? 'money'
          : /\b(number|count|quantity)\b/i.test(text) ? 'integer'
            : /\b(yes\/no|flag|boolean|whether)\b/i.test(text) ? 'boolean'
              : /\b(note|notes|comment|description|detail|explanation)\b/i.test(text) ? 'long_text'
                : 'text';
      return [{
        op: 'add_field',
        entity: entity.key,
        field: { name, label, type, sensitive: /\binternal\b|\bconfidential\b|\bprivate\b/i.test(text) },
      }];
    },
  },
];

/**
 * @returns {{operations: Array, satisfied: string|null}} — `satisfied` is set
 *          when a rule recognised the request and found it already done.
 */
function operationsFromRules(spec, text) {
  let satisfied = null;
  for (const rule of RULES) {
    if (!rule.match.test(text)) continue;
    try {
      const built = rule.build(spec, text);
      const ops = Array.isArray(built) ? built : (built?.operations || []);
      if (ops.length) return { operations: ops, satisfied: null };
      if (!Array.isArray(built) && built?.satisfied) satisfied = built.satisfied;
    } catch {
      // A rule that throws on an odd specification is a rule that does not
      // apply, not a failure of the iteration. Try the next one.
    }
  }
  return { operations: [], satisfied };
}

const primaryEntity = (spec) => spec.data.entities[0] || null;

/** The entity a sentence is about, by label or key, longest match first. */
function pickEntity(spec, text) {
  const lower = text.toLowerCase();
  return [...spec.data.entities]
    .sort((a, b) => b.label.length - a.label.length)
    .find((e) => lower.includes(e.label.toLowerCase())
      || lower.includes(e.key.replace(/_/g, ' '))
      || lower.includes(e.singular.toLowerCase())) || null;
}

function pickWorkflow(spec, text) {
  const entity = pickEntity(spec, text);
  if (entity) {
    const wf = spec.workflows.find((w) => w.entity === entity.key);
    if (wf) return wf;
  }
  return spec.workflows[0] || null;
}

function pickPage(spec, text) {
  const lower = text.toLowerCase();
  return spec.ui.pages.find((p) => lower.includes(p.title.toLowerCase())) || null;
}

module.exports = { iterate, IterationError, operationsFromRules, RULES };
