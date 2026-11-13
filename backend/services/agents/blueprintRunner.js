/**
 * Blueprint runner — turns a user-authored agent declaration into something the
 * existing autonomous runtime can execute.
 *
 * A blueprint is an ordered list of steps, each a tool call whose arguments may
 * reference earlier outputs. The runner compiles one into the same
 * `{ key, detect, act }` shape that services/agents/definitions/*.js export, so
 * an agent built in a chat window inherits every guarantee the hand-written
 * agents have: the advisory lock, per-action authority evaluation, escalation
 * instead of silent refusal, the durable action trail, auto-disable on repeated
 * failure. None of that is reimplemented here.
 *
 * THE DETECT/ACT SPLIT
 * ----------------------------------------------------------------------------
 * The runtime requires `detect()` to be free of side effects — that is what
 * makes a dry run honest and what lets the authority check sit between deciding
 * and doing. A linear pipeline of mixed reads and writes has to be mapped onto
 * that split, and the mapping is the interesting part of this file:
 *
 *   The steps are cut into SEGMENTS at each write step. A segment is
 *   "the reads leading up to one write, and that write".
 *
 *   detect() executes the FIRST segment's reads only — genuinely side-effect
 *   free, since read-only tools are the only thing it runs — and emits one
 *   observation per write step.
 *
 *   act(observation) executes that segment's own reads (for every segment after
 *   the first, whose reads have not run yet) and then its write.
 *
 * So each write is authority-checked individually, with the real arguments it
 * will be called with, and chaining still works because segments run in order
 * against one shared variable scope. A blueprint with no writes at all is pure
 * detection: everything runs in detect() and the run records what was seen.
 *
 * A consequence worth stating: in a DRY RUN, steps after the first write do not
 * execute, so their arguments are shown unresolved. A preview that invented
 * plausible-looking downstream values would be worse than one that admits it
 * cannot know them yet.
 */

// Resolved per call, not at module load. There is a genuine require cycle here —
// toolCatalog → toolRegistry → metaTools → blueprintStore → blueprintRunner →
// toolCatalog — so whichever module is required first sees the other only
// half-initialised. Entering through blueprintStore (which is what creating an
// agent does) captured `toolCatalog`'s exports object while it was still empty,
// leaving `catalog.listTools` undefined at run time. `require` is cached, so
// looking it up per call costs nothing and removes the dependency on load order.
const catalog = () => require('../ai/toolCatalog');

const MAX_STEPS = 25;

// How a step's tool maps onto the impact tiers authority.js understands.
//   read  — no business-data change; never needs authority
//   draft — creates a proposal a human must approve
//   real  — changes business state (sends, posts, reconciles)
function impactOf(tool) {
  if (!tool) return 'real';          // unknown tool: assume the worst
  // A connected MCP server's tool is a third-party action this ERP cannot
  // review, so it is 'real' regardless of what its flags say — the same
  // reasoning (and the same deliberate refusal to infer) as aiAgentRunner.js.
  if (tool.mcp) return 'real';
  if (tool.readOnly) return 'read';
  return tool.highImpact ? 'real' : 'draft';
}

// ---------------------------------------------------------------------------
// Template resolution
//
// Deliberately NOT an expression language. Arguments may reference config, the
// outputs of earlier steps and the current date — nothing else, and nothing
// evaluable. An agent definition that could compute arbitrary expressions would
// be a second, unreviewed code path into the ERP; the place for computation is
// a custom tool, which is sandboxed.
// ---------------------------------------------------------------------------

const REFERENCE = /^\{\{\s*([\w.[\]]+)\s*\}\}$/;
const EMBEDDED = /\{\{\s*([\w.[\]]+)\s*\}\}/g;

function scopeFor(vars, config, event) {
  const now = new Date();
  return {
    config: config || {},
    // Present only for event-triggered runs. A blueprint referencing
    // {{event.x}} on a schedule resolves to empty rather than to a stale
    // payload from some earlier trigger.
    event: event || {},
    steps: vars || {},
    vars: vars || {},          // alias; both read naturally in a step definition
    now: {
      iso: now.toISOString(),
      date: now.toISOString().slice(0, 10),
      year: now.getFullYear(),
      month: String(now.getMonth() + 1).padStart(2, '0'),
      day: String(now.getDate()).padStart(2, '0'),
      // Handy for "everything since the start of the month" style filters.
      month_start: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`,
    },
  };
}

function lookup(scope, path) {
  return String(path).split(/[.[\]]+/).filter(Boolean).reduce(
    (acc, key) => (acc === null || acc === undefined ? undefined : acc[key]),
    scope
  );
}

/**
 * Resolve references inside a value.
 *
 * A value that is exactly one reference keeps its resolved TYPE — `{{steps.x.rows}}`
 * yields the array, not "[object Object]". A reference embedded in a larger
 * string is interpolated as text. Without that distinction a step could never
 * pass a list to the next one.
 */
function resolveValue(value, scope) {
  if (typeof value === 'string') {
    const whole = value.match(REFERENCE);
    if (whole) return lookup(scope, whole[1]);
    return value.replace(EMBEDDED, (_, path) => {
      const resolved = lookup(scope, path);
      if (resolved === undefined || resolved === null) return '';
      return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, scope));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, scope);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

const OPERATORS = {
  '==': (a, b) => String(a) === String(b),
  '!=': (a, b) => String(a) !== String(b),
  '>': (a, b) => Number(a) > Number(b),
  '<': (a, b) => Number(a) < Number(b),
  '>=': (a, b) => Number(a) >= Number(b),
  '<=': (a, b) => Number(a) <= Number(b),
  contains: (a, b) => String(a).toLowerCase().includes(String(b).toLowerCase()),
  empty: (a) => a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0),
  not_empty: (a) => !(a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0)),
};

const CONDITION_PATTERN = /^\s*(.+?)\s*(>=|<=|==|!=|>|<|contains|not_empty|empty)\s*(.*?)\s*$/;

/**
 * Evaluate a step condition. Accepts either a structured form
 * ({ left, op, right }) or the string form ("{{steps.x.count}} > 0").
 *
 * An unparseable condition is treated as FALSE and reported, not ignored. The
 * alternative — running the step anyway — means a typo in a guard turns into an
 * unguarded action, which for a step that sends email or posts a document is
 * the worst possible interpretation.
 */
function evaluateCondition(condition, scope) {
  if (condition === undefined || condition === null || condition === '') return { pass: true };

  let left;
  let op;
  let right;

  if (typeof condition === 'object') {
    ({ left, op, right } = condition);
  } else {
    const match = String(condition).match(CONDITION_PATTERN);
    if (!match) {
      return { pass: false, reason: `Condition "${condition}" could not be understood, so the step was skipped.` };
    }
    [, left, op, right] = match;
  }

  const fn = OPERATORS[op];
  if (!fn) return { pass: false, reason: `Unknown condition operator "${op}".` };

  const l = resolveValue(left, scope);
  const r = right === undefined || right === '' ? undefined : resolveValue(right, scope);
  const pass = !!fn(l, r);
  return {
    pass,
    reason: pass ? undefined : `Condition not met: ${JSON.stringify(l)} ${op}${r === undefined ? '' : ` ${JSON.stringify(r)}`}.`,
  };
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

async function runStep(step, scope, ctx, vars) {
  const check = evaluateCondition(step.condition, scope);
  if (!check.pass) return { skipped: true, reason: check.reason };

  const args = resolveValue(step.args || {}, scope);
  const result = await catalog().executeTool(step.tool, args, {
    userId: ctx.userId,
    actor: `agent:${ctx.agentKey}`,
    role: 'ADMIN', // an agent runs with the authority its envelope grants, not a user's
    runId: ctx.runId,
    toolDefaults: ctx.config?.tool_defaults,
  });

  const key = step.save_as || step.id;
  if (key) vars[key] = result;
  return { skipped: false, args, result };
}

/**
 * Cut the step list into segments at each write step. Read-only steps that
 * trail the final write form a last segment with no write of its own — they run
 * at the end of the last action so a "then summarise what happened" step still
 * executes.
 */
function segment(steps, toolsByName) {
  const segments = [];
  let pending = [];
  for (const step of steps) {
    const tool = toolsByName.get(step.tool);
    if (impactOf(tool) === 'read') {
      pending.push(step);
    } else {
      segments.push({ reads: pending, write: step, tool });
      pending = [];
    }
  }
  if (pending.length) segments.push({ reads: pending, write: null, tool: null });
  return segments;
}

/**
 * Compile a blueprint row into a runtime agent implementation.
 */
function compile(blueprint) {
  const steps = (Array.isArray(blueprint.steps) ? blueprint.steps : []).slice(0, MAX_STEPS);

  return {
    key: blueprint.agent_key,
    displayName: blueprint.display_name,
    description: blueprint.description,
    domain: blueprint.domain || 'DATA',
    blueprint: true,

    async detect(ctx) {
      const toolsByName = new Map((await catalog().listTools({ role: 'ADMIN' })).map((t) => [t.name, t]));
      const segments = segment(steps, toolsByName);

      // One scope for the whole run. `ctx.blueprintVars` is deliberately hung on
      // the runtime's ctx object, which is the same reference passed to act() —
      // that is what carries outputs from one authorised action to the next.
      const vars = {};
      ctx.blueprintVars = vars;
      ctx.blueprintSegments = segments;

      const config = { ...(blueprint.config || {}), ...(ctx.config || {}) };
      ctx.blueprintConfig = config;

      const observations = [];

      // Unknown tools are reported as observations rather than thrown: one bad
      // step should not make the whole agent look broken, and the run history
      // then names the step that needs fixing.
      for (const step of steps) {
        if (!toolsByName.has(step.tool)) {
          observations.push({
            action_type: step.tool || 'unknown_step',
            impact: 'read',
            entity_type: 'blueprint_step',
            entity_label: step.id || step.tool,
            rationale: `This agent references a tool named "${step.tool}" that does not exist. Edit the agent and remove or replace that step.`,
            data: { error: 'unknown_tool' },
          });
        }
      }
      if (observations.length) return observations;

      // Segment 0's reads are the only thing that runs during detection.
      const first = segments[0];
      if (first) {
        for (const step of first.reads) {
          const outcome = await runStep(step, scopeFor(vars, config, ctx.eventPayload), ctx, vars);
          if (outcome.skipped) {
            observations.push({
              action_type: step.tool,
              impact: 'read',
              entity_type: 'blueprint_step',
              entity_label: step.id || step.tool,
              rationale: outcome.reason,
              data: { skipped: true },
            });
          }
        }
      }

      // A blueprint with no write steps is detection only. It still records what
      // it saw, so a "watch this number" agent produces a readable history.
      if (!segments.length || segments.every((s) => !s.write)) {
        for (const s of segments) {
          for (const step of s.reads) {
            const key = step.save_as || step.id;
            observations.push({
              action_type: step.tool,
              impact: 'read',
              entity_type: 'blueprint_step',
              entity_label: step.id || step.tool,
              rationale: step.note || `Read ${step.tool}.`,
              data: summarise(vars[key]),
            });
          }
        }
        return observations;
      }

      segments.forEach((s, index) => {
        if (!s.write) return;
        const scope = scopeFor(vars, config, ctx.eventPayload);
        // Only the first segment's arguments are fully known at detection time;
        // later ones depend on writes that have not happened. Resolving them
        // anyway would show a preview built from missing values.
        const resolvable = index === 0;
        const args = resolvable ? resolveValue(s.write.args || {}, scope) : s.write.args || {};
        const amount = s.write.amount !== undefined ? Number(resolveValue(s.write.amount, scope)) : undefined;

        observations.push({
          action_type: s.write.tool,
          impact: impactOf(s.tool),
          entity_type: 'blueprint_step',
          entity_id: null,
          entity_label: s.write.id || s.write.tool,
          amount: Number.isFinite(amount) ? amount : undefined,
          currency: s.write.currency || config.currency,
          rationale: s.write.note || `Step ${index + 1}: ${s.write.tool}.`,
          data: { segment: index, args, args_resolved: resolvable },
          segmentIndex: index,
        });
      });

      return observations;
    },

    async act(observation, ctx) {
      const segments = ctx.blueprintSegments || [];
      const vars = ctx.blueprintVars || {};
      const config = ctx.blueprintConfig || blueprint.config || {};
      const index = observation.segmentIndex;
      const seg = segments[index];
      if (!seg || !seg.write) return { skipped: true, reason: 'Nothing to do for this step.' };

      const outcome = { step: seg.write.id || seg.write.tool, reads: [] };

      // Segment 0's reads already ran during detection; the rest run now, in
      // order, so a step can read what the previous action just changed.
      if (index > 0) {
        for (const step of seg.reads) {
          const r = await runStep(step, scopeFor(vars, config, ctx.eventPayload), ctx, vars);
          outcome.reads.push({ step: step.id || step.tool, skipped: r.skipped, reason: r.reason });
        }
      }

      const result = await runStep(seg.write, scopeFor(vars, config, ctx.eventPayload), ctx, vars);
      if (result.skipped) return { ...outcome, skipped: true, reason: result.reason };

      outcome.args = result.args;
      outcome.result = summarise(result.result);

      // Trailing read steps belong to the run, not to any single action, so they
      // are executed once the last write has been performed.
      const tail = segments[segments.length - 1];
      if (tail && !tail.write && index === segments.length - 2) {
        outcome.tail = [];
        for (const step of tail.reads) {
          const r = await runStep(step, scopeFor(vars, config, ctx.eventPayload), ctx, vars).catch((err) => ({ skipped: true, reason: err.message }));
          outcome.tail.push({ step: step.id || step.tool, skipped: !!r.skipped, reason: r.reason });
        }
      }

      return outcome;
    },
  };
}

/**
 * Keep the recorded outcome readable. A tool can return thousands of rows, and
 * agent_run_actions.outcome is meant to be an account of what happened, not a
 * second copy of the database.
 */
function summarise(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return { value };
  const json = JSON.stringify(value);
  if (json.length <= 4000) return value;
  const keys = Object.keys(value).slice(0, 20);
  return {
    truncated: true,
    size_bytes: json.length,
    keys,
    preview: JSON.parse(json.slice(0, 2000).replace(/[^}\]]*$/, '') || '{}'),
  };
}

/**
 * The tools a blueprint needs authority for — i.e. everything that is not a
 * read. Used to seed a new agent's allowed_actions, and to tell an operator
 * which steps an EXISTING agent is not yet permitted to perform.
 */
async function writeActionsOf(steps) {
  const tools = new Map((await catalog().listTools({ role: 'ADMIN' })).map((t) => [t.name, t]));
  const actions = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    const tool = tools.get(step.tool);
    if (!tool) continue;
    if (impactOf(tool) !== 'read' && !actions.includes(step.tool)) actions.push(step.tool);
  }
  return actions;
}

module.exports = {
  compile,
  resolveValue,
  evaluateCondition,
  scopeFor,
  impactOf,
  segment,
  writeActionsOf,
  summarise,
  MAX_STEPS,
};
