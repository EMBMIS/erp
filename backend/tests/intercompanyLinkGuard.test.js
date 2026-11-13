// Intercompany posting must be confined to companies that actually belong to
// the same group. Without this, Intercompany.post would let any two
// unrelated companies in the system book a "due from / due to" pair against
// each other — which is not an intercompany balance, just two ledgers
// pretending to consolidate together.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const { Intercompany } = require('../models/Company');
const {
  enableMultiCompany,
  disableMultiCompany,
  insertAsAppRole,
  resetTestCompanies,
} = require('./helpers/multiCompany');

let dbAvailable = false;
let userId = null;
let parentId = null;
let childId = null;
let strangerId = null;

before(async () => {
  try {
    await pool.query('SELECT 1');
    const { rows } = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!rows.length) throw new Error('no users');
    userId = rows[0].id;
    dbAvailable = true;
  } catch (err) {
    dbAvailable = false;
    return;
  }

  await resetTestCompanies(pool);
  await enableMultiCompany(pool);

  const suffix = Date.now().toString(36).toUpperCase();

  const parent = await insertAsAppRole(pool,
    `INSERT INTO companies (company_code, name, legal_name, base_currency, is_default, status)
     VALUES ($1, $2, $2, 'USD', false, 'ACTIVE') RETURNING id`,
    [`ICLP${suffix}`, 'IC Link Parent']
  );
  parentId = parent.rows[0].id;

  const child = await insertAsAppRole(pool,
    `INSERT INTO companies (company_code, name, legal_name, base_currency, parent_company_id, is_default, status)
     VALUES ($1, $2, $2, 'USD', $3, false, 'ACTIVE') RETURNING id`,
    [`ICLC${suffix}`, 'IC Link Child', parentId]
  );
  childId = child.rows[0].id;

  const stranger = await insertAsAppRole(pool,
    `INSERT INTO companies (company_code, name, legal_name, base_currency, is_default, status)
     VALUES ($1, $2, $2, 'USD', false, 'ACTIVE') RETURNING id`,
    [`ICLS${suffix}`, 'IC Link Stranger']
  );
  strangerId = stranger.rows[0].id;
});

after(async () => {
  if (!dbAvailable) return;
  await resetTestCompanies(pool).catch(() => {});
  await disableMultiCompany(pool).catch(() => {});
  await pool.end();
});

test('a company unrelated to either party may not post an intercompany transaction', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  await assert.rejects(
    () => Intercompany.post({
      from_company_id: parentId,
      to_company_id: strangerId,
      amount: 100,
    }, userId),
    /not linked/i
  );
});

test('a parent and its own subsidiary may post an intercompany transaction', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // This will fail later (missing COA accounts for the throwaway companies)
  // for reasons unrelated to linkage — what matters here is that it gets
  // PAST the linkage guard, i.e. never rejects with "not linked".
  await assert.rejects(
    () => Intercompany.post({
      from_company_id: parentId,
      to_company_id: childId,
      amount: 100,
    }, userId),
    (err) => !/not linked/i.test(err.message)
  );
});
