/**
 * Turning a sentence into an agent or a tool.
 *
 * The agent builder and the tool builder both used to demand that the author
 * already speak the system's language: which of 75 tools, what interval in
 * seconds, what JSON Schema, what SQL. This module is the translation layer, so
 * that "email me when stock drops below the reorder point" is a valid way to
 * ask for an agent.
 *
 * Three things make this more than a prompt:
 *
 *   1. The model is told what actually exists. The tool catalogue is read from
 *      the live registry and the database schema from information_schema, so a
 *      generated agent references tools this installation has and a generated
 *      tool queries columns this database has. A prompt written from memory
 *      produces plausible configurations that fail on save.
 *   2. The output is put through the SAME validator the save endpoint uses
 *      (blueprintStore.validate / customTools.validateDefinition) before it is
 *      ever shown. If it fails, the error goes back to the model once. A draft
 *      the user approves and then cannot save is worse than no draft.
 *   3. A generated tool is EXECUTED against real data before it is shown, and
 *      the result is part of the response. Nobody should approve code they have
 *      not seen run — least of all code the AI will later call unattended.
 *
 * What is deliberately NOT done here: nothing is saved, and nothing is granted.
 * Generation returns a draft. Creating the agent is a separate call the person
 * makes, and it still lands disabled in observe mode like every other agent.
 */

const { getOpenAIClient, AI_MODEL, isAIEnabled } = require('../../config/aiConfig');
const { safeJsonParse } = require('../aiJson');
const catalog = require('./toolCatalog');
const customTools = require('./customTools');
const blueprints = require('../agents/blueprintStore');
const { searchRegistry } = require('./mcpDiscovery');

// A custom tool is read-only SQL against this ERP's own database — it has no
// way to reach an external service. A description that names one (Stripe,
// QuickBooks, Slack, ...) is not a tool this builder can produce no matter
// how many repair attempts it gets; the honest answer is to say so and point
// at the matching MCP server instead of generating something that will
// silently do nothing or hallucinate a call it cannot make. The threshold is
// tuned so a name match plus one supporting field (category or description)
// is enough, since that is what a query naming a real external product
// against the curated registry naturally produces.
const EXTERNAL_SERVICE_SCORE_THRESHOLD = 4;

const MAX_DESCRIPTION_CHARS = 4000;

// The intervals the scheduler can actually express. It re-arms next_run_at as
// `now + schedule_seconds`, so there is no time of day — see scheduler.js. The
// UI says so plainly rather than rendering a comforting "every day at 8am" for
// something that will in fact run 24 hours after it was enabled.
const INTERVALS = [
  { seconds: 900, label: 'Every 15 minutes' },
  { seconds: 3600, label: 'Every hour' },
  { seconds: 21600, label: 'Every 6 hours' },
  { seconds: 43200, label: 'Every 12 hours' },
  { seconds: 86400, label: 'Every 24 hours' },
  { seconds: 604800, label: 'Every week' },
  { seconds: 2592000, label: 'Every 30 days' },
];

// ---------------------------------------------------------------------------
// Model access
// ---------------------------------------------------------------------------

async function askForJson({ system, user, maxTokens = 3000 }) {
  if (!isAIEnabled()) {
    throw new Error('The AI is not configured on this server, so it cannot draft this for you. Set OPENAI_API_KEY, or build it by hand.');
  }
  const client = getOpenAIClient();
  const completion = await client.chat.completions.create({
    model: AI_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2, // this is a translation task, not a creative one
    max_tokens: maxTokens,
  });
  const raw = completion.choices?.[0]?.message?.content;
  const parsed = safeJsonParse(raw, null);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('The AI did not return a usable configuration. Try describing it again, in a sentence or two.');
  }
  return parsed;
}

/**
 * Ask, validate, and on failure ask again with the validator's own words.
 *
 * The error text is the whole point. "column s.deleted_at does not exist" is a
 * far better instruction than any amount of prompting about being careful,
 * because it names the one thing that is wrong. A few attempts, not a loop:
 * past that, the description is ambiguous in a way more turns will not fix, and
 * the caller can still hand the draft to the person to finish by hand.
 */
async function generateWithRepair({ system, user, maxTokens, build, attempts = 2 }) {
  let outcome = null;
  let nextUser = user;

  for (let n = 0; n < attempts; n += 1) {
    const attempt = await askForJson({ system, user: nextUser, maxTokens });
    outcome = await build(attempt);
    if (outcome.ok) return { ...outcome, attempts: n + 1 };

    nextUser = [
      user,
      '',
      'Your previous answer was rejected. This is the exact error:',
      outcome.error,
      '',
      'Here is what you returned:',
      JSON.stringify(attempt).slice(0, 6000),
      '',
      'Return the corrected JSON only. Fix the problem named above; keep everything else that was right.',
      'If the error names a column or table, re-read the schema listing and use only what is actually there.',
    ].join('\n');
  }

  // Even a still-invalid draft is worth returning: the person can finish it in
  // the full editor, which is strictly better than starting from an empty form.
  return { ...outcome, attempts };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function cleanDescription(text) {
  const value = String(text || '').trim();
  if (value.length < 10) {
    throw new Error('Describe what you want in a sentence or two — a few words is not enough to work from.');
  }
  return value.slice(0, MAX_DESCRIPTION_CHARS);
}

function slugify(text, max) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/g, '')
    .slice(0, max);
}

/** A key nobody else is using, so "Create" does not fail on a name collision. */
async function uniqueKey(base, exists) {
  let candidate = base;
  for (let n = 2; n <= 20; n += 1) {
    if (!(await exists(candidate))) return candidate;
    const suffix = `_${n}`;
    candidate = `${base.slice(0, 60 - suffix.length)}${suffix}`;
  }
  return `${base.slice(0, 50)}_${Date.now().toString(36)}`;
}

async function toolCatalogueText(role) {
  const tools = await catalog.listTools({ role: role || 'ADMIN' });
  return {
    tools,
    text: tools
      .map((t) => `- ${t.name}${t.readOnly === false ? ' [CHANGES DATA]' : ''}: ${String(t.description || '').slice(0, 200)}`)
      .join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const AGENT_SYSTEM = (catalogueText) => `You configure autonomous agents for Simeli, an ERP system. A colleague describes what they want in plain English; you return the agent configuration as JSON. You know ERP work — procurement, receivables, inventory, close — so read past the wording to what the person actually needs to happen.

Return ONLY a JSON object. No prose, no code fences.

{
  "display_name": "short human name, e.g. Collections watch",
  "agent_key": "lowercase_snake_case_identifier",
  "description": "one line a colleague could read",
  "domain": "FINANCE | PROCUREMENT | SALES | INVENTORY | HR | DATA",
  "kind": "ai | pipeline",
  "goal": "for kind=ai: the agent's standing instructions, second person, several sentences",
  "steps": [ { "id": "short_id", "tool": "tool_name", "args": {}, "condition": "optional" } ],
  "trigger_type": "schedule | event | manual",
  "schedule_seconds": 86400,
  "event_key": "only for trigger_type=event, e.g. invoice.overdue",
  "allowed_tools": ["tool_name", "..."],
  "escalation_rules": { "guidance": "when it should stop and ask a person" },
  "effort": "low | medium | high | xhigh | max",
  "max_iterations": 20,
  "memory_enabled": true,
  "reasoning": "one or two sentences for the person: why this shape, this schedule, these tools",
  "schedule_note": "if they asked for a specific time of day, say here that runs are interval-based"
}

CHOOSING THE SHAPE
- "ai" is the default. Use it whenever the work involves judgement: deciding which overdue invoices actually matter, whether a variance is worth reporting, how firmly to chase someone.
- "pipeline" only when the work is a fixed, ordered list of tool calls that must come out identically every time, with nothing to decide. A pipeline needs at least one step and no goal.

THE GOAL IS THE AGENT (kind=ai)
Write it in the second person, as standing instructions. It must cover three things or the agent will improvise:
  1. What it is and what to achieve.
  2. What judgement to apply — what matters, what to ignore, how to weigh things.
  3. When to stop and ask a person instead of acting.
At least 30 characters; realistically several sentences. A vague goal produces a vague agent.

SCHEDULING — READ THIS CAREFULLY
The scheduler runs an agent every N seconds from when it is enabled. It CANNOT run something "at 8am" or "on Friday". If the person asks for a time of day or a weekday, pick the closest interval and say so in schedule_note. Use one of: 900, 3600, 21600, 43200, 86400, 604800, 2592000.
Use trigger_type "event" only when they describe reacting to something happening rather than checking on a cadence.

TOOLS
Pick from this catalogue only. Never invent a tool name. Give the agent what its goal needs and nothing more — a narrow tool list is what makes an agent focused and reviewable. Tools marked [CHANGES DATA] require a human to grant authority separately, which is expected for anything that emails, drafts or posts; include them when the job needs them.

${catalogueText}

EFFORT
"high" unless the work is trivial (low/medium) or involves hard judgement calls on money (xhigh).

EXAMPLE — "Check inventory every morning and email me if anything is below reorder point"
{
  "display_name": "Reorder watch",
  "agent_key": "reorder_watch",
  "description": "Checks stock against reorder points daily and reports what needs ordering",
  "domain": "INVENTORY",
  "kind": "ai",
  "goal": "You watch stock levels for this company.\\n\\nEach run: compare on-hand quantity against the reorder point for every stocked item. Judge which shortfalls actually matter — an item that is one unit under its reorder point but has no open demand is not urgent, and an item with a long lead time that will run out before the next delivery is. Consider open purchase orders already covering the gap before you report anything.\\n\\nEmail a summary of what genuinely needs ordering, worst first, with the numbers.\\n\\nStop and ask a person if: an item shows negative stock, a reorder point looks like a data error, or the shortfall is large enough to halt production.",
  "trigger_type": "schedule",
  "schedule_seconds": 86400,
  "allowed_tools": ["get_inventory_status", "get_low_stock_items", "send_email"],
  "escalation_rules": { "guidance": "Negative stock, obviously wrong reorder points, or anything that would stop production." },
  "effort": "high",
  "max_iterations": 20,
  "memory_enabled": true,
  "reasoning": "Judgement is needed to tell a real shortfall from a rounding one, so this is a reasoning agent rather than a fixed report.",
  "schedule_note": "You asked for every morning. Agents run on an interval, so this runs every 24 hours from the moment you enable it."
}`;

const KIND_ALIASES = {
  reasoning: 'ai',
  ai: 'ai',
  agent: 'ai',
  fixed_sequence: 'pipeline',
  'fixed sequence': 'pipeline',
  pipeline: 'pipeline',
  sequence: 'pipeline',
};

/**
 * Cron is not something this scheduler understands, but a model asked for a
 * schedule will sometimes produce one anyway. Rather than discard it, read the
 * cadence out of it and snap to the nearest interval we can actually run.
 */
function cronToSeconds(expression) {
  const parts = String(expression || '').trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [minute, hour, dayOfMonth, , dayOfWeek] = parts;
  const every = (field) => {
    const match = /^\*\/(\d+)$/.exec(field);
    return match ? Number(match[1]) : null;
  };
  if (every(minute)) return Math.max(900, every(minute) * 60);
  if (every(hour)) return every(hour) * 3600;
  if (dayOfWeek !== '*' && dayOfWeek !== '?') return 604800;
  if (dayOfMonth !== '*' && dayOfMonth !== '?') return 2592000;
  if (hour !== '*') return 86400;
  return 3600;
}

function nearestInterval(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 86400;
  return INTERVALS.reduce((best, option) =>
    Math.abs(option.seconds - value) < Math.abs(best.seconds - value) ? option : best
  ).seconds;
}

function intervalLabel(seconds) {
  return INTERVALS.find((i) => i.seconds === Number(seconds))?.label
    || `Every ${Math.round(Number(seconds) / 3600)} hours`;
}

/**
 * Take whatever the model returned and make it the shape blueprintStore expects.
 *
 * Every coercion here is one the model gets wrong often enough to be worth
 * absorbing silently — a hallucinated tool name, "REASONING" instead of "ai", a
 * cron string. Dropping a hallucinated tool is reported as a warning rather than
 * hidden, because the person is about to approve this.
 */
async function normalizeBlueprint(raw, knownTools) {
  const warnings = [];
  const known = new Set(knownTools.map((t) => t.name));

  const kind = KIND_ALIASES[String(raw.kind || raw.type || 'ai').toLowerCase().replace(/-/g, '_')] || 'ai';

  const nameSource = raw.display_name || raw.name || 'New agent';
  const baseKey = slugify(raw.agent_key || nameSource, 60) || 'new_agent';
  const agent_key = await uniqueKey(
    baseKey.length >= 3 ? baseKey : `${baseKey}_agent`,
    async (candidate) => !!(await blueprints.getBlueprint(candidate))
  );

  const requested = Array.isArray(raw.allowed_tools) ? raw.allowed_tools.map(String) : [];
  const allowed_tools = requested.filter((name) => known.has(name));
  const dropped = requested.filter((name) => !known.has(name));
  if (dropped.length) {
    warnings.push(`These tools do not exist in this system and were left out: ${dropped.join(', ')}.`);
  }

  let trigger_type = ['schedule', 'event', 'manual'].includes(raw.trigger_type) ? raw.trigger_type : 'schedule';
  if (trigger_type === 'event' && !raw.event_key) trigger_type = 'schedule';

  let schedule_seconds = null;
  if (trigger_type === 'schedule') {
    const fromCron = typeof raw.schedule === 'string' ? cronToSeconds(raw.schedule) : null;
    const proposed = Number(raw.schedule_seconds) || fromCron || 86400;
    schedule_seconds = nearestInterval(proposed);
    if (fromCron && !raw.schedule_seconds) {
      warnings.push(`"${raw.schedule}" was read as ${intervalLabel(schedule_seconds).toLowerCase()} — this scheduler runs on an interval, not at a fixed time.`);
    }
  }

  const steps = kind === 'pipeline' && Array.isArray(raw.steps)
    ? raw.steps
        .filter((s) => s && known.has(s.tool))
        .map((s, index) => ({
          id: slugify(s.id || `step_${index + 1}`, 40) || `step_${index + 1}`,
          tool: s.tool,
          args: s.args && typeof s.args === 'object' && !Array.isArray(s.args) ? s.args : {},
          ...(s.condition ? { condition: String(s.condition) } : {}),
        }))
    : [];

  const domain = String(raw.domain || '').toUpperCase();

  return {
    blueprint: {
      agent_key,
      display_name: String(nameSource).slice(0, 160),
      description: raw.description ? String(raw.description).slice(0, 500) : null,
      domain: blueprints.DOMAINS.includes(domain) ? domain : 'DATA',
      kind,
      goal: kind === 'ai' ? String(raw.goal || '').trim() : null,
      steps,
      trigger_type,
      schedule_seconds,
      event_key: trigger_type === 'event' ? String(raw.event_key).slice(0, 120) : null,
      allowed_tools,
      escalation_rules: {
        guidance: String(raw.escalation_rules?.guidance || raw.escalation || '').slice(0, 2000),
      },
      provider: 'openai',
      model: null,
      effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(raw.effort) ? raw.effort : 'high',
      max_iterations: Math.min(Math.max(Number(raw.max_iterations) || 20, 1), 100),
      memory_enabled: raw.memory_enabled !== false,
      config: {},
      source_prompt: null,
    },
    warnings,
    reasoning: raw.reasoning ? String(raw.reasoning).slice(0, 600) : null,
    schedule_note: raw.schedule_note ? String(raw.schedule_note).slice(0, 400) : null,
  };
}

/** Plain-English sentences for the review screen, one per thing the agent will do. */
function explainBlueprint(blueprint, knownTools) {
  const byName = new Map(knownTools.map((t) => [t.name, t]));
  const selected = blueprint.allowed_tools.map((n) => byName.get(n)).filter(Boolean);

  return {
    when:
      blueprint.trigger_type === 'schedule'
        ? `${intervalLabel(blueprint.schedule_seconds)}, starting when you enable it`
        : blueprint.trigger_type === 'event'
          ? `Whenever "${blueprint.event_key}" happens`
          : 'Only when someone runs it by hand',
    writes: selected.filter((t) => t.readOnly === false).map((t) => t.name),
    steps:
      blueprint.kind === 'pipeline'
        ? blueprint.steps.map((s, i) => `${i + 1}. ${byName.get(s.tool)?.description || s.tool}${s.condition ? ` — only if ${s.condition}` : ''}`)
        : String(blueprint.goal || '')
            .split(/\n{2,}/)
            .map((p) => p.trim())
            .filter(Boolean),
  };
}

/**
 * Draft an agent from a sentence.
 *
 * @returns {{ blueprint, explanation, warnings, reasoning, valid, validation_error }}
 */
async function generateAgent({ description, role }) {
  const prompt = cleanDescription(description);
  const { tools, text } = await toolCatalogueText(role);

  const outcome = await generateWithRepair({
    system: AGENT_SYSTEM(text),
    user: `Configure an agent that does this:\n\n${prompt}`,
    maxTokens: 3000,
    build: async (raw) => {
      const normalized = await normalizeBlueprint(raw, tools);
      try {
        // The save endpoint's own validator, run before the person sees the
        // draft. Anything it rejects here would have rejected the Create click.
        await blueprints.validate(normalized.blueprint);
        return { ok: true, ...normalized };
      } catch (err) {
        return { ok: false, error: err.message, ...normalized };
      }
    },
  });

  return {
    blueprint: { ...outcome.blueprint, source_prompt: prompt },
    explanation: explainBlueprint(outcome.blueprint, tools),
    warnings: outcome.warnings,
    reasoning: outcome.reasoning,
    schedule_note: outcome.schedule_note,
    valid: !!outcome.ok,
    validation_error: outcome.ok ? null : outcome.error,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOL_SYSTEM = (schemaText, readOnlyToolsText) => `You write tools for Simeli, an ERP system. A colleague describes something they want the AI to be able to look up; you return the tool as JSON. The tool becomes a function the assistant and the autonomous agents can call.

Return ONLY a JSON object. No prose, no code fences.

{
  "name": "lowercase_snake_case, 3-64 chars, starts with a letter",
  "display_name": "short human name",
  "description": "a sentence saying what it returns and when to use it — the model reads this to decide when to call it",
  "input_schema": { "type": "object", "properties": { "customer_id": { "type": "string", "description": "..." } }, "required": [] },
  "implementation": "the JavaScript function body",
  "returns": "plain English: what comes back, e.g. 'The customer's name and their total invoiced amount'",
  "sample_input": { "customer_id": "..." },
  "allowed_tools": [],
  "allow_sql": true,
  "reasoning": "one or two sentences for the person: what this queries and why"
}

THE IMPLEMENTATION
It is a function body — no wrapper, no function signature, just statements ending in a return. Two things are in scope:
  input                     the arguments, matching input_schema
  erp.sql(text, params)     read-only SQL, parameterised with $1, $2, …
  erp.callTool(name, args)  a read-only built-in tool listed in allowed_tools
  erp.log(...)              visible in the test output

It runs in a sandbox with nothing else. These all throw: require, process, globalThis, eval, new Function, Buffer, setTimeout, __proto__, import(). Do not use them, and do not use fetch, fs or any Node API.

SQL RULES — these are enforced, not advisory
- A single SELECT statement. No INSERT/UPDATE/DELETE/DDL, no semicolon-separated statements, no CTE writes.
- Only the tables listed below. Anything else is rejected before it reaches the database.
- Always parameterise user input as $1, $2 — never build SQL by string concatenation.
- Use LIMIT. Default it from input where a row count makes sense.
- Some tables are soft-deleted and some are not. Add "deleted_at IS NULL" ONLY for a table whose listing below actually contains a deleted_at column. Adding it to a table that has no such column is the single most common way these queries fail.

CHECK BEFORE YOU ANSWER
Go through your query one table at a time. For each one, find its line in the listing below and confirm that every column you named appears on that line, spelled exactly the same way. Do not reason from what an ERP table usually has — this database is the only authority, and it is printed in full below. A column that "should" exist and does not is a broken tool.

SAMPLE_INPUT
Must be arguments the tool can actually run with against a real database RIGHT NOW. Prefer inputs that need no existing row (a limit, a date range, a status). Only reference an id if the tool cannot work without one — and then the tool should return an empty result rather than throw.

THE DATABASE — these are the real tables and columns. Use nothing else.
${schemaText}

READ-ONLY BUILT-IN TOOLS you may list in allowed_tools (leave it empty unless you call one):
${readOnlyToolsText}

EXAMPLE — "a tool that looks up a customer's total lifetime spend"
{
  "name": "customer_lifetime_spend",
  "display_name": "Customer lifetime spend",
  "description": "Returns how much a customer has been invoiced in total, how much they have paid, and how many invoices they have. Use it when asked what a customer is worth or how much they have spent.",
  "input_schema": { "type": "object", "properties": { "customer_name": { "type": "string", "description": "Full or partial customer name" } }, "required": ["customer_name"] },
  "implementation": "const { rows } = await erp.sql(\\n  \`SELECT c.customer_name,\\n          COUNT(ci.id) AS invoice_count,\\n          COALESCE(SUM(ci.total_amount), 0) AS total_invoiced\\n     FROM customers c\\n     LEFT JOIN customer_invoices ci ON ci.customer_id = c.id AND ci.deleted_at IS NULL\\n    WHERE c.deleted_at IS NULL AND c.customer_name ILIKE $1\\n    GROUP BY c.id, c.customer_name\\n    ORDER BY total_invoiced DESC\\n    LIMIT 10\`,\\n  ['%' + (input.customer_name || '') + '%']\\n);\\nif (!rows.length) return { found: false, customers: [] };\\nreturn { found: true, customers: rows };",
  "returns": "Each matching customer with their invoice count and total invoiced amount",
  "sample_input": { "customer_name": "a" },
  "allowed_tools": [],
  "allow_sql": true,
  "reasoning": "Joins customers to their invoices and sums the totals, matching the name loosely so a partial name still works."
}`;

async function normalizeTool(raw) {
  const warnings = [];

  const baseName = slugify(raw.name || raw.display_name || 'custom_tool', 64) || 'custom_tool';
  const name = await uniqueKey(
    baseName.length >= 3 ? baseName : `${baseName}_tool`,
    async (candidate) => {
      const { byName } = require('./toolRegistry');
      return byName.has(candidate) || !!(await customTools.getTool(candidate));
    }
  );
  if (name !== baseName) {
    warnings.push(`A tool called "${baseName}" already exists, so this one is named "${name}".`);
  }

  const schema = raw.input_schema && typeof raw.input_schema === 'object' && !Array.isArray(raw.input_schema)
    ? { ...raw.input_schema, type: 'object' }
    : { type: 'object', properties: {} };

  // A custom tool may only reach read-only built-ins; the save-time validator
  // says so too, but dropping the impossible ones here saves a repair round.
  const { byName } = require('./toolRegistry');
  const requested = Array.isArray(raw.allowed_tools) ? raw.allowed_tools.map(String) : [];
  const allowed_tools = requested.filter((n) => byName.get(n)?.readOnly);
  const dropped = requested.filter((n) => !byName.get(n)?.readOnly);
  if (dropped.length) {
    warnings.push(`Left out ${dropped.join(', ')} — a tool may only call read-only built-ins.`);
  }

  return {
    tool: {
      name,
      display_name: raw.display_name ? String(raw.display_name).slice(0, 160) : null,
      description: String(raw.description || '').trim().slice(0, 1000),
      input_schema: schema,
      implementation: String(raw.implementation || ''),
      allowed_tools,
      allow_sql: raw.allow_sql !== false,
      timeout_ms: 5000,
      enabled: true,
    },
    sample_input: raw.sample_input && typeof raw.sample_input === 'object' ? raw.sample_input : {},
    returns: raw.returns ? String(raw.returns).slice(0, 500) : null,
    reasoning: raw.reasoning ? String(raw.reasoning).slice(0, 600) : null,
    warnings,
  };
}

/**
 * Draft a tool from a sentence, then run it.
 *
 * The test run is not a nicety. A generated tool is code the assistant will call
 * on its own, and the one thing that distinguishes working code from code that
 * merely looks right is having watched it return rows. If the first attempt
 * fails, the real error — the SQL rejection, the missing column — goes back to
 * the model, which is a far better repair signal than any amount of prompting.
 */
async function generateTool({ description, userId, role }) {
  const prompt = cleanDescription(description);

  const externalMatches = searchRegistry(prompt).filter((m) => m.score >= EXTERNAL_SERVICE_SCORE_THRESHOLD);
  if (externalMatches.length) {
    const top = externalMatches[0];
    return {
      tool: null,
      sample_input: null,
      returns: null,
      reasoning: null,
      warnings: [],
      test: null,
      valid: false,
      validation_error: null,
      impossible: true,
      impossible_reason:
        `A tool built here can only run read-only SQL against this ERP's own database — it has no way to call ${top.name} ` +
        `or any other outside service. That is what "${prompt}" needs, so no amount of retrying will produce a working tool. ` +
        `Connect the ${top.name} MCP server from Discover instead to get real ${top.name} tools.`,
      suggested_mcp: externalMatches.slice(0, 3).map(({ score, ...candidate }) => candidate),
    };
  }

  const [schemaText, { tools }] = await Promise.all([
    require('./nlQuery').reportingSchema(),
    toolCatalogueText(role),
  ]);
  const readOnlyText = tools
    .filter((t) => t.readOnly !== false && !t.custom)
    .map((t) => `- ${t.name}: ${String(t.description || '').slice(0, 120)}`)
    .join('\n');

  const ctx = { userId, actor: 'tool-generator', role: role || 'ADMIN' };

  const outcome = await generateWithRepair({
    system: TOOL_SYSTEM(schemaText, readOnlyText),
    user: `Write a tool that does this:\n\n${prompt}`,
    maxTokens: 3000,
    // One more go than the agent gets. A tool is validated by actually running
    // it, so its failures are concrete and mechanical — a wrong column name, a
    // rejected construct — and those are exactly the kind a second look fixes.
    attempts: 3,
    build: async (raw) => {
      const normalized = await normalizeTool(raw);
      try {
        customTools.validateDefinition(normalized.tool);
      } catch (err) {
        return { ok: false, error: err.message, ...normalized };
      }
      const test = await customTools.testTool(
        {
          implementation: normalized.tool.implementation,
          input: normalized.sample_input,
          timeout_ms: normalized.tool.timeout_ms,
          allowed_tools: normalized.tool.allowed_tools,
          allow_sql: normalized.tool.allow_sql,
        },
        ctx
      );
      if (!test.ok) {
        return {
          ok: false,
          error: `Running it with ${JSON.stringify(normalized.sample_input)} failed: ${test.error}`,
          test,
          ...normalized,
        };
      }
      return { ok: true, test, ...normalized };
    },
  });

  return {
    tool: outcome.tool,
    sample_input: outcome.sample_input,
    returns: outcome.returns,
    reasoning: outcome.reasoning,
    warnings: outcome.warnings,
    test: outcome.test || null,
    valid: !!outcome.ok,
    validation_error: outcome.ok ? null : outcome.error,
  };
}

module.exports = {
  generateAgent,
  generateTool,
  INTERVALS,
  intervalLabel,
  cronToSeconds,
  nearestInterval,
};
