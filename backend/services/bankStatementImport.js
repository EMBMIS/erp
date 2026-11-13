/**
 * Bank statement import: parse a CSV export from any bank into
 * bank_transactions rows (ERP-Roadmap P2 #10).
 *
 * Deliberately dependency-free (no csv-parse package) — bank statement CSVs are
 * simple, and a small hand-rolled parser avoids adding a dependency for
 * something this contained. Supports the two common shapes:
 *   1. A single signed "Amount" column (positive = inflow, negative = outflow)
 *   2. Separate "Debit"/"Credit" columns (debit = outflow, credit = inflow)
 * Header matching is case-insensitive and tolerant of common synonyms
 * (Date/Transaction Date, Description/Narrative/Details, Reference/Ref/Memo).
 */

const BankTransaction = require('../models/BankTransaction');

const HEADER_ALIASES = {
  date: ['date', 'transaction date', 'posting date', 'value date'],
  description: ['description', 'narrative', 'details', 'memo', 'particulars'],
  reference: ['reference', 'ref', 'ref no', 'check number', 'transaction id'],
  amount: ['amount', 'value'],
  debit: ['debit', 'withdrawal', 'money out', 'paid out'],
  credit: ['credit', 'deposit', 'money in', 'paid in'],
};

function splitCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

function matchHeader(headerCell) {
  const norm = headerCell.trim().toLowerCase();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(norm)) return field;
  }
  return null;
}

function parseAmount(str) {
  if (str == null || str === '') return null;
  // Strip currency symbols/thousands separators; keep sign and decimal point.
  const cleaned = String(str).replace(/[^0-9.\-()]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  // Accounting-style negatives in parentheses, e.g. "(123.45)".
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    const n = parseFloat(cleaned.slice(1, -1));
    return Number.isFinite(n) ? -n : null;
  }
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseDate(str) {
  if (!str) return null;
  const s = str.trim();
  // ISO (YYYY-MM-DD) passes straight through to Postgres.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  // MM/DD/YYYY or DD/MM/YYYY — assume MM/DD/YYYY (most common bank export format).
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  return s; // let Postgres attempt to parse anything else, or reject it
}

/**
 * Parse raw CSV text into an array of { transaction_date, description,
 * reference, amount } lines suitable for BankTransaction.createMany.
 * Throws if no header row can be matched to at least a date and an amount
 * (or debit/credit pair).
 */
function parseCsv(csvText) {
  const lines = String(csvText || '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row');

  const headerCells = splitCsvLine(lines[0]);
  const fieldByCol = headerCells.map(matchHeader);

  if (!fieldByCol.includes('date')) throw new Error('CSV header must include a date column (e.g. "Date")');
  const hasAmount = fieldByCol.includes('amount');
  const hasDebitCredit = fieldByCol.includes('debit') || fieldByCol.includes('credit');
  if (!hasAmount && !hasDebitCredit) {
    throw new Error('CSV header must include an "Amount" column, or "Debit"/"Credit" columns');
  }

  const rows = [];
  const errors = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const record = {};
    fieldByCol.forEach((field, idx) => { if (field) record[field] = cells[idx]; });

    const transaction_date = parseDate(record.date);
    if (!transaction_date) { errors.push({ line: i + 1, error: 'missing/unparseable date' }); continue; }

    let amount = null;
    if (hasAmount) {
      amount = parseAmount(record.amount);
    } else {
      const debit = parseAmount(record.debit) || 0;
      const credit = parseAmount(record.credit) || 0;
      amount = credit - debit;
    }
    if (amount == null || amount === 0) { errors.push({ line: i + 1, error: 'missing/zero amount' }); continue; }

    rows.push({
      transaction_date,
      description: record.description || null,
      reference: record.reference || null,
      amount,
    });
  }

  return { rows, errors };
}

/**
 * Parse and import a CSV bank statement for one bank account.
 */
async function importStatement(bankAccountId, csvText, userId) {
  const { rows, errors } = parseCsv(csvText);
  const imported = await BankTransaction.createMany(bankAccountId, rows, userId);
  return { imported, skipped: errors.length, errors };
}

module.exports = { parseCsv, importStatement };
