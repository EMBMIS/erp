/**
 * Meta tools — the ERP's ability to extend itself from a conversation.
 *
 * These are what turn the assistant from something that answers questions about
 * the ERP into something that changes what the ERP can do: build an agent,
 * build a tool, design a document template, inspect what already exists.
 *
 * Two rules run through all of them, and they are the difference between a
 * useful meta-layer and a dangerous one:
 *
 *   1. BUILDING IS NOT GRANTING. `build_agent` always creates the agent
 *      DISABLED and in observe mode. Describing an agent out loud must never be
 *      the act that lets it run — that stays a deliberate human decision on the
 *      Agents screen, or an explicit `enable_agent` call which is highImpact and
 *      therefore confirmed. Someone who says "make an agent that emails
 *      customers every Monday" has described a behaviour, not authorised it.
 *   2. AUTHORING IS ADMIN WORK. Every writing tool here re-checks the caller's
 *      role. The chat surface is reachable by any authenticated user, and a
 *      tool that can define new unattended behaviour must not be more permissive
 *      than the REST endpoint that does the same thing.
 */

const blueprintStore = require('../agents/blueprintStore');
const customTools = require('./customTools');
const templateStore = require('../pdf/templateStore');

/**
 * Role gate for the meta tools.
 *
 * Enforced in code rather than through ai_tool_settings.min_role because this
 * is a security boundary, not a preference: a settings row can be edited, and
 * "who may define new autonomous behaviour" should not depend on one.
 */
function requireManager(ctx, what) {
  if (ctx.role === 'ADMIN' || ctx.role === 'MANAGER') return;
  throw new Error(
    `Only an administrator or manager can ${what}. Tell the user what you would have built and ask them to have an administrator do it.`
  );
}

const metaTools = [
  // -------------------------------------------------------------------------
  // Discovery — what this system can already do
  // -------------------------------------------------------------------------
  {
    name: 'list_available_tools',
    description:
      'List every tool available in this ERP, with what each does and whether it changes data. Call this before building an agent or a tool, so you compose from what actually exists instead of guessing at names.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Optional: only tools whose name or description matches' } },
    },
    handler: async (args, ctx = {}) => {
      const catalog = require('./toolCatalog');
      const tools = await catalog.listTools({ role: ctx.role || 'ADMIN' });
      const needle = String(args.search || '').toLowerCase();
      const filtered = needle
        ? tools.filter((t) => t.name.includes(needle) || String(t.description).toLowerCase().includes(needle))
        : tools;
      return {
        count: filtered.length,
        tools: filtered.map((t) => ({
          name: t.name,
          description: t.description,
          // The impact tier is what an agent author actually needs: it decides
          // what authority the agent will require.
          impact: t.readOnly ? 'read' : t.highImpact ? 'real' : 'draft',
          custom: !!t.custom,
          inputs: Object.keys(t.inputSchema?.properties || {}),
        })),
      };
    },
  },

  {
    name: 'list_agents_built',
    description: 'List the agents built in this ERP, with their goal or steps, trigger, and whether they are enabled. Use before creating one, to avoid duplicating an agent that already exists.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const blueprints = await blueprintStore.listBlueprints();
      return {
        count: blueprints.length,
        agents: blueprints.map((b) => ({
          agent_key: b.agent_key,
          name: b.display_name,
          kind: b.kind,
          goal: b.goal ? String(b.goal).slice(0, 400) : undefined,
          steps: b.kind === 'pipeline' ? (b.steps || []).map((s) => s.tool) : undefined,
          trigger: b.trigger_type,
          schedule_seconds: b.schedule_seconds,
          enabled: b.enabled,
          mode: b.mode,
          last_run_at: b.last_run_at,
        })),
      };
    },
  },

  // -------------------------------------------------------------------------
  // Agent builder
  // -------------------------------------------------------------------------
  {
    name: 'build_agent',
    description:
      'Create a new agent that runs on its own. Prefer kind="ai": you give it a GOAL and a set of tools, and at run time a model reasons, calls tools, reads what it finds and decides what to do next — it handles situations you did not anticipate. Use kind="pipeline" only when the work is genuinely fixed and must be identical every time. ' +
      'The goal is the agent: state the objective, the judgement to apply, and when to stop and ask a human. ' +
      'IMPORTANT: the agent is saved DISABLED, in observe mode. Creating it grants it nothing. Say so, and tell the user to enable it on the Agents page (or ask you to) once they have read what it will do.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        agent_key: { type: 'string', description: 'Stable identifier, lowercase with underscores, e.g. collections_watch' },
        display_name: { type: 'string' },
        description: { type: 'string', description: 'One line a colleague could read to know what this agent is for' },
        kind: { type: 'string', description: '"ai" (reasoning loop — the default and usually right) or "pipeline" (fixed steps)' },
        goal: {
          type: 'string',
          description:
            'For kind="ai": the agent\'s instructions. Several sentences at least — what to achieve, how to judge, what to escalate. Written in the second person ("You are the collections agent...").',
        },
        domain: { type: 'string', description: 'FINANCE | PROCUREMENT | SALES | INVENTORY | HR | DATA' },
        trigger_type: { type: 'string', description: 'schedule | event | manual' },
        schedule_seconds: { type: 'number', description: 'For trigger_type=schedule, e.g. 604800 for weekly' },
        event_key: { type: 'string', description: 'For trigger_type=event' },
        allowed_tools: {
          type: 'array',
          description: 'Tool names this agent may use. Give it what the goal needs and no more. Omit to allow every tool.',
          items: { type: 'string' },
        },
        steps: {
          type: 'array',
          description: 'For kind="pipeline" only: ordered [{id, tool, args, condition, note}]. args may reference {{config.x}} and {{steps.id.field}}.',
          items: { type: 'object' },
        },
        config: { type: 'object', description: 'Editable settings the operator can tune later (thresholds, recipients)' },
        max_iterations: { type: 'number', description: 'For kind="ai": reasoning-step cap per run. Default 20.' },
        escalation_rules: { type: 'object', description: '{ guidance: "when to stop and ask" }' },
        source_prompt: { type: 'string', description: 'What the user actually asked for, verbatim' },
      },
      required: ['agent_key', 'display_name'],
    },
    handler: async (args, ctx = {}) => {
      requireManager(ctx, 'create agents');

      const kind = args.kind === 'pipeline' ? 'pipeline' : 'ai';
      const created = await blueprintStore.createBlueprint(
        {
          ...args,
          kind,
          trigger_type: args.trigger_type || 'manual',
          steps: kind === 'pipeline' ? args.steps || [] : [],
        },
        ctx.userId
      );

      const gaps = await blueprintStore.authorityGaps(created.blueprint);
      const scheduleNote =
        args.trigger_type === 'schedule' && args.schedule_seconds
          ? ` It is set to run every ${describeInterval(args.schedule_seconds)} once enabled.`
          : '';

      return {
        agent_key: created.blueprint.agent_key,
        name: created.blueprint.display_name,
        kind,
        enabled: false,
        mode: 'observe',
        will_need_authority_for: gaps.required_actions,
        // Spelled out rather than implied. The single most likely
        // misunderstanding here is a user believing the agent is now running.
        status:
          `Created and saved, but NOT running. It is disabled and in observe mode, so it cannot change anything yet.${scheduleNote}` +
          (gaps.required_actions?.length
            ? ` To let it act, someone must enable it and grant: ${gaps.required_actions.join(', ')}.`
            : ' It only reads data, so enabling it is low risk.'),
        where: `Agents → ${created.blueprint.display_name}`,
      };
    },
  },

  {
    name: 'preview_agent',
    description:
      'Run an agent in preview mode: it works through its goal against real data but every action is recorded rather than performed. Use this after building one, and show the user what it would have done before suggesting they enable it.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: { agent_key: { type: 'string' } },
      required: ['agent_key'],
    },
    handler: async (args, ctx = {}) => {
      requireManager(ctx, 'run agents');
      const agents = require('../agents');
      const run = await agents.runAgent(args.agent_key, {
        trigger: 'manual',
        triggeredBy: ctx.userId,
        dryRun: true,
        force: true, // a preview of a disabled agent is exactly the point
      });
      const detail = run.run_id ? await agents.getRun(run.run_id) : null;
      return {
        ...run,
        would_have_done: (detail?.actions || []).map((a) => ({
          action: a.action_type,
          decision: a.decision,
          why: a.rationale,
          amount: a.amount,
        })),
      };
    },
  },

  {
    name: 'enable_agent',
    description:
      'Enable an agent and set how much it may do on its own. This is the moment autonomy is granted, so explain in plain language what the agent will now do unattended, and how often, before calling it.',
    readOnly: false,
    // The grant itself. Confirmed in chat under any mode short of full-auto.
    highImpact: true,
    min_role: 'MANAGER',
    inputSchema: {
      type: 'object',
      properties: {
        agent_key: { type: 'string' },
        mode: { type: 'string', description: 'observe (look only) | propose (drafts, needs approval) | act (real actions within limits)' },
        schedule_seconds: { type: 'number', description: 'Optional: change the interval at the same time' },
        max_amount: { type: 'number', description: 'Value ceiling per action; anything above it is escalated to a human' },
        currency: { type: 'string' },
      },
      required: ['agent_key', 'mode'],
    },
    handler: async (args, ctx = {}) => {
      requireManager(ctx, 'enable agents');
      const agents = require('../agents');

      const blueprint = await blueprintStore.getBlueprint(args.agent_key);
      const definition = await agents.getDefinition(args.agent_key);
      if (!definition) throw new Error(`No agent called "${args.agent_key}".`);

      // Enabling has to carry the allowlist with it, or the agent runs and
      // escalates everything — which looks like a broken agent rather than an
      // unauthorised one. The list still comes from the agent's own declared
      // tools, not from anything the model invents here.
      const required = blueprint
        ? (await blueprintStore.authorityGaps(blueprint)).required_actions || []
        : [];

      const authority = {
        ...(definition.authority || {}),
        allowed_actions: [...new Set([...(definition.authority?.allowed_actions || []), ...required])],
      };
      if (args.max_amount !== undefined) authority.max_amount = Number(args.max_amount);
      if (args.currency) authority.currency = args.currency;

      const updated = await agents.configureAgent(args.agent_key, {
        enabled: true,
        mode: args.mode,
        schedule_seconds: args.schedule_seconds,
        authority,
      });

      return {
        agent_key: updated.agent_key,
        enabled: updated.enabled,
        mode: updated.mode,
        runs_every: updated.schedule_seconds ? describeInterval(updated.schedule_seconds) : 'only when triggered by hand',
        may_perform: authority.allowed_actions,
        value_limit: authority.max_amount ?? null,
        note:
          args.mode === 'act'
            ? 'This agent can now change business data unattended, within the limits above. Anything beyond them is escalated to a person.'
            : args.mode === 'propose'
              ? 'This agent will prepare drafts. Nothing takes effect until a human approves it.'
              : 'This agent will look and report only.',
      };
    },
  },

  // -------------------------------------------------------------------------
  // Background tasks — one-time, throwaway sub-runs, NOT an agent blueprint.
  //
  // build_agent/enable_agent create durable, reusable, schedulable behaviour —
  // deliberately heavyweight, since it runs forever. This is the opposite: a
  // single ad-hoc run for something separable from the current reply, gone
  // once it finishes. It never starts without a person saying yes — see
  // alwaysConfirm below and needsConfirmation() in agent.js — because "keeps
  // running after I've stopped watching" carries the same trust requirement
  // as "runs code I didn't review," regardless of what autonomy mode chat is
  // currently in.
  // -------------------------------------------------------------------------
  {
    name: 'propose_background_task',
    description:
      'Start a separate, one-time background run for work that is clearly separable from this reply and would take many more tool-calling steps than are worth making the user wait for right now — e.g. "reindex every document", "check all suppliers for duplicates", "go through the last 200 journal entries for anomalies". ' +
      'Do NOT use this for anything you can just finish in this same turn — it exists for genuinely separable, longer-running work, not to avoid answering directly. ' +
      'This always asks the user to confirm before anything runs, in every mode. The background run itself is capped: if it hits something that would need a live confirmation, it stops and reports that rather than guessing or waiting forever. ' +
      'After calling this, tell the user it is running in the background and that they can check on it or ask you about it later — do not imply it already finished.',
    readOnly: false,
    alwaysConfirm: true, // see needsConfirmation() in agent.js
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short label for this run, shown to the user, e.g. "Reindex all contracts"' },
        description: {
          type: 'string',
          description: 'The actual instructions for the background run — written as if it were a fresh message to yourself, with everything it needs (it starts with no memory of this conversation).',
        },
      },
      required: ['title', 'description'],
    },
    handler: async (args, ctx = {}) => require('./backgroundTasks').proposeTask(args, ctx),
  },

  {
    name: 'list_background_tasks',
    description: 'List background tasks you have proposed for the current user, most recent first — their status, and the result or error once finished. Use this when asked "what happened with that background task" or "is it done yet".',
    readOnly: true,
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'default 20' } } },
    handler: async (args, ctx = {}) => {
      const tasks = await require('./backgroundTasks').listTasksForUser(ctx.userId, { limit: args.limit });
      return { count: tasks.length, tasks };
    },
  },

  // -------------------------------------------------------------------------
  // Tool builder
  // -------------------------------------------------------------------------
  {
    name: 'try_tool',
    description:
      'Run tool code WITHOUT saving it, and see exactly what it returns. Always do this before build_tool, and show the user the real output. The code is a function body receiving `input` and `erp`; use `await erp.sql(text, params)` for read-only SELECT queries and `return` the result.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        implementation: { type: 'string', description: 'Function body. Receives (input, erp). Must return a value.' },
        input: { type: 'object', description: 'Sample arguments to test with' },
        allowed_tools: { type: 'array', description: 'Read-only built-in tools the code may call via erp.callTool', items: { type: 'string' } },
      },
      required: ['implementation'],
    },
    handler: async (args, ctx = {}) => {
      requireManager(ctx, 'build tools');
      const outcome = await customTools.testTool(args, ctx);
      return outcome.ok
        ? { ok: true, result: outcome.result, logs: outcome.logs, duration_ms: outcome.duration_ms }
        : { ok: false, error: outcome.error, logs: outcome.logs, hint: 'Fix the code and try again before saving it.' };
    },
  },

  {
    name: 'build_tool',
    description:
      'Save a new tool, available to the assistant and to agents immediately. Test it with try_tool first — never save code you have not run. Custom tools are read-only by design: they may query and compute, but cannot change data. If the user wants something that writes, compose existing write tools in an agent instead.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lowercase with underscores, e.g. customer_payment_history' },
        description: { type: 'string', description: 'What it does and when to use it — this is what the model reads to decide whether to call it' },
        input_schema: { type: 'object', description: 'JSON Schema: {"type":"object","properties":{...},"required":[...]}' },
        implementation: { type: 'string', description: 'The tested function body' },
        allowed_tools: { type: 'array', description: 'Read-only built-in tools it may call', items: { type: 'string' } },
      },
      required: ['name', 'description', 'implementation'],
    },
    handler: async (args, ctx = {}) => {
      requireManager(ctx, 'build tools');
      const tool = await customTools.createTool(args, ctx.userId);
      return {
        name: tool.name,
        version: tool.version,
        status: 'Saved and enabled. You can call it in this conversation from now on, and agents can use it as a step.',
        where: `AI → Tool Library → ${tool.name}`,
      };
    },
  },

  // -------------------------------------------------------------------------
  // Credentials — visibility only; secrets are never handled here
  // -------------------------------------------------------------------------
  {
    name: 'list_credentials',
    description:
      'List the API credentials stored in this ERP, by name and provider. Secrets are never shown, to you or anyone else. Use this to tell an agent which credential to use, or to check whether one exists before suggesting a feature that needs it.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async (args, ctx = {}) => {
      requireManager(ctx, 'view stored credentials');
      const vault = require('./credentialVault');
      const credentials = await vault.listCredentials();
      return {
        count: credentials.length,
        vault: vault.vaultStatus(),
        credentials: credentials.map((c) => ({
          name: c.name,
          provider: c.provider,
          allowed_hosts: c.allowed_hosts,
          enabled: c.enabled,
          ends_with: c.hint,
          last_used_at: c.last_used_at,
        })),
        note: 'If the user needs to add a key, they must enter it themselves in AI Settings → Credentials. Never ask a user to paste an API key into the chat.',
      };
    },
  },

  // -------------------------------------------------------------------------
  // PDF templates
  // -------------------------------------------------------------------------
  {
    name: 'list_pdf_template_details',
    description: 'Show a PDF template in full — its colours, letterhead and body sections with their placeholders. Use before editing one or before filling it in.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
    handler: async (args) => {
      const template = await templateStore.getTemplate(args.key);
      if (!template) throw new Error(`No PDF template named "${args.key}".`);
      const { placeholdersIn } = require('./pdfTools');
      return { ...template, placeholders: placeholdersIn(template.sections) };
    },
  },
];

function describeInterval(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return 'never';
  if (n % 604800 === 0) return `${n / 604800} week(s)`;
  if (n % 86400 === 0) return `${n / 86400} day(s)`;
  if (n % 3600 === 0) return `${n / 3600} hour(s)`;
  return `${Math.round(n / 60)} minute(s)`;
}

module.exports = { metaTools, describeInterval };
