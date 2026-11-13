/**
 * Connected products, as tools the assistant can call.
 *
 * The fourth source in services/ai/toolCatalog.js, after built-ins, custom
 * tools and MCP servers. Each connected provider contributes:
 *
 *   • its named tools from connectorProviders.js — documented, with real
 *     argument schemas, so the model can do the common thing without knowing
 *     the vendor's URL scheme; and
 *   • one `<provider>_api_request` escape hatch, so a connector is useful for
 *     everything else the API offers the moment it is connected, rather than
 *     only for whatever anyone has got round to writing a tool for.
 *
 * Everything here is `mcp: true` and `highImpact: true`. The flag name is about
 * behaviour, not protocol: it is the marker toolCatalog, agent.js and both
 * agent runners already use for "an outside system, always confirm, never run
 * unattended". Reusing it means a REST call to someone's live Salesforce
 * inherits every guardrail already built for third-party tools instead of
 * needing a parallel set that could drift.
 *
 * `readOnly` is honest per tool — a search is a read, posting to Slack is not —
 * because it drives the audit log. It does NOT relax the confirmation gate;
 * that is unconditional for anything reaching outside this ERP.
 */

const connectors = require('./connectors');
const { getProvider } = require('./connectorProviders');
const { getCustomHandler } = require('./connectorCustomTools');

const MAX_NAME = 64;

function isConnectorToolName(name) {
  return typeof name === 'string' && name.startsWith('conn_');
}

function toolName(connector, suffix) {
  // The connector id keeps two accounts of the same provider apart; the
  // provider name keeps it readable.
  const short = connector.id.slice(0, 4);
  return `conn_${connector.provider}_${short}_${suffix}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, MAX_NAME);
}

/** Substitute {{arg}} placeholders in a tool's path/query/body from its input. */
function resolve(template, input) {
  if (template === null || template === undefined) return template;
  if (typeof template === 'string') {
    const whole = /^\{\{(\w+)\}\}$/.exec(template);
    if (whole) return input[whole[1]];
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (input[k] === undefined ? '' : String(input[k])));
  }
  if (Array.isArray(template)) return template.map((t) => resolve(t, input));
  if (typeof template === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(template)) {
      const value = resolve(v, input);
      if (value !== undefined && value !== '') out[k] = value;
    }
    return out;
  }
  return template;
}

function buildNamedTool(connector, config, spec) {
  // A handful of tools (file uploads) cannot be expressed as a path/query/body
  // template — see connectorCustomTools.js for why. `spec.custom` names one of
  // those handlers instead of describing a request to build.
  const customHandler = spec.custom ? getCustomHandler(spec.custom) : null;

  return {
    name: toolName(connector, spec.name),
    description: `[${connector.label}] ${spec.description}`,
    inputSchema: spec.input_schema || { type: 'object', properties: {} },
    readOnly: spec.readOnly !== false,
    highImpact: true,
    mcp: true,
    connector: true,
    connectorId: connector.id,
    handler: customHandler
      ? (args, ctx) => customHandler(connector, spec.api_base ? { ...config, api_base: spec.api_base } : config, args || {}, ctx)
      : async (args = {}) => {
          const account = connector.account_info || {};
          // Path placeholders may come from the account (a Shopify shop) or
          // from the call's own arguments (a Drive file id).
          const merged = { ...account, ...args };
          const result = await connectors.apiFetch(resolve(spec.path, merged), {
            connector,
            config: spec.api_base ? { ...config, api_base: spec.api_base } : config,
            account,
            method: spec.method || 'GET',
            query: resolve(spec.query, merged),
            body: spec.body ? resolve(spec.body, merged) : undefined,
            headers: spec.extra_headers,
          });
          return result.body;
        },
  };
}

function buildGenericTool(connector, config) {
  return {
    name: toolName(connector, 'api_request'),
    description:
      `[${connector.label}] Make an authenticated request to the ${config.name} API. ` +
      `Use this for anything the named ${connector.provider} tools do not cover. ` +
      `Give a path relative to ${config.api_base} (e.g. "/drive/v3/about"), and consult the provider's API reference for the exact path and parameters.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'API path, e.g. /drive/v3/files' },
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], description: 'HTTP method (default GET)' },
        query: { type: 'object', description: 'Query-string parameters as an object' },
        body: { type: 'object', description: 'JSON body, for POST/PATCH/PUT' },
      },
      required: ['path'],
    },
    // Unknowable in advance: the model chooses the method. Treated as a write,
    // which only affects how it is recorded — it needs confirmation regardless.
    readOnly: false,
    highImpact: true,
    mcp: true,
    connector: true,
    connectorId: connector.id,
    handler: async (args = {}) => {
      const result = await connectors.apiFetch(String(args.path || '/'), {
        connector,
        config,
        account: connector.account_info || {},
        method: (args.method || 'GET').toUpperCase(),
        query: args.query,
        body: args.body,
      });
      return result.body;
    },
  };
}

/** Every tool from every connected provider. */
async function listRuntimeTools() {
  const rows = await connectors.listConnected();
  const tools = [];

  for (const connector of rows) {
    const config = getProvider(connector.provider);
    if (!config) continue; // provider removed from the catalogue since connecting
    for (const spec of config.tools || []) {
      tools.push(buildNamedTool(connector, config, spec));
    }
    tools.push(buildGenericTool(connector, config));
  }
  return tools;
}

module.exports = { listRuntimeTools, isConnectorToolName, toolName };
