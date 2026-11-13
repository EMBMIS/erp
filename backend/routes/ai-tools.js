/**
 * Tool library — the control plane for the tool builder.
 *
 * Reading the catalogue is open to any authenticated user: knowing what the
 * assistant can do is not a privilege, and hiding it just makes the AI feel
 * arbitrary.
 *
 * Authoring is ADMIN/MANAGER only, and that gate is the primary security
 * control for custom tools — not the sandbox. A tool body is JavaScript that
 * will later run unattended inside agent runs, so the question "who may write
 * one" carries more weight than any pattern list. See services/ai/sandbox.js.
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const customTools = require('../services/ai/customTools');
const catalog = require('../services/ai/toolCatalog');
const settings = require('../services/ai/settings');

router.use(auth);

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...result });
  } catch (error) {
    console.error(`AI tool route error (${req.method} ${req.path}):`, error.message);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  }
};

// --- Catalogue --------------------------------------------------------------

/**
 * GET /ai-tools/catalog — every tool the assistant knows about, built-in and
 * custom, with its configuration. This is the "what can this AI actually do"
 * view, so unavailable tools are included and marked rather than hidden.
 */
router.get('/catalog', handle(async (req) => {
  const tools = await catalog.listTools({ role: req.user.role, includeUnavailable: true });
  return {
    data: tools.map((t) => ({
      name: t.name,
      description: t.description,
      read_only: t.readOnly !== false,
      high_impact: !!t.highImpact,
      custom: !!t.custom,
      version: t.version || null,
      input_schema: t.inputSchema,
      enabled: t.setting?.enabled !== false,
      min_role: t.setting?.min_role || null,
      // Outside tools ask before running unless this was granted; shown so the
      // grant is visible and revocable rather than invisibly permanent.
      external: !!t.mcp,
      auto_approve: !!t.setting?.auto_approve,
      defaults: t.setting?.defaults || {},
      available: t.available,
    })),
  };
}));

// --- Custom tool CRUD -------------------------------------------------------

router.get('/', handle(async () => ({ data: await customTools.listTools() })));

router.get('/:idOrName', handle(async (req) => {
  const tool = await customTools.getTool(req.params.idOrName);
  if (!tool) throw new Error('Tool not found.');
  return { data: tool };
}));

/**
 * Run the same test path /test uses before a save is allowed to reach the
 * database — a saved tool is immediately callable by the assistant and by
 * agents, so nothing should be saved that hasn't been proven to run. Only an
 * ADMIN may skip this (e.g. importing a tool already known to work).
 *
 * `payload` is the fully-resolved definition to test — for an update that is
 * the existing row merged with the requested changes, not the raw (possibly
 * partial) request body, so a patch that only touches e.g. `enabled` doesn't
 * get tested against an undefined implementation.
 */
async function ensureTested(req, payload) {
  if (req.body.skip_test === true) {
    if (req.user.role !== 'ADMIN') throw new Error('Only an administrator can skip tool validation.');
    console.warn(`AI tool save skipped validation (skip_test) — user ${req.user.id}, tool "${payload.name || req.params?.idOrName}"`);
    return null;
  }
  return customTools.testTool(payload, { userId: req.user.id, actor: 'tool-test', role: req.user.role });
}

router.post('/', requireManagerOrAdmin, handle(async (req, res) => {
  const testResult = await ensureTested(req, req.body);
  if (testResult && !testResult.ok) {
    res.status(422).json({ success: false, error: `Tool validation failed: ${testResult.error}`, test_output: testResult });
    return;
  }
  return {
    data: await customTools.createTool(req.body, req.user.id),
    note: 'The tool is now callable by the assistant and by agents.',
  };
}));

router.put('/:idOrName', requireManagerOrAdmin, handle(async (req, res) => {
  const existing = await customTools.getTool(req.params.idOrName);
  if (!existing) throw new Error('Tool not found.');
  const payload = {
    implementation: req.body.implementation ?? existing.implementation,
    input: req.body.input,
    timeout_ms: req.body.timeout_ms ?? existing.timeout_ms,
    allowed_tools: req.body.allowed_tools ?? existing.allowed_tools,
    allow_sql: req.body.allow_sql ?? existing.allow_sql,
    name: req.body.name ?? existing.name,
  };

  const testResult = await ensureTested(req, payload);
  if (testResult && !testResult.ok) {
    res.status(422).json({ success: false, error: `Tool validation failed: ${testResult.error}`, test_output: testResult });
    return;
  }
  return {
    data: await customTools.updateTool(req.params.idOrName, req.body, req.user.id),
  };
}));

router.patch('/:idOrName/enabled', requireManagerOrAdmin, handle(async (req) => ({
  data: await customTools.setEnabled(req.params.idOrName, !!req.body.enabled, req.user.id),
})));

router.delete('/:idOrName', requireManagerOrAdmin, handle(async (req) => ({
  data: await customTools.deleteTool(req.params.idOrName),
})));

// --- Versions ---------------------------------------------------------------

router.get('/:idOrName/versions', handle(async (req) => ({
  data: await customTools.listVersions(req.params.idOrName),
})));

router.post('/:idOrName/rollback', requireManagerOrAdmin, handle(async (req) => ({
  data: await customTools.rollbackTool(req.params.idOrName, req.body.version, req.user.id),
})));

// --- Test bench -------------------------------------------------------------

/**
 * POST /ai-tools/test — run an unsaved implementation.
 *
 * The whole point of the builder is that nobody has to guess what a tool does:
 * the author runs it against real data, sees the rows and the logs, and only
 * then saves something the AI may call on its own.
 */
router.post('/test', requireManagerOrAdmin, handle(async (req) => ({
  data: await customTools.testTool(req.body, { userId: req.user.id, actor: 'tool-test', role: req.user.role }),
})));

/** POST /ai-tools/lint — static check only, no execution. */
router.post('/lint', requireManagerOrAdmin, handle(async (req) => {
  const { lintToolCode } = require('../services/ai/sandbox');
  return { data: lintToolCode(req.body.implementation) };
}));

// --- Import / export --------------------------------------------------------

router.get('/:idOrName/export', handle(async (req) => {
  const tool = await customTools.getTool(req.params.idOrName);
  if (!tool) throw new Error('Tool not found.');
  return {
    data: {
      kind: 'qira.ai_tool',
      version: 1,
      tool: {
        name: tool.name,
        display_name: tool.display_name,
        description: tool.description,
        input_schema: tool.input_schema,
        output_schema: tool.output_schema,
        implementation: tool.implementation,
        timeout_ms: tool.timeout_ms,
        allowed_tools: tool.allowed_tools,
        allow_sql: tool.allow_sql,
      },
    },
  };
}));

/**
 * POST /ai-tools/import — accepts an exported bundle.
 *
 * Imported code is validated exactly as typed-in code is. A tool arriving as
 * JSON from another installation is not more trustworthy for having been in a
 * file, and it lands disabled so someone reads it before the AI can call it.
 */
router.post('/import', requireManagerOrAdmin, handle(async (req) => {
  const payload = req.body?.tool || req.body;
  if (!payload?.name || !payload?.implementation) throw new Error('That does not look like an exported tool.');
  return {
    data: await customTools.createTool({ ...payload, enabled: false }, req.user.id),
    note: 'Imported disabled. Review the implementation, then enable it.',
  };
}));

// --- Per-tool configuration (applies to built-ins too) ----------------------

router.put('/:name/settings', requireManagerOrAdmin, handle(async (req) => ({
  data: await settings.upsertToolSetting(req.params.name, req.body, req.user.id),
})));

// --- Document search indexing ------------------------------------------------

/**
 * POST /ai-tools/reindex-documents — (re)build the document_embeddings table
 * that search_documents (services/ai/toolRegistry.js) reads from.
 *
 * Manual trigger only, on purpose: there is no hook that calls this on every
 * contract save or document generation (see services/ai/documentSearch.js) —
 * that automatic-reindex decision is bigger than this endpoint, and an admin
 * choosing when to (re)build the index is a fine V1. Gated the same as the
 * other maintenance actions in this file (requireManagerOrAdmin).
 */
router.post('/reindex-documents', requireManagerOrAdmin, handle(async () => {
  const documentSearch = require('../services/ai/documentSearch');
  const knowledgeBase = require('../services/ai/knowledgeBase');
  const [contracts, documents, kbDocuments, chatMessages, supplierInvoices] = await Promise.all([
    documentSearch.indexSalesContracts(),
    documentSearch.indexGeneratedDocuments(),
    knowledgeBase.indexPending(),
    documentSearch.indexConversationMessages(),
    documentSearch.indexSupplierInvoices(),
  ]);
  return {
    data: {
      sales_contracts: contracts,
      generated_documents: documents,
      kb_documents: kbDocuments,
      chat_messages: chatMessages,
      supplier_invoices: supplierInvoices,
      total_indexed: contracts.indexed + documents.indexed + kbDocuments.indexed + chatMessages.indexed + supplierInvoices.indexed,
      total_skipped: contracts.skipped + documents.skipped + kbDocuments.skipped + chatMessages.skipped + supplierInvoices.skipped,
    },
  };
}));

module.exports = router;
