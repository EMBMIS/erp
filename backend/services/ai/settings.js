/**
 * Global AI settings and per-tool configuration.
 *
 * Three things are configurable here, and the distinction between them matters:
 *
 *   1. How the assistant answers — model, response style, step budget. Taste.
 *   2. Which tools exist for whom — enable/disable, minimum role. Access.
 *   3. What a tool assumes when it is not told — per-tool defaults. Behaviour.
 *
 * (3) is the subtle one. Defaults are merged UNDER the model's arguments, never
 * over them. A configured default is a starting point for a call the model made
 * without specifying much; silently overwriting an argument the model *did*
 * choose would make tool results disagree with the reasoning that requested
 * them, and that failure is invisible in the transcript.
 *
 * Settings are cached briefly. Every chat turn reads them, so a query per turn
 * is not acceptable — but a config change must reach other instances without a
 * restart, so the cache expires rather than living forever.
 */

const { pool } = require('../../config/database');
const { AI_MODEL } = require('../../config/aiConfig');

const CACHE_TTL_MS = 15_000;

// Role ladder used for `min_role`. Mirrors middleware/auth.js, where MANAGER and
// ADMIN carry finance authority: a FINANCE_MANAGER sits above ordinary finance
// staff but below general management.
const ROLE_RANK = {
  USER: 0,
  FINANCE_USER: 1,
  FINANCE_MANAGER: 2,
  MANAGER: 3,
  ADMIN: 4,
};

const AGENT_MODE_RANK = { manual: 0, accept_edits: 1, auto: 2, bypass: 3 };

const RESPONSE_STYLE_PROMPTS = {
  concise: 'Answer in as few words as the question allows. Lead with the number or the decision; add context only if it changes what the reader should do.',
  balanced: '',
  detailed: 'Explain your reasoning and show the intermediate figures you used, so the reader can check the result rather than take it on trust.',
};

let settingsCache = { at: 0, value: null };
let toolCache = { at: 0, value: null };

function invalidate() {
  settingsCache = { at: 0, value: null };
  toolCache = { at: 0, value: null };
}

const MAX_STEP_CEILING = 200;

const DEFAULTS = {
  model: null,
  response_style: 'balanced',
  default_agent_mode: 'accept_edits',
  // 8 was too low for real work: an investigation that reads receivables,
  // compares periods, resolves a customer and draws a chart is already five
  // steps before it has said anything. 24 is a working default; the ceiling
  // below is what an operator may raise it to.
  max_steps: 24,
  role_permissions: {},
  extra: {},
};

async function getSettings() {
  if (settingsCache.value && Date.now() - settingsCache.at < CACHE_TTL_MS) return settingsCache.value;
  let value = DEFAULTS;
  try {
    const { rows } = await pool.query('SELECT * FROM ai_settings WHERE id = true');
    if (rows[0]) value = { ...DEFAULTS, ...rows[0] };
  } catch (err) {
    // Migration 117 may not have run yet. Falling back to the code defaults
    // keeps the assistant working instead of taking the whole chat surface down
    // over a settings table.
    if (!/relation .*ai_settings.* does not exist/i.test(err.message)) throw err;
  }
  settingsCache = { at: Date.now(), value };
  return value;
}

async function updateSettings(patch = {}, userId) {
  const sets = [];
  const params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (patch.model !== undefined) add('model', patch.model || null);
  if (patch.response_style !== undefined) {
    if (!RESPONSE_STYLE_PROMPTS[patch.response_style]  && patch.response_style !== 'balanced') {
      throw new Error(`Unknown response style "${patch.response_style}".`);
    }
    add('response_style', patch.response_style);
  }
  if (patch.default_agent_mode !== undefined) {
    if (!(patch.default_agent_mode in AGENT_MODE_RANK)) throw new Error(`Unknown agent mode "${patch.default_agent_mode}".`);
    add('default_agent_mode', patch.default_agent_mode);
  }
  if (patch.max_steps !== undefined) {
    // Ceiling raised from 30 to MAX_STEP_CEILING. Not unlimited, and that is
    // deliberate: the bound is what stops a model that has decided to keep
    // calling one tool from spending real money in a loop nobody is watching.
    // A run that legitimately needs more than this can be continued by the
    // person — see the step-limit result in agent.js, which is resumable.
    add('max_steps', Math.min(Math.max(Number(patch.max_steps) || DEFAULTS.max_steps, 1), MAX_STEP_CEILING));
  }
  if (patch.role_permissions !== undefined) add('role_permissions', JSON.stringify(patch.role_permissions || {}));
  if (patch.extra !== undefined) add('extra', JSON.stringify(patch.extra || {}));
  if (!sets.length) throw new Error('Nothing to update.');

  params.push(userId || null);
  sets.push(`updated_by = $${params.length}`, 'updated_at = CURRENT_TIMESTAMP');

  // The row being updated may not exist yet. Migration 117 seeded a single
  // global row; migration 140 re-scoped the table per company, and a company
  // that has never saved settings has no row at all. A plain UPDATE then
  // matches nothing, returns no rows, and the route reports success anyway —
  // which is how a setting looks like it changed until the next page load
  // brings the old value back. So this is an upsert: the first save for a
  // company creates its row, later saves update it. company_id comes from the
  // column DEFAULT (current_company_id(), i.e. the request's own company),
  // which is also what lets the RLS WITH CHECK pass.
  const submittedCols = sets.map((s) => s.slice(0, s.indexOf(' ')));
  const submittedSet = new Set(submittedCols);
  // On INSERT, settings the patch does not mention take the code defaults
  // above rather than the schema's column defaults (max_steps is 8 in the
  // table, 24 in DEFAULTS) — otherwise a partial save — say, permissions
  // only — would quietly cut the assistant's step budget. ON CONFLICT below
  // only touches the submitted columns, so an update never resets anything
  // it was not asked about.
  const fill = [];
  for (const [col, val] of Object.entries(DEFAULTS)) {
    if (submittedSet.has(col)) continue;
    params.push(val && typeof val === 'object' ? JSON.stringify(val) : val);
    fill.push(col);
  }
  // updated_at is a literal (CURRENT_TIMESTAMP) with no $n placeholder, so it
  // must stay last in the column list or every later param shifts by one.
  const insertCols = [...submittedCols.filter((c) => c !== 'updated_at'), ...fill, 'updated_at'];
  const values = params.map((_, i) => `$${i + 1}`);
  const conflictCols = submittedCols.filter((c) => c !== 'updated_at');
  const { rows } = await pool.query(
    `INSERT INTO ai_settings (id, ${insertCols.join(', ')})
     VALUES (true${values.length ? `, ${values.join(', ')}` : ''}, CURRENT_TIMESTAMP)
     ON CONFLICT (company_id) DO UPDATE SET
       ${conflictCols
         .map((c) => (c === 'updated_at' ? 'updated_at = CURRENT_TIMESTAMP' : `${c} = EXCLUDED.${c}`))
         .join(', ')}
     RETURNING *`,
    params
  );
  invalidate();
  return rows[0];
}

/** The model to use: an explicit UI override, otherwise the deployment default. */
async function resolveModel() {
  const s = await getSettings();
  return s.model || AI_MODEL;
}

/** Style guidance appended to the agent's system prompt. Empty for 'balanced'. */
async function styleInstruction() {
  const s = await getSettings();
  return RESPONSE_STYLE_PROMPTS[s.response_style] || '';
}

/**
 * The highest agent mode a role may use. An operator can stop ordinary users
 * from putting the assistant in a mode that runs writes without confirmation,
 * without having to disable the assistant for them.
 */
async function clampAgentMode(requestedMode, role) {
  const s = await getSettings();
  const ceilingName = (s.role_permissions || {})[role];
  if (!ceilingName || !(ceilingName in AGENT_MODE_RANK)) return requestedMode;
  const requested = AGENT_MODE_RANK[requestedMode];
  if (requested === undefined) return requestedMode;
  if (requested <= AGENT_MODE_RANK[ceilingName]) return requestedMode;
  return ceilingName;
}

// ---------------------------------------------------------------------------
// Per-tool settings
// ---------------------------------------------------------------------------

async function getToolSettings() {
  if (toolCache.value && Date.now() - toolCache.at < CACHE_TTL_MS) return toolCache.value;
  const map = new Map();
  try {
    const { rows } = await pool.query('SELECT * FROM ai_tool_settings');
    rows.forEach((r) => map.set(r.tool_name, r));
  } catch (err) {
    if (!/relation .*ai_tool_settings.* does not exist/i.test(err.message)) throw err;
  }
  toolCache = { at: Date.now(), value: map };
  return map;
}

async function listToolSettings() {
  const map = await getToolSettings();
  return [...map.values()];
}

async function upsertToolSetting(toolName, { enabled, defaults, min_role, auto_approve }, userId) {
  if (min_role && !(min_role in ROLE_RANK)) throw new Error(`Unknown role "${min_role}".`);
  const { rows } = await pool.query(
    `INSERT INTO ai_tool_settings (tool_name, enabled, defaults, min_role, auto_approve, updated_by)
     VALUES ($1, COALESCE($2, true), COALESCE($3, '{}'::jsonb), $4, COALESCE($5, false), $6)
     ON CONFLICT (tool_name) DO UPDATE
       SET enabled      = COALESCE($2, ai_tool_settings.enabled),
           defaults     = COALESCE($3, ai_tool_settings.defaults),
           min_role     = $4,
           auto_approve = COALESCE($5, ai_tool_settings.auto_approve),
           updated_by   = $6,
           updated_at   = CURRENT_TIMESTAMP
     RETURNING *`,
    [
      toolName,
      enabled === undefined ? null : !!enabled,
      defaults === undefined ? null : JSON.stringify(defaults),
      min_role || null,
      auto_approve === undefined ? null : !!auto_approve,
      userId || null,
    ]
  );
  invalidate();
  return rows[0];
}

/**
 * Remember (or forget) that a tool may run without asking.
 *
 * Deliberately its own function rather than a flag on upsertToolSetting's
 * general path: this is the one setting a normal user changes mid-conversation,
 * by clicking "Always allow" on a confirmation, and it must not be able to
 * disturb enabled/min_role/defaults as a side effect of that click.
 */
async function setAutoApprove(toolName, autoApprove, userId) {
  const { rows } = await pool.query(
    `INSERT INTO ai_tool_settings (tool_name, auto_approve, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (tool_name) DO UPDATE
       SET auto_approve = $2, updated_by = $3, updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [toolName, !!autoApprove, userId || null]
  );
  invalidate();
  return rows[0];
}

/** Is this tool available to a caller with this role? Absent settings = yes. */
function isToolAvailable(setting, role) {
  if (!setting) return true;
  if (setting.enabled === false) return false;
  if (!setting.min_role) return true;
  return (ROLE_RANK[role] ?? -1) >= ROLE_RANK[setting.min_role];
}

/** Merge configured defaults UNDER the caller's arguments. Never over them. */
function applyDefaults(setting, args = {}) {
  const defaults = setting?.defaults;
  if (!defaults || typeof defaults !== 'object') return args;
  const merged = { ...defaults };
  for (const [k, v] of Object.entries(args || {})) {
    if (v !== undefined && v !== null && v !== '') merged[k] = v;
  }
  return merged;
}

module.exports = {
  MAX_STEP_CEILING,
  getSettings,
  updateSettings,
  resolveModel,
  styleInstruction,
  clampAgentMode,
  getToolSettings,
  listToolSettings,
  upsertToolSetting,
  setAutoApprove,
  isToolAvailable,
  applyDefaults,
  invalidate,
  ROLE_RANK,
  AGENT_MODE_RANK,
  RESPONSE_STYLE_PROMPTS,
};
