/**
 * Custom AI tools — the tool builder's storage, versioning and execution.
 *
 * A custom tool is a row in `ai_tools` whose `implementation` is a JavaScript
 * function body. Once saved it is indistinguishable to the model from a
 * built-in: it appears in the same flat namespace, with the same schema shape,
 * available to the chat agent, the MCP server and to agent blueprints.
 *
 * The capability envelope is fixed by design and is not per-tool configurable
 * upward:
 *
 *   erp.sql(text, params)      read-only SQL through the nlQuery gauntlet —
 *                              single SELECT, table allowlist, READ ONLY
 *                              transaction, statement timeout, row cap.
 *   erp.callTool(name, args)   built-in tools this tool was explicitly allowed
 *                              to call, and only READ-ONLY ones.
 *   erp.log(...)               captured for the test panel and the audit trail.
 *
 * So a custom tool can compute, summarise and reshape, but it cannot write.
 * That is the point: authoring code and changing the ledger are two different
 * grants. Composition that writes belongs in an agent blueprint, where the
 * authority engine decides what may happen unattended.
 */

const { pool } = require('../../config/database');
const { runSandboxed, lintToolCode, DEFAULT_TIMEOUT_MS } = require('./sandbox');

const NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

// ---------------------------------------------------------------------------
// Cache. Every model turn asks for the tool list, so this must not be a query
// per turn — but a tool edited on one instance has to reach the others, hence a
// short TTL rather than an in-process-forever cache.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 10_000;
let cache = { at: 0, rows: [] };

function invalidate() {
  cache = { at: 0, rows: [] };
}

async function loadEnabled() {
  if (Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  const { rows } = await pool.query(
    `SELECT id, name, display_name, description, input_schema, output_schema, implementation,
            timeout_ms, allowed_tools, allow_sql, version
       FROM ai_tools WHERE enabled = true ORDER BY name`
  );
  cache = { at: Date.now(), rows };
  return rows;
}

// ---------------------------------------------------------------------------
// Capabilities handed to the sandbox
// ---------------------------------------------------------------------------

/**
 * Read-only SQL. Reuses nlQuery's validator rather than inventing a second one:
 * a tool author and a language model are both untrusted sources of SQL, and
 * having two allowlists that can drift apart would be worse than either.
 */
async function sqlCapability(text, params) {
  const { validateSql, runReadOnly } = require('./nlQuery');
  const validation = validateSql(String(text || ''));
  if (!validation.ok) throw new Error(`Query rejected: ${validation.reason}`);
  const safeParams = Array.isArray(params) ? params.slice(0, 32) : [];
  return runReadOnly(validation.sql, safeParams);
}

/**
 * Call a built-in tool. Deny-by-default twice over: the tool must be in this
 * custom tool's own allowlist, AND it must be read-only. The second check is
 * what stops an allowlist written today from silently granting write authority
 * if a built-in tool's implementation gains side effects later.
 */
function callToolCapability(allowedTools, ctx) {
  const allowed = new Set(Array.isArray(allowedTools) ? allowedTools : []);
  return async (name, args) => {
    const { byName, executeTool } = require('./toolRegistry');
    const target = byName.get(name);
    if (!target) throw new Error(`Unknown tool "${name}".`);
    if (!allowed.has(name)) {
      throw new Error(
        `This tool is not permitted to call "${name}". Add it to the tool's allowed tools first.`
      );
    }
    if (!target.readOnly) {
      throw new Error(`"${name}" changes data, and a custom tool may only call read-only tools.`);
    }
    return executeTool(name, args || {}, { ...ctx, actor: ctx?.actor || 'custom-tool' });
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function runToolRow(row, args, ctx = {}) {
  const outcome = await runSandboxed({
    code: row.implementation,
    input: args || {},
    timeoutMs: row.timeout_ms || DEFAULT_TIMEOUT_MS,
    capabilities: {
      sql: row.allow_sql === false ? undefined : sqlCapability,
      callTool: callToolCapability(row.allowed_tools, ctx),
    },
  });

  // Health counters, best-effort: a tool that always fails should be visible on
  // the tool library page without anyone reading logs, but bookkeeping must not
  // turn a working call into a failed one.
  pool
    .query(
      `UPDATE ai_tools
          SET run_count = run_count + 1,
              error_count = error_count + CASE WHEN $2 THEN 0 ELSE 1 END,
              last_run_at = CURRENT_TIMESTAMP,
              last_error = CASE WHEN $2 THEN NULL ELSE $3 END
        WHERE id = $1`,
      [row.id, outcome.ok, outcome.error || null]
    )
    .catch(() => {});

  if (!outcome.ok) throw new Error(outcome.error || 'The custom tool failed.');
  return outcome.logs.length ? { ...wrapResult(outcome.result), _log: outcome.logs } : wrapResult(outcome.result);
}

// A tool may legitimately return a scalar or an array; the model's tool-result
// channel is easier to read when everything is an object.
function wrapResult(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  return { result };
}

/**
 * Every enabled custom tool, in the same shape as a built-in tool definition so
 * the catalogue can concatenate the two lists without special-casing.
 */
async function listRuntimeTools() {
  const rows = await loadEnabled();
  return rows.map((row) => ({
    name: row.name,
    description: row.description,
    readOnly: true, // structurally true: the sandbox has no write capability
    custom: true,
    version: row.version,
    inputSchema: row.input_schema || { type: 'object', properties: {} },
    outputSchema: row.output_schema || null,
    handler: (args, ctx) => runToolRow(row, args, ctx),
  }));
}

// ---------------------------------------------------------------------------
// CRUD + versioning
// ---------------------------------------------------------------------------

async function listTools({ includeDisabled = true } = {}) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.display_name, t.description, t.input_schema, t.output_schema,
            t.implementation, t.enabled, t.timeout_ms, t.allowed_tools, t.allow_sql, t.version,
            t.run_count, t.error_count, t.last_run_at, t.last_error, t.created_at, t.updated_at,
            u.first_name || ' ' || u.last_name AS created_by_name
       FROM ai_tools t
       LEFT JOIN users u ON u.id = t.created_by
      ${includeDisabled ? '' : 'WHERE t.enabled = true'}
      ORDER BY t.name`
  );
  return rows;
}

async function getTool(idOrName) {
  const { rows } = await pool.query(
    `SELECT * FROM ai_tools WHERE ${isUuid(idOrName) ? 'id = $1' : 'name = $1'}`,
    [idOrName]
  );
  return rows[0] || null;
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
}

/**
 * Validate everything a tool needs to be safe to save. Returns the normalised
 * fields, or throws with a message an author can act on.
 */
function validateDefinition({ name, description, input_schema, implementation, timeout_ms, allowed_tools, allow_sql }) {
  if (!NAME_PATTERN.test(String(name || ''))) {
    throw new Error('A tool name must be lowercase letters, digits and underscores, 3-64 characters, starting with a letter.');
  }
  // The built-in registry is the authority on collisions — two tools with one
  // name would make which implementation runs depend on list ordering.
  const { byName } = require('./toolRegistry');
  if (byName.has(name)) {
    throw new Error(`"${name}" is the name of a built-in tool. Choose a different name.`);
  }
  if (!description || String(description).trim().length < 10) {
    throw new Error('Describe what the tool does in at least a sentence — the model uses this text to decide when to call it.');
  }

  const schema = input_schema || { type: 'object', properties: {} };
  if (typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') {
    throw new Error('The input schema must be a JSON Schema object with "type": "object".');
  }

  const lint = lintToolCode(implementation);
  if (!lint.ok) throw new Error(lint.problems.join(' '));

  // Reject an allowlist entry that can never work, at save time rather than at
  // call time inside an unattended run.
  const requested = Array.isArray(allowed_tools) ? [...new Set(allowed_tools.map(String))] : [];
  for (const toolName of requested) {
    const target = byName.get(toolName);
    if (!target) throw new Error(`"${toolName}" is not a built-in tool, so it cannot be allowed.`);
    if (!target.readOnly) throw new Error(`"${toolName}" changes data. A custom tool may only be allowed to call read-only tools.`);
  }

  return {
    name: String(name),
    description: String(description).trim(),
    input_schema: schema,
    implementation: String(implementation),
    timeout_ms: Math.min(Math.max(Number(timeout_ms) || DEFAULT_TIMEOUT_MS, 100), 30000),
    allowed_tools: requested,
    allow_sql: allow_sql !== false,
  };
}

async function snapshotVersion(client, tool, note, userId) {
  await client.query(
    `INSERT INTO ai_tool_versions (tool_id, version, snapshot, note, created_by)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tool_id, version) DO NOTHING`,
    [
      tool.id,
      tool.version,
      JSON.stringify({
        name: tool.name,
        display_name: tool.display_name,
        description: tool.description,
        input_schema: tool.input_schema,
        output_schema: tool.output_schema,
        implementation: tool.implementation,
        timeout_ms: tool.timeout_ms,
        allowed_tools: tool.allowed_tools,
        allow_sql: tool.allow_sql,
      }),
      note || null,
      userId || null,
    ]
  );
}

async function createTool(definition, userId) {
  const v = validateDefinition(definition);
  const { rows } = await pool.query(
    `INSERT INTO ai_tools
       (name, display_name, description, input_schema, output_schema, implementation,
        timeout_ms, allowed_tools, allow_sql, enabled, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
     RETURNING *`,
    [
      v.name,
      definition.display_name || null,
      v.description,
      JSON.stringify(v.input_schema),
      definition.output_schema ? JSON.stringify(definition.output_schema) : null,
      v.implementation,
      v.timeout_ms,
      v.allowed_tools,
      v.allow_sql,
      definition.enabled !== false,
      userId || null,
    ]
  );
  const tool = rows[0];
  await snapshotVersion(pool, tool, 'Created', userId);
  invalidate();
  return tool;
}

async function updateTool(idOrName, changes, userId) {
  const existing = await getTool(idOrName);
  if (!existing) throw new Error('Tool not found.');

  const merged = validateDefinition({
    name: changes.name ?? existing.name,
    description: changes.description ?? existing.description,
    input_schema: changes.input_schema ?? existing.input_schema,
    implementation: changes.implementation ?? existing.implementation,
    timeout_ms: changes.timeout_ms ?? existing.timeout_ms,
    allowed_tools: changes.allowed_tools ?? existing.allowed_tools,
    allow_sql: changes.allow_sql ?? existing.allow_sql,
  });

  // Renaming is allowed but must not collide with another custom tool.
  if (merged.name !== existing.name) {
    const clash = await getTool(merged.name);
    if (clash) throw new Error(`A tool named "${merged.name}" already exists.`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Snapshot the OUTGOING revision, so version N in history is what version N
    // actually was — not what replaced it.
    await snapshotVersion(client, existing, changes.note || 'Edited', userId);
    const { rows } = await client.query(
      `UPDATE ai_tools
          SET name = $2, display_name = $3, description = $4, input_schema = $5,
              output_schema = $6, implementation = $7, timeout_ms = $8,
              allowed_tools = $9, allow_sql = $10, enabled = $11,
              version = version + 1, updated_by = $12, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING *`,
      [
        existing.id,
        merged.name,
        changes.display_name ?? existing.display_name,
        merged.description,
        JSON.stringify(merged.input_schema),
        changes.output_schema ? JSON.stringify(changes.output_schema) : existing.output_schema,
        merged.implementation,
        merged.timeout_ms,
        merged.allowed_tools,
        merged.allow_sql,
        changes.enabled === undefined ? existing.enabled : !!changes.enabled,
        userId || null,
      ]
    );
    await client.query('COMMIT');
    invalidate();
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function setEnabled(idOrName, enabled, userId) {
  const existing = await getTool(idOrName);
  if (!existing) throw new Error('Tool not found.');
  const { rows } = await pool.query(
    `UPDATE ai_tools SET enabled = $2, updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 RETURNING *`,
    [existing.id, !!enabled, userId || null]
  );
  invalidate();
  return rows[0];
}

async function deleteTool(idOrName) {
  const existing = await getTool(idOrName);
  if (!existing) throw new Error('Tool not found.');
  // Refuse to orphan a blueprint step. A tool vanishing mid-schedule turns into
  // a failing agent at 3am, which is a worse outcome than a refused delete.
  const { rows } = await pool.query(
    `SELECT agent_key, display_name FROM agent_blueprints
      WHERE steps::text LIKE '%"' || $1 || '"%'`,
    [existing.name]
  );
  if (rows.length) {
    throw new Error(
      `This tool is used by ${rows.length} agent(s): ${rows.map((r) => r.display_name).join(', ')}. Remove those steps first, or disable the tool instead of deleting it.`
    );
  }
  await pool.query('DELETE FROM ai_tools WHERE id = $1', [existing.id]);
  invalidate();
  return { deleted: existing.name };
}

async function listVersions(idOrName) {
  const existing = await getTool(idOrName);
  if (!existing) throw new Error('Tool not found.');
  const { rows } = await pool.query(
    `SELECT v.id, v.version, v.note, v.created_at, v.snapshot, u.first_name || ' ' || u.last_name AS created_by_name
       FROM ai_tool_versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.tool_id = $1 ORDER BY v.version DESC`,
    [existing.id]
  );
  return rows;
}

/** Restore a previous revision. Forward-only: the rollback is itself a new version. */
async function rollbackTool(idOrName, version, userId) {
  const existing = await getTool(idOrName);
  if (!existing) throw new Error('Tool not found.');
  const { rows } = await pool.query(
    'SELECT snapshot FROM ai_tool_versions WHERE tool_id = $1 AND version = $2',
    [existing.id, Number(version)]
  );
  if (!rows.length) throw new Error(`Version ${version} not found for this tool.`);
  const snap = rows[0].snapshot;
  return updateTool(existing.id, { ...snap, note: `Rolled back to version ${version}` }, userId);
}

/**
 * Run a tool body without saving it. This is what makes the builder honest —
 * the author sees exactly what their code returns, and what it read to get
 * there, before it becomes something the AI may call unattended.
 */
async function testTool({ implementation, input, timeout_ms, allowed_tools, allow_sql }, ctx = {}) {
  const lint = lintToolCode(implementation);
  if (!lint.ok) return { ok: false, error: lint.problems.join(' '), logs: [] };

  return runSandboxed({
    code: implementation,
    input: input || {},
    timeoutMs: timeout_ms || DEFAULT_TIMEOUT_MS,
    capabilities: {
      sql: allow_sql === false ? undefined : sqlCapability,
      callTool: callToolCapability(allowed_tools || [], ctx),
    },
  });
}

module.exports = {
  listRuntimeTools,
  listTools,
  getTool,
  createTool,
  updateTool,
  setEnabled,
  deleteTool,
  listVersions,
  rollbackTool,
  testTool,
  validateDefinition,
  invalidate,
  NAME_PATTERN,
};
