const { pool } = require('../config/database');

/**
 * Simeli's own overview, in one round trip.
 *
 * EVERY FIGURE HERE IS SOMETHING THE SYSTEM DID, NOT SOMETHING IT CLAIMS
 * ---------------------------------------------------------------------------
 * An AI panel is the easiest place in an ERP to put a number nobody can check.
 * "Models active", "queries processed", "knowledge items" all sound like
 * measurements and can be invented without anyone noticing for a year.
 *
 * So each figure here maps to rows in a table:
 *
 *   Insights      ai_findings — things Simeli flagged, by severity and status.
 *   Automations   agent_runs — actual executions, with their outcomes.
 *   Agents        agent_definitions that are enabled.
 *   Actions       agent_run_actions — individual decisions with reasoning.
 *   Knowledge     kb_documents and their embeddings.
 *
 * A count that has no table behind it is not returned. Where a table is absent
 * in a given deployment the query is allowed to fail on its own and the field
 * comes back null, rather than a zero that reads as "nothing happened".
 *
 * ESCALATIONS AND FAILURES ARE NOT HIDDEN BEHIND THE SUCCESSES
 * ---------------------------------------------------------------------------
 * An autonomous agent that fails, or hands work back to a human, is the most
 * important thing on this screen — it is the only signal that the automation is
 * not doing what was assumed. Both are counted separately and surfaced.
 */

/** Runs a query, returning null instead of throwing when the table is absent. */
async function optional(sql, params = []) {
  try {
    const { rows } = await pool.query(sql, params);
    return rows;
  } catch (error) {
    // 42P01 is undefined_table: a deployment without this feature migrated in.
    // Anything else is a real fault and should surface as one.
    if (error.code === '42P01') return null;
    throw error;
  }
}

async function getSimeliAnalytics(months = 12) {
  const span = Math.max(1, Math.min(36, Number(months) || 12));

  const [findings, bySeverity, byEntity, topFinding, runs, agents, actions, escalations,
    kbDocs, kbChunks, recent, series] = await Promise.all([
    optional(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open_findings,
         COUNT(*) FILTER (WHERE status = 'ACKNOWLEDGED')::int AS acknowledged,
         COUNT(*) FILTER (WHERE status = 'DISMISSED')::int AS dismissed,
         COUNT(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE))::int AS this_month
       FROM ai_findings`
    ),

    optional(
      `SELECT severity, COUNT(*)::int AS n
         FROM ai_findings
        WHERE status = 'OPEN'
        GROUP BY severity`
    ),

    optional(
      `SELECT COALESCE(NULLIF(TRIM(entity_type), ''), 'Unattributed') AS entity_type,
              COUNT(*)::int AS n
         FROM ai_findings
        WHERE status = 'OPEN'
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 7`
    ),

    // The single open finding most worth a person's attention: highest
    // severity, and within that the newest. The overview surfaces exactly one,
    // and which one it is has to be decided by the data rather than picked.
    optional(
      `SELECT id, title, description, severity, entity_type, entity_id, created_at
         FROM ai_findings
        WHERE status = 'OPEN'
        ORDER BY CASE severity
                   WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 1 ELSE 0
                 END DESC,
                 created_at DESC
        LIMIT 1`
    ),

    optional(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE started_at >= date_trunc('month', CURRENT_DATE))::int AS this_month,
         COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::int AS succeeded,
         COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
         COUNT(*) FILTER (WHERE status = 'RUNNING')::int AS running,
         COALESCE(SUM(observations), 0)::int AS observations,
         COALESCE(SUM(actions_taken), 0)::int AS actions_taken,
         COALESCE(SUM(escalations), 0)::int AS escalations,
         AVG(duration_ms)::float8 AS avg_duration_ms
       FROM agent_runs`
    ),

    optional(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE enabled)::int AS enabled
       FROM agent_definitions`
    ),

    optional(
      `SELECT COUNT(*)::int AS total FROM agent_run_actions`
    ),

    optional(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS open_escalations
         FROM agent_escalations`
    ),

    // Two separate probes rather than one join. document_embeddings keys on
    // (source_type, source_id) across several document kinds, not on a
    // kb_documents id — and asking for both in one statement would let either
    // table's absence null out the other's count.
    optional(`SELECT COUNT(*)::int AS documents FROM kb_documents`),
    optional(`SELECT COUNT(*)::int AS chunks FROM document_embeddings`),

    // The last few agent runs, in enough detail to judge them: what ran, in
    // what mode, what it did, and whether anything came back to a person.
    optional(
      `SELECT r.id, r.agent_key, r.trigger, r.status, r.mode, r.dry_run,
              r.observations, r.actions_taken, r.escalations, r.errors,
              r.summary, r.started_at, r.duration_ms,
              d.display_name AS agent_name
         FROM agent_runs r
         LEFT JOIN agent_definitions d ON d.id = r.agent_id
        ORDER BY r.started_at DESC
        LIMIT 6`
    ),

    optional(
      `WITH span AS (
         SELECT generate_series(
           date_trunc('month', CURRENT_DATE) - make_interval(months => $1::int - 1),
           date_trunc('month', CURRENT_DATE),
           '1 month'
         ) AS month
       )
       SELECT
         to_char(s.month, 'YYYY-MM') AS month,
         (SELECT COUNT(*) FROM ai_findings f
           WHERE date_trunc('month', f.created_at) = s.month)::int AS insights,
         (SELECT COUNT(*) FROM agent_runs r
           WHERE date_trunc('month', r.started_at) = s.month)::int AS runs,
         (SELECT COALESCE(SUM(r.actions_taken), 0) FROM agent_runs r
           WHERE date_trunc('month', r.started_at) = s.month)::int AS actions
       FROM span s
       ORDER BY s.month`,
      [span]
    ),
  ]);

  const num = (v) => Number(v) || 0;
  const one = (rows) => (rows && rows[0]) || null;

  const f = one(findings);
  const r = one(runs);
  const ag = one(agents);
  const ac = one(actions);
  const es = one(escalations);
  const docs = one(kbDocs);
  const chunks = one(kbChunks);

  const severity = {};
  for (const row of bySeverity || []) severity[row.severity] = num(row.n);

  const runsTotal = r ? num(r.total) : 0;

  return {
    insights: f
      ? {
        total: num(f.total),
        open: num(f.open_findings),
        acknowledged: num(f.acknowledged),
        dismissed: num(f.dismissed),
        this_month: num(f.this_month),
        by_severity: severity,
        by_entity: byEntity || [],
      }
      : null,

    automation: r
      ? {
        runs: runsTotal,
        this_month: num(r.this_month),
        succeeded: num(r.succeeded),
        failed: num(r.failed),
        running: num(r.running),
        observations: num(r.observations),
        actions_taken: num(r.actions_taken),
        escalations: num(r.escalations),
        // Null rather than 100% when nothing has run. A success rate over an
        // empty set is unmeasured, not perfect.
        success_rate: runsTotal > 0 ? num(r.succeeded) / runsTotal : null,
        avg_duration_ms: r.avg_duration_ms == null ? null : num(r.avg_duration_ms),
      }
      : null,

    agents: ag ? { total: num(ag.total), enabled: num(ag.enabled) } : null,
    actions: ac ? num(ac.total) : null,
    escalations: es ? { total: num(es.total), open: num(es.open_escalations) } : null,
    knowledge: docs || chunks
      ? { documents: docs ? num(docs.documents) : null, chunks: chunks ? num(chunks.chunks) : null }
      : null,
    top_finding: one(topFinding),
    recent_runs: recent || [],
    series: series || [],
  };
}

module.exports = { getSimeliAnalytics };
