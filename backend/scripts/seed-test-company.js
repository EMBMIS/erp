#!/usr/bin/env node
/**
 * Give a freshly migrated TEST database the default company the backend test
 * suite assumes.
 *
 * Why: a new database is built from database/baseline/000_baseline_schema.sql,
 * which is schema plus reference data only. Migration 110's
 * `INSERT INTO companies ... is_default = true` is recorded as applied but
 * never ran, and in production that is correct (the first signup creates the
 * first company). The tests, though, resolve their ambient company through
 * companyContext.getDefaultCompanyId() (tests/helpers/withCompany.js), so on a
 * fresh database every hook failed with "No default company is configured",
 * left the pool open, and `node --test` waited on that file forever.
 *
 * What: creates the MAIN company flagged is_default if there is none, then
 * seeds its chart of accounts, cost centres and accounting periods through the
 * same code path signup uses (ChartOfAccounts.seedFinanceMasterData), so GL
 * postings in the tests find their accounts. Idempotent: run it as often as
 * you like.
 *
 * Never run this against a production database: it creates a company.
 *
 *   cd backend && node scripts/seed-test-company.js
 */
require('dotenv').config();

const { pool } = require('../config/database');
const ChartOfAccounts = require('../models/ChartOfAccounts');
const User = require('../models/User');

const SEED_EMAIL = 'test-seed-admin@example.test';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-test-company.js creates a company; it is for test databases only.');
  }

  let { rows } = await pool.query(
    'SELECT id FROM companies WHERE is_default = true AND deleted_at IS NULL LIMIT 1'
  );
  if (!rows.length) {
    ({ rows } = await pool.query(
      `INSERT INTO companies (company_code, name, legal_name, base_currency, is_default)
       VALUES ('MAIN', 'Main Company', 'Main Company',
               COALESCE((SELECT code FROM currencies WHERE is_base = true LIMIT 1), 'USD'), true)
       RETURNING id`
    ));
    console.log(`Created default test company ${rows[0].id}.`);
  }
  const companyId = rows[0].id;

  // The seeded rows record who created them (created_by is NOT NULL).
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [SEED_EMAIL]);
  const userId = existing.rows[0]?.id || (await User.create({
    email: SEED_EMAIL,
    password: `Seed-${require('node:crypto').randomBytes(12).toString('hex')}!`,
    first_name: 'Test',
    last_name: 'Seed',
    role: 'ADMIN',
  })).id;

  // What the first signup on a real deployment gets (routes/auth.js): a seat in
  // the company and platform ownership, which is also the posting authority
  // automated GL postings record as poster (services/platformOwner.js).
  await pool.query(
    `INSERT INTO user_companies (user_id, company_id, role, is_primary)
     VALUES ($1, $2, 'ADMIN', true) ON CONFLICT DO NOTHING`,
    [userId, companyId]
  );
  await pool.query(
    `UPDATE users SET is_platform_owner = true
      WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE is_platform_owner)`,
    [userId]
  );

  const seeded = await ChartOfAccounts.seedFinanceMasterData(companyId, userId);
  console.log(`Default company ${companyId}: seeded ${seeded.accounts} accounts, ` +
    `${seeded.cost_centers} cost centres, ${seeded.periods} periods, ${seeded.gl_mappings} GL mappings, ${seeded.approval_chains} approval chains.`);
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error('seed-test-company failed:', error.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
