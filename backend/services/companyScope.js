/**
 * The ambient company for the current request — carrier only, no database.
 *
 * WHY THIS IS A SEPARATE FILE FROM companyContext.js
 * ===========================================================================
 * config/database.js needs to know which company the running request acts for,
 * so that it can put that company onto the connection before any query runs.
 * companyContext.js knows, but it requires config/database.js — so having the
 * database require it back would be a cycle, and in CommonJS a cycle resolves
 * to a half-initialised module rather than an error. The failure would be a
 * `undefined is not a function` at boot, on a good day, and a silently missing
 * company context on a bad one.
 *
 * So the AsyncLocalStorage lives here, with no dependencies at all. Both the
 * database layer and companyContext.js require this, and neither requires the
 * other. It holds no policy and makes no decisions; it is a variable that
 * follows the call stack.
 */

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/** The company for the current request, or null outside one. */
function currentCompanyId() {
  return storage.getStore()?.companyId || null;
}

/** Run `fn` with `companyId` as the ambient company. */
function runWithCompany(companyId, fn) {
  return storage.run({ companyId }, fn);
}

module.exports = { storage, currentCompanyId, runWithCompany };
