/**
 * Data-integrity ("self-healing") agent.
 *
 * Continuously re-checks the invariants the system depends on and repairs the
 * ones that are safe to repair automatically.
 *
 * The distinction this agent is built around: a *derived* value that disagrees
 * with its source is a caching bug and can be recomputed safely, because the
 * source of truth is unambiguous. A *source* value that is wrong cannot be
 * repaired by an agent, because there is nothing to recompute it from — someone
 * has to decide what the right number is.
 *
 * So it will happily recompute customer_invoices.outstanding_amount from
 * total - paid, and it will never touch an unbalanced journal entry: the fix for
 * that requires knowing which side is wrong, which is an accounting judgement.
 * Unbalanced entries are raised, loudly, and left alone.
 */

const { pool } = require('../../../config/database');

module.exports = {
  key: 'data_integrity',
  displayName: 'Data Integrity Agent',
  description:
    'Detects and repairs derived-value drift (invoice outstanding balances, stale overdue statuses) and reports structural problems that require human judgement.',
  domain: 'DATA',
  defaultMode: 'observe',
  defaultSchedule: 60 * 60 * 4,
  defaultAuthority: {
    max_actions_per_run: 200,
    // Must list every action type act() can perform, or the authority engine
    // denies it. `recompute_invoice_outstanding` was dropped when that check was
    // replaced by the account-balance one — invoice outstanding_amount is a
    // GENERATED column and cannot drift.
    allowed_actions: ['recompute_account_balance', 'mark_invoice_overdue'],
  },
  defaultConfig: {},

  async detect() {
    const observations = [];

    // -----------------------------------------------------------------------
    // Repairable: chart_of_accounts.current_balance drifted from the posted
    // journal lines.
    //
    // This is a denormalised cache maintained incrementally by
    // ChartOfAccounts.updateBalance (ADD/SUBTRACT), so any posting path that
    // failed part-way, or any entry written without going through it, leaves it
    // permanently wrong. It matters because getTrialBalance derives from the
    // journal lines (correct) while the balance-sheet summary and account detail
    // endpoints read current_balance (wrong) — the same account can therefore
    // report two different balances depending on which screen you open.
    //
    // The journal lines are the source of truth, so recomputing is safe and
    // unambiguous. Note: invoice outstanding_amount is NOT checked here — it is
    // a Postgres GENERATED column (total_amount - paid_amount) and cannot drift.
    // -----------------------------------------------------------------------
    const balanceDrift = await pool.query(`
      SELECT coa.id, coa.account_code, coa.account_name, coa.normal_balance,
             coa.current_balance::float AS stored,
             COALESCE(SUM(
               CASE WHEN coa.normal_balance = 'DEBIT'
                    THEN jei.debit_amount - jei.credit_amount
                    ELSE jei.credit_amount - jei.debit_amount END
             ), 0)::float AS derived
        FROM chart_of_accounts coa
        LEFT JOIN journal_entry_items jei ON jei.account_id = coa.id
        LEFT JOIN journal_entries je
               ON je.id = jei.journal_entry_id
              AND je.status = 'POSTED'
              AND je.deleted_at IS NULL
       WHERE coa.deleted_at IS NULL
         AND coa.is_header = false
         AND coa.current_balance IS NOT NULL
       GROUP BY coa.id, coa.account_code, coa.account_name, coa.normal_balance, coa.current_balance
      HAVING ROUND(coa.current_balance, 2) <> ROUND(COALESCE(SUM(
               CASE WHEN coa.normal_balance = 'DEBIT'
                    THEN jei.debit_amount - jei.credit_amount
                    ELSE jei.credit_amount - jei.debit_amount END
             ), 0), 2)
       LIMIT 200
    `);

    for (const acc of balanceDrift.rows) {
      observations.push({
        action_type: 'recompute_account_balance',
        impact: 'real',
        entity_type: 'chart_of_accounts',
        entity_id: acc.id,
        entity_label: `${acc.account_code} ${acc.account_name}`,
        // Deliberately no `amount`. In the authority model, `amount` means the
        // monetary value of the action being performed, and it gates against
        // max_amount. Recomputing a cache moves no money — the drift figure is
        // diagnostic, and putting it here made every repair escalate as though
        // the agent were transferring that sum.
        rationale: `Account ${acc.account_code} (${acc.account_name}) stores a balance of ${acc.stored} but its posted journal lines sum to ${acc.derived} — a difference of ${(acc.derived - acc.stored).toFixed(2)}. The journal lines are the source of truth, so the cached balance can be recomputed from them.`,
        data: { derived: acc.derived, stored: acc.stored },
      });
    }

    // -----------------------------------------------------------------------
    // Repairable: an invoice past its due date still sitting in a pre-overdue
    // status. Status is derived from the date, so this is mechanical.
    // -----------------------------------------------------------------------
    const staleStatus = await pool.query(`
      SELECT id, invoice_number, due_date, currency, outstanding_amount::float AS outstanding,
             (CURRENT_DATE - due_date)::int AS days_overdue
        FROM customer_invoices
       WHERE deleted_at IS NULL
         AND status IN ('APPROVED', 'SENT')
         AND outstanding_amount > 0
         AND due_date < CURRENT_DATE
       LIMIT 200
    `);

    for (const inv of staleStatus.rows) {
      observations.push({
        action_type: 'mark_invoice_overdue',
        impact: 'real',
        entity_type: 'customer_invoice',
        entity_id: inv.id,
        entity_label: inv.invoice_number,
        // As above: flipping a status to OVERDUE moves no money. The outstanding
        // figure belongs in the rationale, not in the monetary gate.
        currency: inv.currency,
        rationale: `${inv.invoice_number} (${inv.currency} ${inv.outstanding}) is ${inv.days_overdue} days past its due date but still shows as APPROVED/SENT. Overdue status follows directly from the due date.`,
      });
    }

    // -----------------------------------------------------------------------
    // NOT repairable: an unbalanced posted journal entry. Reported only.
    // Recomputing this would require deciding which side is wrong — an
    // accounting judgement, not a derivation. Silently "fixing" it would
    // destroy the evidence of whatever caused it.
    // -----------------------------------------------------------------------
    const unbalanced = await pool.query(`
      SELECT je.id, je.journal_number,
             ROUND(SUM(jei.debit_amount), 2)::float  AS debits,
             ROUND(SUM(jei.credit_amount), 2)::float AS credits
        FROM journal_entries je
        JOIN journal_entry_items jei ON jei.journal_entry_id = je.id
       WHERE je.status = 'POSTED' AND je.deleted_at IS NULL
       GROUP BY je.id, je.journal_number
      HAVING ROUND(SUM(jei.debit_amount), 2) <> ROUND(SUM(jei.credit_amount), 2)
       LIMIT 50
    `);

    for (const je of unbalanced.rows) {
      observations.push({
        action_type: 'report_unbalanced_journal_entry',
        impact: 'read',
        entity_type: 'journal_entry',
        entity_id: je.id,
        entity_label: je.journal_number,
        amount: Math.abs(je.debits - je.credits),
        rationale: `${je.journal_number} is POSTED but unbalanced: debits ${je.debits} vs credits ${je.credits}. This cannot be auto-corrected — which side is wrong is an accounting judgement, and every report drawing on this entry is affected until a human resolves it.`,
      });
    }

    // -----------------------------------------------------------------------
    // NOT repairable: orphaned references.
    // -----------------------------------------------------------------------
    const orphans = await pool.query(`
      SELECT COUNT(*)::int AS n
        FROM journal_entry_items jei
        LEFT JOIN chart_of_accounts coa ON coa.id = jei.account_id
       WHERE coa.id IS NULL
    `);

    if (orphans.rows[0].n > 0) {
      observations.push({
        action_type: 'report_orphaned_journal_lines',
        impact: 'read',
        entity_type: 'journal_entry_items',
        rationale: `${orphans.rows[0].n} journal line(s) reference a GL account that no longer exists. These lines cannot appear correctly on any report, and the correct account has to be identified by a human.`,
      });
    }

    return observations;
  },

  async act(observation) {
    switch (observation.action_type) {
      case 'recompute_account_balance': {
        // Recompute from the journal lines rather than trusting the value
        // detect() saw: minutes may have passed and postings may have landed
        // since, and writing a stale figure would create fresh drift.
        const { rows } = await pool.query(
          `UPDATE chart_of_accounts coa
              SET current_balance = sub.derived,
                  updated_at = CURRENT_TIMESTAMP
             FROM (
               SELECT c.id,
                      COALESCE(SUM(
                        CASE WHEN c.normal_balance = 'DEBIT'
                             THEN jei.debit_amount - jei.credit_amount
                             ELSE jei.credit_amount - jei.debit_amount END
                      ), 0) AS derived
                 FROM chart_of_accounts c
                 LEFT JOIN journal_entry_items jei ON jei.account_id = c.id
                 LEFT JOIN journal_entries je
                        ON je.id = jei.journal_entry_id
                       AND je.status = 'POSTED'
                       AND je.deleted_at IS NULL
                WHERE c.id = $1
                GROUP BY c.id, c.normal_balance
             ) sub
            WHERE coa.id = sub.id
            RETURNING coa.current_balance::float AS balance`,
          [observation.entity_id]
        );
        return { repaired: true, new_balance: rows[0]?.balance, previous: observation.data.stored };
      }

      case 'mark_invoice_overdue': {
        const { rows } = await pool.query(
          `UPDATE customer_invoices
              SET status = 'OVERDUE', updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status IN ('APPROVED', 'SENT')
            RETURNING status`,
          [observation.entity_id]
        );
        return { repaired: true, new_status: rows[0]?.status };
      }

      default:
        throw new Error(`${observation.action_type} is report-only and must not be auto-actioned.`);
    }
  },
};
