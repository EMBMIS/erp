// Task 16 (F1) — full consolidation with NCI, IFRS-style.
//
// Group: P (parent, USD) owns 80% of S (subsidiary, EUR).
//   • P sells 800 of goods to S intercompany (linked JEs: P books
//     Dr IC_AR / Cr IC_REVENUE; S books Dr INVENTORY / Cr IC_AP).
//   • P also has 2000 of external revenue; S has 300 of external expense.
//   • EUR->USD rates exist (closing 1.10, average ~1.05) so the translated
//     balance sheet needs a CTA to balance.
//
// Verify lines (roadmap Task 16):
//   (a) intercompany AR/AP nets to ZERO after elimination
//   (b) CTA balances the translated balance sheet
//   (c) drill-through sums to the consolidated figure

const assert = require('node:assert/strict');

const {
  generateConsolidatedFinancials,
  generateEliminationEntries,
} = require('../services/intercompanyService');
const { pool } = require('../config/database');
const {
  enableMultiCompany,
  disableMultiCompany,
  insertAsAppRole,
  resetTestCompanies,
} = require('./helpers/multiCompany');
const companyContext = require('../services/companyContext');

let dbAvailable = false;
let userId = null;
let parentId = null;
let subId = null;

// This suite seeds TWO of its own dedicated companies (parent + sub), so no
// single ambient context (this file's own, or the shared default) is right
// for every call — seedAccount/seedMapping/postJE below each take companyId
// per call and establish their own context; before()/after() do the same
// around blocks that touch both companies. Test bodies call
// generateEliminationEntries/generateConsolidatedFinancials (which now loop
// per company internally — see services/intercompanyService.js) and the
// local icBalances() helper (same fix, below), so they need no wrapping.
const { test, before, after } = require('node:test');
const created = {
  companyIds: [],
  accountIds: [],
  mappingIds: [],
  entryIds: [],
  icTxIds: [],
};

const IC_AMOUNT = 800;
const EXTERNAL_REVENUE = 2000;
const SUB_EXPENSE = 300;
const CLOSING_RATE = 1.10;

async function seedAccount(companyId, code, name, type, subtype, normalBalance, balance = 0) {
  const { rows } = await companyContext.runWithCompany(companyId, () => pool.query(
    `INSERT INTO chart_of_accounts (company_id, account_code, account_name, account_type,
       account_subtype, account_level, is_header, normal_balance, status, created_by,
       allow_manual_posting, balance_sheet_section, current_balance)
     VALUES ($1, $2, $3, $4::text, $5::text, 3, false, $6, 'ACTIVE', $7, true,
       CASE WHEN $4::text = 'ASSET' THEN 'CURRENT_ASSETS' WHEN $4::text = 'LIABILITY' THEN 'CURRENT_LIABILITIES'
            WHEN $4::text = 'EQUITY' THEN 'EQUITY' ELSE 'OTHER' END, $8) RETURNING id`,
    [companyId, code, name, type, subtype, normalBalance, userId, balance]
  ));
  created.accountIds.push(rows[0].id);
  return rows[0].id;
}

async function seedMapping(companyId, purpose, accountCode) {
  const { rows } = await companyContext.runWithCompany(companyId, () => pool.query(
    'INSERT INTO company_gl_mappings (company_id, purpose, account_code) VALUES ($1, $2, $3) RETURNING id',
    [companyId, purpose, accountCode]
  ));
  created.mappingIds.push(rows[0].id);
}

async function seedCompany(code, name, baseCurrency, parentId, ownership) {
  const { rows } = await insertAsAppRole(pool,
    `INSERT INTO companies (company_code, name, legal_name, base_currency, parent_company_id,
       ownership_percentage, is_default, status)
     VALUES ($1, $2, $2, $3, $4, $5, false, 'ACTIVE') RETURNING id`,
    [code, name, baseCurrency, parentId, ownership]
  );
  const companyId = rows[0].id;
  created.companyIds.push(companyId);
  return companyId;
}

async function postJE({ companyId, date, description, lines, sourceType = 'MANUAL', postingKey = null }) {
  return companyContext.runWithCompany(companyId, async () => {
    const { rows } = await pool.query(
      `INSERT INTO journal_entries
         (company_id, journal_number, entry_date, posting_date, period_year, period_month,
          source_type, description, total_debit, total_credit, status, currency, created_by,
          posting_key)
       VALUES ($1, $2, $3, $3, EXTRACT(YEAR FROM $3::date), EXTRACT(MONTH FROM $3::date),
          $4, $5, $6, $6, 'POSTED', 'USD', $7, $8)
       RETURNING id`,
      [companyId, `JE-CONS-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, date, sourceType,
        description, lines.reduce((s, l) => s + (l.debit || 0), 0), userId, postingKey]
    );
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      await pool.query(
        `INSERT INTO journal_entry_items (journal_entry_id, line_number, account_id, account_code,
           account_name, debit_amount, credit_amount, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [rows[0].id, i + 1, line.accountId, line.accountCode, line.accountName, line.debit || 0,
          line.credit || 0, line.description || '']
      );
    }
    created.entryIds.push(rows[0].id);
    return rows[0].id;
  });
}

// journal_entries/chart_of_accounts are RLS-forced with no cross-company
// carve-out (see services/intercompanyService.js's comment on the same
// issue) — a single WHERE company_id IN (...) would only see one company.
async function icBalances(companyIds) {
  const all = [];
  for (const companyId of companyIds) {
    const { rows } = await companyContext.runWithCompany(companyId, () => pool.query(
      `SELECT j.company_id, coa.account_code,
              SUM(ji.debit_amount - ji.credit_amount)::float AS net
         FROM journal_entry_items ji
         JOIN journal_entries j ON ji.journal_entry_id = j.id
         JOIN chart_of_accounts coa ON ji.account_id = coa.id
        WHERE j.company_id = $1 AND j.status = 'POSTED'
          AND coa.account_code IN ('ICARCTRL01', 'ICAPCTRL01')
        GROUP BY j.company_id, coa.account_code`,
      [companyId]
    ));
    all.push(...rows);
  }
  return all;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const { rows } = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!rows.length) throw new Error('no users');
    userId = rows[0].id;
    dbAvailable = true;
  } catch (err) {
    console.error('consolidation test setup failed:', err.message);
    dbAvailable = false;
    return;
  }

  await resetTestCompanies(pool);
  await enableMultiCompany(pool);

  // Static fixture account codes collide with leftovers from crashed runs
  // (their teardown never ran). Clear them before seeding.
  const fixtureCodes = ['ICARCTRL01', 'ICAPCTRL01', 'PSETTLE01', 'SSETTLE01', 'PEQUITY001', 'SEQUITY001',
    'PCASH0001', 'SCASH0001', 'ICREVCTRL1', 'PREVCTRL01', 'SINVCTRL01', 'SEXPCTRL01'];
  const codeList = fixtureCodes.map(x => `'${x}'`).join(',');
  await pool.query(`DELETE FROM journal_entry_items WHERE account_id IN (SELECT id FROM chart_of_accounts WHERE account_code IN (${codeList}))`).catch(() => {});
  await pool.query(`DELETE FROM company_gl_mappings WHERE account_code IN (${codeList})`).catch(() => {});
  await pool.query(`DELETE FROM chart_of_accounts WHERE account_code IN (${codeList})`).catch(() => {});

  parentId = await seedCompany(`CONSP${Date.now().toString(36).toUpperCase()}`, 'Consolidation Parent', 'USD', null, 100);
  subId = await seedCompany(`CONSS${Date.now().toString(36).toUpperCase()}`, 'Consolidation Sub', 'EUR', parentId, 80);

  // Parent COA + mappings.
  const pCash = await seedAccount(parentId, 'PCASH0001', 'Parent Cash', 'ASSET', 'CASH', 'DEBIT');
  const pAr = await seedAccount(parentId, 'ICARCTRL01', 'IC Receivable', 'ASSET', 'ACCOUNTS_RECEIVABLE', 'DEBIT');
  const pRev = await seedAccount(parentId, 'ICREVCTRL1', 'IC Revenue', 'REVENUE', 'REVENUE', 'CREDIT');
  await seedAccount(parentId, 'PREVCTRL01', 'External Revenue', 'REVENUE', 'REVENUE', 'CREDIT');
  await seedMapping(parentId, 'IC_AR_CONTROL', 'ICARCTRL01');
  await seedAccount(parentId, 'PSETTLE01', 'IC Settlement', 'ASSET', 'CURRENT_ASSETS', 'DEBIT');
  await seedMapping(parentId, 'IC_SETTLEMENT', 'PSETTLE01');
  const pEquity = await seedAccount(parentId, 'PEQUITY001', 'Parent Equity', 'EQUITY', 'EQUITY', 'CREDIT');
  await seedMapping(parentId, 'IC_REVENUE', 'ICREVCTRL1');

  // Sub COA + mappings.
  const sCash = await seedAccount(subId, 'SCASH0001', 'Sub Cash', 'ASSET', 'CASH', 'DEBIT');
  const sInv = await seedAccount(subId, 'SINVCTRL01', 'Sub Inventory', 'ASSET', 'INVENTORY', 'DEBIT');
  const sAp = await seedAccount(subId, 'ICAPCTRL01', 'IC Payable', 'LIABILITY', 'ACCOUNTS_PAYABLE', 'CREDIT');
  await seedAccount(subId, 'SEXPCTRL01', 'External Expense', 'EXPENSE', 'EXPENSE', 'DEBIT');
  await seedMapping(subId, 'IC_AP_CONTROL', 'ICAPCTRL01');
  await seedAccount(subId, 'SSETTLE01', 'IC Settlement', 'ASSET', 'CURRENT_ASSETS', 'DEBIT');
  await seedMapping(subId, 'IC_SETTLEMENT', 'SSETTLE01');
  const sEquity = await seedAccount(subId, 'SEQUITY001', 'Sub Equity', 'EQUITY', 'EQUITY', 'CREDIT');
  await seedMapping(subId, 'IC_COGS', 'SINVCTRL01');

  // Opening balances are REAL journal entries (the consolidation reads
  // journal items, not chart_of_accounts.current_balance).
  await postJE({ companyId: parentId, date: '2026-07-01', description: 'Opening balance', lines: [
    { accountId: pCash, accountCode: 'PCASH0001', accountName: 'Parent Cash', debit: 10000 },
    { accountId: pEquity, accountCode: 'PEQUITY001', accountName: 'Parent Equity', credit: 10000 },
  ]});
  await postJE({ companyId: subId, date: '2026-07-01', description: 'Opening balance', lines: [
    { accountId: sCash, accountCode: 'SCASH0001', accountName: 'Sub Cash', debit: 5000 },
    { accountId: sEquity, accountCode: 'SEQUITY001', accountName: 'Sub Equity', credit: 5000 },
  ]});

  // External activity.
  await postJE({ companyId: parentId, date: '2026-07-10', description: 'External revenue', lines: [
    { accountId: pCash, accountCode: 'P-CASH', accountName: 'Parent Cash', debit: EXTERNAL_REVENUE },
    { accountId: pRev, accountCode: 'P-REV', accountName: 'External Revenue', credit: EXTERNAL_REVENUE },
  ]});
  const sExpAccount = await companyContext.runWithCompany(subId, () => pool.query(
    `SELECT id FROM chart_of_accounts WHERE company_id = $1 AND account_code = 'SEXPCTRL01'`, [subId]));
  await postJE({ companyId: subId, date: '2026-07-12', description: 'External expense', lines: [
    { accountId: sCash, accountCode: 'S-CASH', accountName: 'Sub Cash', credit: SUB_EXPENSE },
    { accountId: sExpAccount.rows[0].id,
      accountCode: 'S-EXP', accountName: 'External Expense', debit: SUB_EXPENSE },
  ]});

  // Intercompany sale: P sells 800 to S with linked JEs.
  const sellerJe = await postJE({ companyId: parentId, date: '2026-07-15', description: 'IC sale to sub', sourceType: 'INTERCOMPANY', lines: [
    { accountId: pAr, accountCode: 'IC_AR', accountName: 'IC Receivable', debit: IC_AMOUNT },
    { accountId: pRev, accountCode: 'IC_REV', accountName: 'IC Revenue', credit: IC_AMOUNT },
  ]});
  const buyerJe = await postJE({ companyId: subId, date: '2026-07-15', description: 'IC purchase from parent', sourceType: 'INTERCOMPANY', lines: [
    { accountId: sInv, accountCode: 'S-INV', accountName: 'Sub Inventory', debit: IC_AMOUNT },
    { accountId: sAp, accountCode: 'IC_AP', accountName: 'IC Payable', credit: IC_AMOUNT },
  ]});
  const { rows: icTx } = await pool.query(
    `INSERT INTO intercompany_transactions
       (from_company_id, to_company_id, transaction_type, reference, amount, currency, transaction_date,
        description, from_journal_entry_id, to_journal_entry_id, status)
     VALUES ($1, $2, 'SALE', $6, $3, 'USD', '2026-07-15', 'P sells goods to S',
        $4, $5, 'POSTED') RETURNING id`,
    [parentId, subId, IC_AMOUNT, sellerJe, buyerJe, `IC-SALE-${Date.now()}`]
  );
  created.icTxIds.push(icTx[0].id);

  // EUR -> USD rates: closing 1.10, historical 1.00 (average ~1.05).
  await pool.query(
    `INSERT INTO exchange_rates (from_currency, to_currency, rate, rate_date, created_by)
     VALUES ('EUR', 'USD', 1.00, '2026-07-01', $1), ('EUR', 'USD', 1.10, '2026-07-31', $1)`,
    [userId]
  );
});

after(async () => {
  if (!dbAvailable) return;
  try {
    for (const id of created.icTxIds) {
      await pool.query('DELETE FROM intercompany_transactions WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.entryIds) {
      await pool.query('DELETE FROM journal_entry_items WHERE journal_entry_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM journal_entries WHERE id = $1', [id]).catch(() => {});
    }
    await pool.query('DELETE FROM exchange_rates WHERE created_by = $1', [userId]).catch(() => {});
    for (const id of created.mappingIds) {
      await pool.query('DELETE FROM company_gl_mappings WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.accountIds) {
      await pool.query('DELETE FROM chart_of_accounts WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.companyIds) {
      await pool.query('DELETE FROM companies WHERE id = $1', [id]).catch(() => {});
    }
    await resetTestCompanies(pool).catch(() => {});
    await disableMultiCompany(pool).catch(() => {});
  } catch (err) {
    console.error('consolidation test teardown error:', err.message);
  }
  await pool.end();
});

test('intercompany AR/AP nets to ZERO after identifiable elimination', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const result = await generateEliminationEntries({ companyIds: [parentId, subId], userId });

  assert.equal(result.ok, true);
  const arAp = result.entries.filter(e => e.type === 'IC_AR_AP');
  assert.equal(arAp.length, 2, 'one IC AR/AP elimination entry per side (seller + buyer)');
  assert.ok(arAp.every(e => e.amount === IC_AMOUNT));
  assert.ok(arAp[0].journalEntryId, 'the elimination is a real posted journal entry');

  // Revenue and COGS live in different companies' books, so eliminating them
  // is two separate self-balanced entries (one per side, each netting through
  // that company's own IC settlement account) — never one entry with a line
  // in someone else's chart of accounts. See services/intercompanyService.js.
  const revCogs = result.entries.filter(e => e.type === 'IC_REVENUE_COGS');
  assert.equal(revCogs.length, 2, 'one IC revenue/COGS elimination entry per side (seller + buyer)');
  assert.ok(revCogs.every(e => e.amount === IC_AMOUNT));

  // The elimination entry offset the IC legs: net IC balances are zero.
  const balances = await icBalances([parentId, subId]);
  for (const b of balances) {
    assert.ok(Math.abs(b.net) < 0.01, `${b.account_code} in ${b.company_id} must net to zero, got ${b.net}`);
  }

  // Re-running is idempotent — the IC transaction is stamped eliminated.
  const second = await generateEliminationEntries({ companyIds: [parentId, subId], userId });
  assert.equal(second.entries.length, 0, 'no new elimination entries on re-run');
});

test('CTA balances the translated balance sheet and NCI splits the sub share', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const result = await generateConsolidatedFinancials({ companyIds: [parentId, subId], targetCurrency: 'USD', asOf: '2026-07-31', userId });

  assert.equal(result.success, true);
  console.log('PNL DEBUG:', JSON.stringify(result.consolidated_pnl));
  console.log('BS DEBUG2:', JSON.stringify(result.consolidated_balance_sheet));
  for (const [cid, e] of Object.entries(result.entity_drill_through)) { console.log('ENT2 ' + cid.slice(0, 8) + ': nci ' + JSON.stringify(e.nci) + ' own ' + e.ownership_percentage + ' parent ' + e.is_parent); }
  assert.equal(result.method, 'full_consolidation');
  assert.equal(result.currency, 'USD');

  // (b) The translated balance sheet balances: assets = liabilities + equity + NCI.
  const bs = result.consolidated_balance_sheet;
  assert.equal(bs.balanced, true,
    `balance sheet must balance: A ${bs.total_assets} vs L ${bs.total_liabilities} + E ${bs.total_equity} + NCI ${bs.non_controlling_interest}`);

  // The EUR sub translates at 1.10 (closing) — its assets differ from raw,
  // and the CTA is the balancing plug in equity.
  const sub = result.entity_drill_through[subId];
  // The IC COGS elimination (mapped to the buyer's inventory) removes the IC
  // purchase from the sub's assets: 5000 - 300 + 800 - 800 = 4700, x 1.10.
  assert.equal(sub.translated.assets, Number((5000 - 300).toFixed(2)) * CLOSING_RATE);
  assert.ok(Math.abs(sub.translated.cta) > 0, 'the EUR sub produces a CTA');

  // NCI: 20% of the sub's translated equity + profit.
  // The sub runs a loss, so the NCI bears 20% of it (negative share).
  assert.ok(result.consolidated_pnl.net_income_attributable_to_nci < 0, 'NCI bears 20% of the sub loss');
  assert.ok(bs.non_controlling_interest > 0);
  assert.equal(
    Number((bs.non_controlling_interest).toFixed(2)),
    Number((sub.nci.equity).toFixed(2)),
    'NCI on the balance sheet equals the sub NCI share'
  );

  // Test 1 already eliminated the IC transaction; this run must REUSE it
  // (idempotent) — the registry row is stamped ELIMINATED, never re-eliminated.
  const { rows: icCheck } = await pool.query(
    'SELECT status FROM intercompany_transactions WHERE id = $1',
    [created.icTxIds[0]]
  );
  assert.equal(icCheck[0].status, 'ELIMINATED', 'the IC transaction is stamped eliminated (idempotent reuse)');
});

test('drill-through sums to the consolidated figures', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const result = await generateConsolidatedFinancials({ companyIds: [parentId, subId], targetCurrency: 'USD', asOf: '2026-07-31', userId });

  const entities = Object.values(result.entity_drill_through);
  assert.equal(entities.length, 2);

  // (c) Sum of translated assets across entities == consolidated total assets.
  const sumAssets = entities.reduce((s, e) => s + e.translated.assets, 0);
  assert.equal(Number(sumAssets.toFixed(2)), result.consolidated_balance_sheet.total_assets);

  // Every consolidated P&L line is traceable to its entities.
  const sumProfitParentShare = entities.reduce((s, e) => s + e.parent_share.profit, 0);
  assert.equal(
    Number(sumProfitParentShare.toFixed(2)),
    result.consolidated_pnl.net_income_attributable_to_parent,
    'parent-attributable income is the sum of the parent shares'
  );

  // Drill-through reaches journal entries.
  for (const e of entities) {
    assert.ok(Array.isArray(e.top_entries) && e.top_entries.length > 0,
      `${e.company_code} must expose top journal entries`);
  }
});
