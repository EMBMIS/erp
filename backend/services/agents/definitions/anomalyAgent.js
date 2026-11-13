/**
 * Anomaly detection and triage agent.
 *
 * Runs the statistical scans (services/ai/forecasting.js, findingsScan.js,
 * duplicateDetection.js) on a schedule and records what they find.
 *
 * Its "remediation" is deliberately narrow. The only thing it will do on its own
 * is raise and route a finding — because the correct response to a detected
 * anomaly is almost never mechanical. A duplicate invoice might be a genuine
 * second delivery; an unusual amount might be a real one-off purchase. Anything
 * that auto-cancelled or auto-reversed on a statistical signal would eventually
 * destroy legitimate business records, and the failure mode is silent.
 *
 * So this agent detects and escalates with a full explanation, and leaves the
 * decision where it belongs. That is a deliberate limit on autonomy, not a gap.
 */

const { pool } = require('../../../config/database');
const forecasting = require('../../ai/forecasting');
const duplicateDetection = require('../../ai/duplicateDetection');

module.exports = {
  key: 'anomaly_detection',
  displayName: 'Anomaly Detection Agent',
  description:
    'Runs statistical anomaly, duplicate and cash-risk scans on a schedule, records findings, and routes material ones to a human with the evidence.',
  domain: 'FINANCE',
  defaultMode: 'observe',
  defaultSchedule: 60 * 60 * 8,
  defaultAuthority: {
    max_actions_per_run: 50,
    allowed_actions: ['record_finding'],
  },
  defaultConfig: {
    anomaly_sigma_threshold: 4,
    duplicate_score_threshold: 0.9,
  },

  async detect(ctx) {
    const observations = [];
    const sigma = Number(ctx.config.anomaly_sigma_threshold) || 4;
    const dupScore = Number(ctx.config.duplicate_score_threshold) || 0.9;

    // --- Amount anomalies -------------------------------------------------
    const anomalies = await forecasting.detectAmountAnomalies({ threshold: sigma });
    if (!anomalies.analysis_ran) {
      observations.push({
        action_type: 'record_finding',
        impact: 'read',
        entity_type: 'system',
        rationale: `Anomaly scan could not run: ${anomalies.note}`,
      });
    } else {
      for (const a of anomalies.anomalies) {
        observations.push({
          action_type: 'record_finding',
          impact: 'draft',
          entity_type: 'journal_entry',
          entity_label: a.journal_number,
          amount: a.amount,
          rationale: `${a.journal_number} posts ${a.amount} to ${a.account_code} (${a.account_name}), ${a.deviation_sigmas} robust sigmas from that account's typical ${a.typical_amount}. Unusual for this account, which does not by itself make it wrong.`,
          data: {
            finding_type: 'AMOUNT_ANOMALY',
            severity: Math.abs(a.deviation_sigmas) > 8 ? 'HIGH' : 'MEDIUM',
            title: `Unusual amount on ${a.journal_number}`,
            description: a.reason,
            detail: a,
          },
        });
      }
    }

    // --- Duplicates -------------------------------------------------------
    const dupes = await duplicateDetection.scanAll();

    for (const pair of dupes.suppliers.by_name.filter((p) => p.score >= dupScore)) {
      observations.push({
        action_type: 'record_finding',
        impact: 'draft',
        entity_type: 'supplier',
        entity_id: pair.records[0].id,
        entity_label: `${pair.records[0].name} / ${pair.records[1].name}`,
        rationale: `"${pair.records[0].name}" and "${pair.records[1].name}" score ${pair.score} as the same company. Duplicate supplier records are how the same invoice gets paid twice.`,
        data: {
          finding_type: 'DUPLICATE_SUPPLIER',
          severity: 'MEDIUM',
          title: 'Probable duplicate supplier',
          description: `${pair.records[0].name} and ${pair.records[1].name} appear to be the same company (similarity ${pair.score}).`,
          detail: pair,
        },
      });
    }

    for (const pair of dupes.suppliers.by_shared_email) {
      observations.push({
        action_type: 'record_finding',
        impact: 'draft',
        entity_type: 'supplier',
        entity_id: pair.records[0].id,
        entity_label: `${pair.records[0].name} / ${pair.records[1].name}`,
        rationale: pair.reason,
        data: {
          finding_type: 'DUPLICATE_SUPPLIER',
          severity: 'HIGH',
          title: 'Suppliers sharing an email address',
          description: pair.reason,
          detail: pair,
        },
      });
    }

    for (const d of dupes.supplier_invoices.same_supplier_reference) {
      observations.push({
        action_type: 'record_finding',
        impact: 'draft',
        entity_type: 'supplier_invoice',
        entity_id: d.records[0].id,
        entity_label: `${d.records[0].bill_number} / ${d.records[1].bill_number}`,
        amount: d.amount,
        rationale: d.reason,
        data: {
          finding_type: 'DUPLICATE_INVOICE',
          severity: 'HIGH',
          title: 'Same supplier invoice entered twice',
          description: d.reason,
          detail: d,
        },
      });
    }

    // Purchase/sales order duplicates. Most of these are already caught the
    // moment the record is created (models/PurchaseOrder.js,
    // models/SalesOrder.js — same threshold, same ai_findings insert this
    // agent's own act() below does), so this is mainly a backstop: bulk
    // imports that bypass those hooks, and the rare pair created within
    // milliseconds of each other where each record's own check ran before
    // the other existed to be found. ON CONFLICT DO NOTHING in act() means
    // re-finding a pair the create-time hook already flagged is a no-op.
    for (const pair of dupes.purchase_orders.pairs.filter((p) => p.score >= dupScore)) {
      observations.push({
        action_type: 'record_finding',
        impact: 'draft',
        entity_type: 'purchase_order',
        entity_id: pair.records[0].id,
        entity_label: `${pair.records[0].number} / ${pair.records[1].number}`,
        rationale: `Purchase orders ${pair.records[0].number} and ${pair.records[1].number} are ${pair.score} similar (supplier, line items, terms).`,
        data: {
          finding_type: 'DUPLICATE_PURCHASE_ORDER',
          severity: pair.score >= 0.95 ? 'HIGH' : 'MEDIUM',
          title: 'Possible duplicate purchase order',
          description: `${pair.records[0].number} and ${pair.records[1].number} look like the same order (similarity ${pair.score}).`,
          detail: pair,
        },
      });
    }

    for (const pair of dupes.sales_orders.pairs.filter((p) => p.score >= dupScore)) {
      observations.push({
        action_type: 'record_finding',
        impact: 'draft',
        entity_type: 'sales_order',
        entity_id: pair.records[0].id,
        entity_label: `${pair.records[0].number} / ${pair.records[1].number}`,
        rationale: `Sales orders ${pair.records[0].number} and ${pair.records[1].number} are ${pair.score} similar (customer, line items, notes).`,
        data: {
          finding_type: 'DUPLICATE_SALES_ORDER',
          severity: pair.score >= 0.95 ? 'HIGH' : 'MEDIUM',
          title: 'Possible duplicate sales order',
          description: `${pair.records[0].number} and ${pair.records[1].number} look like the same order (similarity ${pair.score}).`,
          detail: pair,
        },
      });
    }

    // --- Cash risk --------------------------------------------------------
    const cash = await forecasting.forecastCashFlow({ horizonDays: 90 });
    if (cash.risk !== 'OK') {
      observations.push({
        action_type: 'record_finding',
        impact: 'draft',
        entity_type: 'cash_position',
        entity_label: 'Projected cash position',
        amount: cash.projected_closing_cash,
        rationale:
          cash.risk === 'NEGATIVE_CASH_PROJECTED'
            ? `Projected cash over the next ${cash.horizon_days} days is ${cash.projected_closing_cash} — negative. Opening ${cash.opening_cash}, expected in ${cash.expected_inflow}, expected out ${cash.expected_outflow}.`
            : `Cash projection depends on collecting ${cash.receivables.overdue} of already-overdue receivables, which may not arrive.`,
        data: {
          finding_type: 'CASH_RISK',
          severity: cash.risk === 'NEGATIVE_CASH_PROJECTED' ? 'HIGH' : 'MEDIUM',
          title: cash.risk === 'NEGATIVE_CASH_PROJECTED' ? 'Negative cash projected' : 'Cash depends on overdue collections',
          description: cash.caveats.join(' '),
          detail: cash,
        },
      });
    }

    return observations;
  },

  async act(observation) {
    const d = observation.data || {};
    const { rows } = await pool.query(
      `INSERT INTO ai_findings (finding_type, severity, entity_type, entity_id, title, description, data, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        d.finding_type || 'ANOMALY',
        d.severity || 'MEDIUM',
        observation.entity_type,
        observation.entity_id || null,
        (d.title || observation.entity_label || 'Finding').slice(0, 200),
        d.description || observation.rationale,
        JSON.stringify(d.detail || {}),
      ]
    );
    return { finding_id: rows[0]?.id || null, deduped: !rows.length };
  },
};
