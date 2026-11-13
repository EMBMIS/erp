/**
 * Seed data for the application-platform tests.
 *
 * Two companies, each with its own users and its own suppliers and customers.
 * Two is the minimum that can prove isolation: with one company, every
 * cross-tenant test passes trivially.
 *
 * Everything created here is namespaced with a per-run suffix and removed by
 * `cleanup`, so suites can run repeatedly against a developer's database
 * without accumulating rows or colliding with each other.
 */

const { Pool } = require('pg');
const { pool } = require('../../config/database');
const companyContext = require('../../services/companyContext');

const RUN = Date.now().toString(36).toUpperCase().slice(-6);

async function ensureCompany({ code, name, isDefault = false }) {
  const existing = await pool.query('SELECT * FROM companies WHERE company_code = $1', [code]);
  if (existing.rows.length) return existing.rows[0];
  const { rows } = await pool.query(
    `INSERT INTO companies (company_code, name, legal_name, base_currency, is_default, status)
     VALUES ($1, $2, $2, 'USD', $3, 'ACTIVE') RETURNING *`,
    [code, name, isDefault]
  );
  return rows[0];
}

async function ensureUser({ email, firstName, lastName, role = 'ADMIN', companyId }) {
  const found = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const { rows } = found.rows.length ? found : await pool.query(
    `INSERT INTO users (email, password_hash, first_name, last_name, role, email_verified, must_change_password, is_platform_owner)
     VALUES ($1, '$2a$12$notarealhashusedonlyfortestsxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', $2, $3, $4, true, false, false)
     RETURNING *`,
    [email, firstName, lastName, role]
  );
  const user = rows[0];
  await pool.query(
    `INSERT INTO user_companies (user_id, company_id, is_primary, role)
     VALUES ($1, $2, true, $3) ON CONFLICT DO NOTHING`,
    [user.id, companyId, role]
  );
  return user;
}

async function ensureSupplier(companyId, { code, name }) {
  return companyContext.withCompany(companyId, async (client) => {
    const existing = await client.query('SELECT * FROM suppliers WHERE company_id = $1 AND supplier_code = $2', [companyId, code]);
    if (existing.rows.length) return existing.rows[0];
    const { rows } = await client.query(
      `INSERT INTO suppliers (company_id, supplier_code, legal_name, trade_name, email, country, status)
       VALUES ($1, $2, $3, $3, $4, 'GB', 'ACTIVE') RETURNING *`,
      [companyId, code, name, `${code.toLowerCase()}@suppliers.invalid`]
    );
    return rows[0];
  });
}

async function ensureCustomer(companyId, { code, name }) {
  return companyContext.withCompany(companyId, async (client) => {
    const existing = await client.query('SELECT * FROM customers WHERE company_id = $1 AND customer_code = $2', [companyId, code]);
    if (existing.rows.length) return existing.rows[0];
    const { rows } = await client.query(
      `INSERT INTO customers (company_id, customer_code, customer_name, legal_entity_name, primary_email, status)
       VALUES ($1, $2, $3, $3, $4, 'ACTIVE') RETURNING *`,
      [companyId, code, name, `${code.toLowerCase()}@customers.invalid`]
    );
    return rows[0];
  });
}

/**
 * @returns {{run, companyA, companyB, userA, userB, suppliersA, suppliersB, customersA}}
 */
async function seed() {
  const companyA = await ensureCompany({ code: `PLATA${RUN}`, name: `Platform Test A ${RUN}`, isDefault: false });
  const companyB = await ensureCompany({ code: `PLATB${RUN}`, name: `Platform Test B ${RUN}` });

  const userA = await ensureUser({
    email: `platform.a.${RUN}@test.invalid`, firstName: 'Ada', lastName: 'Owner', companyId: companyA.id,
  });
  const userB = await ensureUser({
    email: `platform.b.${RUN}@test.invalid`, firstName: 'Bo', lastName: 'Owner', companyId: companyB.id,
  });
  const contributorA = await ensureUser({
    email: `platform.c.${RUN}@test.invalid`, firstName: 'Cass', lastName: 'Worker', role: 'USER', companyId: companyA.id,
  });

  const suppliersA = [
    await ensureSupplier(companyA.id, { code: `SUPA1${RUN}`, name: `Northgate Components ${RUN}` }),
    await ensureSupplier(companyA.id, { code: `SUPA2${RUN}`, name: `Halden Fabrication ${RUN}` }),
  ];
  const suppliersB = [
    await ensureSupplier(companyB.id, { code: `SUPB1${RUN}`, name: `Other Co Supplier ${RUN}` }),
  ];
  const customersA = [
    await ensureCustomer(companyA.id, { code: `CUSA1${RUN}`, name: `Ridgeway Plant Hire ${RUN}` }),
    await ensureCustomer(companyA.id, { code: `CUSA2${RUN}`, name: `Tolmers Engineering ${RUN}` }),
  ];

  return { run: RUN, companyA, companyB, userA, userB, contributorA, suppliersA, suppliersB, customersA };
}

/**
 * Remove everything this run created, including every physical table any
 * deployment made.
 *
 * The generated tables are found through the registry rather than by pattern —
 * the registry is the authority on which tables belong to an instance, and a
 * cleanup that guessed at names could drop something it did not create.
 */
async function cleanup(seeded) {
  if (!seeded) return;
  const ids = [seeded.companyA?.id, seeded.companyB?.id].filter(Boolean);
  if (!ids.length) return;

  // On the OWNER connection, not the application's.
  //
  // `app_instance_tables` is company-scoped, so reading it through the app pool
  // with no ambient company returns nothing — and a cleanup that finds nothing
  // deletes nothing, silently, leaving a generated table behind after every
  // run. (That is exactly what happened: tenancyGuard's "every table is either
  // company-scoped or exempt" check found the debris.) Dropping tables needs
  // ownership in any case.
  const owner = new Pool({
    connectionString: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 2,
  });

  try {
    const { rows: tables } = await owner.query(
      'SELECT table_schema, table_name FROM app_instance_tables WHERE company_id = ANY($1)',
      [ids]
    );
    for (const t of tables) {
      // The identifiers came out of the registry, which constrains them by CHECK
      // to the same pattern quoteIdent enforces.
      if (!/^[a-z][a-z0-9_]*$/.test(t.table_name) || !/^[a-z][a-z0-9_]*$/.test(t.table_schema)) continue;
      await owner.query(`DROP TABLE IF EXISTS "${t.table_schema}"."${t.table_name}" CASCADE`).catch(() => {});
      await owner.query('DELETE FROM company_scoped_tables WHERE table_name = $1', [t.table_name]).catch(() => {});
    }

    const { rows: apps } = await owner.query(
      'SELECT DISTINCT application_id FROM app_company_instances WHERE company_id = ANY($1)',
      [ids]
    );
    await owner.query('DELETE FROM app_company_instances WHERE company_id = ANY($1)', [ids]).catch(() => {});
    for (const a of apps) {
      await owner.query('DELETE FROM applications WHERE id = $1', [a.application_id]).catch(() => {});
    }
    await owner.query('DELETE FROM companies WHERE id = ANY($1)', [ids]).catch(() => {});
  } finally {
    await owner.end().catch(() => {});
  }
}

module.exports = { seed, cleanup, ensureCompany, ensureUser, ensureSupplier, ensureCustomer, RUN };
