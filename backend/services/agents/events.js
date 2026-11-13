/**
 * Event triggers for agents.
 *
 * The scheduler answers "run this every hour". This answers "run this when X
 * happens" — an invoice went overdue, a stock level crossed a threshold, a
 * webhook arrived. A blueprint declares `trigger_type: 'event'` with an
 * `event_key`, and anything in the system that knows the event occurred calls
 * `emitAgentEvent(key, payload)`.
 *
 * Deliberate properties:
 *
 *   • Emitting is fire-and-forget and never throws into the caller. An event is
 *     something that already happened; an agent failing to react to it must not
 *     roll back the business transaction that caused it. This is the same rule
 *     the rest of the AI surface follows — an AI failure never blocks a
 *     business transaction.
 *   • Only ENABLED agents react. A blueprint that declares an event trigger but
 *     has not been granted autonomy stays inert, exactly as it would on a
 *     schedule.
 *   • The payload is data, not instruction. It is exposed to steps as
 *     {{event.*}} template values only — it cannot name a tool, change a step
 *     or widen authority. Whatever emitted the event cannot make an agent do
 *     something its blueprint does not already say it does.
 */

const { pool } = require('../../config/database');

async function listeners(eventKey) {
  const { rows } = await pool.query(
    `SELECT b.agent_key, b.display_name, d.enabled
       FROM agent_blueprints b
       JOIN agent_definitions d ON d.agent_key = b.agent_key
      WHERE b.trigger_type = 'event' AND b.event_key = $1`,
    [eventKey]
  );
  return rows;
}

/**
 * Fire an event. Returns a summary of what ran; callers that do not care can
 * ignore it (and should not await it inside a transaction).
 *
 * @param {string} eventKey
 * @param {object} payload   available to steps as {{event.*}}
 * @param {object} options   { triggeredBy, dryRun }
 */
async function emitAgentEvent(eventKey, payload = {}, options = {}) {
  const results = [];
  try {
    const runtime = require('./runtime');
    const found = await listeners(eventKey);

    for (const listener of found) {
      if (!listener.enabled) {
        results.push({ agent_key: listener.agent_key, status: 'SKIPPED', reason: 'Agent is disabled.' });
        continue;
      }
      try {
        results.push(await runtime.runAgent(listener.agent_key, {
          trigger: 'event',
          triggeredBy: options.triggeredBy || null,
          dryRun: !!options.dryRun,
          eventPayload: payload,
        }));
      } catch (err) {
        // One broken listener must not stop the others, and must not surface as
        // a failure of whatever emitted the event.
        console.error(`Agent ${listener.agent_key} failed reacting to "${eventKey}":`, err.message);
        results.push({ agent_key: listener.agent_key, status: 'FAILED', error: err.message });
      }
    }
  } catch (err) {
    console.error(`Could not dispatch agent event "${eventKey}":`, err.message);
  }
  return { event: eventKey, listeners: results.length, results };
}

module.exports = { emitAgentEvent, listeners };
