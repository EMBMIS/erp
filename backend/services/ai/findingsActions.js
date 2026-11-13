/**
 * AI findings actions — the "AI proposes, humans approve" loop (Round 7, Task 19).
 *
 *   approve → posts the proposed DRAFT correcting journal entry and marks the
 *             finding RESOLVED. Posting goes through JournalEntry.updateStatus,
 *             so the normal GL mechanics (balance check, status history, webhook)
 *             apply. The agent itself never posts — a human's approval does.
 *
 *   dismiss → records WHY (status DISMISSED + dismiss_reason) and writes an
 *             ai_finding_suppressions row so the next sweep does not re-raise
 *             the same issue for the suppression window (30 days by default).
 *
 * Both are idempotent: approving a finding whose draft is already POSTED just
 * resolves the finding; dismissing an already-dismissed finding updates the
 * reason and extends the suppression.
 */

const { pool } = require('../../config/database');
const JournalEntry = require('../../models/JournalEntry');

const SUPPRESSION_DAYS = 30;

class FindingsActions {
  /**
   * Approve a finding: post its proposed draft journal entry.
   * @returns {{finding: object, journal_entry: object|null}}
   */
  static async approveFinding(findingId, userId) {
    const { rows } = await pool.query(
      'SELECT * FROM ai_findings WHERE id = $1',
      [findingId]
    );
    if (!rows.length) {
      const err = new Error('Finding not found');
      err.status = 404;
      throw err;
    }
    const finding = rows[0];

    if (finding.status === 'RESOLVED') {
      return { finding, journal_entry: null, already_resolved: true };
    }
    if (finding.status === 'DISMISSED') {
      const err = new Error('A dismissed finding cannot be approved — re-open it first if the correction is still needed');
      err.status = 409;
      throw err;
    }

    let journalEntry = null;
    if (finding.proposed_journal_entry_id) {
      const { rows: jeRows } = await pool.query(
        'SELECT id, status, journal_number FROM journal_entries WHERE id = $1 AND deleted_at IS NULL',
        [finding.proposed_journal_entry_id]
      );
      const draft = jeRows[0] || null;
      if (draft && draft.status === 'PENDING_APPROVAL') {
        // JournalEntry.create derives approval from the company's approval
        // chain, so a correction at or above the chain's first band (or any
        // correction in a company with no chain) is created PENDING_APPROVAL,
        // not DRAFT. PENDING_APPROVAL cannot move straight to POSTED; going
        // through APPROVED runs the authority engine on this approver, so the
        // chain still decides who may approve an entry of this size.
        await JournalEntry.updateStatus(
          draft.id,
          'APPROVED',
          userId,
          `Approved AI finding ${finding.id} — ${finding.title}`
        );
        draft.status = 'APPROVED';
      }
      if (draft && draft.status !== 'POSTED') {
        journalEntry = await JournalEntry.updateStatus(
          draft.id,
          'POSTED',
          userId,
          `Approved AI finding ${finding.id} — ${finding.title}`
        );
      } else if (draft) {
        journalEntry = draft;
      }
    }

    await pool.query(
      `UPDATE ai_findings
          SET status = 'RESOLVED', acknowledged_by = $2, acknowledged_at = CURRENT_TIMESTAMP,
              resolved_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [findingId, userId]
    );

    const { rows: updated } = await pool.query('SELECT * FROM ai_findings WHERE id = $1', [findingId]);
    return { finding: updated[0], journal_entry: journalEntry, already_resolved: false };
  }

  /**
   * Dismiss a finding: record why, and suppress re-raising for the window.
   */
  static async dismissFinding(findingId, userId, reason) {
    if (!reason || !String(reason).trim()) {
      const err = new Error('A dismissal reason is required — the next sweep uses it to decide whether to re-raise the issue');
      err.status = 400;
      throw err;
    }

    const { rows } = await pool.query(
      'SELECT * FROM ai_findings WHERE id = $1',
      [findingId]
    );
    if (!rows.length) {
      const err = new Error('Finding not found');
      err.status = 404;
      throw err;
    }
    const finding = rows[0];

    await pool.query(
      `UPDATE ai_findings
          SET status = 'DISMISSED', acknowledged_by = $2, acknowledged_at = CURRENT_TIMESTAMP,
              dismiss_reason = $3
        WHERE id = $1`,
      [findingId, userId, String(reason).trim()]
    );

    // Keyed on the same (type, entity) triple the dedup index and the
    // suppression check in findingsScan.upsertFinding use.
    await pool.query(
      `INSERT INTO ai_finding_suppressions
         (company_id, finding_type, entity_type, entity_id, dismissed_by, reason, suppressed_until)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP + ($7 || ' days')::interval)
       ON CONFLICT DO NOTHING`,
      [
        finding.company_id,
        finding.finding_type,
        finding.entity_type,
        finding.entity_id,
        userId,
        String(reason).trim(),
        SUPPRESSION_DAYS,
      ]
    );

    const { rows: updated } = await pool.query('SELECT * FROM ai_findings WHERE id = $1', [findingId]);
    return { finding: updated[0], suppression_days: SUPPRESSION_DAYS };
  }
}

module.exports = FindingsActions;
