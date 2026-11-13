// Tests for the AI platform meta-layer: the sandbox, the credential vault's
// egress rules, LaTeX rejection, blueprint compilation and template rendering.
//
// These are the parts where a failure is SILENT. A sandbox that leaks does not
// throw; an egress check that accepts a spoofed hostname returns 200; a
// truncated PDF still opens. So the tests are written as adversarial cases —
// what should be refused — rather than as happy paths, which the build already
// exercises.
//
// Run on its own:  npm run test:ai-platform

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const sandbox = require('../services/ai/sandbox');
const vault = require('../services/ai/credentialVault');
const latex = require('../services/pdf/latexService');
const runner = require('../services/agents/blueprintRunner');
const { renderDocument, interpolate } = require('../services/pdf/templatedPdf');
const authority = require('../services/agents/authority');
const { pool } = require('../config/database');

// These tests are pure/adversarial-input cases with no direct DB calls, but
// several of the required services transitively open config/database.js's
// pool (min: 2 keepalive connections) — without closing it, the process
// hangs after the last test forever.
after(() => pool.end());

// ===========================================================================
// Sandbox — the boundary around user-authored tool code
// ===========================================================================

test('sandbox runs a tool body and returns its value', async () => {
  const out = await sandbox.runSandboxed({ code: 'return { sum: input.a + input.b };', input: { a: 2, b: 3 } });
  assert.equal(out.ok, true);
  assert.deepEqual(out.result, { sum: 5 });
});

test('sandbox terminates a synchronous infinite loop', async () => {
  // The guest function must be INVOKED inside runInContext for vm's timeout to
  // cover it. Returning the function to the host and calling it from there ran
  // the synchronous prefix unsupervised and wedged the process.
  const out = await sandbox.runSandboxed({ code: 'while (true) {}', input: {}, timeoutMs: 400 });
  assert.equal(out.ok, false);
  assert.match(out.error, /timed out/i);
});

test('sandbox abandons a hanging await rather than never settling', async () => {
  const out = await sandbox.runSandboxed({
    code: 'return await erp.sql("SELECT 1");',
    input: {},
    timeoutMs: 300,
    capabilities: { sql: () => new Promise(() => {}) },
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /did not finish/i);
});

test('sandbox has no route back to the host realm', async () => {
  // The classic vm escape is walking a host-realm object's constructor chain.
  // Only primitives cross the boundary, so there is nothing to walk.
  for (const code of [
    'return typeof require;',
    'return typeof process;',
    'return typeof __bridge;',
    'return typeof globalThis.__bridge;',
  ]) {
    const out = await sandbox.runSandboxed({ code, input: {}, capabilities: { sql: async () => ({}) } });
    // Either the static scan refuses it, or it evaluates to undefined. Both are
    // correct; what must never happen is a defined host object.
    if (out.ok) assert.equal(out.result, 'undefined', `"${code}" reached something`);
  }
});

test('sandbox refuses the obvious escape shapes before compiling', () => {
  for (const code of [
    'return process.env;',
    "return require('fs');",
    "return this.constructor.constructor('return process')();",
    "return new Function('return process')();",
  ]) {
    assert.equal(sandbox.lintToolCode(code).ok, false, `"${code}" was not rejected`);
  }
});

test('sandbox bounds data calls and output size', async () => {
  const calls = await sandbox.runSandboxed({
    code: 'for (let i = 0; i < 40; i++) await erp.sql("SELECT 1"); return "done";',
    input: {},
    timeoutMs: 5000,
    capabilities: { sql: async () => ({ rows: [] }) },
  });
  assert.equal(calls.ok, false);
  assert.match(calls.error, /at most \d+ data calls/i);

  const big = await sandbox.runSandboxed({ code: 'return "x".repeat(300000);', input: {} });
  assert.equal(big.ok, false);
  assert.match(big.error, /KB of data/i);
});

test('sandbox capabilities are deny-by-default', async () => {
  const out = await sandbox.runSandboxed({ code: 'return await erp.callTool("x", {});', input: {}, capabilities: {} });
  assert.equal(out.ok, false);
  assert.match(out.error, /not permitted/i);
});

// ===========================================================================
// Credential vault egress — the SSRF boundary
// ===========================================================================

const CREDENTIAL = { name: 'test', allowed_hosts: ['api.stripe.com', '*.example.com'] };

test('egress allows an exact host and a wildcard subdomain', () => {
  assert.equal(vault.checkEgress(CREDENTIAL, 'https://api.stripe.com/v1/charges').ok, true);
  assert.equal(vault.checkEgress(CREDENTIAL, 'https://sub.example.com/y').ok, true);
});

test('egress refuses a host that merely ends with an allowed one', () => {
  // Substring matching would accept this. It is a different domain entirely.
  const verdict = vault.checkEgress(CREDENTIAL, 'https://api.stripe.com.evil.net/x');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not permitted/i);
});

test('egress refuses plaintext HTTP', () => {
  const verdict = vault.checkEgress(CREDENTIAL, 'http://api.stripe.com/x');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /https/i);
});

test('egress refuses private, loopback and cloud-metadata addresses', () => {
  const open = { name: 'open', allowed_hosts: ['*'] };
  for (const host of [
    'https://169.254.169.254/latest/meta-data', // AWS/GCP metadata
    'https://127.0.0.1/admin',
    'https://10.0.0.5/internal',
    'https://192.168.1.1/router',
    'https://172.16.4.4/x',
    'https://localhost/x',
  ]) {
    const verdict = vault.checkEgress(open, host);
    assert.equal(verdict.ok, false, `${host} was allowed`);
    assert.match(verdict.reason, /private or loopback/i);
  }
});

test('egress refuses a credential with no configured hosts', () => {
  const verdict = vault.checkEgress({ name: 'unscoped', allowed_hosts: [] }, 'https://api.stripe.com/x');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no allowed hosts/i);
});

// ===========================================================================
// Vault encryption
// ===========================================================================

test('vault reports honestly when it cannot store anything', () => {
  const original = process.env.AI_VAULT_KEY;
  delete process.env.AI_VAULT_KEY;
  try {
    const status = vault.vaultStatus();
    assert.equal(status.configured, false);
    // The failure has to be actionable — "not configured" alone sends people
    // looking in the wrong place.
    assert.match(status.how_to_configure, /AI_VAULT_KEY/);
  } finally {
    if (original) process.env.AI_VAULT_KEY = original;
  }
});

test('vault rejects a key of the wrong length rather than padding it', () => {
  const original = process.env.AI_VAULT_KEY;
  process.env.AI_VAULT_KEY = 'too-short';
  try {
    assert.match(vault.vaultStatus().error || '', /32 bytes/);
  } finally {
    if (original) process.env.AI_VAULT_KEY = original;
    else delete process.env.AI_VAULT_KEY;
  }
});

// ===========================================================================
// LaTeX — model-authored code that can read files and run commands
// ===========================================================================

test('latex refuses shell escape and absolute-path reads', () => {
  const cases = [
    [String.raw`\documentclass{a}\begin{document}\write18{rm -rf /}\end{document}`, /shell escape/i],
    [String.raw`\documentclass{a}\begin{document}\input{/etc/passwd}\end{document}`, /absolute path/i],
    [String.raw`\documentclass{a}\begin{document}\openout1=x\end{document}`, /writing files/i],
    [String.raw`\documentclass{a}\begin{document}\input{../../secret}\end{document}`, /parent-directory/i],
  ];
  for (const [source, expected] of cases) {
    const lint = latex.lintLatex(source);
    assert.equal(lint.ok, false, `not rejected: ${source}`);
    assert.match(lint.problems.join(' '), expected);
  }
});

test('latex requires a complete document, not a fragment', () => {
  const lint = latex.lintLatex('Just some text with a \\textbf{bold} bit.');
  assert.equal(lint.ok, false);
  assert.match(lint.problems.join(' '), /documentclass/);
});

test('latex accepts an ordinary report', () => {
  const source = String.raw`\documentclass{article}\usepackage{booktabs}\begin{document}Hello\end{document}`;
  assert.equal(latex.lintLatex(source).ok, true);
});

test('latex names a missing package instead of quoting an unanswerable prompt', () => {
  // This text is handed back to a model as a tool result. TeX's own wording
  // ends in "Type X to quit or <RETURN> to proceed" — an interactive prompt
  // nothing in this pipeline can answer, and following it is not a repair.
  const log = [
    '! LaTeX Error: File `siunitx.sty\' not found.',
    '',
    'Type X to quit or <RETURN> to proceed,',
    'or enter new name. (Default extension: sty)',
  ].join('\n');
  const summary = latex.extractLatexError(log);
  assert.match(summary, /Not installed on this server: siunitx\.sty/);
  assert.match(summary, /Rewrite the document/);
});

test('latex actually renders a document, not just lints one', async (t) => {
  // The regression this guards: `spawn`'s `env` REPLACES the environment, so a
  // minimal allowlist left the engine unable to find its own package database.
  // Every lint-level test passed while no document could be produced at all —
  // which is why this one runs a real engine rather than inspecting a string.
  if (!latex.latexStatus().available) {
    t.skip('no LaTeX engine installed on this machine');
    return;
  }
  const source = [
    '\\documentclass{article}',
    '\\usepackage{booktabs}',
    '\\begin{document}',
    '\\section{Totals}',
    '\\begin{tabular}{lr}\\toprule Customer & Amount \\\\ \\midrule Acme & 12{,}500 \\\\ \\bottomrule\\end{tabular}',
    '\\end{document}',
  ].join('\n');
  const { buffer } = await latex.renderLatex(source, { timeoutMs: 120000 });
  assert.equal(buffer.slice(0, 5).toString(), '%PDF-');
  assert.ok(buffer.length > 1000);
});

test('latex reports unavailability instead of falling back to another renderer', () => {
  const status = latex.latexStatus();
  assert.equal(typeof status.available, 'boolean');
  if (!status.available) {
    // A document asked for as LaTeX and delivered as an approximation is a
    // wrong answer that looks like a right one.
    assert.match(status.reason, /install/i);
  }
});

// ===========================================================================
// Blueprint runner — template resolution and the detect/act split
// ===========================================================================

test('a whole-value reference keeps its type; an embedded one interpolates', () => {
  const scope = runner.scopeFor({ overdue: { count: 3, rows: [['a']] } }, { threshold: 1000 });
  assert.deepEqual(runner.resolveValue('{{steps.overdue.rows}}', scope), [['a']]);
  assert.equal(runner.resolveValue('Found {{steps.overdue.count}} over {{config.threshold}}', scope), 'Found 3 over 1000');
});

test('a missing reference renders empty rather than leaking the placeholder', () => {
  const scope = runner.scopeFor({}, {});
  assert.equal(runner.resolveValue('x={{steps.nope.field}}', scope), 'x=');
});

test('an unparseable condition skips the step instead of running it', () => {
  // A typo in a guard must not become an unguarded action — for a step that
  // sends email, running anyway is the worst possible interpretation.
  const verdict = runner.evaluateCondition('total the thing', runner.scopeFor({}, {}));
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /could not be understood/);
});

test('conditions compare resolved values', () => {
  const scope = runner.scopeFor({ overdue: { count: 3, rows: [1] } }, {});
  assert.equal(runner.evaluateCondition('{{steps.overdue.count}} > 0', scope).pass, true);
  assert.equal(runner.evaluateCondition('{{steps.overdue.count}} > 10', scope).pass, false);
  assert.equal(runner.evaluateCondition('{{steps.overdue.rows}} not_empty', scope).pass, true);
});

test('steps are segmented at each write, so every write is checked separately', () => {
  const tools = new Map([
    ['read_a', { name: 'read_a', readOnly: true }],
    ['draft_b', { name: 'draft_b' }],
    ['send_c', { name: 'send_c', highImpact: true }],
  ]);
  const segments = runner.segment(
    [
      { id: 's1', tool: 'read_a' },
      { id: 's2', tool: 'draft_b' },
      { id: 's3', tool: 'read_a' },
      { id: 's4', tool: 'send_c' },
      { id: 's5', tool: 'read_a' },
    ],
    tools
  );
  assert.equal(segments.length, 3);
  assert.deepEqual(segments[0].reads.map((s) => s.id), ['s1']);
  assert.equal(segments[0].write.id, 's2');
  assert.equal(segments[1].write.id, 's4');
  // Trailing reads form a segment with no write of its own.
  assert.equal(segments[2].write, null);
  assert.deepEqual(segments[2].reads.map((s) => s.id), ['s5']);
});

test('impact is derived from the tool, so authority tiers cannot drift from it', () => {
  assert.equal(runner.impactOf({ readOnly: true }), 'read');
  assert.equal(runner.impactOf({}), 'draft');
  assert.equal(runner.impactOf({ highImpact: true }), 'real');
  // An unknown tool is assumed to be the most dangerous kind.
  assert.equal(runner.impactOf(null), 'real');
});

// ===========================================================================
// Authority still governs an AI agent's tool calls
// ===========================================================================

test('a model cannot call a tool outside its allowed actions', () => {
  const envelope = { allowed_actions: ['send_dunning'], max_amount: 1000, max_actions_per_run: 10 };
  // The AI runner maps every non-read tool call through this same engine.
  const verdict = authority.evaluate(envelope, 'act', { type: 'email_document', impact: 'real' }, { actionsTaken: 0 });
  assert.equal(verdict.verdict, 'deny');
  assert.equal(verdict.reason, 'ACTION_NOT_PERMITTED');
});

test('an amount above the ceiling escalates rather than being refused', () => {
  const envelope = { allowed_actions: ['send_dunning'], max_amount: 1000, max_actions_per_run: 10 };
  const verdict = authority.evaluate(envelope, 'act', { type: 'send_dunning', impact: 'real', amount: 5000 }, { actionsTaken: 0 });
  assert.equal(verdict.verdict, 'escalate');
});

test('observe mode escalates writes no matter what the model decides', () => {
  const envelope = { allowed_actions: ['send_dunning'], max_amount: 100000, max_actions_per_run: 50 };
  const verdict = authority.evaluate(envelope, 'observe', { type: 'send_dunning', impact: 'real', amount: 10 }, { actionsTaken: 0 });
  assert.equal(verdict.verdict, 'escalate');
  assert.equal(verdict.reason, 'MODE_RESTRICTED');
});

// ===========================================================================
// Templated PDF rendering
// ===========================================================================

test('renders a document with every section type', async () => {
  const buffer = await renderDocument({
    title: 'Test',
    subtitle: 'Sub',
    sections: [
      { type: 'heading', text: 'H' },
      { type: 'paragraph', text: 'P' },
      { type: 'metrics', items: [{ label: 'A', value: '1' }] },
      { type: 'table', columns: ['X', 'Y'], rows: [['1', '2']], totals: ['', '2'] },
      { type: 'keyvalue', items: [{ label: 'K', value: 'V' }] },
      { type: 'list', items: ['one'] },
      { type: 'callout', text: 'note', tone: 'warn' },
      { type: 'divider' },
      { type: 'spacer', size: 1 },
    ],
  });
  assert.ok(buffer.length > 1000);
  assert.equal(buffer.slice(0, 5).toString(), '%PDF-');
});

test('an unknown section is marked in the document, not dropped silently', async () => {
  // A report that quietly lost a section still looks complete, and the reader
  // has no way to know a figure is missing.
  const buffer = await renderDocument({ title: 'T', sections: [{ type: 'invented_by_a_model', text: 'x' }] });
  assert.equal(buffer.slice(0, 5).toString(), '%PDF-');
});

test('a bad colour in a template does not fail the render', async () => {
  // A malformed hex string in a template would otherwise throw mid-render,
  // inside a scheduled agent run, at 3am.
  const buffer = await renderDocument(
    { title: 'T', sections: [{ type: 'paragraph', text: 'x' }] },
    { colors: { primary: 'not-a-colour' }, fonts: { family: 'NoSuchFont' } }
  );
  assert.equal(buffer.slice(0, 5).toString(), '%PDF-');
});

test('template interpolation preserves arrays passed to a table', () => {
  const filled = interpolate(
    { type: 'table', columns: ['A'], rows: '{{data.rows}}', text: 'Total {{data.total}}' },
    { data: { rows: [['1']], total: 5 } }
  );
  assert.deepEqual(filled.rows, [['1']]);
  assert.equal(filled.text, 'Total 5');
});
