// The loop itself — the part of Simeli that turns a question into an answer.
//
// agent.js is 744 lines carrying the whole conversation: the model call for
// each provider, tool dispatch, the confirmation pause, cancellation, and the
// event stream the chat window renders from. Until now the only thing tested
// in it was buildSystemPrompt. Everything else was covered by using it — which
// is how `ctx is not defined` sat in the Anthropic branch: unreachable on the
// OpenAI path, fatal on the other, and invisible to every test.
//
// The model is stubbed, not mocked away: the stub returns the chunk shapes the
// real SDKs emit, so the parsing, accumulation and event code under test is
// the code that ships. What is asserted is the contract the chat window
// depends on — which events arrive, in what order, carrying what.
//
// Run on its own:  node --test tests/agentLoop.test.js

const nodeTest = require('node:test');
const { test, before, after } = require('./helpers/withCompany').wrapHooks(nodeTest);
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const companyContext = require('../services/companyContext');

const CONFIG = require.resolve('../config/aiConfig');
const AGENT = require.resolve('../services/ai/agent');

/**
 * Load agent.js against a stubbed provider.
 *
 * The client is swapped in the module cache rather than injected, because
 * agent.js resolves it through getAIClient() on every call — which is exactly
 * the seam a deployment uses to switch providers, so stubbing it here tests
 * the same path a provider switch takes.
 */
function withProvider(provider, client) {
  const real = require('../config/aiConfig');
  require.cache[CONFIG].exports = {
    ...real,
    getAIClient: () => client,
    getAIProvider: () => provider,
  };
  delete require.cache[AGENT];
  return require(AGENT);
}

function restoreConfig() {
  delete require.cache[CONFIG];
  delete require.cache[AGENT];
}

/** An OpenAI-shaped stream of chunks. */
function openAIStream(chunks) {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

function textChunk(content) {
  return { choices: [{ delta: { content } }] };
}

function toolChunk(name, args, index = 0) {
  return {
    choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, function: { name, arguments: args } }] } }],
  };
}

let companyId = null;
let dbAvailable = false;

before(async () => {
  try {
    companyId = await companyContext.getDefaultCompanyId();
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  restoreConfig();
  await pool.end();
});

function ctx() {
  return { userId: null, role: 'ADMIN', companyId };
}

// ---------------------------------------------------------------------------
// The provider seam
// ---------------------------------------------------------------------------

test('the Anthropic path reaches the SDK', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  // Regression: callAnthropicStreaming referenced `ctx`, which was a parameter
  // of its caller and not of itself. Every model call on this provider threw
  // ReferenceError before a request was ever made — the whole chat, dead, for
  // any deployment running Anthropic.
  let reached = false;
  const client = {
    messages: {
      stream() {
        reached = true;
        return (async function* () {})();
      },
    },
  };
  const { runAgent } = withProvider('anthropic', client);
  await companyContext.runWithCompany(companyId, () =>
    runAgent('anything', ctx(), [], 'manual', () => {}));
  assert.ok(reached, 'the request was never made');
  restoreConfig();
});

test('cancellation reaches the provider, not just the loop', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  // Stopping a run has to close the upstream request. Aborting only the loop
  // leaves the model generating into a socket nobody reads — billed, and still
  // running after the person has moved on.
  let sawSignal = null;
  const client = {
    chat: { completions: { create: (_body, options) => {
      sawSignal = options?.signal || null;
      return openAIStream([textChunk('ok')]);
    } } },
  };
  const { runAgent } = withProvider('openai', client);
  const control = new AbortController();
  await companyContext.runWithCompany(companyId, () =>
    runAgent('anything', { ...ctx(), signal: control.signal }, [], 'manual', () => {}));
  assert.ok(sawSignal, 'no signal was handed to the SDK');
  assert.equal(sawSignal, control.signal);
  restoreConfig();
});

// ---------------------------------------------------------------------------
// The event stream the chat window renders from
// ---------------------------------------------------------------------------

test('a plain answer streams as deltas and ends as final', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  const client = {
    chat: { completions: { create: () => openAIStream([
      textChunk('Cash is '), textChunk('healthy.'),
    ]) } },
  };
  const { runAgent } = withProvider('openai', client);
  const events = [];
  const out = await companyContext.runWithCompany(companyId, () =>
    runAgent('how is cash', ctx(), [], 'manual', (e) => events.push(e)));

  assert.equal(out.response, 'Cash is healthy.', 'the deltas reassemble into the answer');
  assert.deepEqual(
    events.filter((e) => e.type === 'delta').map((e) => e.content),
    ['Cash is ', 'healthy.'],
  );
  const end = events.find((e) => e.type === 'step_end');
  assert.ok(end, 'the step announced it had ended');
  assert.equal(end.final, true, 'text with no tool call after it is the answer, not reasoning');
  restoreConfig();
});

test('text before a tool call is marked as reasoning, not as the answer', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  // This is the flag the window uses to keep thinking out of the answer bubble
  // and inside the tool dropdown. Getting it backwards puts the model's
  // working-out where the conclusion belongs.
  let call = 0;
  const client = {
    chat: { completions: { create: () => {
      call += 1;
      return call === 1
        ? openAIStream([textChunk('Let me look at the ledger.'), toolChunk('get_trial_balance', '{}')])
        : openAIStream([textChunk('Everything balances.')]);
    } } },
  };
  const { runAgent } = withProvider('openai', client);
  const events = [];
  const out = await companyContext.runWithCompany(companyId, () =>
    runAgent('is the ledger balanced', ctx(), [], 'auto', (e) => events.push(e)));

  const ends = events.filter((e) => e.type === 'step_end');
  assert.equal(ends.length, 2, 'both steps ended');
  assert.equal(ends[0].final, false, 'the first step was reasoning ahead of a tool call');
  assert.equal(ends[1].final, true, 'the second step was the answer');
  assert.equal(out.response, 'Everything balances.', 'the reasoning is not in the answer');
  restoreConfig();
});

test('a tool call announces itself before it runs and reports how it went', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  let call = 0;
  const client = {
    chat: { completions: { create: () => {
      call += 1;
      return call === 1
        ? openAIStream([toolChunk('get_trial_balance', '{}')])
        : openAIStream([textChunk('Done.')]);
    } } },
  };
  const { runAgent } = withProvider('openai', client);
  const events = [];
  await companyContext.runWithCompany(companyId, () =>
    runAgent('trial balance please', ctx(), [], 'auto', (e) => events.push(e)));

  const started = events.findIndex((e) => e.type === 'tool_call' && e.name === 'get_trial_balance');
  const finished = events.findIndex((e) => e.type === 'tool_result' && e.name === 'get_trial_balance');
  assert.ok(started >= 0, 'the window was told the tool was starting');
  assert.ok(finished > started, 'and told how it went, afterwards');
  assert.equal(events[finished].ok, true);
  restoreConfig();
});

test('an unknown tool is reported, and the run carries on', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  // A model that invents a tool name must not end the investigation, and must
  // not stop to ask a person about it either: approving a name that does not
  // exist cannot do anything except produce "Unknown tool". It has to hear
  // that immediately and get another turn to choose a tool that is real.
  let call = 0;
  const client = {
    chat: { completions: { create: () => {
      call += 1;
      return call === 1
        ? openAIStream([toolChunk('summon_the_ledger_spirits', '{}')])
        : openAIStream([textChunk('Using a real tool instead.')]);
    } } },
  };
  const { runAgent } = withProvider('openai', client);
  const events = [];
  const out = await companyContext.runWithCompany(companyId, () =>
    runAgent('do something impossible', ctx(), [], 'auto', (e) => events.push(e)));

  assert.ok(
    !events.some((e) => e.type === 'awaiting_confirmation'),
    'a name that does not exist is not a decision worth interrupting someone for',
  );
  const failed = events.find((e) => e.type === 'tool_result' && e.ok === false);
  assert.ok(failed, 'the failure was reported rather than swallowed');
  assert.match(failed.error, /[Uu]nknown tool/);
  assert.equal(out.response, 'Using a real tool instead.', 'the run continued to an answer');
  restoreConfig();
});

test('a write in manual mode pauses for a decision instead of executing', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  // The confirmation prompt is the control standing between the model and a
  // write. In manual mode nothing that changes data may run unasked.
  const client = {
    chat: { completions: { create: () => openAIStream([
      toolChunk('create_sales_quotation_draft', '{"customer_id":"x"}'),
    ]) } },
  };
  const { runAgent } = withProvider('openai', client);
  const events = [];
  const out = await companyContext.runWithCompany(companyId, () =>
    runAgent('draft a quote', ctx(), [], 'manual', (e) => events.push(e)));

  assert.equal(out.status, 'awaiting_confirmation');
  const waiting = events.find((e) => e.type === 'awaiting_confirmation');
  assert.ok(waiting, 'the window was told a decision is needed');
  assert.ok(waiting.pending?.length, 'and told what is waiting on it');
  restoreConfig();
});

test('a high-impact write still pauses in accept_edits', async (t) => {
  if (!dbAvailable) return t.skip('no database');
  // The counterweight to the test above: not asking about a name that does not
  // exist must not become not asking about a tool that does. accept_edits is
  // the mode where the distinction lives — a draft may go through unasked
  // (that is what accepting edits means), a change to a real record may not.
  const client = {
    chat: { completions: { create: () => openAIStream([
      toolChunk('move_deal_stage', '{"deal_id":"x","stage":"CLOSED_WON"}'),
    ]) } },
  };
  const { runAgent } = withProvider('openai', client);
  const out = await companyContext.runWithCompany(companyId, () =>
    runAgent('mark it won', ctx(), [], 'accept_edits', () => {}));

  assert.equal(out.status, 'awaiting_confirmation', 'a real record change still asks');
  assert.equal(out.pending?.[0]?.name, 'move_deal_stage');
  restoreConfig();
});
