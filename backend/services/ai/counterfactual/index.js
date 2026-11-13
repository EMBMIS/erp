/**
 * Counterfactual decision engine — public surface.
 *
 * The one capability in this ERP that a bolt-on cannot reproduce: a course of
 * action is APPLIED to the real ledger, inside a transaction that is guaranteed
 * to roll back, and the resulting numbers are read back out of the database
 * rather than predicted. See engine.js for the sequence and shadowLedger.js for
 * the guarantees that make it safe.
 */

const engine = require('./engine');
const effects = require('./effects');
const scoring = require('./scoring');
const branches = require('./branches');
const observables = require('./observables');

module.exports = {
  decide: engine.decide,
  getRun: engine.getRun,
  listRuns: engine.listRuns,
  catalogue: effects.catalogue,
  DEFAULT_OBJECTIVE: scoring.DEFAULT_OBJECTIVE,
  SCENARIOS: Object.keys(branches.SCENARIOS),
  measure: observables.measure,
};
