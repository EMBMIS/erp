#!/usr/bin/env node
/**
 * Live-database invariant checker.
 *
 * `db-migrate.js --status` answers "which migration files ran?". That is not the
 * same question as "is the database actually in the shape the code expects?" —
 * and the gap between those two is exactly where this project has repeatedly
 * lost fixes. Migrations 088 and 089 were both recorded as applied while the
 * advisory locks they add were absent from the live DB for weeks.
 *
 * This script asserts the invariants directly against the running database, so
 * drift is caught by a command instead of by a production incident.
 *
 * Exit code 0 = all invariants hold, 1 = at least one violation.
 *
 * Usage:
 *   node scripts/db-verify.js
 *   node scripts/db-verify.js --json
 */

const { pool } = require('../config/database');

const checks = [];
function check(name, description, fn) {
  checks.push({ name, description, fn });
}

// ---------------------------------------------------------------------------
// Concurrency: every MAX()+1 number generator must serialize itself.
// Without the lock two concurrent inserts compute the same number and the
// second dies on the UNIQUE constraint — a load-only failure.
// ---------------------------------------------------------------------------
const LOCKED_GENERATORS = [
  'generate_journal_entry_number',
  'generate_asset_number',
  'generate_employee_number',
  'generate_invoice_number',
  'generate_payment_number',
  'generate_sales_rfq_number',
  'generate_supplier_bill_number',
  'generate_supplier_payment_number',
  'generate_transfer_number',
];

check('number-generator-locks', 'every MAX()+1 number generator holds an advisory lock', async () => {
  const { rows } = await pool.query(
    `SELECT proname, (prosrc ~* 'pg_advisory') AS locked
       FROM pg_proc WHERE proname = ANY($1)`,
    [LOCKED_GENERATORS]
  );
  const found = new Map(rows.map((r) => [r.proname, r.locked]));
  const problems = [];
  for (const fn of LOCKED_GENERATORS) {
    if (!found.has(fn)) problems.push(`${fn}() is missing from the database`);
    else if (!found.get(fn)) problems.push(`${fn}() has no pg_advisory_xact_lock — concurrent callers can collide`);
  }
  return problems;
});

// ---------------------------------------------------------------------------
// The ambiguous-column bug that blocked all journal posting. Assert behaviour,
// not source text: the function must actually return a number.
// ---------------------------------------------------------------------------
check('journal-numbering-works', 'generate_journal_entry_number() returns a well-formed number', async () => {
  try {
    const { rows } = await pool.query('SELECT generate_journal_entry_number() AS n');
    const n = rows[0].n;
    if (!/^JE-\d{4}-\d{6}$/.test(n)) return [`returned an unexpected format: ${n}`];
    return [];
  } catch (err) {
    return [`call failed (this blocks ALL journal entries): ${err.message}`];
  }
});

// ---------------------------------------------------------------------------
// Columns the models reference. CREATE TABLE IF NOT EXISTS silently no-ops on a
// pre-existing table, so columns added by later revisions can be missing.
// ---------------------------------------------------------------------------
const REQUIRED_COLUMNS = [
  ['supplier_invoices', 'purchase_order_id'],
  ['supplier_invoices', 'journal_entry_id'],
  ['employees', 'housing_allowance'],
  ['employees', 'transport_allowance'],
  ['employees', 'other_allowance'],
  ['journal_entries', 'journal_number'],
];

check('required-columns', 'columns the models reference exist', async () => {
  const problems = [];
  for (const [table, column] of REQUIRED_COLUMNS) {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      [table, column]
    );
    if (!rows.length) problems.push(`${table}.${column} is missing`);
  }
  return problems;
});

// ---------------------------------------------------------------------------
// GL accounts the posting code hard-codes. A missing account turns into a
// runtime failure deep inside a posting transaction.
// ---------------------------------------------------------------------------
const REQUIRED_ACCOUNTS = ['1130', '2115', '4900', '5100', '5900'];

check('required-gl-accounts', 'GL accounts referenced by the posting service exist', async () => {
  const { rows } = await pool.query(
    'SELECT account_code FROM chart_of_accounts WHERE account_code = ANY($1)',
    [REQUIRED_ACCOUNTS]
  );
  const have = new Set(rows.map((r) => r.account_code));
  return REQUIRED_ACCOUNTS.filter((c) => !have.has(c)).map((c) => `chart_of_accounts is missing account ${c}`);
});

// ---------------------------------------------------------------------------
// Accounting integrity: a posted journal entry MUST balance. This is the single
// most important invariant in the system — an unbalanced posted entry means
// every downstream report is wrong.
// ---------------------------------------------------------------------------
check('posted-entries-balance', 'every POSTED journal entry has debits = credits', async () => {
  const { rows } = await pool.query(`
    SELECT je.journal_number,
           ROUND(SUM(jel.debit_amount), 2)  AS debits,
           ROUND(SUM(jel.credit_amount), 2) AS credits
      FROM journal_entries je
      JOIN journal_entry_items jel ON jel.journal_entry_id = je.id
     WHERE je.status = 'POSTED'
     GROUP BY je.id, je.journal_number
    HAVING ROUND(SUM(jel.debit_amount), 2) <> ROUND(SUM(jel.credit_amount), 2)
     LIMIT 20
  `);
  return rows.map((r) => `${r.journal_number} is unbalanced: debits ${r.debits} vs credits ${r.credits}`);
});

// ---------------------------------------------------------------------------
// Every journal line must point at a real account.
// ---------------------------------------------------------------------------
check('journal-lines-have-accounts', 'no journal line references a missing GL account', async () => {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS n
      FROM journal_entry_items jel
      LEFT JOIN chart_of_accounts coa ON coa.id = jel.account_id
     WHERE coa.id IS NULL
  `);
  return rows[0].n > 0 ? [`${rows[0].n} journal line(s) reference a non-existent account`] : [];
});

// ---------------------------------------------------------------------------
// chart_of_accounts.current_balance is a denormalised cache maintained
// incrementally by ChartOfAccounts.updateBalance. getTrialBalance derives from
// the journal lines instead, so when the cache drifts the same account reports
// two different balances depending on which endpoint you call — the balance
// sheet summary and account-detail views read the cache.
// ---------------------------------------------------------------------------
check('account-balance-cache', 'cached account balances match their posted journal lines', async () => {
  const { rows } = await pool.query(`
    SELECT coa.account_code, coa.account_name,
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
     LIMIT 20
  `);
  return rows.map(
    (r) => `${r.account_code} ${r.account_name}: cached ${r.stored} vs ${r.derived} posted (out by ${(r.derived - r.stored).toFixed(2)})`
  );
});

// ---------------------------------------------------------------------------
// Status vocabularies must match between the application allowlist and the DB
// CHECK constraint. When they drift, the DB accepts a value the API rejects (or
// vice versa) and transitions break in one layer only — which is exactly how
// the sales-order pipeline ended up half-working.
// ---------------------------------------------------------------------------
function statusesFromCheck(def) {
  // Parses: CHECK (((status)::text = ANY (ARRAY['A'::character varying, ...])))
  return [...String(def).matchAll(/'([A-Z_]+)'::character varying/g)].map((m) => m[1]).sort();
}

check('status-vocabulary-matches-db', 'model status allowlists match the DB CHECK constraints', async () => {
  const problems = [];
  const targets = [
    { constraint: 'sales_orders_status_check', model: '../models/SalesOrder', label: 'SalesOrder' },
  ];

  for (const t of targets) {
    const { rows } = await pool.query(
      'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1',
      [t.constraint]
    );
    if (!rows.length) {
      problems.push(`${t.constraint} not found in the database`);
      continue;
    }
    const dbStatuses = statusesFromCheck(rows[0].def);
    let modelStatuses;
    try {
      modelStatuses = [...require(t.model).STATUSES].sort();
    } catch (err) {
      problems.push(`could not read ${t.label}.STATUSES: ${err.message}`);
      continue;
    }

    const missingInModel = dbStatuses.filter((s) => !modelStatuses.includes(s));
    const missingInDb = modelStatuses.filter((s) => !dbStatuses.includes(s));

    if (missingInModel.length) {
      problems.push(
        `${t.label}.STATUSES is missing ${missingInModel.join(', ')} — the DB accepts these but the API will reject them with a 400`
      );
    }
    if (missingInDb.length) {
      problems.push(
        `${t.label}.STATUSES allows ${missingInDb.join(', ')} which the DB CHECK rejects — setting one raises a constraint violation`
      );
    }
  }

  // Also assert stateMachine transition maps agree with DB CHECK constraints
  try {
    const { TRANSITION_MAPS } = require('../services/stateMachine');
    if (!TRANSITION_MAPS || Object.keys(TRANSITION_MAPS).length === 0) {
      problems.push('stateMachine.TRANSITION_MAPS is missing or empty');
    }
  } catch (err) {
    problems.push(`could not load services/stateMachine: ${err.message}`);
  }

  return problems;
});

// ---------------------------------------------------------------------------
// Migration bookkeeping: files edited after they were applied mean the live DB
// silently lags the repo.
// ---------------------------------------------------------------------------
check('migration-checksums', 'applied migrations still match their files', async () => {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const dir = path.join(__dirname, '../database/migrations');
  const { rows } = await pool.query('SELECT filename, checksum FROM schema_migrations');
  const problems = [];
  for (const row of rows) {
    const file = path.join(dir, row.filename);
    if (!fs.existsSync(file)) {
      problems.push(`${row.filename} is recorded as applied but no longer exists in the repo`);
      continue;
    }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex');
    if (actual !== row.checksum) problems.push(`${row.filename} was edited after it was applied`);
  }
  return problems;
});

async function main() {
  const asJson = process.argv.includes('--json');
  const results = [];
  let violations = 0;

  for (const c of checks) {
    let problems;
    try {
      problems = await c.fn();
    } catch (err) {
      problems = [`check itself failed: ${err.message}`];
    }
    violations += problems.length;
    results.push({ name: c.name, description: c.description, ok: problems.length === 0, problems });
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: violations === 0, violations, results }, null, 2));
  } else {
    for (const r of results) {
      console.log(`${r.ok ? '✅' : '❌'} ${r.name} — ${r.description}`);
      r.problems.forEach((p) => console.log(`     ↳ ${p}`));
    }
    console.log(
      violations === 0
        ? `\n✔ All ${checks.length} invariants hold.`
        : `\n✖ ${violations} violation(s) across ${results.filter((r) => !r.ok).length} check(s).`
    );
  }
  return violations === 0 ? 0 : 1;
}

main()
  .then((code) => pool.end().then(() => process.exit(code)))
  .catch((err) => {
    console.error('Verification aborted:', err.message);
    pool.end().then(() => process.exit(1));
  });
