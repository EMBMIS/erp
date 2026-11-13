/**
 * AI-assisted journal entry suggestions and expense auto-categorization.
 *
 * Learns GL coding from what this company has actually posted before, rather
 * than from a language model's opinion about accounting. Two sources of
 * evidence, in priority order:
 *
 *   1. Supplier history — if the last six bills from this supplier were all
 *      coded to 5300, that is a far stronger signal than any text analysis.
 *   2. Description similarity — trigram match against historical entry
 *      descriptions, aggregated to the accounts those entries actually used.
 *
 * Only when neither yields anything does an LLM get consulted, and even then it
 * must choose from the real chart of accounts (its answer is validated against
 * chart_of_accounts before being returned). It can never invent an account code.
 *
 * Everything here returns *suggestions*. Nothing posts. The caller creates a
 * DRAFT that flows through the normal approval path.
 */

const { pool } = require('../../config/database');
const stats = require('./stats');

// A suggestion needs at least this much historical support to be offered
// without a caveat.
const MIN_SUPPORT = 2;

// ---------------------------------------------------------------------------
// Evidence: what has this supplier been coded to before?
// ---------------------------------------------------------------------------
async function accountsUsedForSupplier(supplierId, { limit = 5 } = {}) {
  if (!supplierId) return [];
  const { rows } = await pool.query(
    `
    SELECT coa.account_code, coa.account_name, coa.account_type,
           COUNT(*)::int AS support,
           MAX(je.entry_date) AS last_used
      FROM supplier_invoices si
      JOIN journal_entries je      ON je.id = si.journal_entry_id
      JOIN journal_entry_items jei ON jei.journal_entry_id = je.id
      JOIN chart_of_accounts coa   ON coa.id = jei.account_id
     WHERE si.supplier_id = $1
       AND si.deleted_at IS NULL
       AND je.status = 'POSTED'
       -- Exclude the AP control account and tax accounts: those are mechanical
       -- on every purchase and tell us nothing about what was bought.
       AND coa.account_type IN ('EXPENSE', 'ASSET')
       AND coa.account_code NOT LIKE '21%'
     GROUP BY coa.account_code, coa.account_name, coa.account_type
     ORDER BY support DESC, last_used DESC
     LIMIT $2
    `,
    [supplierId, limit]
  );
  return rows.map((r) => ({
    account_code: r.account_code,
    account_name: r.account_name,
    account_type: r.account_type,
    support: r.support,
    last_used: r.last_used,
    basis: 'supplier-history',
    reason: `Coded to ${r.account_code} on ${r.support} previous posted bill(s) from this supplier.`,
  }));
}

// ---------------------------------------------------------------------------
// Evidence: what have similar descriptions been coded to?
// ---------------------------------------------------------------------------
async function accountsUsedForSimilarDescriptions(description, { limit = 5, minSimilarity = 0.3 } = {}) {
  const text = String(description || '').trim();
  if (text.length < 3) return [];

  const { rows } = await pool.query(
    `
    SELECT coa.account_code, coa.account_name, coa.account_type,
           COUNT(*)::int AS support,
           ROUND(AVG(similarity(je.description, $1))::numeric, 3)::float AS avg_similarity,
           MAX(je.description) AS example_description
      FROM journal_entries je
      JOIN journal_entry_items jei ON jei.journal_entry_id = je.id
      JOIN chart_of_accounts coa   ON coa.id = jei.account_id
     WHERE je.status = 'POSTED'
       AND je.deleted_at IS NULL
       AND je.description IS NOT NULL
       AND similarity(je.description, $1) >= $2
       AND coa.account_type IN ('EXPENSE', 'REVENUE', 'ASSET')
     GROUP BY coa.account_code, coa.account_name, coa.account_type
     ORDER BY support DESC, avg_similarity DESC
     LIMIT $3
    `,
    [text, minSimilarity, limit]
  );

  return rows.map((r) => ({
    account_code: r.account_code,
    account_name: r.account_name,
    account_type: r.account_type,
    support: r.support,
    similarity: r.avg_similarity,
    basis: 'description-similarity',
    reason: `${r.support} similar posted entr${r.support === 1 ? 'y' : 'ies'} (e.g. "${truncate(r.example_description, 60)}") used ${r.account_code}.`,
  }));
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ---------------------------------------------------------------------------
// LLM fallback — constrained to the real chart of accounts
// ---------------------------------------------------------------------------
async function llmAccountSuggestion(description, { amount } = {}) {
  const { rows: accounts } = await pool.query(`
    SELECT account_code, account_name, account_type
      FROM chart_of_accounts
     WHERE status = 'ACTIVE' AND is_header = false
       AND account_type IN ('EXPENSE','REVENUE','ASSET')
       AND COALESCE(allow_manual_posting, true) = true
     ORDER BY account_code
     LIMIT 300
  `);
  if (!accounts.length) return null;

  const valid = new Map(accounts.map((a) => [a.account_code, a]));

  try {
    const { getOpenAIClient, AI_MODEL, isAIEnabled } = require('../../config/aiConfig');
    const { safeJsonParse } = require('../aiJson');
    if (!isAIEnabled()) return null;
    const client = getOpenAIClient();
    if (!client) return null;

    const completion = await client.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are an accountant coding a transaction to a general ledger account. ' +
            'You MUST choose an account_code from the provided chart of accounts. ' +
            'Never invent a code. If nothing fits, return {"account_code": null}. ' +
            'Respond with JSON: {"account_code": "...", "confidence": "high|medium|low", "reason": "..."}',
        },
        {
          role: 'user',
          content:
            `Transaction: ${description}\n` +
            (amount != null ? `Amount: ${amount}\n` : '') +
            `\nChart of accounts:\n${accounts.map((a) => `${a.account_code} — ${a.account_name} (${a.account_type})`).join('\n')}`,
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 300,
    });

    const parsed = safeJsonParse(completion.choices?.[0]?.message?.content);
    if (!parsed || !parsed.account_code) return null;

    // Guardrail: the model must have chosen a real, postable account.
    const account = valid.get(String(parsed.account_code).trim());
    if (!account) return null;

    return {
      account_code: account.account_code,
      account_name: account.account_name,
      account_type: account.account_type,
      support: 0,
      basis: 'llm-inference',
      confidence: parsed.confidence || 'low',
      reason: `No historical precedent found. Suggested by AI from the chart of accounts: ${truncate(parsed.reason, 140)}`,
    };
  } catch (err) {
    const { classifyAiError } = require('./errorClassifier');
    const classified = classifyAiError(err);
    return {
      unavailable: true,
      basis: 'llm-inference',
      reason: `No historical precedent found and the AI fallback is unavailable: ${classified.userMessage}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Public: rank candidate accounts for a transaction
// ---------------------------------------------------------------------------

/**
 * Suggest GL account codings for a transaction, best evidence first.
 *
 * @param {object} input {description, supplier_id, amount, allow_llm}
 */
async function suggestAccounts({ description, supplier_id, amount, allow_llm = true } = {}) {
  const [supplierBased, textBased] = await Promise.all([
    accountsUsedForSupplier(supplier_id),
    accountsUsedForSimilarDescriptions(description),
  ]);

  // Merge, preferring supplier evidence and summing support for agreement.
  const merged = new Map();
  for (const s of [...supplierBased, ...textBased]) {
    const existing = merged.get(s.account_code);
    if (!existing) {
      merged.set(s.account_code, { ...s, bases: [s.basis] });
    } else {
      existing.support += s.support;
      existing.bases.push(s.basis);
      existing.reason = `${existing.reason} ${s.reason}`;
    }
  }

  let suggestions = [...merged.values()].sort((a, b) => b.support - a.support);

  // Agreement between two independent signals is worth more than either alone.
  suggestions.forEach((s) => {
    const agreed = new Set(s.bases).size > 1;
    s.confidence = agreed || s.support >= 4 ? 'high' : s.support >= MIN_SUPPORT ? 'medium' : 'low';
    delete s.bases;
  });

  let llm = null;
  if (!suggestions.length && allow_llm) {
    llm = await llmAccountSuggestion(description, { amount });
    if (llm && !llm.unavailable) suggestions = [llm];
  }

  return {
    description,
    suggestions,
    // Say plainly when there is no basis, rather than returning an empty list
    // that reads like "no coding needed".
    note: suggestions.length
      ? null
      : llm?.unavailable
        ? llm.reason
        : 'No historical precedent and no AI suggestion available — this transaction needs manual coding.',
    ai_unavailable: !!llm?.unavailable,
  };
}

/**
 * Propose a complete, balanced journal entry for a purchase-style transaction.
 * Returns a draft proposal only — the caller decides whether to create it.
 */
async function suggestJournalEntry({ description, amount, supplier_id, entry_date, counterpart_account_code } = {}) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return { error: 'A positive amount is required to propose a journal entry.' };
  }

  const { suggestions, note, ai_unavailable } = await suggestAccounts({ description, supplier_id, amount: value });
  const best = suggestions[0];

  // Credit side: AP control for a supplier transaction, else a bank/cash account.
  const counterpart = counterpart_account_code || (supplier_id ? '2110' : '1110');
  const { rows: cpRows } = await pool.query(
    'SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = $1',
    [counterpart]
  );

  if (!best) {
    return {
      proposed: null,
      note: note || 'Could not determine a debit account.',
      ai_unavailable,
    };
  }
  if (!cpRows.length) {
    return {
      proposed: null,
      note: `Debit account ${best.account_code} identified, but the balancing account ${counterpart} does not exist in the chart of accounts.`,
      ai_unavailable,
    };
  }

  return {
    proposed: {
      entry_date: entry_date || new Date().toISOString().split('T')[0],
      description: description || 'AI-suggested entry',
      status: 'DRAFT',
      lines: [
        {
          account_code: best.account_code,
          account_name: best.account_name,
          debit_amount: stats.round2(value),
          credit_amount: 0,
        },
        {
          account_code: cpRows[0].account_code,
          account_name: cpRows[0].account_name,
          debit_amount: 0,
          credit_amount: stats.round2(value),
        },
      ],
      total_debit: stats.round2(value),
      total_credit: stats.round2(value),
      balanced: true,
    },
    confidence: best.confidence,
    basis: best.basis,
    reason: best.reason,
    alternatives: suggestions.slice(1, 4),
    ai_unavailable,
    disclaimer: 'This is a suggestion, not a posting. Review the coding before creating the entry.',
  };
}

/**
 * Auto-categorize an expense (used by invoice intake). Thin wrapper over
 * suggestAccounts that returns a single best answer.
 */
async function categorizeExpense({ description, supplier_id, amount } = {}) {
  const result = await suggestAccounts({ description, supplier_id, amount });
  const best = result.suggestions[0];
  return {
    description,
    category: best
      ? { account_code: best.account_code, account_name: best.account_name, confidence: best.confidence, basis: best.basis, reason: best.reason }
      : null,
    alternatives: result.suggestions.slice(1, 4),
    note: result.note,
    ai_unavailable: result.ai_unavailable,
  };
}

module.exports = {
  suggestAccounts,
  suggestJournalEntry,
  categorizeExpense,
  accountsUsedForSupplier,
  accountsUsedForSimilarDescriptions,
};
