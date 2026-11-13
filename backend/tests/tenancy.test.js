// Tenancy invariants — the cheap, deterministic half.
//
// WHAT THIS COVERS, AND WHAT IT DELIBERATELY DOES NOT
// ---------------------------------------------------------------------------
// Proving isolation end to end means turning row-level security on across ~84
// tables and connecting as a role that does not bypass it — the development
// database connects as `postgres`, a superuser, for which RLS is unconditionally
// skipped. That drill lives in scripts/verify-tenancy.js and is run
// deliberately, because it reconfigures the database.
//
// What belongs HERE is everything that can be checked without that: the schema
// invariants which, if broken, mean multi-tenancy cannot work at all. Each one
// corresponds to a real defect that survived three migrations:
//
//   • company_id defaulted to a hardcoded literal of the DEFAULT company, so a
//     second tenant's insert wrote the first tenant's id and was rejected by
//     the RLS WITH CHECK. Multi-company could not be switched on.
//   • Tables holding third-party API keys, OAuth tokens and document text were
//     never scoped at all — one tenant could read another's stored secrets.
//   • Natural keys were unique across the whole table, so the second tenant to
//     use a name was refused, citing a row RLS hides from them.
//
// These are exactly the failures a passing single-tenant test suite hides.
//
// Run on its own:  node --test tests/tenancy.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');

const { pool } = require('../config/database');

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

/** Every base table carrying company_id, with its default expression. */
async function scopedColumns() {
  const { rows } = await pool.query(`
    SELECT c.table_name, c.column_default, c.is_nullable
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
     WHERE c.table_schema = 'public'
       AND c.column_name = 'company_id'
       AND tb.table_type = 'BASE TABLE'
       -- user_companies' company_id names the company being GRANTED, not the
       -- company that owns the row, so it is correctly exempt.
       AND c.table_name <> 'user_companies'
       -- mailboxes is deliberately NOT row-level isolated (migration
       -- 202608280901): the inbound webhook must look an address up before
       -- any company context exists. Its boundary is the explicit company_id
       -- filter in mailboxService.js / routes/mailboxes.js; the content tables
       -- (mailbox_messages, mailbox_attachments) keep real RLS.
       AND c.table_name <> 'mailboxes'
     ORDER BY c.table_name`);
  return rows;
}

test('company_id resolves from the session, never from a fixed literal', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const rows = await scopedColumns();
  assert.ok(rows.length > 60, `expected many scoped tables, found ${rows.length}`);

  const literalDefault = rows
    .filter((r) => !String(r.column_default || '').includes('current_company_id'))
    // A generated application's table is the one case where a literal IS the
    // correct default, and it took a deployed application sitting in the
    // database for this test to ever meet one.
    //
    // The rule this test enforces is about SHARED tables: many tenants insert
    // into `invoices`, so a fixed company_id there would mean only one of them
    // ever could. An application table is not shared. It is created by the
    // deployer for ONE instance of ONE company, its name is derived from both,
    // and a CHECK pins app_instance_id to that instance (compiler/ddl.js). The
    // literal is that company's id and no other value is legal in the table at
    // all — so here a literal is not a weaker default than current_company_id(),
    // it is a stronger one.
    .filter((r) => !/^app_[0-9a-f]{8}_[0-9a-f]{8}_/.test(r.table_name))
    .map((r) => r.table_name);

  assert.deepEqual(literalDefault, [],
    'these tables still default company_id to a fixed literal, so only one tenant could ever insert into them');
});

test('the default actually evaluates to the ambient company', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // Asserting the expression's TEXT is not enough — it has to resolve. Checked
  // against a synthetic id inside a transaction, so no row and no second
  // company is needed, and nothing is left behind.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fake = '4d1f8a2e-0000-4000-8000-00000000beef';
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [fake]);

    const { rows } = await client.query('SELECT public.current_company_id() AS c');
    assert.equal(rows[0].c, fake, 'the session company must be readable by the default expression');

    // And with no context it must fall back rather than erroring, or every
    // single-company insert breaks.
    await client.query("SELECT set_config('app.current_company_id', '', true)");
    const { rows: unset } = await client.query('SELECT public.current_company_id() AS c');
    assert.equal(unset[0].c, null, 'an unset context must be NULL, not an error');

    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('company_id is NOT NULL wherever it exists', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // A nullable company_id is a row that belongs to nobody. Under RLS it
  // matches no policy and becomes invisible to everyone, including support.
  const nullable = (await scopedColumns())
    .filter((r) => r.is_nullable === 'YES')
    .map((r) => r.table_name);

  assert.deepEqual(nullable, [], 'company_id must be NOT NULL on every scoped table');
});

test('tables holding tenant secrets and content are scoped', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // Everything else here is correctness. This one is a breach: these hold
  // third-party API keys, OAuth tokens, and the text of tenants' documents,
  // and none of them were scoped before migration 140.
  const mustBeScoped = [
    'ai_credentials', 'agent_credentials', 'mcp_connections', 'connectors',
    'mcp_oauth_grants', 'document_embeddings', 'ai_tools', 'agent_definitions',
    'agent_blueprints', 'ai_findings', 'ai_audit_log', 'chat_memory',
    'background_tasks', 'agent_paused_runs', 'webhook_subscriptions',
    'notifications', 'pdf_templates', 'ai_settings',
  ];

  const missing = [];
  for (const table of mustBeScoped) {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = $1 AND column_name = 'company_id'`, [table]);
    if (!rows.length) missing.push(table);
  }

  assert.deepEqual(missing, [],
    'these tables hold tenant secrets or tenant content and must be company-scoped');
});

test('natural keys are unique per company, not globally', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // A global unique on a natural key means the second tenant to pick a name is
  // refused — and RLS hides the conflicting row, so the error names a record
  // they can neither see nor delete.
  const naturalKeys = [
    ['ai_tools', 'name'],
    ['agent_definitions', 'agent_key'],
    ['pdf_templates', 'key'],
    ['mcp_connections', 'slug'],
  ];

  // Match against the index's COLUMN LIST, not the whole definition. Searching
  // the raw text matched the index NAME too — `pdf_templates_pkey` contains the
  // substring "key", so the primary key on (id) was reported as a global unique
  // on `key`, and the test failed on a table that was already correct.
  const columnsOf = (indexdef) => {
    const match = indexdef.match(/USING \w+ \(([^)]*)\)/);
    return match ? match[1].split(',').map((c) => c.trim()) : [];
  };

  for (const [table, column] of naturalKeys) {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexdef LIKE '%UNIQUE%'`,
      [table]);

    const covering = rows.filter((r) => columnsOf(r.indexdef).includes(column));
    assert.ok(covering.length > 0, `${table}.${column} should still be unique somehow`);

    const globallyUnique = covering.filter((r) => !columnsOf(r.indexdef).includes('company_id'));
    assert.deepEqual(globallyUnique.map((r) => r.indexdef), [],
      `${table}.${column} is unique across all tenants; it must be unique per company`);
  }
});

test('ai_settings is per company', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // It was a singleton (`id BOOLEAN PRIMARY KEY`), so every tenant would have
  // shared one AI configuration — including the model, the spend caps and the
  // autonomy ceiling. company_id is now the primary key, while `id` stays so
  // that services/ai/settings.js's `WHERE id = true` keeps working untouched.
  const { rows } = await pool.query(`
    SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = 'ai_settings'::regclass AND i.indisprimary`);

  assert.deepEqual(rows.map((r) => r.attname), ['company_id'],
    'ai_settings should be keyed by company so each tenant has its own configuration');
});

test('the scoped-table register matches reality', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // enable_multi_company() protects exactly what this register lists. A table
  // with company_id that is missing from it gets no RLS policy — scoped in
  // appearance, unprotected in fact, which is the worst of both.
  const { rows: registered } = await pool.query('SELECT table_name FROM company_scoped_tables');
  const known = new Set(registered.map((r) => r.table_name));

  const unregistered = (await scopedColumns())
    .map((r) => r.table_name)
    .filter((t) => !known.has(t));

  assert.deepEqual(unregistered, [],
    'these tables carry company_id but are not registered, so enable_multi_company would skip them');
});

test('enable_multi_company isolates real rows for a newly seeded tenant', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  // This is deliberately an end-to-end RLS test, not a schema assertion. A
  // superuser always bypasses RLS, so the application connection must be a
  // fresh NOBYPASSRLS role.  The role and all fixture rows are unique to this
  // run and are removed in finally, which keeps it safe for the normal suite.
  const suffix = `${process.pid}_${randomBytes(6).toString('hex')}`;
  const role = `qira_tenancy_test_${suffix}`;
  const password = randomBytes(24).toString('hex');
  // company_code is VARCHAR(20), so keep the tenant marker short enough for
  // the actual companies row while retaining more entropy in the role name.
  const marker = `T${randomBytes(4).toString('hex').toUpperCase()}`;
  let appPool;
  let tenantId;
  let sharedKey;
  let priorConfig;
  let priorRls;

  const asTenant = async (companyId, callback) => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  try {
    const { rows: privileges } = await pool.query(
      'SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    if (!privileges[0]?.rolsuper) {
      return t.skip('live RLS drill requires an admin database connection');
    }

    ({ rows: priorConfig } = await pool.query(
      'SELECT application_role, enabled_at, enabled_by FROM company_isolation_config WHERE id'));
    ({ rows: priorRls } = await pool.query(`
      SELECT c.relname AS table_name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND c.relname IN (SELECT table_name FROM company_scoped_tables)`));

    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOBYPASSRLS`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);

    // The one explicit transition this test is here to exercise. Supplying the
    // app role is required when the caller is the database owner/superuser.
    await pool.query('SELECT enable_multi_company($1)', [role]);

    const url = new URL(process.env.DATABASE_URL);
    appPool = new Pool({
      host: url.hostname,
      port: url.port || 5432,
      database: url.pathname.slice(1),
      user: role,
      password,
      ssl: false,
      max: 2,
    });

    const { rows: connection } = await appPool.query(
      `SELECT current_user AS user,
              public.role_bypasses_rls() AS bypasses,
              public.multi_company_enabled() AS multi_company_enabled`);
    assert.equal(connection[0].user, role);
    assert.equal(connection[0].bypasses, false, 'the fixture role must be subject to RLS');
    assert.equal(connection[0].multi_company_enabled, true,
      'enable_multi_company must be active for the fixture role');

    const { rows: defaults } = await pool.query(
      'SELECT id FROM companies WHERE is_default = true AND deleted_at IS NULL');
    assert.equal(defaults.length, 1, 'exactly one default tenant is required');
    const defaultTenantId = defaults[0].id;

    // This is the second tenant: the companies trigger permits it only after
    // policies have been enabled and only from a role that cannot bypass RLS.
    const created = await asTenant(defaultTenantId, (client) => client.query(
      `INSERT INTO companies (company_code, name, base_currency)
       VALUES ($1, $2, 'USD') RETURNING id`,
      [marker, `${marker} Ltd`]));
    tenantId = created.rows[0].id;

    const defaultCustomer = `${marker}-DEFAULT`;
    const secondCustomer = `${marker}-SECOND`;
    await asTenant(defaultTenantId, (client) => client.query(
      'INSERT INTO customers (customer_name, customer_code) VALUES ($1, $2)',
      ['Default tenant fixture', defaultCustomer]));
    await asTenant(tenantId, (client) => client.query(
      'INSERT INTO customers (customer_name, customer_code) VALUES ($1, $2)',
      ['Second tenant fixture', secondCustomer]));

    // Inspect as the admin only to prove where the implicit company_id default
    // landed. Tenant reads below are made through the unprivileged role.
    const { rows: stored } = await pool.query(
      'SELECT customer_code, company_id FROM customers WHERE customer_code = ANY($1::text[])',
      [[defaultCustomer, secondCustomer]]);
    assert.deepEqual(Object.fromEntries(stored.map((row) => [row.customer_code, row.company_id])), {
      [defaultCustomer]: defaultTenantId,
      [secondCustomer]: tenantId,
    });

    const seenByDefault = await asTenant(defaultTenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT customer_code FROM customers WHERE customer_code = ANY($1::text[]) ORDER BY customer_code',
        [[defaultCustomer, secondCustomer]]);
      return rows.map((row) => row.customer_code);
    });
    const seenBySecond = await asTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT customer_code FROM customers WHERE customer_code = ANY($1::text[]) ORDER BY customer_code',
        [[defaultCustomer, secondCustomer]]);
      return rows.map((row) => row.customer_code);
    });
    assert.deepEqual(seenByDefault, [defaultCustomer]);
    assert.deepEqual(seenBySecond, [secondCustomer]);

    await assert.rejects(
      asTenant(defaultTenantId, (client) => client.query(
        'INSERT INTO customers (customer_name, customer_code, company_id) VALUES ($1, $2, $3)',
        ['Cross-tenant write', `${marker}-BLOCKED`, tenantId])),
      /row-level security|violates/i,
      'a tenant must not be able to choose the second tenant as the row owner');

    const withoutContext = await appPool.query(
      'SELECT customer_code FROM customers WHERE customer_code = ANY($1::text[])',
      [[defaultCustomer, secondCustomer]]);
    assert.equal(withoutContext.rowCount, 0, 'an unscoped query must fail closed');

    // A natural key used by both tenants must be accepted, while each tenant
    // remains unable to read the other tenant's matching row.
    sharedKey = `t${randomBytes(4).toString('hex')}_template`;
    for (const companyId of [defaultTenantId, tenantId]) {
      await asTenant(companyId, (client) => client.query(
        'INSERT INTO pdf_templates (key, name) VALUES ($1, $2)',
        [sharedKey, 'Shared-key tenancy fixture']));
    }
    const { rows: templates } = await pool.query(
      'SELECT company_id FROM pdf_templates WHERE key = $1', [sharedKey]);
    assert.deepEqual(new Set(templates.map((row) => row.company_id)),
      new Set([defaultTenantId, tenantId]));
  } finally {
    if (appPool) await appPool.end().catch(() => {});

    // The admin connection intentionally bypasses RLS so cleanup is reliable
    // even after an assertion failure halfway through the drill.
    await pool.query('DELETE FROM customers WHERE customer_code LIKE $1', [`${marker}%`]).catch(() => {});
    if (sharedKey) await pool.query('DELETE FROM pdf_templates WHERE key = $1', [sharedKey]).catch(() => {});
    if (tenantId) await pool.query('DELETE FROM companies WHERE id = $1', [tenantId]).catch(() => {});

    if (priorRls) {
      for (const table of priorRls) {
        if (!table.forced) await pool.query(`ALTER TABLE ${table.table_name} NO FORCE ROW LEVEL SECURITY`);
        if (!table.enabled) await pool.query(`ALTER TABLE ${table.table_name} DISABLE ROW LEVEL SECURITY`);
      }
    }
    if (priorConfig?.[0]) {
      const config = priorConfig[0];
      await pool.query(
        `UPDATE company_isolation_config
            SET application_role = $1, enabled_at = $2, enabled_by = $3
          WHERE id`,
        [config.application_role, config.enabled_at, config.enabled_by]);
    }
    await pool.query(`DROP OWNED BY ${role}`).catch(() => {});
    await pool.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  }
});
