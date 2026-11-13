const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { pool } = require('../config/database');
const RevenueRecognitionService = require('../services/revenueRecognitionService');

let dbAvailable = false;

before(async () => {
  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  await pool.end();
});

test('resolveAccounts returns explicit mappings from company_gl_mappings when set', async (t) => {
  if (!dbAvailable) return t.skip('No database');

  const { rows } = await pool.query(`SELECT id FROM companies ORDER BY created_at ASC LIMIT 1`);
  if (rows.length === 0) return t.skip('No company available in DB');
  const companyId = rows[0].id;

  // Insert explicit GL mapping
  await pool.query(
    `INSERT INTO company_gl_mappings (company_id, purpose, account_code)
     VALUES ($1, 'DEFERRED_REVENUE', '2210'), ($1, 'RECOGNIZED_REVENUE', '4110')
     ON CONFLICT (company_id, purpose) DO UPDATE SET account_code = EXCLUDED.account_code`,
    [companyId]
  );

  const { deferredAccount, revenueAccount } = await RevenueRecognitionService.resolveAccounts(companyId);
  assert.equal(deferredAccount, '2210');
  assert.equal(revenueAccount, '4110');
});

