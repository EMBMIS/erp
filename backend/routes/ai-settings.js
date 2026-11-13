/**
 * Global AI settings.
 *
 * Readable by any authenticated user — knowing which model answers you, and
 * which tools the assistant has, is not privileged information, and hiding it
 * makes the AI feel arbitrary. Changing any of it is manager/admin, because
 * these settings decide what the assistant may do on everyone's behalf.
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const settings = require('../services/ai/settings');
const catalog = require('../services/ai/toolCatalog');
const aiConfig = require('../config/aiConfig');

router.use(auth);

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...result });
  } catch (error) {
    console.error(`AI settings route error (${req.method} ${req.path}):`, error.message);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  }
};

/**
 * Everything the settings screen needs in one call: the configuration, what the
 * deployment defaults to, and which optional capabilities are actually
 * available on this server. The last part matters — a UI that offers LaTeX
 * reports on a server with no TeX engine is offering a button that fails.
 */
router.get('/', handle(async (req) => {
  const [config, toolSettings, tools] = await Promise.all([
    settings.getSettings(),
    settings.listToolSettings(),
    catalog.listTools({ role: req.user.role, includeUnavailable: true }),
  ]);

  const latex = require('../services/pdf/latexService').latexStatus();
  const vault = require('../services/ai/credentialVault').vaultStatus();
  const providerInfo = aiConfig.getProviderInfo();

  return {
    data: {
      ...config,
      // NULL model means "whatever the deployment is configured for" — the UI
      // must be able to show that as inherited rather than as blank.
      effective_model: config.model || aiConfig.AI_MODEL_RESOLVED,
      environment_model: aiConfig.AI_MODEL,
      ai_enabled: aiConfig.isAIEnabled(),
      provider: providerInfo.provider,
      available_providers: providerInfo.available,
      tool_settings: toolSettings,
      tool_count: tools.length,
      custom_tool_count: tools.filter((t) => t.custom).length,
      capabilities: {
        latex,
        vault,
        agent_scheduler: process.env.AGENT_SCHEDULER_ENABLED === 'true',
      },
      // Served rather than hardcoded in the form, so the input's ceiling and
      // the value the server will actually accept cannot drift apart — which
      // is exactly how you get a field that silently refuses what you type.
      max_step_ceiling: settings.MAX_STEP_CEILING,
      // What the agent can actually reach, grouped the way the brain models
      // draw it. Counted from the registry rather than typed anywhere.
      tool_breakdown: (() => {
        const narration = require('../services/ai/agentNarration');
        const by = {};
        for (const t of tools) {
          const m = narration.meta(t.name);
          by[m.module] = (by[m.module] || 0) + 1;
        }
        return by;
      })(),
    },
  };
}));

router.put('/', requireManagerOrAdmin, handle(async (req) => ({
  data: await settings.updateSettings(req.body, req.user.id),
})));

// --- Per-tool configuration -------------------------------------------------

router.get('/tools', handle(async (req) => {
  const [tools, toolSettings] = await Promise.all([
    catalog.listTools({ role: req.user.role, includeUnavailable: true }),
    settings.getToolSettings(),
  ]);
  return {
    data: tools.map((t) => {
      const setting = toolSettings.get(t.name);
      return {
        name: t.name,
        description: t.description,
        impact: t.readOnly ? 'read' : t.highImpact ? 'real' : 'draft',
        custom: !!t.custom,
        enabled: setting?.enabled !== false,
        min_role: setting?.min_role || null,
        defaults: setting?.defaults || {},
        available_to_me: t.available,
        input_schema: t.inputSchema,
      };
    }),
  };
}));

router.put('/tools/:name', requireManagerOrAdmin, handle(async (req) => ({
  data: await settings.upsertToolSetting(req.params.name, req.body, req.user.id),
})));

module.exports = router;
