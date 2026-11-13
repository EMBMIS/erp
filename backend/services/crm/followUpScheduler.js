/**
 * Stage-timer follow-up auto-scheduling (PHASE3_TEN_TENTHS CRM item:
 * "Follow-ups: task/activity auto-scheduling from ... stage timers").
 *
 * Deals.findAll already computes last_activity_at, so staleness was visible
 * on the pipeline board — nothing ever acted on it. This scans open deals
 * that have gone quiet past a threshold and drops a TASK activity for the
 * owner, so a deal doesn't silently die in NEGOTIATION because everyone
 * assumed someone else was chasing it.
 *
 * Idempotent by design: a deal already carrying an open, auto-scheduled
 * follow-up task is skipped, so running this daily does not pile up
 * duplicate tasks — the existing one just gets more overdue, which is
 * itself a signal.
 */

const { pool } = require('../../config/database');
const { currentCompanyId } = require('../companyContext');

const DEFAULT_STALE_DAYS = 7;
const AUTO_FOLLOW_UP_MARKER = '[auto-follow-up]';

/**
 * @param {{staleDays?: number}} opts
 * @param {string|null} companyId
 * @returns {{ scheduled: Array<{deal_id, deal_number, title, days_stale}> }}
 */
async function scheduleStaleDealFollowUps(opts = {}, companyId = currentCompanyId()) {
  const staleDays = Number(opts.staleDays) > 0 ? Number(opts.staleDays) : DEFAULT_STALE_DAYS;

  const params = [staleDays, `${AUTO_FOLLOW_UP_MARKER}%`];
  let companyClause = '';
  if (companyId) { companyClause = 'AND d.company_id = $3'; params.push(companyId); }

  const { rows: staleDeals } = await pool.query(
    `SELECT d.id, d.deal_number, d.title, d.owner_id, d.created_by,
            COALESCE(MAX(a.created_at), d.created_at) AS last_activity_at,
            EXTRACT(DAY FROM (CURRENT_TIMESTAMP - COALESCE(MAX(a.created_at), d.created_at)))::int AS days_stale
       FROM deals d
       LEFT JOIN activities a ON a.deal_id = d.id
      WHERE d.deleted_at IS NULL
        AND d.stage NOT IN ('WON', 'LOST')
        ${companyClause}
      GROUP BY d.id
     HAVING COALESCE(MAX(a.created_at), d.created_at) < CURRENT_TIMESTAMP - ($1 || ' days')::interval
      -- Skip deals that already have an open auto-scheduled follow-up task.
        AND NOT EXISTS (
              SELECT 1 FROM activities open_task
               WHERE open_task.deal_id = d.id
                 AND open_task.activity_type = 'TASK'
                 AND open_task.completed_at IS NULL
                 AND open_task.subject LIKE $2
            )`,
    params
  );

  const scheduled = [];
  for (const deal of staleDeals) {
    const { rows: [activity] } = await pool.query(
      `INSERT INTO activities (activity_type, subject, notes, due_date, deal_id, owner_id, created_by)
       VALUES ('TASK', $1, $2, CURRENT_DATE, $3, $4, $4)
       RETURNING id`,
      [
        `${AUTO_FOLLOW_UP_MARKER} Follow up on "${deal.title}" — no activity in ${deal.days_stale} days`,
        `Auto-scheduled: this deal (${deal.deal_number}) has had no logged activity since ${new Date(deal.last_activity_at).toISOString().split('T')[0]}.`,
        deal.id,
        deal.owner_id || deal.created_by,
      ]
    );
    scheduled.push({ deal_id: deal.id, deal_number: deal.deal_number, title: deal.title, days_stale: deal.days_stale, activity_id: activity.id });
  }

  return { scheduled, stale_days: staleDays };
}

module.exports = { scheduleStaleDealFollowUps, DEFAULT_STALE_DAYS, AUTO_FOLLOW_UP_MARKER };
