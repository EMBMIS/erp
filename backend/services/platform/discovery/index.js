/**
 * Capability Discovery: noticing that the business needs an application nobody
 * has built.
 *
 * ===========================================================================
 * THE PIPELINE, AND WHY IT HAS THIS MANY STAGES
 * ===========================================================================
 *     detectors            arithmetic over the ledger  (signals.js)
 *       -> accumulation    counts persist across scans
 *       -> thresholds      a count crossing a line, not a single occurrence
 *       -> deduplication   one open opportunity per underlying problem
 *       -> proposal        a stored row a person can read
 *
 * Each stage exists to stop the stage before it becoming noise. Without
 * accumulation, one late delivery is a "capability gap". Without thresholds,
 * every company gets every opportunity on day one. Without deduplication, the
 * same problem is proposed again on every scan until someone acts, which
 * teaches people to ignore the list.
 *
 * ===========================================================================
 * DISCOVERY NEVER DEPLOYS
 * ===========================================================================
 * The strongest thing in this file writes a row to capability_opportunities.
 * There is no code path from here to the deployer, and `accept` does not build
 * anything either — it opens a Studio session with the requirement pre-filled,
 * and a person takes it from there. An automated system that notices a gap and
 * fills it without being asked is a system that reshapes a company's data model
 * overnight.
 */

const crypto = require('crypto');
const companyContext = require('../../companyContext');
const registry = require('../registry');
const signals = require('./signals');
const catalog = require('../catalog');
const { asCompany } = require('../db');

/**
 * How much accumulated weight a signal needs before it becomes a proposal.
 *
 * Per signal kind, because the kinds are not comparable: two late deliveries
 * from one supplier is a pattern, whereas two items below reorder point is a
 * Tuesday.
 */
const THRESHOLDS = {
  late_supplier_deliveries: 12,
  overdue_receivables: 14,
  stock_below_reorder: 10,
  goods_receipt_quality_issues: 10,
  unresolved_ai_findings: 8,
  supplier_concentration: 9,
  canonical_data_unserved: 6,
};

/**
 * What each signal kind suggests building.
 *
 * These are proposals, not applications: the requirement text is what a person
 * would type into the Studio, and the Studio designs it from scratch when they
 * accept. Keeping them as REQUIREMENTS rather than as specifications is what
 * stops discovery from quietly becoming a second, worse designer.
 */
const PROPOSALS = {
  late_supplier_deliveries: (evidence) => ({
    title: 'Supplier delivery performance is not being tracked',
    missing: 'supplier_delivery_performance',
    requirement: 'Build a supplier delivery performance application where we record every late or short delivery against the supplier, rate suppliers on reliability, and let suppliers see and respond to their own delivery issues in a portal.',
    reason: `${evidence.latePurchaseOrders || evidence.count} purchase order(s) are past their delivery date and nothing in EMBMIS records the consequence, so late deliveries leave no trail beyond the order itself.`,
    requiresNewDataModel: true,
  }),
  overdue_receivables: (evidence) => ({
    title: 'Collections are happening outside EMBMIS',
    missing: 'collections_management',
    requirement: 'Build a collections application that tracks every overdue customer invoice through chase, promise-to-pay, dispute and escalation, with a record of each contact and who is responsible.',
    reason: `${evidence.overdueInvoices} invoice(s) are overdue with ${Math.round(evidence.outstanding || 0)} outstanding, and EMBMIS records the debt but nothing about what anyone is doing to collect it.`,
    requiresNewDataModel: true,
  }),
  stock_below_reorder: (evidence) => ({
    title: 'Stock replenishment decisions are not recorded',
    missing: 'replenishment_workflow',
    requirement: 'Build a replenishment application that tracks each item below its reorder point through a decision — order, substitute, or accept the risk — with who decided and why.',
    reason: `${evidence.itemsBelowReorder} item(s) are below their reorder point. EMBMIS knows the position but keeps no record of what was decided about it.`,
    requiresNewDataModel: true,
  }),
  goods_receipt_quality_issues: (evidence) => ({
    title: 'Incoming quality problems have nowhere to go',
    missing: 'supplier_quality',
    requirement: 'Build a supplier quality management application where our employees raise quality findings against suppliers and suppliers respond to their own findings with corrective actions in a portal.',
    reason: `${evidence.poorConditionReceipts} goods receipt(s) were recorded in poor condition. The condition is on the receipt and the conversation with the supplier is not anywhere.`,
    requiresNewDataModel: true,
  }),
  unresolved_ai_findings: (evidence) => ({
    title: 'Anomalies are raised and never closed out',
    missing: 'exception_management',
    requirement: 'Build an exception management application that takes each anomaly the platform raises, assigns an owner, records the investigation and the outcome, and closes it.',
    reason: `${evidence.openFindings} finding(s) from the last 60 days are still open. They are being raised faster than anyone is resolving them, and there is no place to record the resolution.`,
    requiresNewDataModel: true,
  }),
  supplier_concentration: (evidence) => ({
    title: 'Concentrated supply with no risk assessment',
    missing: 'supplier_risk',
    requirement: 'Build a supplier risk application that records a periodic risk assessment for each significant supplier, with the reasoning behind each score and the mitigations agreed.',
    reason: `${evidence.supplier} accounts for about ${evidence.shareOfSpend}% of purchasing over the last year and no assessment of that concentration is recorded anywhere.`,
    requiresNewDataModel: true,
  }),
  canonical_data_unserved: (evidence) => ({
    title: `${evidence.label} exist in EMBMIS but no application works with them`,
    missing: `${evidence.entity}_operations`,
    requirement: `Build an application that manages the process around ${evidence.label.toLowerCase()} — what happens to each one, who is responsible, and what state it is in.`,
    reason: `EMBMIS holds ${evidence.records} ${evidence.label.toLowerCase()} and none of this company's applications reference them, so whatever process surrounds them is happening outside the system.`,
    requiresNewDataModel: true,
  }),
};

const dedupeKey = (signalKey, subject) => crypto
  .createHash('sha256').update(`${signalKey}:${subject || 'company'}`).digest('hex').slice(0, 40);

/**
 * Run a scan. Accumulates signals, then proposes what has crossed a threshold.
 *
 * Idempotent in the way that matters: running it twice in a row records the
 * observations twice (they are real observations) but produces no second
 * opportunity for the same problem.
 */
async function scan(companyId, { actorId = null } = {}) {
  return asCompany(companyId, async () => {
    const observed = await signals.collect(companyId);
    const accumulated = [];

    for (const signal of observed) {
      const row = await companyContext.withCompany(companyId, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO app_discovery_signals (company_id, signal_key, subject, observations, weight, evidence)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (company_id, signal_key, subject) DO UPDATE
             SET observations = app_discovery_signals.observations + EXCLUDED.observations,
                 weight = app_discovery_signals.weight + EXCLUDED.weight,
                 evidence = EXCLUDED.evidence,
                 last_seen_at = CURRENT_TIMESTAMP
           RETURNING *`,
          [companyId, signal.key, signal.subject, signal.observations, signal.weight, JSON.stringify(signal.evidence)]
        );
        return rows[0];
      });
      accumulated.push({ ...signal, accumulatedWeight: Number(row.weight), totalObservations: row.observations });
    }

    const described = await catalog.describe(companyId);
    const existingCapabilities = described.applications.map((a) => ({ appKey: a.appKey, name: a.name, dependsOn: a.dependsOn }));

    const proposed = [];
    for (const signal of accumulated) {
      const threshold = THRESHOLDS[signal.key] ?? 10;
      if (signal.accumulatedWeight < threshold) continue;

      const build = PROPOSALS[signal.key];
      if (!build) continue;
      const proposal = build(signal.evidence || {});

      // Already served? An application that already depends on the data and
      // owns an entity for this process is the capability, and proposing it
      // again would be the system failing to notice its own work.
      const alreadyServed = described.applications.some(
        (a) => a.appKey.includes(proposal.missing) || proposal.missing.includes(a.appKey)
      );
      if (alreadyServed) continue;

      const key = dedupeKey(signal.key, signal.subject);
      const row = await companyContext.withCompany(companyId, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO capability_opportunities
             (company_id, title, description, reason, evidence, confidence, source_signal, dedupe_key,
              existing_capabilities, missing_capability, requires_new_data_model, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'detected',
                   CURRENT_TIMESTAMP + INTERVAL '90 days')
           ON CONFLICT (company_id, dedupe_key) DO UPDATE
             SET evidence = EXCLUDED.evidence,
                 reason = EXCLUDED.reason,
                 confidence = EXCLUDED.confidence,
                 updated_at = CURRENT_TIMESTAMP
           RETURNING *, (xmax = 0) AS inserted`,
          [companyId, proposal.title, proposal.requirement, proposal.reason,
            JSON.stringify({ ...signal.evidence, accumulatedWeight: signal.accumulatedWeight, observations: signal.totalObservations }),
            confidenceFor(signal, threshold), signal.key, key,
            JSON.stringify(existingCapabilities), proposal.missing, proposal.requiresNewDataModel]
        );
        return rows[0];
      });
      if (row.inserted) {
        proposed.push(row);
        await registry.recordEvent({
          companyId,
          eventType: 'discovery.opportunity_detected',
          provenanceClass: 'observation',
          actorKind: 'system', actorId,
          summary: `Detected a capability gap: ${proposal.title}`,
          detail: { signal: signal.key, weight: signal.accumulatedWeight, threshold },
        });
      }
    }

    return {
      signalsObserved: observed.length,
      signalsAccumulated: accumulated.length,
      opportunitiesProposed: proposed.length,
      opportunities: proposed,
    };
  });
}

/**
 * Confidence, from how far past the threshold the evidence has gone.
 *
 * Capped at 0.9: this is a heuristic over counts, and a heuristic reporting
 * certainty is a heuristic misrepresenting itself.
 */
function confidenceFor(signal, threshold) {
  const ratio = signal.accumulatedWeight / threshold;
  return Math.min(0.9, Math.round(Math.min(1, 0.4 + (ratio - 1) * 0.25) * 1000) / 1000);
}

async function list(companyId, { status = null, limit = 50 } = {}) {
  return asCompany(companyId, () => companyContext.withCompany(companyId, async (client) => {
    const params = [companyId, Math.min(Math.max(1, limit), 200)];
    let where = 'company_id = $1';
    if (status) { params.push(status); where += ` AND status = $${params.length}`; }
    const { rows } = await client.query(
      `SELECT * FROM capability_opportunities WHERE ${where}
        ORDER BY confidence DESC, created_at DESC LIMIT $2`,
      params
    );
    return rows;
  }));
}

async function setStatus({ companyId, opportunityId, status, userId = null }) {
  return asCompany(companyId, async () => {
    const { rows } = await companyContext.withCompany(companyId, async (client) => client.query(
      `UPDATE capability_opportunities
          SET status = $3, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = $4, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND company_id = $2 RETURNING *`,
      [opportunityId, companyId, status, userId]
    ));
    if (!rows.length) {
      const err = new Error('No such opportunity.'); err.code = 'OPPORTUNITY_NOT_FOUND'; err.status = 404; throw err;
    }
    await registry.recordEvent({
      companyId,
      eventType: `discovery.opportunity_${status}`,
      provenanceClass: 'authorization',
      actorKind: userId ? 'user' : 'system', actorId: userId,
      summary: `Opportunity "${rows[0].title}" marked ${status}.`,
      detail: { opportunityId },
    });
    return rows[0];
  });
}

/**
 * Accept an opportunity: open a Studio session with the requirement filled in.
 *
 * This is where discovery stops. It does not design, validate or deploy — a
 * person now sees the plan and decides, exactly as if they had typed the
 * requirement themselves.
 */
async function accept({ companyId, opportunityId, userId }) {
  const session = require('../studio/session');
  const opportunities = await list(companyId, { limit: 200 });
  const opportunity = opportunities.find((o) => o.id === opportunityId);
  if (!opportunity) {
    const err = new Error('No such opportunity.'); err.code = 'OPPORTUNITY_NOT_FOUND'; err.status = 404; throw err;
  }

  const started = await session.start({
    companyId, userId, requirement: opportunity.description, title: opportunity.title,
  });

  await asCompany(companyId, () => companyContext.withCompany(companyId, async (client) => {
    await client.query(
      `UPDATE capability_opportunities
          SET status = 'accepted', application_id = $2, version_id = $3, studio_session_id = $4,
              reviewed_at = CURRENT_TIMESTAMP, reviewed_by = $5, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [opportunityId, started.application.id, started.version.id, started.session.id, userId]
    );
  }));

  return { opportunity, session: started };
}

module.exports = { scan, list, setStatus, accept, THRESHOLDS, PROPOSALS, dedupeKey };
