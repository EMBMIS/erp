/**
 * Unified AI tool catalogue.
 *
 * services/ai/toolRegistry.js remains the source of truth for BUILT-IN tools —
 * the ones whose implementations are code and are reviewed like code. This
 * module is the layer above it, and it is what every AI surface should call:
 *
 *   built-in tools  +  user-authored tools (ai_tools)  +  configuration
 *
 * Configuration means three things, applied in this order:
 *
 *   1. Availability. A tool disabled globally, or restricted to a role above
 *      the caller's, is not merely refused when called — it is absent from the
 *      list handed to the model. A model that cannot see a tool does not spend
 *      a turn calling it and apologising.
 *   2. Defaults. Global per-tool defaults, then per-agent overrides, merged
 *      UNDER the caller's arguments (see services/ai/settings.js for why).
 *   3. Audit. Every call, built-in or custom, lands in ai_audit_log through the
 *      same path, so "what has the AI been doing" has one answer and not two.
 *
 * A custom tool cannot shadow a built-in: the name is rejected at save time,
 * so no ordering rule decides which implementation runs.
 */

const builtin = require('./toolRegistry');
const customTools = require('./customTools');
const settings = require('./settings');
const moduleService = require('../moduleService');
// Lazily required: mcpTools → mcpClient → credentialVault, and this module is
// itself required from deep inside that graph. Same reasoning as the lazy
// `catalog()` in blueprintRunner.js — require is cached, so this costs nothing
// per call and removes any dependence on load order.
const mcpTools = () => require('./mcpTools');
const connectorTools = () => require('./connectorTools');

/**
 * Which toggleable module (see backend/services/moduleService.js) a built-in
 * tool belongs to. Only tools tied to a NON-core, toggleable module need an
 * entry — everything else (finance, reporting, admin, findings, forecasting,
 * generic query/document tools) is core and always available. A company that
 * has turned Manufacturing off should not have an AI that can still call
 * run_mrp — the point of turning a module off is that it stops existing for
 * that company, not just stops appearing in the nav.
 */
const TOOL_MODULE = {
  // Manufacturing
  list_work_orders: 'manufacturing',
  explode_bill_of_material: 'manufacturing',
  run_mrp: 'manufacturing',
  watch_production_lines: 'manufacturing',
  recommend_reorder_points: 'manufacturing',
  predict_inventory_reorders: 'manufacturing',
  // Inventory
  list_low_stock_items: 'inventory',
  list_in_transit_transfers: 'inventory',
  read_warehouse_twin: 'inventory',
  plan_replenishment: 'inventory',
  record_stocktake_count: 'inventory',
  run_reorder_check: 'inventory',
  search_similar_inventory_items: 'inventory',
  // Procurement
  list_purchase_orders: 'procurement',
  monitor_supplier_risk: 'procurement',
  recall_supplier_precedent: 'procurement',
  create_purchase_requisition_draft: 'procurement',
  create_rfq_draft: 'procurement',
  explain_spend: 'procurement',
  prepare_spend_follow_ups: 'procurement',
  get_purchase_order_pdf_link: 'procurement',
  search_similar_purchase_orders: 'procurement',
  // Sales
  list_sales_orders: 'sales',
  explain_delivery_risk: 'sales',
  explain_revenue: 'sales',
  prepare_revenue_follow_ups: 'sales',
  show_order_chain: 'sales',
  check_delivery_promise: 'sales',
  list_orders_landed_short: 'sales',
  draft_order_watch_purchase_order: 'procurement',
  plan_delivery_recovery: 'sales',
  approve_delivery_recovery: 'sales',
  list_sales_contracts: 'sales',
  list_sales_quotations: 'sales',
  list_sales_rfqs: 'sales',
  search_similar_sales_orders: 'sales',
  search_customers: 'sales',
  // HR
  list_employees: 'hr',
  get_payroll_summary: 'hr',
  // CRM — a company that has turned CRM off should not have an AI that can
  // still read its pipeline, for the same reason the nav entry disappears.
  list_deals: 'crm',
  get_deal: 'crm',
  get_deal_history: 'crm',
  get_sales_pipeline: 'crm',
  search_contacts: 'crm',
  list_crm_activities: 'crm',
  create_crm_activity: 'crm',
  move_deal_stage: 'crm',
  // Projects
  list_projects: 'projects',
  get_project: 'projects',
  get_project_profitability: 'projects',
  get_project_budget: 'projects',
  list_time_entries: 'projects',
  preview_project_billing: 'projects',
  get_project_milestones: 'projects',
  get_resource_load: 'projects',
  create_project_task: 'projects',
  log_time_entry: 'projects',
  // Sales and procurement writes follow their module too.
  create_sales_quotation_draft: 'sales',
  create_purchase_order_draft: 'procurement',
};

/** True if this tool's module (if any) is enabled for the company. No company context or no mapped module: always available. */
async function isModuleAvailable(toolName, companyId) {
  const moduleKey = TOOL_MODULE[toolName];
  if (!moduleKey || !companyId) return true;
  const enabled = await moduleService.getEnabledModuleKeys(companyId);
  return enabled.has(moduleKey);
}

/**
 * The setting to gate a tool by: an explicit ai_tool_settings row always wins
 * (that is how an operator overrides or lifts a default), but a tool with no
 * row at all still falls back to its own built-in `min_role` — e.g. the
 * handful of highImpact tools (run_findings_scan, email_document, ...) that
 * ship gated to MANAGER+ without requiring a database row to be seeded first.
 */
function effectiveSetting(tool, dbSetting) {
  if (dbSetting) return dbSetting;
  return tool.min_role ? { min_role: tool.min_role } : null;
}

/**
 * Every tool the caller may use: built-in, user-authored, and MCP-backed.
 *
 * @param {object} ctx { role, companyId, includeUnavailable }
 */
async function listTools(ctx = {}) {
  const [custom, mcp, connected, toolSettings, enabledModules] = await Promise.all([
    customTools.listRuntimeTools().catch((err) => {
      // A broken/absent ai_tools table must not remove the built-in tools from
      // the assistant. Losing custom tools degrades it; losing all of them
      // breaks it, and the second failure is much harder to diagnose from the
      // chat window.
      console.error('Could not load custom AI tools:', err.message);
      return [];
    }),
    mcpTools().listRuntimeTools().catch((err) => {
      // Same reasoning: an unreachable or misconfigured MCP connection must
      // not take the rest of the assistant's tools down with it.
      console.error('Could not load MCP tools:', err.message);
      return [];
    }),
    connectorTools().listRuntimeTools().catch((err) => {
      console.error('Could not load connector tools:', err.message);
      return [];
    }),
    settings.getToolSettings(),
    // No companyId (e.g. the MCP server, which isn't a per-tenant surface in
    // the same way) means no module filtering — null, not an empty set, so
    // moduleEnabled() below treats it as "don't gate by module."
    ctx.companyId ? moduleService.getEnabledModuleKeys(ctx.companyId).catch(() => null) : Promise.resolve(null),
  ]);

  const moduleEnabled = (t) => !enabledModules || !TOOL_MODULE[t.name] || enabledModules.has(TOOL_MODULE[t.name]);

  const all = [...builtin.tools, ...custom, ...mcp, ...connected];
  if (ctx.includeUnavailable) {
    return all.map((t) => {
      const setting = effectiveSetting(t, toolSettings.get(t.name));
      return { ...t, setting, available: settings.isToolAvailable(setting, ctx.role) && moduleEnabled(t) };
    });
  }
  return all.filter((t) => settings.isToolAvailable(effectiveSetting(t, toolSettings.get(t.name)), ctx.role) && moduleEnabled(t));
}

/** OpenAI-compatible specs for the tools this caller may use. */
async function getOpenAITools(ctx = {}) {
  const tools = await listTools(ctx);
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/**
 * MCP-compatible specs, for the server in mcp/server.js that exposes THIS
 * ERP's tools to an external MCP client (Claude Desktop and the like).
 *
 * Tools that came FROM a connected third-party MCP server are deliberately
 * excluded. That server calls executeTool directly with no confirmation step —
 * it is a machine-to-machine surface with no human in the loop — so re-exporting
 * someone else's tools through it would let an external client invoke them
 * without the approval every other path enforces. An external client that wants
 * Stripe's tools can connect to Stripe's MCP server itself; it does not need
 * this ERP to proxy them, and proxying is precisely what would strip the gate.
 */
async function getMcpTools(ctx = {}) {
  const tools = await listTools(ctx);
  return tools
    .filter((t) => !t.mcp)
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      readOnly: t.readOnly,
      custom: !!t.custom,
    }));
}

/** Look one tool up by name, built-in, custom, or MCP-backed. */
async function resolve(name) {
  const found = builtin.byName.get(name);
  if (found) return found;
  const custom = await customTools.listRuntimeTools();
  const fromCustom = custom.find((t) => t.name === name);
  if (fromCustom) return fromCustom;
  // Cheap to skip entirely for the overwhelmingly common case: both outside
  // sources carry a name prefix, so an ordinary name never touches the database.
  if (mcpTools().isMcpToolName(name)) {
    const mcp = await mcpTools().listRuntimeTools();
    return mcp.find((t) => t.name === name) || null;
  }
  if (connectorTools().isConnectorToolName(name)) {
    const connected = await connectorTools().listRuntimeTools();
    return connected.find((t) => t.name === name) || null;
  }
  return null;
}

/**
 * Execute a tool by name.
 *
 * @param {string} name
 * @param {object} args
 * @param {object} ctx { userId, actor, role, toolDefaults }
 *   toolDefaults lets an agent override a tool's configured defaults for its own
 *   runs only — "this agent's anomaly threshold is 3.5" without changing what
 *   the same tool does in chat.
 */
async function executeTool(name, args = {}, ctx = {}) {
  const tool = await resolve(name);
  if (!tool) {
    await builtin.logToolCall({ ...ctx, toolName: name, args, readOnly: true, success: false, error: 'unknown tool' });
    throw new Error(`Unknown tool: ${name}`);
  }

  // Second lock on the same door getMcpTools() closes. Hiding a tool from a
  // listing is not access control — a client can name a tool it was never
  // shown. The stdio MCP surface has no human to confirm anything, and an
  // MCP-backed tool is an unreviewed third-party action, so that combination
  // is refused outright rather than merely undocumented.
  if (tool.mcp && ctx.actor === 'mcp') {
    const reason = `"${name}" comes from a connected MCP server and cannot be called over this ERP's own MCP interface — there is no one on this connection to approve it. Call it from the assistant, where it prompts for confirmation.`;
    await builtin.logToolCall({ ...ctx, toolName: name, args, readOnly: !!tool.readOnly, success: false, error: reason });
    throw new Error(reason);
  }

  // Same reasoning as the MCP-actor check above: a hidden tool must also be a
  // blocked tool, not just an undocumented one. A model that guesses a tool
  // name for a module the company has turned off (e.g. from an older
  // conversation, before the module was disabled) must not still be able to
  // run it.
  if (!(await isModuleAvailable(name, ctx.companyId))) {
    const reason = `The tool "${name}" belongs to a module this company has turned off.`;
    await builtin.logToolCall({ ...ctx, toolName: name, args, readOnly: !!tool.readOnly, success: false, error: reason });
    throw new Error(reason);
  }

  const toolSettings = await settings.getToolSettings();
  const setting = effectiveSetting(tool, toolSettings.get(name));

  if (!settings.isToolAvailable(setting, ctx.role)) {
    const reason = setting?.enabled === false
      ? `The tool "${name}" is disabled in this system's AI settings.`
      : `The tool "${name}" requires the ${setting.min_role} role.`;
    await builtin.logToolCall({ ...ctx, toolName: name, args, readOnly: tool.readOnly, success: false, error: reason });
    throw new Error(reason);
  }

  // Global defaults first, then the agent's overrides, then the actual call.
  let effectiveArgs = settings.applyDefaults(setting, args);
  const perAgent = ctx.toolDefaults?.[name];
  if (perAgent) effectiveArgs = settings.applyDefaults({ defaults: perAgent }, effectiveArgs);

  // Built-ins already audit themselves inside toolRegistry.executeTool; routing
  // through it keeps one audit path rather than two that can disagree.
  if (!tool.custom && !tool.mcp) {
    return builtin.executeTool(name, effectiveArgs, ctx);
  }

  // Tools whose implementation lives outside the registry — user-authored
  // (sandboxed, structurally read-only) and MCP-backed (a real call to a
  // third-party server). Both are audited here rather than by the registry.
  //
  // readOnly is taken from the tool rather than assumed: it used to be
  // hardcoded true, which was harmless while custom tools were the only thing
  // on this path — they cannot write — but would have logged every real MCP
  // side effect as a read.
  try {
    const result = await tool.handler(effectiveArgs, ctx);
    await builtin.logToolCall({
      actor: ctx.actor || 'ai-agent',
      userId: ctx.userId,
      toolName: name,
      args: effectiveArgs,
      readOnly: !!tool.readOnly,
      success: true,
      resultSummary: typeof result === 'object' ? JSON.stringify(result).slice(0, 500) : String(result),
    });
    return result;
  } catch (err) {
    await builtin.logToolCall({
      actor: ctx.actor || 'ai-agent',
      userId: ctx.userId,
      toolName: name,
      args: effectiveArgs,
      readOnly: !!tool.readOnly,
      success: false,
      error: err.message,
    });
    throw err;
  }
}

/** True if the tool needs a confirmation step in `accept_edits` mode. */
async function isHighImpact(name) {
  const tool = await resolve(name);
  return !!tool?.highImpact;
}

module.exports = {
  listTools,
  getOpenAITools,
  getMcpTools,
  resolve,
  executeTool,
  isHighImpact,
};
