/**
 * Learning from overrides (ROADMAP Task 21 — A6).
 *
 * When a user corrects something the assistant suggested, that correction is
 * persisted as a company-level preference and fed back into the agent's system
 * prompt on every later turn. That feedback is the whole point: recording
 * corrections without applying them means a company that has fixed the same
 * field fifty times gets the same wrong answer on the fifty-first.
 *
 * WHAT WAS WRONG
 * ---------------------------------------------------------------------------
 * This service used to write to `ai_settings (company_id, key, value)`.
 * ai_settings has no key or value column — it holds ONE config row per company
 * (model, response_style, max_steps, ...). Every recordOverride() call threw
 * `column "key" does not exist`, so the feature had never once succeeded, and
 * getLearnedPreferences() was only ever reachable from a GET endpoint that
 * returned an empty object. Preferences now have their own scoped table
 * (migration 202608021200).
 */

const { pool } = require('../../config/database');
const { currentCompanyId } = require('../companyContext');

class PreferenceLearningService {
  /**
   * Capture a user override as a learned company preference.
   *
   * Re-correcting the same field updates the stored value and increments
   * `occurrences` rather than inserting a duplicate — a preference asserted
   * repeatedly is a stronger signal than one asserted once, and the prompt
   * fragment says so.
   *
   * @param {{fieldName: string, originalValue?, correctedValue, notes?, userId?}} override
   * @param {string} [companyId] defaults to the session's company
   */
  static async recordOverride(
    { fieldName, originalValue, correctedValue, notes, userId = null },
    companyId = currentCompanyId()
  ) {
    if (!fieldName) throw new Error('fieldName is required to record an override');
    if (correctedValue == null || correctedValue === '') {
      throw new Error('correctedValue is required to record an override');
    }

    const { rows } = await pool.query(
      `INSERT INTO ai_learned_preferences
         (company_id, field_name, corrected_value, original_value, notes, created_by)
       VALUES (COALESCE($1, public.current_company_id()), $2, $3, $4, $5, $6)
       ON CONFLICT (company_id, field_name) DO UPDATE
         SET corrected_value = EXCLUDED.corrected_value,
             original_value  = EXCLUDED.original_value,
             notes           = EXCLUDED.notes,
             occurrences     = ai_learned_preferences.occurrences + 1,
             updated_at      = CURRENT_TIMESTAMP
       RETURNING *`,
      [companyId || null, String(fieldName), String(correctedValue),
        originalValue != null ? String(originalValue) : null, notes || null, userId]
    );

    return rows[0];
  }

  /**
   * Every learned preference for a company, strongest (most re-corrected) first.
   */
  static async getLearnedPreferences(companyId = currentCompanyId()) {
    const { rows } = await pool.query(
      `SELECT field_name, corrected_value, original_value, notes, occurrences, updated_at
         FROM ai_learned_preferences
        WHERE company_id = COALESCE($1, public.current_company_id())
        ORDER BY occurrences DESC, updated_at DESC`,
      [companyId || null]
    );
    return rows;
  }

  /**
   * Render learned preferences as a system-prompt fragment.
   *
   * Returns '' when nothing has been learned, so the caller can append
   * unconditionally without leaving a dangling header in the prompt.
   *
   * @param {string} [companyId]
   * @param {number} [limit] cap the fragment so a company with hundreds of
   *   preferences cannot crowd the rest of the system prompt out of context.
   */
  static async buildPromptFragment(companyId = currentCompanyId(), limit = 40) {
    const preferences = await PreferenceLearningService.getLearnedPreferences(companyId);
    if (!preferences.length) return '';

    const lines = preferences.slice(0, limit).map((p) => {
      const from = p.original_value ? ` (not ${p.original_value})` : '';
      const why = p.notes ? ` — ${p.notes}` : '';
      // Only surface the count once it actually means something; "corrected 1
      // time" is noise on every single line.
      const strength = p.occurrences > 1 ? ` [corrected ${p.occurrences}x]` : '';
      return `- ${p.field_name}: use ${p.corrected_value}${from}${why}${strength}`;
    });

    const omitted = preferences.length - lines.length;
    if (omitted > 0) lines.push(`- (…and ${omitted} more, strongest shown first)`);

    return [
      'LEARNED PREFERENCES FOR THIS COMPANY',
      'These are corrections this company has made to your previous answers.',
      'Follow them by default. If you deliberately depart from one, say why.',
      ...lines,
    ].join('\n');
  }
}

module.exports = PreferenceLearningService;
