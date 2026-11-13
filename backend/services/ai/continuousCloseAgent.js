/**
 * Continuous Close AI Agent
 *
 * Reconciles each sub-ledger (AR, AP) to its GL control account and turns every
 * break into an actionable pair:
 *
 *   ai_finding  — what broke, by how much, in plain English
 *   DRAFT correcting journal entry — linked to the finding via
 *                ai_findings.proposed_journal_entry_id, NEVER posted by the
 *                agent. This is the "AI proposes, humans approve" rule: the
 *                draft stays DRAFT until a manager approves the finding
 *                (routes/ai-findings.js → services/ai/findingsActions.js).
 *
 * Idempotent by construction: the same break is reported once (partial unique
 * index on open ai_findings) and its draft is created once (stable posting_key
 * `AI_CONTINUOUS_CLOSE:<companyId>:<purpose>`, reused on later sweeps), so the
 * nightly scheduler sweep can run as often as it likes.
 *
 * Wired into agents/scheduler.js per-company via forEachCompany (same pattern
 * the scheduler already uses for agent claims).
 */

const { pool } = require('../../config/database');
const { currentCompanyId } = require('../companyContext');
const JournalEntry = require('../../models/JournalEntry');
const { upsertFinding } = require('./findingsScan');

// |GL control balance − sub-ledger total| below this is rounding noise.
const BREAK_TOLERANCE = 0.50;
// A break above this absolute size is worth escalating to HIGH severity.
const HIGH_BREAK_THRESHOLD = 10000;

// Ledger definitions: how to total the sub-ledger, and which GL control
// account it must agree with.
const LEDGERS = [
  {
    purpose: 'AR_CONTROL',
    fallbackCode: '1120',
    entityType: 'AR_SUBLEDGER',
    label: 'Accounts Receivable',
    subledgerSql: `
      SELECT COALESCE(SUM(outstanding_amount), 0)::float AS total
        FROM customer_invoices
       WHERE company_id = $1 AND deleted_at IS NULL
         AND status NOT IN ('DRAFT', 'CANCELLED', 'PAID')`,
  },
  {
    purpose: 'AP_CONTROL',
    fallbackCode: '2110',
    entityType: 'AP_SUBLEDGER',
    label: 'Accounts Payable',
    subledgerSql: `
      SELECT COALESCE(SUM(outstanding_amount), 0)::float AS total
        FROM supplier_invoices
       WHERE company_id = $1 AND deleted_at IS NULL
         AND status NOT IN ('DRAFT', 'CANCELLED', 'PAID')`,
  },
];

class ContinuousCloseAgent {
  /**
   * Resolve the chart account backing a GL purpose for a company.
   * Explicit company_gl_mappings win; a conventional account code is the
   * fallback for companies that never configured mappings.
   */
  static async resolveControlAccount(companyId, purpose, fallbackCode) {
    let code = fallbackCode;
    const { rows: mappings } = await pool.query(
      'SELECT account_code FROM company_gl_mappings WHERE company_id = $1 AND purpose = $2',
      [companyId, purpose]
    );
    if (mappings.length) code = mappings[0].account_code;

    const { rows } = await pool.query(
      `SELECT id, account_code, account_name, current_balance, normal_balance
         FROM chart_of_accounts
        WHERE company_id = $1 AND account_code = $2 AND status = 'ACTIVE' AND deleted_at IS NULL
        LIMIT 1`,
      [companyId, code]
    );
    return rows[0] || null;
  }

  /** A user to attribute unattended postings to (journal_entries.created_by is NOT NULL). */
  static async systemUserId() {
    const { rows } = await pool.query(
      `SELECT id FROM users
        WHERE role IN ('ADMIN', 'MANAGER')
        ORDER BY created_at LIMIT 1`
    );
    if (rows.length) return rows[0].id;
    const any = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    return any.rows[0]?.id || null;
  }

  /**
   * Compare one sub-ledger to its control account and, on a break, raise the
   * finding + draft pair.
   */
  static async reconcileLedger({ companyId, ledger }) {
    const control = await this.resolveControlAccount(companyId, ledger.purpose, ledger.fallbackCode);
    if (!control) {
      return { ledger: ledger.entityType, status: 'SKIPPED_NO_CONTROL_ACCOUNT', reason: `no ${ledger.label} control account for company ${companyId}` };
    }

    const { rows } = await pool.query(ledger.subledgerSql, [companyId]);
    const subledgerTotal = Number(rows[0]?.total || 0);

    // Normalise: liability balances are stored negative (debit − credit), so
    // flip to a positive credit balance before comparing to the sub-ledger.
    const glBalance = control.normal_balance === 'CREDIT'
      ? -Number(control.current_balance || 0)
      : Number(control.current_balance || 0);

    const difference = glBalance - subledgerTotal;
    if (Math.abs(difference) <= BREAK_TOLERANCE) {
      return { ledger: ledger.entityType, status: 'IN_BALANCE', gl_balance: glBalance, subledger_total: subledgerTotal };
    }

    const severity = Math.abs(difference) > HIGH_BREAK_THRESHOLD ? 'HIGH' : 'MEDIUM';
    const title = `${ledger.label} sub-ledger does not match its GL control account`;
    const description =
      `${ledger.label} control account (${control.account_code} ${control.account_name}) carries ${fmt(glBalance)} ` +
      `but the sub-ledger totals ${fmt(subledgerTotal)} — a break of ${fmt(difference)}. ` +
      `A DRAFT correcting journal entry has been proposed; review and approve it from the AI findings dashboard.`;

    const finding = await upsertFinding({
      companyId,
      finding_type: 'SUB_LEDGER_RECONCILIATION',
      severity,
      entity_type: ledger.entityType,
      entity_id: control.id,
      title,
      description,
      data: {
        ledger: ledger.entityType,
        purpose: ledger.purpose,
        control_account_code: control.account_code,
        control_account_name: control.account_name,
        gl_balance: glBalance,
        subledger_total: subledgerTotal,
        difference,
      },
    });

    if (!finding.id) {
      // Already open (or recently dismissed) — nothing new to propose.
      return { ledger: ledger.entityType, status: 'ALREADY_OPEN', gl_balance: glBalance, subledger_total: subledgerTotal, finding_id: null };
    }

    const draft = await this.ensureDraftEntry({ companyId, findingId: finding.id, control, difference, ledger, subledgerTotal });
    return {
      ledger: ledger.entityType,
      status: 'BREAK',
      severity,
      gl_balance: glBalance,
      subledger_total: subledgerTotal,
      difference,
      finding_id: finding.id,
      draft_journal_entry_id: draft?.id || null,
      draft_status: draft?.status || null,
      draft_reused: draft ? draft.reused : null,
    };
  }

  /**
   * Create (or reuse) the DRAFT correcting journal entry for a break.
   *
   * The entry moves the control account by the break amount with the opposite
   * leg on the reconciliation suspense account, so the books balance. It is
   * created as DRAFT and never posted here.
   */
  static async ensureDraftEntry({ companyId, findingId, control, difference, ledger, subledgerTotal }) {
    const suspense = await this.resolveControlAccount(companyId, 'RECON_SUSPENSE', '2126');
    if (!suspense) {
      // A finding exists but we could not propose an entry; still actionable
      // as a review item.
      console.warn(`[continuous-close] no reconciliation suspense account for company ${companyId}; draft JE not created`);
      return null;
    }

    const postingKey = `AI_CONTINUOUS_CLOSE:${companyId}:${ledger.purpose}`;

    // Reuse the existing draft for this break — posting_key is unique, so this
    // is both idempotency and the "one draft per break" rule.
    const { rows: existing } = await pool.query(
      `SELECT id, status FROM journal_entries
        WHERE posting_key = $1 AND deleted_at IS NULL LIMIT 1`,
      [postingKey]
    );
    if (existing.length) return { ...existing[0], reused: true };

    const amount = Math.abs(difference);
    // Control account overstates the sub-ledger → reduce it (credit for a
    // debit-normal asset like AR, debit for a credit-normal liability like AP).
    const reduceControl = difference > 0;
    const controlIsDebit = control.normal_balance !== 'CREDIT';
    const controlDebit = controlIsDebit === reduceControl ? 0 : amount;
    const controlCredit = controlIsDebit === reduceControl ? amount : 0;

    const userId = await this.systemUserId();
    if (!userId) throw new Error('Cannot create AI continuous-close draft: no user to attribute it to');

    const entry = await JournalEntry.create(
      {
        entry_date: new Date().toISOString().split('T')[0],
        description: `[AI Continuous Close] ${ledger.label} control ${control.account_code}: GL ${fmt(glBalanceOf(control))} vs sub-ledger ${fmt(subledgerTotal)} — proposed correction ${fmt(Math.abs(difference))}`,
        source_type: 'AI_CONTINUOUS_CLOSE',
        source_id: findingId,
        posting_key: postingKey,
        company_id: companyId,
        reference: `AI-CC-${ledger.entityType}`,
        notes: `Proposed by the AI continuous-close sweep on ${new Date().toISOString()}. Review before approving — approving posts this draft.`,
      },
      [
        { account_id: control.id, debit_amount: controlDebit, credit_amount: controlCredit, description: `${ledger.label} control correction (${fmt(amount)})` },
        { account_id: suspense.id, debit_amount: controlCredit, credit_amount: controlDebit, description: `Reconciliation suspense (${ledger.label} break ${fmt(amount)})` },
      ],
      userId
    );

    // Link finding → draft so the approve action knows what to post.
    await pool.query(
      'UPDATE ai_findings SET proposed_journal_entry_id = $2 WHERE id = $1',
      [findingId, entry.id]
    );
    return { id: entry.id, status: entry.status, reused: false };
  }

  /**
   * Run the nightly continuous-close sweep for one company: reconcile every
   * sub-ledger to its GL control account, raising finding + DRAFT pairs.
   */
  static async runSweep(companyId = currentCompanyId()) {
    let resolvedCompanyId = companyId;
    if (!resolvedCompanyId) {
      const { rows } = await pool.query('SELECT id FROM companies ORDER BY created_at LIMIT 1');
      resolvedCompanyId = rows[0]?.id;
    }
    if (!resolvedCompanyId) {
      return { success: false, error: 'No company to run the sweep for.' };
    }

    const ledgers = [];
    for (const ledger of LEDGERS) {
      try {
        ledgers.push(await this.reconcileLedger({ companyId: resolvedCompanyId, ledger }));
      } catch (err) {
        console.error(`[continuous-close] ${ledger.entityType} reconciliation failed for ${resolvedCompanyId}:`, err.message);
        ledgers.push({ ledger: ledger.entityType, status: 'ERROR', error: err.message });
      }
    }

    const breaks = ledgers.filter((l) => l.status === 'BREAK');
    return {
      success: true,
      company_id: resolvedCompanyId,
      ledgers,
      findings_created: breaks.length,
      // Counted from whether the entry was made by this sweep, not from its
      // status: a new proposal is DRAFT or PENDING_APPROVAL depending on the
      // company's approval chain.
      drafts_created: breaks.filter((b) => b.draft_reused === false).length,
      drafts_reused: breaks.filter((b) => b.draft_reused === true).length,
      executed_at: new Date().toISOString(),
    };
  }
}

function fmt(n) {
  const v = Number(n || 0);
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Normalised control-account balance: positive for credit-normal liabilities. */
function glBalanceOf(control) {
  return control.normal_balance === 'CREDIT'
    ? -Number(control.current_balance || 0)
    : Number(control.current_balance || 0);
}

module.exports = ContinuousCloseAgent;
