/**
 * What each person keeps on their rail.
 *
 * ===========================================================================
 * THE THREE STATES
 * ===========================================================================
 *   never decided     the defaults — every core application that is switched
 *                     on. Almost everybody wants this and nobody should have
 *                     to configure it.
 *   pinned some       exactly those, in the order they chose.
 *   pinned nothing    an empty rail, on purpose. Everything is reached from
 *                     the launcher and the switcher.
 *
 * The third is why the preference is a ROW with a list inside it rather than a
 * join table: with rows-per-pin, "no rows" would mean both "new here" and
 * "deliberately empty", and one of those two people would get a rail they
 * explicitly did not ask for.
 *
 * ===========================================================================
 * A PIN IS A WISH, NOT A GRANT
 * ===========================================================================
 * Pins are filtered against what the company actually runs, every time they
 * are read. Pinning something has never been a way to reach it: an
 * application that is switched off simply does not appear — and the pin is
 * left alone rather than deleted, so switching it back on restores their rail
 * instead of having silently forgotten it.
 */

const companyContext = require('../companyContext');
const { asCompany } = require('./db');
const appDirectory = require('./appDirectory');

const MAX_PINS = 24;

class PreferenceError extends Error {
  constructor(message, code = 'PREFERENCE_ERROR', status = 400) {
    super(message);
    this.name = 'PreferenceError';
    this.code = code;
    this.status = status;
  }
}

/** The stored list, or null when this person has never decided. */
async function stored(companyId, userId) {
  return companyContext.withCompany(companyId, async (client) => {
    const { rows } = await client.query(
      'SELECT pinned FROM user_shell_preferences WHERE user_id = $1 AND company_id = $2',
      [userId, companyId]
    );
    return rows[0] ? rows[0].pinned : null;
  });
}

/**
 * The rail this person should see, resolved against what is actually running.
 *
 * Returns the applications themselves rather than keys: every caller needs the
 * name, icon and route to draw anything, and a round trip per plate would be a
 * strange way to save a join.
 */
async function rail(companyId, userId) {
  const [enabled, chosen] = await Promise.all([
    appDirectory.enabled(companyId),
    userId ? stored(companyId, userId) : null,
  ]);
  const byKey = new Map(enabled.map((a) => [a.key, a]));

  // Never decided: the core applications, in manifest order.
  if (chosen === null) {
    return { customised: false, pinned: enabled.filter((a) => a.kind === 'native') };
  }

  // Decided: exactly what they chose, in their order, minus anything no
  // longer running. An empty list is a real answer.
  return { customised: true, pinned: chosen.map((key) => byKey.get(key)).filter(Boolean) };
}

/**
 * Replace the list.
 *
 * Validated against the applications this company runs, so a pin can never
 * name something the person could not otherwise open — the rail is a shortcut
 * to what they already have, never a way to acquire something.
 */
async function setPins(companyId, userId, keys) {
  if (!Array.isArray(keys)) {
    throw new PreferenceError('Pins must be a list of application keys.', 'PINS_NOT_A_LIST');
  }
  if (keys.length > MAX_PINS) {
    throw new PreferenceError(`A rail holds at most ${MAX_PINS} applications.`, 'TOO_MANY_PINS');
  }

  const enabled = await appDirectory.enabled(companyId);
  const available = new Set(enabled.map((a) => a.key));
  const unknown = keys.filter((k) => !available.has(k));
  if (unknown.length) {
    throw new PreferenceError(
      `Not something you can pin: ${unknown.join(', ')}.`, 'UNKNOWN_APPLICATION', 404
    );
  }
  // Deduplicated, order preserved — two plates for one application is not a
  // preference anybody holds, it is a double click.
  const unique = [...new Set(keys)];

  await companyContext.withCompany(companyId, (client) => client.query(
    `INSERT INTO user_shell_preferences (user_id, company_id, pinned)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (user_id, company_id)
     DO UPDATE SET pinned = EXCLUDED.pinned, updated_at = CURRENT_TIMESTAMP`,
    [userId, companyId, JSON.stringify(unique)]
  ));
  return rail(companyId, userId);
}

/** Forget the choice and go back to the defaults. */
async function reset(companyId, userId) {
  await companyContext.withCompany(companyId, (client) => client.query(
    'DELETE FROM user_shell_preferences WHERE user_id = $1 AND company_id = $2',
    [userId, companyId]
  ));
  return rail(companyId, userId);
}

module.exports = {
  rail: (companyId, userId) => asCompany(companyId, () => rail(companyId, userId)),
  setPins: (companyId, userId, keys) => asCompany(companyId, () => setPins(companyId, userId, keys)),
  reset: (companyId, userId) => asCompany(companyId, () => reset(companyId, userId)),
  PreferenceError,
  MAX_PINS,
};
