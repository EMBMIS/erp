/**
 * Storage for user-authored agents.
 *
 * A blueprint is the DECLARATION of an agent — its steps, its config, its
 * intended trigger. Its OPERATIONAL state (enabled, mode, authority envelope,
 * schedule, failure count) stays in `agent_definitions`, exactly where the
 * hand-written agents keep theirs.
 *
 * That split is the whole design, and it is worth being precise about why:
 *
 *   • Editing what an agent DOES cannot change what it is ALLOWED to do. Adding
 *     a step that sends email to a blueprint does not extend the agent's
 *     allowed_actions, so the runtime's deny-by-default check still refuses it
 *     until a human grants it. `authorityGaps()` surfaces that as a visible
 *     warning rather than a mysterious "skipped" in the run history.
 *   • An agent created from a chat message is created DISABLED and in observe
 *     mode. Autonomy is granted by a person, in the Agents screen, as its own
 *     act — never as a side effect of describing what you want.
 *   • The scheduler, the advisory lock, escalation, the audit trail and
 *     auto-disable need no knowledge that blueprints exist.
 */

const { pool } = require('../../config/database');
const blueprintRunner = require('./blueprintRunner');

const KEY_PATTERN = /^[a-z][a-z0-9_]{2,79}$/;
const DOMAINS = ['FINANCE', 'PROCUREMENT', 'SALES', 'INVENTORY', 'HR', 'DATA'];
const TRIGGERS = ['schedule', 'event', 'manual'];
const KINDS = ['ai', 'pipeline'];

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function listBlueprints() {
  const { rows } = await pool.query(
    `SELECT b.*, u.first_name || ' ' || u.last_name AS created_by_name,
            d.enabled, d.mode, d.authority, d.last_run_at, d.failure_count, d.last_error,
            d.schedule_seconds AS active_schedule_seconds
       FROM agent_blueprints b
       LEFT JOIN users u ON u.id = b.created_by
       LEFT JOIN agent_definitions d ON d.agent_key = b.agent_key
      ORDER BY b.display_name`
  );
  return rows;
}

async function getBlueprint(keyOrId) {
  if (!keyOrId) return null;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(keyOrId));
  const { rows } = await pool.query(
    `SELECT * FROM agent_blueprints WHERE ${isUuid ? 'id' : 'agent_key'} = $1`,
    [keyOrId]
  );
  return rows[0] || null;
}

/** Every blueprint key, so the runtime can tell a blueprint agent from a code one. */
async function blueprintKeys() {
  const { rows } = await pool.query('SELECT agent_key FROM agent_blueprints');
  return new Set(rows.map((r) => r.agent_key));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

async function validate(input) {
  if (!KEY_PATTERN.test(String(input.agent_key || ''))) {
    throw new Error('An agent key must be lowercase letters, digits and underscores, 3-80 characters, starting with a letter.');
  }
  if (!input.display_name || !String(input.display_name).trim()) throw new Error('The agent needs a name.');
  if (input.domain && !DOMAINS.includes(input.domain)) {
    throw new Error(`Domain must be one of: ${DOMAINS.join(', ')}.`);
  }
  const trigger = input.trigger_type || 'manual';
  if (!TRIGGERS.includes(trigger)) throw new Error(`Trigger must be one of: ${TRIGGERS.join(', ')}.`);
  if (trigger === 'schedule' && !Number(input.schedule_seconds)) {
    throw new Error('A scheduled agent needs an interval — how often should it run?');
  }
  if (trigger === 'event' && !input.event_key) {
    throw new Error('An event-triggered agent needs an event key.');
  }

  const kind = input.kind || 'pipeline';
  if (!KINDS.includes(kind)) throw new Error(`Kind must be one of: ${KINDS.join(', ')}.`);

  // Validating tool names at save time is what stops a broken agent being
  // discovered at 3am by the scheduler instead of by its author.
  const catalog = require('../ai/toolCatalog');
  const known = new Map((await catalog.listTools({ role: 'ADMIN' })).map((t) => [t.name, t]));

  if (kind === 'ai') {
    // The goal IS the agent. A one-line goal produces an agent that improvises,
    // which is exactly what an unattended process should not do.
    const goal = String(input.goal || '').trim();
    if (goal.length < 30) {
      throw new Error(
        'An AI agent needs a goal of at least a couple of sentences: what it should achieve, what judgement to apply, and when to stop and ask a human. This is the agent — a vague goal produces a vague agent.'
      );
    }
    if (input.provider && !['anthropic', 'openai'].includes(input.provider)) {
      throw new Error('Provider must be "anthropic" or "openai".');
    }
    if (input.effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(input.effort)) {
      throw new Error('Effort must be one of: low, medium, high, xhigh, max.');
    }
    const allowedTools = Array.isArray(input.allowed_tools) ? input.allowed_tools : [];
    for (const name of allowedTools) {
      if (!known.has(name)) throw new Error(`"${name}" is not an available tool, so this agent cannot be given access to it.`);
    }
    if (input.credential_id) {
      const vault = require('../ai/credentialVault');
      const credential = await vault.getCredential(input.credential_id);
      if (!credential) throw new Error('The selected model credential does not exist.');
      if (credential.provider !== (input.provider || 'openai')) {
        // A key for the wrong provider produces a 401 mid-run that the agent
        // would report as "no data available" — catch it here instead.
        throw new Error(
          `Credential "${credential.name}" is a ${credential.provider} key, but this agent is configured for ${input.provider || 'openai'}.`
        );
      }
    }
    return { steps: [], trigger, known, kind };
  }

  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (!steps.length) throw new Error('A pipeline agent needs at least one step.');
  if (steps.length > blueprintRunner.MAX_STEPS) {
    throw new Error(`An agent may have at most ${blueprintRunner.MAX_STEPS} steps.`);
  }

  const ids = new Set();
  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object') throw new Error(`Step ${index + 1} is not a step.`);
    if (!step.tool) throw new Error(`Step ${index + 1} does not name a tool.`);
    if (!known.has(step.tool)) {
      throw new Error(`Step ${index + 1} uses "${step.tool}", which is not an available tool.`);
    }
    if (step.args !== undefined && (typeof step.args !== 'object' || Array.isArray(step.args))) {
      throw new Error(`Step ${index + 1}: args must be an object.`);
    }
    const id = step.id || step.save_as;
    if (id) {
      if (ids.has(id)) throw new Error(`Two steps share the id "${id}"; later references would be ambiguous.`);
      ids.add(id);
    }
  });

  return { steps, trigger, known, kind };
}

// ---------------------------------------------------------------------------
// Definition sync
// ---------------------------------------------------------------------------

/**
 * Mirror a blueprint into agent_definitions.
 *
 * On INSERT the authority envelope is seeded from the blueprint's write steps —
 * safe, because the row is created disabled and in observe mode, so the single
 * human act of enabling it is the grant.
 *
 * On UPDATE, operational columns are deliberately untouched. Re-seeding
 * allowed_actions here would mean editing a blueprint silently widens what an
 * already-running agent may do, which is precisely the property the
 * deny-by-default allowlist exists to prevent.
 */
async function syncDefinition(blueprint, { seedAuthority = false } = {}) {
  // What the agent needs authority for. A pipeline declares it in its steps; an
  // AI agent declares it by the tools it was given, since which of them it will
  // actually call is not knowable in advance.
  const allowedActions = blueprint.kind === 'ai'
    ? await writeToolsAmong(blueprint.allowed_tools)
    : await blueprintRunner.writeActionsOf(blueprint.steps);
  const scheduleSeconds = blueprint.trigger_type === 'schedule' ? Number(blueprint.schedule_seconds) || null : null;

  const { rows } = await pool.query(
    `INSERT INTO agent_definitions
       (agent_key, display_name, description, domain, mode, schedule_seconds, authority, config, enabled)
     VALUES ($1,$2,$3,$4,'observe',$5,$6,$7,false)
     ON CONFLICT (company_id, agent_key) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           description  = EXCLUDED.description,
           domain       = EXCLUDED.domain,
           updated_at   = CURRENT_TIMESTAMP
     RETURNING *`,
    [
      blueprint.agent_key,
      blueprint.display_name,
      blueprint.description || null,
      blueprint.domain || 'DATA',
      scheduleSeconds,
      JSON.stringify(
        seedAuthority
          ? { allowed_actions: allowedActions, max_actions_per_run: 25 }
          : {}
      ),
      JSON.stringify(blueprint.config || {}),
    ]
  );
  return rows[0];
}

/**
 * Which of a blueprint's steps the agent is not currently authorised to perform.
 *
 * The runtime would refuse them at run time with a `skipped` action, which is
 * correct but only discoverable after the fact. Reporting it up front turns a
 * confusing silence into an explicit "grant this, or remove the step".
 */
/**
 * Which of a set of tool names are not read-only — i.e. the actions an agent
 * given those tools would need authority for. An empty list means the agent was
 * given the whole catalogue, so it needs authority for every writing tool in it.
 */
async function writeToolsAmong(toolNames) {
  const catalog = require('../ai/toolCatalog');
  const tools = await catalog.listTools({ role: 'ADMIN' });
  const names = Array.isArray(toolNames) ? toolNames : [];
  const considered = names.length ? tools.filter((t) => names.includes(t.name)) : tools;
  return considered.filter((t) => !t.readOnly).map((t) => t.name);
}

async function authorityGaps(blueprint) {
  const { rows } = await pool.query(
    'SELECT authority, mode, enabled FROM agent_definitions WHERE agent_key = $1',
    [blueprint.agent_key]
  );
  const definition = rows[0];
  if (!definition) return { missing_actions: [], mode: null, enabled: false };

  const required = blueprint.kind === 'ai'
    ? await writeToolsAmong(blueprint.allowed_tools)
    : await blueprintRunner.writeActionsOf(blueprint.steps);
  const allowed = Array.isArray(definition.authority?.allowed_actions) ? definition.authority.allowed_actions : [];
  return {
    required_actions: required,
    missing_actions: required.filter((a) => !allowed.includes(a)),
    mode: definition.mode,
    enabled: definition.enabled,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function snapshot(client, blueprint, note, userId) {
  await client.query(
    `INSERT INTO agent_blueprint_versions (blueprint_id, version, snapshot, note, created_by)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (blueprint_id, version) DO NOTHING`,
    [blueprint.id, blueprint.version, JSON.stringify(blueprint), note || null, userId || null]
  );
}

async function createBlueprint(input, userId) {
  await validate(input);

  const existing = await getBlueprint(input.agent_key);
  if (existing) throw new Error(`An agent with the key "${input.agent_key}" already exists.`);

  // A blueprint key must not collide with a code-defined agent, or the runtime
  // would have two candidate implementations for one key.
  const runtime = require('./runtime');
  if (runtime.getImplementation(input.agent_key)) {
    throw new Error(`"${input.agent_key}" is the key of a built-in agent. Choose a different key.`);
  }

  const { rows } = await pool.query(
    `INSERT INTO agent_blueprints
       (agent_key, display_name, description, domain, trigger_type, event_key, schedule_seconds,
        steps, config, config_schema, source_prompt, kind, goal, provider, model, effort,
        credential_id, allowed_tools, max_iterations, memory_enabled, escalation_rules,
        created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$22)
     RETURNING *`,
    [
      input.agent_key,
      String(input.display_name).slice(0, 160),
      input.description || null,
      input.domain || 'DATA',
      input.trigger_type || 'manual',
      input.event_key || null,
      input.trigger_type === 'schedule' ? Number(input.schedule_seconds) || null : null,
      JSON.stringify(input.steps || []),
      JSON.stringify(input.config || {}),
      JSON.stringify(input.config_schema || []),
      input.source_prompt || null,
      input.kind || 'pipeline',
      input.goal || null,
      input.provider || 'openai',
      input.model || null,
      input.effort || 'high',
      input.credential_id || null,
      Array.isArray(input.allowed_tools) ? input.allowed_tools : [],
      Number(input.max_iterations) || 20,
      input.memory_enabled !== false,
      JSON.stringify(input.escalation_rules || {}),
      userId || null,
    ]
  );

  const blueprint = rows[0];
  await snapshot(pool, blueprint, 'Created', userId);
  const definition = await syncDefinition(blueprint, { seedAuthority: true });
  return { blueprint, definition };
}

async function updateBlueprint(keyOrId, changes, userId) {
  const existing = await getBlueprint(keyOrId);
  if (!existing) throw new Error('Agent not found.');

  const merged = {
    agent_key: existing.agent_key, // renaming would orphan the definition and its history
    display_name: changes.display_name ?? existing.display_name,
    description: changes.description ?? existing.description,
    domain: changes.domain ?? existing.domain,
    trigger_type: changes.trigger_type ?? existing.trigger_type,
    event_key: changes.event_key ?? existing.event_key,
    schedule_seconds: changes.schedule_seconds ?? existing.schedule_seconds,
    steps: changes.steps ?? existing.steps,
    config: changes.config ?? existing.config,
    config_schema: changes.config_schema ?? existing.config_schema,
    kind: changes.kind ?? existing.kind,
    goal: changes.goal ?? existing.goal,
    provider: changes.provider ?? existing.provider,
    model: changes.model ?? existing.model,
    effort: changes.effort ?? existing.effort,
    credential_id: changes.credential_id === undefined ? existing.credential_id : changes.credential_id,
    allowed_tools: changes.allowed_tools ?? existing.allowed_tools,
    max_iterations: changes.max_iterations ?? existing.max_iterations,
    memory_enabled: changes.memory_enabled ?? existing.memory_enabled,
    escalation_rules: changes.escalation_rules ?? existing.escalation_rules,
  };
  await validate(merged);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await snapshot(client, existing, changes.note || 'Edited', userId);
    const { rows } = await client.query(
      `UPDATE agent_blueprints
          SET display_name = $2, description = $3, domain = $4, trigger_type = $5,
              event_key = $6, schedule_seconds = $7, steps = $8, config = $9, config_schema = $10,
              kind = $12, goal = $13, provider = $14, model = $15, effort = $16,
              credential_id = $17, allowed_tools = $18, max_iterations = $19,
              memory_enabled = $20, escalation_rules = $21,
              version = version + 1, updated_by = $11, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING *`,
      [
        existing.id, merged.display_name, merged.description, merged.domain, merged.trigger_type,
        merged.event_key, merged.trigger_type === 'schedule' ? Number(merged.schedule_seconds) || null : null,
        JSON.stringify(merged.steps), JSON.stringify(merged.config),
        JSON.stringify(merged.config_schema), userId || null,
        merged.kind, merged.goal, merged.provider, merged.model, merged.effort,
        merged.credential_id || null,
        Array.isArray(merged.allowed_tools) ? merged.allowed_tools : [],
        Number(merged.max_iterations) || 20,
        merged.memory_enabled !== false,
        JSON.stringify(merged.escalation_rules || {}),
      ]
    );
    await client.query('COMMIT');

    const blueprint = rows[0];
    await syncDefinition(blueprint);
    // The schedule lives on the definition, so a changed interval has to be
    // pushed there or the agent keeps running on the old cadence.
    if (blueprint.trigger_type === 'schedule') {
      await pool.query(
        'UPDATE agent_definitions SET schedule_seconds = $2, updated_at = CURRENT_TIMESTAMP WHERE agent_key = $1',
        [blueprint.agent_key, Number(blueprint.schedule_seconds) || null]
      );
    }
    return { blueprint, gaps: await authorityGaps(blueprint) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Update only the config values. Separated from updateBlueprint because tuning
 * a threshold is an everyday act and rewriting the steps is not — and the two
 * should not need the same level of care or the same permission story.
 */
async function updateConfig(keyOrId, config, userId) {
  const existing = await getBlueprint(keyOrId);
  if (!existing) throw new Error('Agent not found.');
  const { rows } = await pool.query(
    `UPDATE agent_blueprints SET config = $2, updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 RETURNING *`,
    [existing.id, JSON.stringify(config || {}), userId || null]
  );
  await pool.query(
    'UPDATE agent_definitions SET config = $2, updated_at = CURRENT_TIMESTAMP WHERE agent_key = $1',
    [existing.agent_key, JSON.stringify(config || {})]
  );
  return rows[0];
}

async function deleteBlueprint(keyOrId) {
  const existing = await getBlueprint(keyOrId);
  if (!existing) throw new Error('Agent not found.');
  const { rows } = await pool.query('SELECT enabled FROM agent_definitions WHERE agent_key = $1', [existing.agent_key]);
  if (rows[0]?.enabled) {
    throw new Error('Disable the agent before deleting it, so it cannot run while it is being removed.');
  }
  await pool.query('DELETE FROM agent_blueprints WHERE id = $1', [existing.id]);
  // The definition (and with it the run history) is left in place deliberately:
  // deleting the record of what an agent did is not part of deleting the agent.
  await pool.query('UPDATE agent_definitions SET enabled = false WHERE agent_key = $1', [existing.agent_key]);
  return { deleted: existing.agent_key };
}

async function listVersions(keyOrId) {
  const existing = await getBlueprint(keyOrId);
  if (!existing) throw new Error('Agent not found.');
  const { rows } = await pool.query(
    `SELECT v.id, v.version, v.note, v.created_at, v.snapshot, u.first_name || ' ' || u.last_name AS created_by_name
       FROM agent_blueprint_versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.blueprint_id = $1 ORDER BY v.version DESC`,
    [existing.id]
  );
  return rows;
}

async function rollbackBlueprint(keyOrId, version, userId) {
  const existing = await getBlueprint(keyOrId);
  if (!existing) throw new Error('Agent not found.');
  const { rows } = await pool.query(
    'SELECT snapshot FROM agent_blueprint_versions WHERE blueprint_id = $1 AND version = $2',
    [existing.id, Number(version)]
  );
  if (!rows.length) throw new Error(`Version ${version} not found for this agent.`);
  const snap = rows[0].snapshot;
  return updateBlueprint(existing.id, { ...snap, note: `Rolled back to version ${version}` }, userId);
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

function exportBlueprint(blueprint) {
  return {
    kind: 'qira.agent_blueprint',
    version: 1,
    agent: {
      agent_key: blueprint.agent_key,
      display_name: blueprint.display_name,
      description: blueprint.description,
      domain: blueprint.domain,
      trigger_type: blueprint.trigger_type,
      event_key: blueprint.event_key,
      schedule_seconds: blueprint.schedule_seconds,
      steps: blueprint.steps,
      config: blueprint.config,
      config_schema: blueprint.config_schema,
      kind: blueprint.kind,
      goal: blueprint.goal,
      provider: blueprint.provider,
      model: blueprint.model,
      effort: blueprint.effort,
      allowed_tools: blueprint.allowed_tools,
      max_iterations: blueprint.max_iterations,
      memory_enabled: blueprint.memory_enabled,
      escalation_rules: blueprint.escalation_rules,
      // credential_id is deliberately NOT exported: a credential is per
      // installation, so carrying a reference across systems would either
      // dangle or, worse, silently bind to a different key.
    },
  };
}

/**
 * Import an exported agent. It lands disabled in observe mode like any other
 * new agent — a definition arriving as JSON is not more trustworthy for having
 * been in a file, and the steps may reference tools this installation lacks
 * (which validate() will say plainly).
 */
async function importBlueprint(payload, userId) {
  const agent = payload?.agent || payload;
  if (!agent?.agent_key || (!Array.isArray(agent.steps) && !agent.goal)) {
    throw new Error('That does not look like an exported agent.');
  }
  let key = agent.agent_key;
  if (await getBlueprint(key)) {
    key = `${key}_imported`.slice(0, 80);
    if (await getBlueprint(key)) throw new Error(`Agents named "${agent.agent_key}" and "${key}" both already exist. Rename before importing.`);
  }
  return createBlueprint({ ...agent, agent_key: key }, userId);
}

module.exports = {
  listBlueprints,
  getBlueprint,
  blueprintKeys,
  createBlueprint,
  updateBlueprint,
  updateConfig,
  deleteBlueprint,
  listVersions,
  rollbackBlueprint,
  syncDefinition,
  authorityGaps,
  exportBlueprint,
  importBlueprint,
  validate,
  writeToolsAmong,
  DOMAINS,
  TRIGGERS,
  KINDS,
};
