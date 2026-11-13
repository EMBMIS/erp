// Round 7, Task 19 — continuous close, actually running.
//
// The AI continuous-close sweep is wired into the agent scheduler per-company
// (services/agents/scheduler.js → forEachCompany). This test proves the whole
// loop on TWO companies, each with a seeded sub-ledger break:
//
//   • the scheduler sweep reconciles each sub-ledger to its GL control account
//   • one break → exactly one ai_finding AND one DRAFT correcting journal
//     entry per company, with NOTHING posted (the "AI proposes, humans
//     approve" rule)
//   • approve → posts the draft and resolves the finding
//   • dismiss → records why and the next sweep does not re-raise it
//
// Run on its own:  node --test tests/continuousClose.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const scheduler = require('../services/agents/scheduler');
const { approveFinding, dismissFinding } = require('../services/ai/findingsActions');
const { pool } = require('../config/database');
const { enableMultiCompany, disableMultiCompany, insertAsAppRole, resetTestCompanies } = require('./helpers/multiCompany');
const companyContext = require('../services/companyContext');

let dbAvailable = false;
let userId = null;
let companies = []; // { id, code } the two test companies (A and B)
const created = {
  companyIds: [],
  customerIds: [],
  invoiceIds: [],
  accountIds: [],
  mappingIds: [],
  findingIds: [],
  suppressionIds: [],
};

const AR_GL_BALANCE = 5000;
const SUBLEDGER_TOTAL = 3000;
const BREAK_AMOUNT = AR_GL_BALANCE - SUBLEDGER_TOTAL; // 2000

async function seedCompany(idx) {
  const code = `CCT${Date.now()}_${idx}`;
  // chart_of_accounts.account_code has a GLOBAL unique constraint, so the two
  // test companies (and the pre-existing default company's COA) must not
  // reuse codes. Codes are derived per company; the sweep resolves accounts
  // through company_gl_mappings, so the codes themselves only need to be
  // unique.
  const ts = Date.now().toString().slice(-6);
  const arCode = idx === 0 ? '1198' + ts : '1199' + ts;
  const suspCode = idx === 0 ? '2198' + ts : '2199' + ts;
  const { rows } = await insertAsAppRole(pool,
    `INSERT INTO companies (company_code, name, legal_name, base_currency, is_default, status)
     VALUES ($1, $2, $2, 'USD', false, 'ACTIVE') RETURNING id`,
    [code, `Continuous Close Test ${idx}`]
  );
  const companyId = rows[0].id;
  created.companyIds.push(companyId);

  // chart_of_accounts/company_gl_mappings/customers/customer_invoices are all
  // RLS-forced on company_id = current_company_id() — every insert below
  // must run under THIS company's own context, not whatever the ambient one
  // happens to be (there are two of these test companies, seeded back to
  // back, so there is no single "right" ambient context for both).
  await companyContext.runWithCompany(companyId, async () => {
    // Chart accounts: AR control with the balance the GL believes, and
    // the reconciliation suspense account.
    const ar = await pool.query(
      `INSERT INTO chart_of_accounts (company_id, account_code, account_name, account_type,
         account_subtype, account_level, is_header, normal_balance, status, created_by,
         allow_manual_posting, balance_sheet_section, current_balance)
       VALUES ($1, ${arCode}, 'Accounts Receivable', 'ASSET', 'ACCOUNTS_RECEIVABLE', 3, false,
         'DEBIT', 'ACTIVE', $2, true, 'CURRENT_ASSETS', $3) RETURNING id`,
      [companyId, userId, AR_GL_BALANCE]
    );
    const suspense = await pool.query(
      `INSERT INTO chart_of_accounts (company_id, account_code, account_name, account_type,
         account_subtype, account_level, is_header, normal_balance, status, created_by,
         allow_manual_posting, balance_sheet_section)
       VALUES ($1, ${suspCode}, 'AI Reconciliation Suspense', 'LIABILITY', 'CURRENT_LIABILITY', 3,
         false, 'CREDIT', 'ACTIVE', $2, true, 'CURRENT_LIABILITIES') RETURNING id`,
      [companyId, userId]
    );
    created.accountIds.push(ar.rows[0].id, suspense.rows[0].id);

    const map1 = await pool.query(
      `INSERT INTO company_gl_mappings (company_id, purpose, account_code)
       VALUES ($1, 'AR_CONTROL', '${arCode}') RETURNING id`,
      [companyId]
    );
    const map2 = await pool.query(
      `INSERT INTO company_gl_mappings (company_id, purpose, account_code)
       VALUES ($1, 'RECON_SUSPENSE', '${suspCode}') RETURNING id`,
      [companyId]
    );
    created.mappingIds.push(map1.rows[0].id, map2.rows[0].id);

    const cust = await pool.query(
      `INSERT INTO customers (company_id, customer_code, customer_name, primary_email, status, created_by)
       VALUES ($1, $2, 'CC Test Customer', 'cc@test.local', 'ACTIVE', $3) RETURNING id`,
      [companyId, `CC-${Date.now().toString().slice(-8)}-${idx}`, userId]
    );
    created.customerIds.push(cust.rows[0].id);

    // The seeded break: sub-ledger says 3000, GL control account says 5000.
    const inv = await pool.query(
      `INSERT INTO customer_invoices (company_id, invoice_number, customer_id, invoice_date,
         due_date, total_amount, paid_amount, status, created_by)
       VALUES ($1, $2, $3, CURRENT_DATE - 10, CURRENT_DATE + 20, $4, 0, 'APPROVED', $5) RETURNING id`,
      [companyId, `CINV-CC-${idx}-${Date.now()}`, cust.rows[0].id, SUBLEDGER_TOTAL, userId]
    );
    created.invoiceIds.push(inv.rows[0].id);
  });

  return { id: companyId, code };
}

// journal_entries/ai_findings are both RLS-forced — read under the specific
// company being inspected, not whatever the ambient context is.
async function sweepStats(companyId) {
  return companyContext.runWithCompany(companyId, async () => {
    const findings = await pool.query(
      `SELECT id, status, proposed_journal_entry_id, data, description FROM ai_findings
        WHERE company_id = $1 AND finding_type = 'SUB_LEDGER_RECONCILIATION'`,
      [companyId]
    );
    const entries = await pool.query(
      `SELECT id, status, posting_key FROM journal_entries
        WHERE company_id = $1 AND source_type = 'AI_CONTINUOUS_CLOSE'`,
      [companyId]
    );
    return { findings: findings.rows, entries: entries.rows };
  });
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!users.rows.length) throw new Error('no users in the database');
    userId = users.rows[0].id;
    dbAvailable = true;
  } catch (err) {
    console.error('continuous-close test setup failed:', err.message);
    dbAvailable = false;
    return;
  }

  // Two companies need the tenancy boundary live (migration 110's guard
  // refuses a second company while isolation is off). The suite runs under
  // the real restricted connection (config/database.js prefers
  // APP_DATABASE_URL's qira_app role, NOBYPASSRLS) — every read/write against
  // a company-scoped table below runs inside companyContext.runWithCompany
  // for the specific company it's about, which is what keeps per-company
  // assertions exact under real RLS. The isolation drill itself lives in
  // scripts/verify-tenancy.js.
  await resetTestCompanies(pool);
  // Seeding a SECOND company is refused by migration 111's guard unless
  // isolation is actually on. The helper was imported but never called.
  await enableMultiCompany(pool);
  // Keep the sweep away from the pre-existing default company's real ledger:
  // the default company is excluded from forEachCompany while INACTIVE and is
  // restored in teardown.
  await pool.query("UPDATE companies SET status = 'INACTIVE' WHERE is_default = true");

  scheduler.resetContinuousCloseGuard();
  companies = [await seedCompany(0), await seedCompany(1)];
});

after(async () => {
  if (!dbAvailable) return;
  try {
    // Findings reference the draft JEs — remove findings first.
    for (const id of created.findingIds) {
      await pool.query('DELETE FROM ai_findings WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.suppressionIds) {
      await pool.query('DELETE FROM ai_finding_suppressions WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.companyIds) {
      await pool.query(
        `DELETE FROM journal_entry_status_history
          WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id = $1)`,
        [id]
      ).catch(() => {});
      await pool.query(
        `DELETE FROM journal_entry_items
          WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id = $1)`,
        [id]
      ).catch(() => {});
      await pool.query('DELETE FROM journal_entries WHERE company_id = $1', [id]).catch(() => {});
      await pool.query(
        'DELETE FROM ai_findings WHERE company_id = $1',
        [id]
      ).catch(() => {});
    }
    for (const id of created.invoiceIds) {
      await pool.query('DELETE FROM customer_invoices WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.customerIds) {
      await pool.query('DELETE FROM customers WHERE id = $1', [id]).catch(() => {});
    }
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
    await pool.query("UPDATE companies SET status = 'ACTIVE' WHERE is_default = true").catch(() => {});
    await disableMultiCompany(pool).catch((err) => {
      console.error('continuous-close test disable-multi-company error:', err.message);
    });
  } catch (err) {
    console.error('continuous-close test teardown error:', err.message);
  }
  await pool.end();
});

test('the scheduler sweep raises exactly one finding and one DRAFT JE per company, nothing posted', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  scheduler.resetContinuousCloseGuard();
  const tick = await scheduler.tick();

  // DEBUG: surface the sweep outcome per company before asserting.
  for (const r of (tick.results || [])) {
    if (r.type === 'continuous_close') {
      console.log('SWEEP ' + (r.result && r.result.company_id) + ': ' + JSON.stringify(r.result && r.result.ledgers));
    }
  }
  // The scheduler must have run the sweep for both companies.
  const sweeps = tick.results.filter((r) => r.type === 'continuous_close' && r.result);
  assert.ok(sweeps.length >= 2, `expected a sweep result per company, got ${sweeps.length}`);

  for (const company of companies) {
    const { findings, entries } = await sweepStats(company.id);

    assert.equal(findings.length, 1,
      `company ${company.code} should have exactly one SUB_LEDGER_RECONCILIATION finding`);
    assert.equal(findings[0].status, 'OPEN');
    assert.equal(findings[0].data.difference, BREAK_AMOUNT);
    assert.ok(findings[0].description.length > 40, 'the finding must explain itself in plain English');

    assert.equal(entries.length, 1,
      `company ${company.code} should have exactly one AI_CONTINUOUS_CLOSE journal entry`);
    // Proposed, never posted. Which of the two depends on the company's
    // approval chain: JournalEntry.create makes an entry at or above the
    // chain's first band PENDING_APPROVAL rather than DRAFT.
    assert.ok(['DRAFT', 'PENDING_APPROVAL'].includes(entries[0].status),
      `the proposed correcting entry must be unposted (DRAFT or PENDING_APPROVAL), got ${entries[0].status}`);
    assert.equal(entries[0].id, findings[0].proposed_journal_entry_id,
      'the finding must link to its proposed draft');

    created.findingIds.push(findings[0].id);
  }

  // Nothing posted, anywhere, for either company.
  for (const company of companies) {
    const posted = await companyContext.runWithCompany(company.id, () => pool.query(
      `SELECT COUNT(*)::int AS n FROM journal_entries
        WHERE company_id = $1 AND source_type = 'AI_CONTINUOUS_CLOSE' AND status = 'POSTED'`,
      [company.id]
    ));
    assert.equal(posted.rows[0].n, 0, 'the sweep must never post anything by itself');
  }
});

test('re-running the sweep is idempotent — no second finding, no second draft', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  scheduler.resetContinuousCloseGuard();
  await scheduler.tick();

  for (const company of companies) {
    const { findings, entries } = await sweepStats(company.id);
    assert.equal(findings.length, 1, 'a second sweep must not duplicate the finding');
    assert.equal(entries.length, 1, 'a second sweep must reuse the same draft');
  }
});

test('approving a finding posts the draft and resolves the finding', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const company = companies[0];
  const { findings } = await sweepStats(company.id);
  assert.ok(findings[0], 'company A should still have its finding');

  const result = await companyContext.runWithCompany(company.id, () => approveFinding(findings[0].id, userId));

  assert.equal(result.finding.status, 'RESOLVED');
  assert.ok(result.finding.resolved_at);
  const { rows } = await companyContext.runWithCompany(company.id, () => pool.query(
    'SELECT status, posted_at FROM journal_entries WHERE id = $1',
    [findings[0].proposed_journal_entry_id]
  ));
  assert.equal(rows[0].status, 'POSTED', 'approving must post the proposed draft');
  assert.ok(rows[0].posted_at);
});

test('dismissing a finding records why and the next sweep does not re-raise it', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const company = companies[1];
  const { findings } = await sweepStats(company.id);
  assert.ok(findings[0], 'company B should still have its finding');

  const reason = 'Manual review: the AR control balance will be corrected by the month-end process';
  const result = await companyContext.runWithCompany(company.id, () => dismissFinding(findings[0].id, userId, reason));

  assert.equal(result.finding.status, 'DISMISSED');
  assert.equal(result.finding.dismiss_reason, reason);

  const supp = await companyContext.runWithCompany(company.id, () => pool.query(
    'SELECT * FROM ai_finding_suppressions WHERE company_id = $1 AND finding_type = $2',
    [company.id, 'SUB_LEDGER_RECONCILIATION']
  ));
  assert.equal(supp.rows.length, 1, 'dismissal must write a suppression row');
  assert.equal(supp.rows[0].reason, reason);
  created.suppressionIds.push(supp.rows[0].id);

  // Next sweep: same break, but the dismissal suppresses it.
  scheduler.resetContinuousCloseGuard();
  await scheduler.tick();

  const after = await sweepStats(company.id);
  assert.equal(after.findings.length, 1, 'no new finding should be raised');
  assert.equal(after.findings[0].status, 'DISMISSED', 'the dismissed finding must stay dismissed');
  assert.equal(after.entries.length, 1, 'no second draft should be created');
});

test('a dismissed finding cannot be approved', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const company = companies[1];
  const { findings } = await sweepStats(company.id);
  assert.equal(findings[0].status, 'DISMISSED');
  await assert.rejects(
    () => companyContext.runWithCompany(company.id, () => approveFinding(findings[0].id, userId)),
    /cannot be approved/i
  );
});
