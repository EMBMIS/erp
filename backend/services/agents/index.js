/**
 * Agent registry entry point.
 *
 * Importing this module registers every agent implementation with the runtime.
 * Registration is import-time and side-effect-free with respect to the database:
 * nothing runs, nothing is enabled. An agent only executes once it has been
 * synced to agent_definitions AND explicitly enabled, which is a deliberate
 * operator action rather than a consequence of deploying code.
 */

const runtime = require('./runtime');
const scheduler = require('./scheduler');
const authority = require('./authority');
const blueprints = require('./blueprintStore');
const events = require('./events');

const AGENTS = [
  require('./definitions/collectionsAgent'),
  require('./definitions/reconciliationAgent'),
  require('./definitions/procurementAgent'),
  require('./definitions/anomalyAgent'),
  require('./definitions/dataIntegrityAgent'),
];

AGENTS.forEach((agent) => runtime.register(agent));

module.exports = {
  ...runtime,
  ...scheduler,
  authority,
  // User-authored agents. Not registered with `register()` above: they are
  // resolved from the database per run, so an agent built five minutes ago is
  // runnable without a restart, and one that is deleted stops being runnable
  // without leaving a stale in-memory implementation behind.
  blueprints,
  ...events,
  AGENTS,
};
