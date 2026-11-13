// Does company context actually reach the database?
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// companyContext.test.js proves `withCompany()` behaves correctly. That was
// never the problem. The problem was that `withCompany` was called by nothing:
// 431 model queries went straight to the pool, so the row-level security
// designed in migration 110 governed no query the application actually ran.
// Enabling multi-company would not have leaked data — it would have blanked
// every screen, because RLS matches no rows when the setting is absent.
//
// config/database.js now applies the context at the pool itself, so the models
// are covered without any of them being changed. These tests assert the two
// properties that makes-or-breaks:
//
//   1. When isolation is ON, an ordinary `pool.query` — the call the models
//      already make — carries the company.
//   2. That context is SET LOCAL, so it cannot survive back into the pool and
//      be inherited by the next request. A wrapper that leaked would be worse
//      than no wrapper at all.
//
// Whatever this environment's actual isolation state is, these tests force it
// both ways by temporarily replacing `multi_company_enabled()` and restoring
// the original definition afterwards — so the assertions are deterministic
// whether run against a single-company dev database or one with company
// isolation genuinely enabled (migrations 110-112).
//
// Replacing a function's definition requires owning it, which the
// application's own runtime role deliberately may not (see migration 111 —
// an app role that owns its tables would be exactly the superuser/BYPASSRLS
// role isolation has to exclude). So DDL here goes through a separate pool on
// MIGRATION_DATABASE_URL (falling back to DATABASE_URL, for a dev database
// that hasn't split the two roles), while the actual behaviour under test —
// does config/database.js's wrapped pool.query/pool.connect carry the company
// — still goes through the real application pool.
//
// Run on its own:  node --test tests/companyScope.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const db = require('../config/database');
const { pool } = db;
const companyScope = require('../services/companyScope');

const READ_SETTING = "SELECT current_setting('app.current_company_id', true) AS c";
const FAKE_COMPANY = '11111111-1111-1111-1111-111111111111';

let dbAvailable = false;
let originalFunctionDef = null;
let ddlPool = null;

before(async () => {
  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
  } catch {
    return;
  }

  ddlPool = new Pool({
    connectionString: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  // Remember the real definition so it can be put back exactly.
  const { rows } = await ddlPool.query(
    `SELECT pg_get_functiondef(oid) AS def
       FROM pg_proc
      WHERE proname = 'multi_company_enabled'
      LIMIT 1`
  );
  originalFunctionDef = rows[0]?.def || null;
});

after(async () => {
  if (originalFunctionDef) {
    await ddlPool.query(originalFunctionDef).catch(() => {});
    db.resetIsolationCache();
  }
  if (ddlPool) await ddlPool.end().catch(() => {});
  await pool.end();
});

async function replaceIsolationFn(returns, fn) {
  await ddlPool.query(
    `CREATE OR REPLACE FUNCTION public.multi_company_enabled() RETURNS BOOLEAN
     LANGUAGE sql STABLE AS $$ SELECT ${returns} $$`
  );
  db.resetIsolationCache();
  try {
    return await fn();
  } finally {
    if (originalFunctionDef) await ddlPool.query(originalFunctionDef).catch(() => {});
    db.resetIsolationCache();
  }
}

/** Run `fn` with the database reporting that isolation is on. */
const withIsolationOn = (fn) => replaceIsolationFn('true', fn);
/** Run `fn` with the database reporting that isolation is off. */
const withIsolationOff = (fn) => replaceIsolationFn('false', fn);

test('with isolation off, a plain query is untouched', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // The single-company default must cost nothing and change nothing. If this
  // fails, every existing installation just started paying for a transaction
  // per statement to buy a boundary it does not use.
  await withIsolationOff(async () => {
    await companyScope.runWithCompany(FAKE_COMPANY, async () => {
      const { rows } = await pool.query(READ_SETTING);
      assert.ok(!rows[0].c, 'no company setting should be applied while isolation is off');
    });
  });
});

test('with isolation on, an ordinary pool.query carries the company', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  await withIsolationOn(async () => {
    await companyScope.runWithCompany(FAKE_COMPANY, async () => {
      // This is exactly the call ~431 model queries make. It must be scoped
      // without the model knowing anything about companies.
      const { rows } = await pool.query(READ_SETTING);
      assert.equal(rows[0].c, FAKE_COMPANY,
        'a bare pool.query inside a request must carry that request\'s company');
    });
  });
});

test('with isolation on, a hand-rolled transaction carries the company', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  await withIsolationOn(async () => {
    await companyScope.runWithCompany(FAKE_COMPANY, async () => {
      // The ~112 sites that do their own pool.connect() + BEGIN. The context
      // has to land on the FIRST statement after BEGIN, not on some later one.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(READ_SETTING);
        assert.equal(rows[0].c, FAKE_COMPANY,
          'a hand-rolled transaction must be scoped straight after BEGIN');
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    });
  });
});

test('the company never survives back into the pool', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  await withIsolationOn(async () => {
    await companyScope.runWithCompany(FAKE_COMPANY, async () => {
      await pool.query(READ_SETTING);
    });

    // The whole reason for SET LOCAL. A plain SET would still be on the
    // connection here, and the next request to borrow it — possibly another
    // tenant's — would inherit it. Checked repeatedly because which physical
    // connection comes back varies.
    for (let i = 0; i < 5; i++) {
      const { rows } = await pool.query(READ_SETTING);
      assert.ok(!rows[0].c,
        'the company must not be readable outside the request that set it');
    }
  });
});

test('concurrent requests for different companies do not see each other', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // The failure mode this guards is the one that only appears under load: two
  // requests interleaved on the same pool, each expected to see its own
  // company. A connection-scoped SET passes every single-threaded test and
  // fails exactly here.
  await withIsolationOn(async () => {
    const companies = [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
    ];

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => {
        const expected = companies[i % companies.length];
        return companyScope.runWithCompany(expected, async () => {
          const { rows } = await pool.query(READ_SETTING);
          return { expected, actual: rows[0].c };
        });
      })
    );

    for (const { expected, actual } of results) {
      assert.equal(actual, expected,
        'each concurrent request must see its own company and no other');
    }
  });
});

test('the ambient store is shared, not duplicated', async (t) => {
  // A regression guard with teeth: companyContext.js and config/database.js
  // must use the SAME AsyncLocalStorage. Two instances would each look right
  // in isolation while the database layer read an empty store and applied no
  // company at all — the exact silent failure this whole seam exists to stop.
  const companyContext = require('../services/companyContext');

  await companyScope.runWithCompany(FAKE_COMPANY, async () => {
    assert.equal(companyContext.currentCompanyId(), FAKE_COMPANY,
      'companyContext must read the same store the database layer writes');
  });
});
