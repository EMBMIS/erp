/**
 * FX Revaluation — unrealized gain/loss on open foreign-currency AR/AP
 * balances, posted to the functional (base) currency GL at period end.
 *
 * `services/fxRateService.js` already syncs live rates into `exchange_rates`
 * and `periodCloseService.js`'s check 9 already flags multicurrency activity
 * with no revaluation posting on record — but nothing in this codebase ever
 * created that posting. This service is the missing step: it walks every
 * open customer/supplier invoice booked in a currency other than the
 * company's base currency, compares the rate booked at invoice creation
 * against the current rate, and posts the resulting unrealized FX gain/loss
 * to 4910/5910 (the same accounts FinancialPostingService.postCashPayment
 * already uses for the REALIZED leg on settlement).
 *
 * Known simplification, stated plainly rather than hidden: the booked-base
 * comparison uses `outstanding_amount * exchange_rate` (the rate the
 * document was created at) rather than tracking the base-currency cost of
 * each partial payment individually. A document with no partial payments
 * revalues exactly; one that has been partially paid at a different rate
 * than it was booked at will carry a small, real approximation. Doing this
 * precisely needs a payment-level FX ledger this schema does not have.
 */

const { pool } = require('../config/database');
const Currency = require('../models/Currency');
const JournalEntry = require('../models/JournalEntry');
const { currentCompanyId } = require('./companyContext');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function resolveCompanyId(companyId) {
  // A caller may pass null explicitly, which skips the currentCompanyId()
  // parameter default; the ambient company still comes before the fallback.
  if (companyId) return companyId;
  const ambient = currentCompanyId();
  if (ambient) return ambient;
  const { rows } = await pool.query(
    'SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY is_default DESC, created_at LIMIT 1'
  );
  return rows[0]?.id || null;
}

async function controlAccount(companyId, purpose) {
  const { rows } = await pool.query(
    `SELECT coa.id, coa.account_code, coa.account_name
       FROM company_gl_mappings m
       JOIN chart_of_accounts coa
         ON coa.account_code = m.account_code AND coa.company_id = m.company_id
      WHERE m.company_id = $1 AND m.purpose = $2
        AND coa.deleted_at IS NULL
      LIMIT 1`,
    [companyId, purpose]
  );
  return rows[0] || null;
}

async function accountByCode(companyId, code) {
  const { rows } = await pool.query(
    `SELECT id, account_code, account_name FROM chart_of_accounts
      WHERE company_id = $1 AND account_code = $2 AND deleted_at IS NULL LIMIT 1`,
    [companyId, code]
  );
  return rows[0] || null;
}

/**
 * Sum of (currentBase - bookedBase) across every open foreign-currency
 * document in `table`, using `exchange_rate` already booked on the row and
 * the live rate from Currency.getRate as of `asOfDate`. Positive = the open
 * balance is now worth MORE in base currency than it was booked at.
 */
async function foreignBalanceDelta(companyId, table, baseCurrency, asOfDate) {
  const { rows } = await pool.query(
    `SELECT id, currency, exchange_rate, outstanding_amount
       FROM ${table}
      WHERE company_id = $1 AND deleted_at IS NULL
        AND status NOT IN ('PAID', 'CANCELLED')
        AND currency IS DISTINCT FROM $2
        AND outstanding_amount IS NOT NULL AND outstanding_amount <> 0`,
    [companyId, baseCurrency]
  );

  let delta = 0;
  const lines = [];
  for (const row of rows) {
    const currentRate = await Currency.getRate(row.currency, baseCurrency, asOfDate);
    if (currentRate == null) continue; // no rate on file — cannot revalue, skip rather than guess
    const bookedRate = Number(row.exchange_rate) || 1;
    const outstanding = Number(row.outstanding_amount);
    const bookedBase = round2(outstanding * bookedRate);
    const currentBase = round2(outstanding * currentRate);
    const lineDelta = round2(currentBase - bookedBase);
    if (lineDelta === 0) continue;
    delta = round2(delta + lineDelta);
    lines.push({ id: row.id, currency: row.currency, booked_rate: bookedRate, current_rate: currentRate, outstanding, booked_base: bookedBase, current_base: currentBase, delta: lineDelta });
  }
  return { delta, lines };
}

/**
 * Revalue open AR and AP foreign-currency balances to the company's base
 * currency and post the resulting unrealized gain/loss as one balanced
 * journal entry. Posts nothing (returns `posted: false`) when there is no
 * multicurrency activity or every rate nets to zero — an empty revaluation
 * is not an entry.
 */
async function revalueOpenBalances(companyId = currentCompanyId(), userId, asOfDate = null) {
  companyId = await resolveCompanyId(companyId);
  if (!companyId) throw new Error('No company found to revalue.');
  const date = asOfDate || new Date().toISOString().split('T')[0];

  const companyRow = await pool.query('SELECT base_currency FROM companies WHERE id = $1', [companyId]);
  const baseCurrency = companyRow.rows[0]?.base_currency || 'USD';

  const [ar, ap] = await Promise.all([
    foreignBalanceDelta(companyId, 'customer_invoices', baseCurrency, date),
    foreignBalanceDelta(companyId, 'supplier_invoices', baseCurrency, date),
  ]);

  // Net P&L impact: AR appreciating is a gain (+arDelta); AP appreciating (we
  // owe more) is a loss (-apDelta). See the derivation in fxRevaluation.test.js
  // for why this construction always balances.
  const netImpact = round2(ar.delta - ap.delta);
  if (ar.delta === 0 && ap.delta === 0) {
    return { posted: false, reason: 'No unrealized FX movement on open foreign-currency balances.', ar_delta: 0, ap_delta: 0 };
  }

  const [arControl, apControl, fxGain, fxLoss] = await Promise.all([
    ar.delta !== 0 ? controlAccount(companyId, 'AR_CONTROL') : null,
    ap.delta !== 0 ? controlAccount(companyId, 'AP_CONTROL') : null,
    accountByCode(companyId, '4910'),
    accountByCode(companyId, '5910'),
  ]);
  if (ar.delta !== 0 && !arControl) throw new Error('AR control account is not mapped (company_gl_mappings purpose AR_CONTROL).');
  if (ap.delta !== 0 && !apControl) throw new Error('AP control account is not mapped (company_gl_mappings purpose AP_CONTROL).');
  if (!fxGain || !fxLoss) throw new Error('FX Gain (4910) / FX Loss (5910) accounts are not set up for this company.');

  const items = [];
  if (ar.delta !== 0) {
    items.push({
      account_id: arControl.id,
      debit_amount: ar.delta > 0 ? ar.delta : 0,
      credit_amount: ar.delta < 0 ? -ar.delta : 0,
      description: `FX revaluation of open AR to ${baseCurrency}`,
    });
  }
  if (ap.delta !== 0) {
    items.push({
      account_id: apControl.id,
      debit_amount: ap.delta < 0 ? -ap.delta : 0,
      credit_amount: ap.delta > 0 ? ap.delta : 0,
      description: `FX revaluation of open AP to ${baseCurrency}`,
    });
  }
  if (netImpact !== 0) {
    items.push({
      account_id: netImpact > 0 ? fxGain.id : fxLoss.id,
      debit_amount: netImpact < 0 ? -netImpact : 0,
      credit_amount: netImpact > 0 ? netImpact : 0,
      description: `Unrealized foreign exchange ${netImpact > 0 ? 'gain' : 'loss'} — revaluation to ${baseCurrency}`,
    });
  }

  const entry = await JournalEntry.create({
    entry_date: date,
    posting_date: date,
    source_type: 'FX_REVALUATION',
    description: `FX revaluation of open AR/AP to ${baseCurrency} as of ${date}`,
    reference: `FX-REVAL-${date}`,
    currency: baseCurrency,
    exchange_rate: 1,
    requires_approval: false,
    company_id: companyId,
  }, items, userId);
  await JournalEntry.postAsSystem(entry.id, userId, `Auto-posted FX revaluation as of ${date}`);

  return {
    posted: true,
    entry_id: entry.id,
    journal_number: entry.journal_number,
    base_currency: baseCurrency,
    ar_delta: ar.delta,
    ap_delta: ap.delta,
    net_impact: netImpact,
    ar_lines: ar.lines,
    ap_lines: ap.lines,
  };
}

module.exports = { revalueOpenBalances, foreignBalanceDelta };
