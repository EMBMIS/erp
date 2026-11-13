/**
 * Gives node:test's test/before/after/beforeEach/afterEach callbacks a real
 * company as the ambient companyScope context.
 *
 * Why this exists: config/database.js's `pool.query` reads
 * companyScope.currentCompanyId() (AsyncLocalStorage) on every call and
 * applies `SET LOCAL app.current_company_id` accordingly — that is how RLS's
 * `WITH CHECK`/`USING (company_id = current_company_id())` policies get a
 * value to check at all. Setting the company inside a suite's `before()` does
 * NOT propagate to separately-scheduled `test()` callbacks — node:test invokes
 * them as independent continuations, not nested inside before()'s own async
 * chain — so each hook/test needs its own `runWithCompany`. Without it,
 * current_company_id() resolves to NULL and every insert against a
 * company-scoped table is rejected with 42501, which is what a large fraction
 * of this suite hit once RLS became genuinely enforced (config/database.js
 * preferring APP_DATABASE_URL's restricted qira_app role over a superuser
 * bypass connection).
 *
 * Usage — replace the node:test import in a test file:
 *   const nodeTest = require('node:test')
 *   const { test, before, after, beforeEach, afterEach } = require('./helpers/withCompany').wrapHooks(nodeTest)
 * Everything else in the file (test bodies, assertions, fixture helpers using
 * the shared `pool`) is unchanged — they inherit the ambient company because
 * pool.query reads it implicitly.
 */

const companyContext = require('../../services/companyContext');

let cachedCompanyId = null;
async function resolveCompanyId() {
  if (cachedCompanyId) return cachedCompanyId;
  cachedCompanyId = await companyContext.getDefaultCompanyId();
  return cachedCompanyId;
}

// Wraps a single callback (test body or hook body) to run inside
// runWithCompany. node:test passes each callback a TestContext (`t`) or,
// for before/after, no argument at all — forwarding `...args` covers both.
function withCompany(fn) {
  return async (...args) => {
    const companyId = await resolveCompanyId();
    return companyContext.runWithCompany(companyId, () => fn(...args));
  };
}

function wrapHooks(raw) {
  return {
    test: (name, fn) => raw.test(name, withCompany(fn)),
    before: (fn) => raw.before(withCompany(fn)),
    after: (fn) => raw.after(withCompany(fn)),
    beforeEach: (fn) => raw.beforeEach(withCompany(fn)),
    afterEach: (fn) => raw.afterEach(withCompany(fn)),
  };
}

// For suites that seed their OWN dedicated company (rather than using the
// shared default) — anomalyDetection/cashflowForecast/consolidation/
// continuousClose all create a throwaway company partway through before()
// via multiCompany.js's insertAsAppRole. Their test()/after() bodies must run
// with THAT company as ambient context, not the default one. `getCompanyId`
// is called lazily at invocation time (a closure reading the suite's own
// `companyId` variable), which works because by the time test()/after() run,
// before() has already assigned it — before() itself is NOT wrapped by this;
// it wraps its own post-company-creation portion directly (see those files).
function withCompanyId(getCompanyId) {
  return (fn) => async (...args) => {
    const companyId = typeof getCompanyId === 'function' ? await getCompanyId() : getCompanyId;
    return companyContext.runWithCompany(companyId, () => fn(...args));
  };
}

function wrapHooksFor(raw, getCompanyId) {
  const wrap = withCompanyId(getCompanyId);
  return {
    test: (name, fn) => raw.test(name, wrap(fn)),
    after: (fn) => raw.after(wrap(fn)),
    beforeEach: (fn) => raw.beforeEach(wrap(fn)),
    afterEach: (fn) => raw.afterEach(wrap(fn)),
    // before is deliberately NOT wrapped here — see the file header.
    before: raw.before,
  };
}

module.exports = { withCompany, wrapHooks, withCompanyId, wrapHooksFor, resolveCompanyId };
