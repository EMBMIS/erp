/**
 * Scenario runner for the tool-calling agent eval suite.
 *
 * Runs each scenario through the real runAgent() loop against the real
 * configured database (see scenarios.js — every scenario is read-only, so
 * this is safe to run any time, including in CI).
 *
 * Mode note: the obvious choice would be 'manual', but in agent.js
 * needsConfirmation() returns true unconditionally when mode === 'manual' —
 * every tool call pauses for confirmation, none of them ever run, and the
 * loop returns status:'awaiting_confirmation' with an empty tools_used on
 * the very first tool call. That mode cannot exercise a tool at all, manual
 * or automated. 'accept_edits' (the app's own DEFAULT_MODE) auto-runs read
 * tools and only pauses for `highImpact` tools — none of which appear in
 * scenarios.js — so it gives the same "nothing runs unconfirmed" guarantee
 * the task asked for while actually letting the read tools execute.
 */

const { runAgent } = require('../agent');
const scenarios = require('./scenarios');

const EVAL_CTX = { userId: null, actor: 'eval', role: 'ADMIN' };
const EVAL_MODE = 'accept_edits';

function toolNamesCalled(events, result) {
  const fromEvents = events.filter((e) => e.type === 'tool_call').map((e) => e.name);
  const fromResult = (result.tools_used || []).map((t) => (typeof t === 'string' ? t : t.name));
  return new Set([...fromEvents, ...fromResult]);
}

function evaluateScenario(scenario, events, result) {
  const reasons = [];
  const called = toolNamesCalled(events, result);
  const calledList = [...called];

  for (const name of scenario.expect.tools_called || []) {
    if (!called.has(name)) {
      reasons.push(`expected tool '${name}' was not called; tools called: [${calledList.join(', ') || 'none'}]`);
    }
  }
  for (const name of scenario.expect.tools_not_called || []) {
    if (called.has(name)) {
      reasons.push(`tool '${name}' was called but should not have been; tools called: [${calledList.join(', ')}]`);
    }
  }

  const response = String(result.response || '');
  const responseLower = response.toLowerCase();
  for (const substr of scenario.expect.response_contains || []) {
    if (!responseLower.includes(String(substr).toLowerCase())) {
      reasons.push(`response did not contain expected substring "${substr}"; response was: ${response.slice(0, 300)}`);
    }
  }

  if (result.status !== 'done') {
    const pendingNames = (result.pending || []).map((p) => p.name).join(', ') || 'unknown';
    reasons.push(
      `run paused for confirmation instead of completing; pending tool(s): [${pendingNames}]; `
      + `tools already executed before the pause: [${calledList.join(', ') || 'none'}] — `
      + 'check whether the model reached for a highImpact tool nobody asked for'
    );
  }

  return { ok: reasons.length === 0, reasons, called: calledList, status: result.status, response: result.response };
}

async function runOne(scenario) {
  const events = [];
  let result;
  try {
    result = await runAgent(scenario.prompt, EVAL_CTX, [], EVAL_MODE, (e) => events.push(e));
  } catch (err) {
    return { id: scenario.id, ok: false, reasons: [`runAgent threw: ${err.message}`], called: [], status: 'error', response: '' };
  }
  return { id: scenario.id, ...evaluateScenario(scenario, events, result) };
}

/**
 * @param {{filter?: string}} [opts] optional substring filter over scenario id
 * @returns {Promise<{total:number, passed:number, failed:number, results: Array}>}
 */
async function runEvals({ filter } = {}) {
  const toRun = filter ? scenarios.filter((s) => s.id.includes(filter)) : scenarios;
  const results = [];
  for (const scenario of toRun) {
    // Sequential, not Promise.all: these hit a real LLM + real DB, and running
    // them concurrently would make failures harder to attribute and could trip
    // rate limits.
    results.push(await runOne(scenario));
  }
  const passed = results.filter((r) => r.ok).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

module.exports = { runEvals };
