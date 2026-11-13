// The company-context fallback in middleware/auth.js.
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// `establishCompany` has a catch block that decides what to do when company
// resolution fails. It shipped calling `companyContext.isMultiCompanyEnabled()`
// — a function that does not exist; the export is `isolationEnabled`. Because
// the call sat INSIDE a catch handler, the resulting TypeError escaped the
// function entirely: `auth` returns that promise without awaiting it, Express 4
// ignores returned promises, so neither next() nor next(err) was ever called.
// The request hung, and on Node 15+ the unhandled rejection terminated the
// process. A typo in a recovery path could take down the API.
//
// The full backend suite passed throughout, because nothing reached the catch.
// That is the whole lesson: the error path needs tests precisely because it is
// the path no ordinary request exercises.
//
// These tests drive the real middleware through the real export surface — no
// reaching into internals — via the internal-service-token path, which is the
// shortest authenticated route to `establishCompany` that touches neither JWT
// verification nor the users table. `primaryCompanyFor` is then stubbed to
// throw, which is what forces the catch.
//
// Run on its own:  node --test tests/authCompanyFallback.test.js

const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');

const companyContext = require('../services/companyContext');
const { auth } = require('../middleware/auth');
const { pool } = require('../config/database');

// None of these tests touch the database directly, but requiring
// companyContext/auth transitively opens config/database.js's pool
// (min: 2 keepalive connections), which otherwise keeps the process alive
// forever after the last test — node --test waits for the event loop to
// drain before exiting.
after(() => pool.end());

const SERVICE_TOKEN = 'test-internal-service-token';

// Saved so each test restores exactly what it replaced, rather than assuming
// what the original was.
let originalPrimaryCompanyFor;
let originalIsolationEnabled;
let originalEnvToken;

beforeEach(() => {
  originalPrimaryCompanyFor = companyContext.primaryCompanyFor;
  originalIsolationEnabled = companyContext.isolationEnabled;
  originalEnvToken = process.env.INTERNAL_SERVICE_TOKEN;
  process.env.INTERNAL_SERVICE_TOKEN = SERVICE_TOKEN;
});

afterEach(() => {
  companyContext.primaryCompanyFor = originalPrimaryCompanyFor;
  companyContext.isolationEnabled = originalIsolationEnabled;
  if (originalEnvToken === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
  else process.env.INTERNAL_SERVICE_TOKEN = originalEnvToken;
});

/** Minimal req/res/next triple that records what the middleware did with it. */
function harness() {
  const calls = { next: 0, status: null, json: null };
  const req = {
    header: (name) => (name === 'X-Internal-Service-Token' ? SERVICE_TOKEN : undefined),
  };
  const res = {
    status(code) { calls.status = code; return this; },
    json(body) { calls.json = body; return this; },
  };
  const next = () => { calls.next += 1; };
  return { req, res, next, calls };
}

/** Force `establishCompany` into its catch block. */
function breakCompanyResolution() {
  companyContext.primaryCompanyFor = async () => {
    throw new Error('simulated company lookup failure');
  };
}

// ---------------------------------------------------------------------------
// The regression guard.
//
// This is the assertion that would have caught the original bug, and it costs
// nothing. A misspelled method on a module is invisible until the line runs;
// naming it here makes it visible at test time instead.
// ---------------------------------------------------------------------------
test('companyContext exports isolationEnabled as a function', () => {
  assert.equal(
    typeof companyContext.isolationEnabled,
    'function',
    'middleware/auth.js calls companyContext.isolationEnabled() on its fallback path'
  );
});

test('the fallback never calls a method companyContext does not export', async () => {
  const fallbackNames = ['isolationEnabled'];
  for (const name of fallbackNames) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(companyContext, name),
      `companyContext must export ${name}`
    );
  }
});

// ---------------------------------------------------------------------------
// Behaviour on the failure path.
// ---------------------------------------------------------------------------

test('single-company install: failed resolution continues the request', async () => {
  breakCompanyResolution();
  companyContext.isolationEnabled = async () => false;

  const { req, res, next, calls } = harness();
  await auth(req, res, next);

  assert.equal(calls.next, 1, 'request should continue when isolation is off');
  assert.equal(calls.status, null, 'no error response should be sent');
});

test('isolated install: failed resolution refuses rather than serving no rows', async () => {
  breakCompanyResolution();
  companyContext.isolationEnabled = async () => true;

  const { req, res, next, calls } = harness();
  await auth(req, res, next);

  assert.equal(calls.next, 0, 'request must not continue without company context');
  assert.equal(calls.status, 500);
  assert.match(calls.json.error, /company context/i);
});

// ---------------------------------------------------------------------------
// The property the original bug actually violated: whatever goes wrong, the
// middleware must resolve — it may not hang, and it may not reject.
// ---------------------------------------------------------------------------

test('an error inside the fallback itself still resolves the request', async () => {
  breakCompanyResolution();
  companyContext.isolationEnabled = async () => {
    throw new Error('isolation probe failed too');
  };

  const { req, res, next, calls } = harness();
  await auth(req, res, next);

  assert.equal(calls.next, 1, 'a failing fallback must still hand control onward');
});

test('a non-function on the fallback path cannot reject the middleware', async () => {
  breakCompanyResolution();
  // Exactly the original defect: the property is not callable.
  companyContext.isolationEnabled = undefined;

  const { req, res, next, calls } = harness();

  // The assertion is that this does not reject. Before the fix it threw a
  // TypeError out of the catch block, which Express never sees.
  await assert.doesNotReject(() => auth(req, res, next));
  assert.equal(calls.next, 1, 'request must still continue rather than hang');
});
