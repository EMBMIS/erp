/**
 * Bank reconciliation agent.
 *
 * Monitors unreconciled bank lines, scores them against open invoices using
 * services/ai/invoiceMatching.js, and reconciles the unambiguous ones itself.
 *
 * The judgement encoded here is where to stop. Reconciliation is easy to do and
 * expensive to undo — a wrong match misstates both the bank position and the
 * customer's balance, and is often only discovered at period end. So the agent
 * acts only on a high-confidence, unambiguous match, and anything where two
 * candidates score alike is escalated *specifically because* it is ambiguous,
 * not merely because it is large. Guessing between two plausible invoices is
 * exactly the decision a human should make.
 */

const invoiceMatching = require('../../ai/invoiceMatching');
const BankTransaction = require('../../../models/BankTransaction');

module.exports = {
  key: 'bank_reconciliation',
  displayName: 'Bank Reconciliation Agent',
  description:
    'Matches unreconciled bank transactions to open invoices and reconciles unambiguous high-confidence matches. Escalates ambiguous ones rather than guessing.',
  domain: 'FINANCE',
  defaultMode: 'observe',
  defaultSchedule: 60 * 60 * 6, // four times a day
  defaultAuthority: {
    max_amount: 25000,
    max_actions_per_run: 40,
    allowed_actions: ['reconcile_bank_transaction'],
  },
  defaultConfig: {
    min_confidence_score: 0.9,
  },

  async detect(ctx) {
    const minScore = Number(ctx.config.min_confidence_score) || 0.9;
    const suggestions = await invoiceMatching.suggestBankMatches({ limit: 100 });
    const observations = [];

    for (const s of suggestions.suggestions) {
      const best = s.best_match;

      if (!best) {
        observations.push({
          action_type: 'reconcile_bank_transaction',
          impact: 'read',
          entity_type: 'bank_transaction',
          entity_id: s.bank_transaction_id,
          entity_label: `${s.description || 'Bank line'} (${s.amount})`,
          amount: Math.abs(s.amount),
          rationale: `No open invoice plausibly matches this ${s.direction} of ${Math.abs(s.amount)}. Left for manual review.`,
        });
        continue;
      }

      if (s.ambiguous) {
        // Declare an action the authority layer will not permit, so this is
        // routed to a human as an ambiguity rather than silently skipped.
        observations.push({
          action_type: 'resolve_ambiguous_bank_match',
          impact: 'real',
          entity_type: 'bank_transaction',
          entity_id: s.bank_transaction_id,
          entity_label: `${s.description || 'Bank line'} (${s.amount})`,
          amount: Math.abs(s.amount),
          rationale: `Two candidates score within 0.15 of each other (${s.candidates.slice(0, 2).map((c) => `${c.document_number} @ ${c.score}`).join(' vs ')}). Choosing between them is a judgement call, not a calculation.`,
          data: { candidates: s.candidates },
        });
        continue;
      }

      if (best.score < minScore) {
        observations.push({
          action_type: 'reconcile_bank_transaction',
          impact: 'read',
          entity_type: 'bank_transaction',
          entity_id: s.bank_transaction_id,
          entity_label: `${s.description || 'Bank line'} (${s.amount})`,
          amount: Math.abs(s.amount),
          rationale: `Best match ${best.document_number} scores ${best.score}, below the ${minScore} threshold for unattended reconciliation. ${best.reason}`,
        });
        continue;
      }

      observations.push({
        action_type: 'reconcile_bank_transaction',
        impact: 'real',
        entity_type: 'bank_transaction',
        entity_id: s.bank_transaction_id,
        entity_label: `${s.description || 'Bank line'} → ${best.document_number}`,
        amount: Math.abs(s.amount),
        rationale: `Confident unambiguous match (score ${best.score}) to ${best.document_number} for ${best.counterparty}. ${best.reason}`,
        data: {
          document_id: best.document_id,
          document_type: best.document_type,
          document_number: best.document_number,
        },
      });
    }

    return observations;
  },

  async act(observation, ctx) {
    const { document_id, document_type } = observation.data;
    const matchedType = document_type === 'customer_invoice' ? 'CUSTOMER_INVOICE' : 'SUPPLIER_INVOICE';

    await BankTransaction.setReconciled(observation.entity_id, true, ctx.userId || null, {
      matched_type: matchedType,
      matched_id: document_id,
    });

    return {
      reconciled: true,
      matched_document: observation.data.document_number,
      matched_type: matchedType,
    };
  },
};
