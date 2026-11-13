// needsConfirmation — the gate deciding whether a tool call pauses for a
// human, and specifically the "Always allow" bug: resumeAgent's `always`
// branch persists an auto_approve grant for whichever tool name was just
// approved, MCP or built-in. needsConfirmation used to only read that grant
// back for tool.mcp, falling straight to `!!tool.highImpact` for a built-in
// tool like write_database — so the grant was recorded and then ignored,
// and a multi-row import (one write_database call per row) asked again on
// every single row.
//
// toolCatalog and settings are stubbed via the require cache, the same
// pattern agentLoop.test.js uses for aiConfig — no live Postgres needed.
//
// Run on its own:  node --test tests/needsConfirmation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const CATALOG = require.resolve('../services/ai/toolCatalog');
const SETTINGS = require.resolve('../services/ai/settings');
const AGENT = require.resolve('../services/ai/agent');

function load({ tool, autoApprove }) {
  require.cache[CATALOG] = {
    id: CATALOG, filename: CATALOG, loaded: true,
    exports: { resolve: async (name) => (name === tool.name ? tool : null) },
  };
  require.cache[SETTINGS] = {
    id: SETTINGS, filename: SETTINGS, loaded: true,
    exports: {
      getToolSettings: async () => new Map(
        autoApprove ? [[tool.name, { auto_approve: true }]] : [],
      ),
    },
  };
  delete require.cache[AGENT];
  return require(AGENT);
}

function restore() {
  delete require.cache[CATALOG];
  delete require.cache[SETTINGS];
  delete require.cache[AGENT];
}

test('needsConfirmation: a built-in high-impact tool asks in accept_edits mode', async () => {
  const { needsConfirmation } = load({ tool: { name: 'write_database', highImpact: true }, autoApprove: false });
  try {
    assert.equal(await needsConfirmation('write_database', 'accept_edits'), true);
  } finally { restore(); }
});

test('needsConfirmation: "Always allow" on a built-in high-impact tool stops it asking again', async () => {
  // This is the exact bug: settings.setAutoApprove('write_database', true, ...)
  // was called (resumeAgent's always branch), so getToolSettings() now
  // reports auto_approve for it — the next row's identical call must not
  // pause again.
  const { needsConfirmation } = load({ tool: { name: 'write_database', highImpact: true }, autoApprove: true });
  try {
    assert.equal(await needsConfirmation('write_database', 'accept_edits'), false);
  } finally { restore(); }
});

test('needsConfirmation: a non-high-impact built-in tool never asks', async () => {
  const { needsConfirmation } = load({ tool: { name: 'list_something', highImpact: false }, autoApprove: false });
  try {
    assert.equal(await needsConfirmation('list_something', 'accept_edits'), false);
  } finally { restore(); }
});

test('needsConfirmation: auto/bypass mode skips a built-in tool even without a grant', async () => {
  const { needsConfirmation } = load({ tool: { name: 'write_database', highImpact: true }, autoApprove: false });
  try {
    assert.equal(await needsConfirmation('write_database', 'auto'), false);
    assert.equal(await needsConfirmation('write_database', 'bypass'), false);
  } finally { restore(); }
});

test('needsConfirmation: an MCP tool asks the first time regardless of mode', async () => {
  const { needsConfirmation } = load({ tool: { name: 'mcp_thing', mcp: true }, autoApprove: false });
  try {
    assert.equal(await needsConfirmation('mcp_thing', 'auto'), true);
    assert.equal(await needsConfirmation('mcp_thing', 'bypass'), true);
  } finally { restore(); }
});

test('needsConfirmation: "Always allow" on an MCP tool still stops it asking again', async () => {
  const { needsConfirmation } = load({ tool: { name: 'mcp_thing', mcp: true }, autoApprove: true });
  try {
    assert.equal(await needsConfirmation('mcp_thing', 'accept_edits'), false);
  } finally { restore(); }
});

test('needsConfirmation: manual mode always asks, even with a grant', async () => {
  const { needsConfirmation } = load({ tool: { name: 'write_database', highImpact: true }, autoApprove: true });
  try {
    assert.equal(await needsConfirmation('write_database', 'manual'), true);
  } finally { restore(); }
});
