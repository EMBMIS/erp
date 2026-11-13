// Every tool Simeli can call has to actually run.
//
// The registry holds 122 tools, 93 of them read-only, spread across a dozen
// modules. The agent picks from all of them, and a tool with a typo'd column
// or a table that was renamed underneath it does not fail at startup — it
// fails the first time a person asks the question that reaches it, mid-answer,
// as a dead end in the middle of an investigation.
//
// So this walks the read-only surface and calls every one of them the way the
// agent does. The bar is deliberately not "returns useful data": the database
// here is empty, and "nothing matched" is a correct answer. The bar is that
// nothing fails STRUCTURALLY — no undefined table, column or function, no
// SQL syntax error, no TypeError from a handler that never ran. Those are
// defects in the tool itself, and they are invisible until someone asks.
//
// Tools that need the network, a model provider or a paid API are excluded by
// name below, with the reason: their failure here would say nothing about the
// tool and everything about this machine.
//
// Run on its own:  node --test tests/agentToolSurface.test.js

const nodeTest = require('node:test');
const { test, before, after } = require('./helpers/withCompany').wrapHooks(nodeTest);
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const { tools, executeTool } = require('../services/ai/toolRegistry');

// Reaching outside this machine, or needing a key this machine does not have.
// Each entry is a fact about the environment, not about the tool.
const NEEDS_THE_OUTSIDE = new Set([
  'web_search',                       // a search API
  'search_documents',                 // local embedding model, downloaded on first use
  'search_similar_purchase_orders',   // "
  'search_similar_sales_orders',      // "
  'search_similar_inventory_items',   // "
  'suggest_gl_accounts',              // asks a model
  'suggest_journal_entry',            // "
  'suggest_visualization',            // "
  'execute_sandboxed_code',           // spawns a sandbox
  'run_agent_dry_run',                // runs a whole agent
  'try_tool',                         // calls another tool by name
  'check_latex_available',            // shells out to a LaTeX install
]);

// Postgres and JavaScript errors that mean the tool is broken, as opposed to
// the arguments being wrong or the data being absent.
const STRUCTURAL_SQLSTATE = new Set([
  '42P01', // undefined_table
  '42703', // undefined_column
  '42883', // undefined_function
  '42601', // syntax_error
  '42P02', // undefined_parameter
  '42804', // datatype_mismatch
]);

function isStructural(err) {
  if (!err) return false;
  if (STRUCTURAL_SQLSTATE.has(err.code)) return true;
  return err instanceof TypeError || err instanceof ReferenceError;
}

/**
 * A minimal argument that satisfies the schema's shape.
 *
 * Not a realistic value — the point is to get past argument validation and
 * into the query, where a broken tool gives itself away. A tool that rejects
 * these as invalid has still demonstrated it runs.
 */
function sampleArgs(tool) {
  const schema = tool.inputSchema || {};
  const props = schema.properties || {};
  const args = {};
  for (const name of schema.required || []) {
    const spec = props[name] || {};
    if (Array.isArray(spec.enum) && spec.enum.length) { args[name] = spec.enum[0]; continue; }
    switch (spec.type) {
      case 'number': case 'integer': args[name] = 1; break;
      case 'boolean': args[name] = false; break;
      case 'array': args[name] = []; break;
      case 'object': args[name] = {}; break;
      default: args[name] = 'test';
    }
  }
  return args;
}

let dbAvailable = false;
let ctx = {};

before(async () => {
  try {
    await pool.query('SELECT 1 FROM companies LIMIT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
  const { rows } = dbAvailable
    ? await pool.query('SELECT id FROM users LIMIT 1')
    : { rows: [] };
  ctx = { userId: rows[0]?.id || null, actor: 'tool-surface-test' };
});

after(async () => {
  await pool.end();
});

const readOnly = tools.filter((t) => t.readOnly && !NEEDS_THE_OUTSIDE.has(t.name));

test('the read-only surface is the size it is meant to be', () => {
  // A guard against this whole file quietly testing nothing, which is what
  // happens when a registry refactor changes how tools are collected.
  assert.ok(readOnly.length > 60, `only ${readOnly.length} read-only tools were found`);
});

for (const tool of readOnly) {
  test(`${tool.name} runs`, async (t) => {
    if (!dbAvailable) return t.skip('no database');
    try {
      const result = await executeTool(tool.name, sampleArgs(tool), ctx);
      assert.notEqual(result, undefined, 'a tool must return something the model can read');
    } catch (err) {
      assert.ok(
        !isStructural(err),
        `${tool.name} failed structurally (${err.code || err.constructor.name}): ${err.message}`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// What a tool says when the model gets an argument wrong
// ---------------------------------------------------------------------------

const { readable } = require('../services/ai/toolRegistry');

function pgError(message, code = '22P02') {
  const err = new Error(message);
  err.code = code;
  return err;
}

test('a name passed where an id belongs points at resolve_entity', () => {
  const err = readable(
    pgError('invalid input syntax for type uuid: "Vestas"'),
    'get_deal',
    { deal_id: 'Vestas' },
  );
  assert.match(err.message, /get_deal/);
  assert.match(err.message, /deal_id/, 'names the argument that was wrong');
  assert.match(err.message, /Vestas/, 'quotes back what was actually sent');
  assert.match(err.message, /resolve_entity/, 'names the way forward');
  assert.doesNotMatch(err.message, /invalid input syntax/, 'no database jargon reaches the model');
});

test('the original error is kept as the cause', () => {
  const original = pgError('invalid input syntax for type uuid: "x"');
  const err = readable(original, 'get_project', { project_id: 'x' });
  assert.equal(err.cause, original);
  assert.equal(err.code, '22P02');
});

test('a bad date says what a date is, not how to resolve an entity', () => {
  const err = readable(
    pgError('invalid input syntax for type date: "last Tuesday"'),
    'compare_periods',
    { period_start: 'last Tuesday' },
  );
  assert.match(err.message, /date/);
  assert.doesNotMatch(err.message, /resolve_entity/);
});

test('an error of any other kind is passed through untouched', () => {
  const original = pgError('connection terminated', 'ECONNRESET');
  assert.equal(readable(original, 'get_deal', {}), original);
});

test('an unparseable 22P02 is left alone rather than guessed at', () => {
  const original = pgError('invalid input syntax, somehow');
  assert.equal(readable(original, 'get_deal', {}), original);
});
