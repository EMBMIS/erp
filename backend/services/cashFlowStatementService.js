// Indirect-method cash flow statement, built from real GL account movements
// (no separate "cash flow" ledger exists — see cashflowForecastService for
// the unrelated forward-looking AR/AP forecast). Classifies the change in
// every non-cash balance-sheet account between two as-of dates into
// operating/investing/financing, starting from net income for the period.
// Because every journal entry is balanced (debits == credits) and every
// account in the chart of accounts is classified into exactly one bucket
// here, net_change_in_cash is mathematically forced to equal the actual
// change in the 1110 (Cash) balance — that identity is the "ties to the
// trial balance" property tests/cashFlowStatement.test.js asserts.
const { pool } = require('../config/database');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Balance of every non-header account as of a date, keyed by account_code.
// Uses the same normal_balance CASE pattern as every other report query in
// financial-reports.js / financialPostingService.js.
async function balancesAsOf(asOfDate) {
  // Status/date filters must live in the WHERE clause, not the LEFT JOIN's ON
  // clause: an ON-clause filter only nulls out `je`'s columns for a
  // non-matching row, it does not drop the row, so a SUM reading jei's own
  // debit/credit columns (as this one does) would silently include every
  // journal_entry_item ever posted to the account regardless of status or
  // date. Matches the WHERE-filtered pattern in financialPostingService.js.
  const { rows } = await pool.query(
    `SELECT coa.id, coa.account_code, coa.account_name, coa.account_type, coa.normal_balance,
            COALESCE(SUM(CASE WHEN coa.normal_balance = 'DEBIT'
                          THEN jei.debit_amount - jei.credit_amount
                          ELSE jei.credit_amount - jei.debit_amount END), 0) AS balance
       FROM chart_of_accounts coa
       LEFT JOIN journal_entry_items jei ON jei.account_id = coa.id
       LEFT JOIN journal_entries je ON je.id = jei.journal_entry_id
      WHERE coa.deleted_at IS NULL AND coa.is_header = false
        AND (je.id IS NULL OR (je.status = 'POSTED' AND je.deleted_at IS NULL AND je.entry_date <= $1::date))
      GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_type, coa.normal_balance`,
    [asOfDate]
  );
  const map = {};
  for (const r of rows) {
    map[r.account_code] = { id: r.id, name: r.account_name, balance: Number(r.balance) };
  }
  return map;
}

async function netIncomeBetween(dateFrom, dateTo) {
  const { rows } = await pool.query(
    `SELECT coa.account_type,
            COALESCE(SUM(CASE WHEN coa.normal_balance = 'CREDIT'
                          THEN jei.credit_amount - jei.debit_amount
                          ELSE jei.debit_amount - jei.credit_amount END), 0) AS balance
       FROM chart_of_accounts coa
       JOIN journal_entry_items jei ON jei.account_id = coa.id
       JOIN journal_entries je ON je.id = jei.journal_entry_id
        AND je.status = 'POSTED' AND je.deleted_at IS NULL
        AND je.entry_date >= $1::date AND je.entry_date <= $2::date
      WHERE coa.deleted_at IS NULL AND coa.is_header = false
        AND coa.account_type IN ('REVENUE', 'EXPENSE')
      GROUP BY coa.account_type`,
    [dateFrom, dateTo]
  );
  let revenue = 0, expense = 0;
  for (const r of rows) {
    if (r.account_type === 'REVENUE') revenue = Number(r.balance);
    if (r.account_type === 'EXPENSE') expense = Number(r.balance);
  }
  return revenue - expense;
}

// Classification of balance-sheet accounts into cash-flow-statement lines.
// `sign: -1` means an increase in the account is a USE of cash (asset-side
// working-capital accounts, PPE); `sign: 1` means an increase is a SOURCE of
// cash (liability/equity accounts).
const OPERATING_LINES = [
  { code: '1220', label: 'Depreciation & amortization', sign: 1 },
  { code: '1120', label: 'Change in accounts receivable', sign: -1 },
  { code: '1130', label: 'Change in inventory', sign: -1 },
  { code: '1140', label: 'Change in prepaid expenses', sign: -1 },
  { code: '1160', label: 'Change in input VAT receivable', sign: -1 },
  { code: '2110', label: 'Change in accounts payable', sign: 1 },
  { code: '2115', label: 'Change in GR/IR clearing', sign: 1 },
  { code: '2120', label: 'Change in accrued expenses', sign: 1 },
  { code: '2140', label: 'Change in output VAT payable', sign: 1 },
];

const INVESTING_LINES = [
  { code: '1210', label: 'Purchase of property, plant & equipment', sign: -1 },
];

const FINANCING_LINES = [
  { code: '2130', label: 'Change in short-term debt', sign: 1 },
  { code: '2210', label: 'Change in long-term debt', sign: 1 },
  { code: '3100', label: 'Change in share capital', sign: 1 },
];

function buildLines(defs, begin, end) {
  return defs.map(({ code, label, sign }) => {
    const b = begin[code]?.balance || 0;
    const e = end[code]?.balance || 0;
    const amount = round2(sign * (e - b));
    return {
      account_code: code,
      account_id: end[code]?.id || begin[code]?.id || null,
      account_name: end[code]?.name || begin[code]?.name || label,
      label,
      amount,
    };
  });
}

async function generateCashFlowStatement({ dateFrom, dateTo }) {
  if (!dateFrom || !dateTo) throw new Error('date_from and date_to are required');

  const begin = new Date(`${dateFrom}T00:00:00Z`);
  begin.setUTCDate(begin.getUTCDate() - 1);
  const beginDate = begin.toISOString().split('T')[0];

  const [beginBalances, endBalances, netIncome] = await Promise.all([
    balancesAsOf(beginDate),
    balancesAsOf(dateTo),
    netIncomeBetween(dateFrom, dateTo),
  ]);

  const operatingLines = buildLines(OPERATING_LINES, beginBalances, endBalances);
  const investingLines = buildLines(INVESTING_LINES, beginBalances, endBalances);
  const financingLines = buildLines(FINANCING_LINES, beginBalances, endBalances);

  const netOperating = round2(round2(netIncome) + operatingLines.reduce((s, l) => s + l.amount, 0));
  const netInvesting = round2(investingLines.reduce((s, l) => s + l.amount, 0));
  const netFinancing = round2(financingLines.reduce((s, l) => s + l.amount, 0));
  const netChangeInCash = round2(netOperating + netInvesting + netFinancing);

  const cashBeginning = round2(beginBalances['1110']?.balance || 0);
  const cashEnding = round2(endBalances['1110']?.balance || 0);
  const actualCashChange = round2(cashEnding - cashBeginning);

  return {
    method: 'indirect',
    date_from: dateFrom,
    date_to: dateTo,
    operating_activities: {
      net_income: round2(netIncome),
      adjustments: operatingLines,
      net_cash_from_operating: netOperating,
    },
    investing_activities: {
      lines: investingLines,
      net_cash_from_investing: netInvesting,
    },
    financing_activities: {
      lines: financingLines,
      net_cash_from_financing: netFinancing,
    },
    net_change_in_cash: netChangeInCash,
    cash_beginning: cashBeginning,
    cash_ending: cashEnding,
    actual_cash_change: actualCashChange,
    ties_to_trial_balance: Math.abs(netChangeInCash - actualCashChange) < 0.01,
  };
}

module.exports = { generateCashFlowStatement, balancesAsOf, netIncomeBetween };
