#!/usr/bin/env node
/**
 * Tracked migration runner.
 *
 * The original setup applied a folder of .sql files ad hoc, with no record of
 * what had actually run against a given database. That is exactly how this
 * project ended up with code assuming columns/functions that never landed on
 * the live DB (audit findings B3, B5). This runner fixes that:
 *
 *   • Maintains a schema_migrations table (filename, checksum, applied_at) so
 *     every database knows precisely which migrations it has.
 *   • Applies each pending migration in its own transaction, in deterministic
 *     filename order (which also removes the duplicate-prefix ambiguity, B12).
 *   • Fails loudly. A migration that errors is rolled back and left PENDING —
 *     never recorded as applied. Brownfield adoption is an explicit operator
 *     decision (--baseline), not an error-message heuristic.
 *   • Detects checksum drift: a migration file edited after it was applied is
 *     reported by --status, since the live DB no longer matches the file.
 *
 * Usage:
 *   node scripts/db-migrate.js               # apply all pending migrations
 *   node scripts/db-migrate.js --status      # list applied vs pending, apply nothing
 *   node scripts/db-migrate.js --baseline    # mark ALL current files as applied (no SQL)
 *   node scripts/db-migrate.js --baseline 078_richer_payroll.sql
 *                                            # mark files up to & incl. the given one as
 *                                            # applied (brownfield adoption), leaving the
 *                                            # rest pending for a normal apply run.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Migrations run ALTER TABLE/CREATE TABLE/etc., which require table ownership
// — the application's own runtime connection (DATABASE_URL, config/database.js)
// may be a deliberately unprivileged role once company isolation is enabled
// (see migration 111: the app role must NOT bypass RLS, which also means it
// cannot own the tables it queries). MIGRATION_DATABASE_URL lets an operator
// point migrations at the owner/superuser connection while DATABASE_URL points
// the app at the restricted one. Undefined MIGRATION_DATABASE_URL falls back to
// DATABASE_URL, so nothing changes for a deployment that hasn't split the roles.
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const MIGRATIONS_DIR = path.join(__dirname, '../database/migrations');

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

async function ensureTrackingTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    VARCHAR(255) PRIMARY KEY,
      checksum    VARCHAR(64)  NOT NULL,
      applied_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function appliedSet() {
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

// Migrations whose file content no longer matches what was applied. Either the
// file was edited after the fact (so the live DB silently lags the repo), or the
// row was baselined from a different revision.
async function checksumDrift() {
  const { rows } = await pool.query('SELECT filename, checksum FROM schema_migrations');
  const drift = [];
  for (const row of rows) {
    const file = path.join(MIGRATIONS_DIR, row.filename);
    if (!fs.existsSync(file)) {
      drift.push({ filename: row.filename, reason: 'applied but file is missing from the repo' });
      continue;
    }
    if (checksum(fs.readFileSync(file, 'utf8')) !== row.checksum) {
      drift.push({ filename: row.filename, reason: 'file changed after it was applied' });
    }
  }
  return drift;
}

async function applyOne(filename) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING',
      [filename, checksum(sql)]
    );
    await client.query('COMMIT');
    console.log(`✅ applied  ${filename}`);
    return 'applied';
  } catch (err) {
    await client.query('ROLLBACK');
    // NOTE: this used to swallow "already exists"-style errors and record the
    // migration as applied anyway. Because a failing statement aborts the whole
    // transaction, that silently threw away every OTHER statement in the file —
    // permanently, since the filename was then marked applied and never retried.
    // That is how the live DB ended up missing the advisory locks in 088/089
    // while reporting both as applied. A migration that does not run is now a
    // hard failure; use --baseline to adopt a brownfield DB deliberately.
    console.error(`❌ FAILED   ${filename}: ${err.message}`);
    console.error(
      '   Nothing from this migration was applied and it has NOT been recorded.\n' +
      '   Make the migration idempotent (IF NOT EXISTS / CREATE OR REPLACE) and re-run,\n' +
      `   or adopt it deliberately with: node scripts/db-migrate.js --baseline ${filename}`
    );
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Re-apply company isolation's RLS policy to every table currently registered
 * in company_scoped_tables, if isolation has ever been turned on for this
 * database.
 *
 * Why this exists: enable_multi_company(role) (migrations 110/112) is a
 * manual, one-time SQL call — deliberately not exposed as an API endpoint,
 * since it runs ALTER TABLE ... FORCE ROW LEVEL SECURITY and needs table
 * ownership. It only applies the policy to whatever is in
 * company_scoped_tables AT THE MOMENT IT RUNS. A later migration that adds a
 * new company-scoped table (INSERT INTO company_scoped_tables (...)) does NOT
 * retroactively get a policy — the table sits registered but unprotected (or,
 * depending on exact state, protected by RLS with no matching policy, which
 * Postgres treats as deny-all) until someone remembers to re-run
 * enable_multi_company() by hand.
 *
 * That "someone remembers" step is exactly what went missing for
 * company_modules (migration 202608071500): a LATER migration
 * (202608141000_hr_payroll_leave_org.sql) got this right by hand-rolling a
 * DO $$ ... $$ block that re-applies RLS to its own new tables if
 * company_isolation_config.application_role is already set — but
 * 202608071500 never got the same treatment, so every write to
 * company_modules on any database where isolation was enabled before that
 * migration ran started failing with "new row violates row-level security
 * policy", live-reported by a real deployment.
 *
 * Centralizing the resync here, run once at the end of every migration
 * pass, makes it structural rather than a convention every migration author
 * has to remember: whatever is in company_scoped_tables always has a policy,
 * automatically, on every deploy. enable_multi_company() is idempotent
 * (DROP POLICY IF EXISTS then CREATE), so calling it again here is always
 * safe — including on every deploy where nothing changed.
 *
 * Deliberately a no-op when isolation was never turned on for this database
 * (company_isolation_config.application_role IS NULL, or the config table
 * itself doesn't exist yet on a pre-112 database) — this must never be the
 * thing that silently turns isolation on for a deployment that hasn't opted
 * in.
 */
async function resyncCompanyIsolation() {
  let appRole;
  try {
    const { rows } = await pool.query(
      'SELECT application_role FROM company_isolation_config WHERE id AND application_role IS NOT NULL'
    );
    appRole = rows[0]?.application_role;
  } catch (err) {
    if (err.code === '42P01') return; // relation does not exist — pre-112 database, nothing to resync
    throw err;
  }
  if (!appRole) return; // isolation was never enabled on this database — leave it that way

  try {
    await pool.query('SELECT enable_multi_company($1)', [appRole]);
    console.log(`🔒 Re-synced company isolation policy for role ${appRole} (covers any newly-registered company-scoped tables).`);
  } catch (err) {
    // enable_multi_company()'s own precondition checks (role missing, can't
    // log in, bypasses RLS — migration 112) all raise a plain RAISE EXCEPTION
    // with no explicit SQLSTATE, so they surface as Postgres's default P0001.
    // That means company_isolation_config's recorded application_role itself
    // is stale or wrong — a pre-existing database-configuration problem this
    // migration run did not cause and can't fix by retrying. The migrations
    // that WERE pending just applied successfully; failing this whole process
    // over an unrelated stale config row would block every future deploy
    // until someone manually fixes a record this step cannot safely guess
    // how to fix. Warn loudly and let the process exit 0 — the operator needs
    // to run `SELECT enable_multi_company('<correct-role>');` by hand once.
    if (err.code === 'P0001') {
      console.warn(`⚠️  Could not re-sync company isolation for role ${appRole}: ${err.message}`);
      console.warn('   company_isolation_config.application_role may be stale. Newly-registered');
      console.warn('   company-scoped tables may be missing their RLS policy until this is fixed —');
      console.warn(`   run manually: SELECT enable_multi_company('<correct-role>');`);
      return;
    }
    throw err;
  }
}

const BASELINE_DIR = path.join(__dirname, '..', 'database', 'baseline');
const BASELINE_SQL = path.join(BASELINE_DIR, '000_baseline_schema.sql');
const BASELINE_MANIFEST = path.join(BASELINE_DIR, '000_baseline_manifest.txt');

// Fixed advisory-lock key for the whole migration run (the integer form of the
// first 8 hex chars of a stable string, so every process agrees on the key).
// Guarding the run makes it safe to invoke migrations from a multi-instance
// boot (Cloud Run cold start, several replicas) or from concurrent deploys:
// one process takes the lock and applies everything; the others block on
// pg_advisory_lock, then find nothing pending and exit 0. Without it, N
// replicas could race to ALTER the same table — the schema_migrations tracking
// prevents double-application but not concurrent DDL on the same column.
// ASCII "QIRA" — the product's former name. The comment keeps the old
// spelling because the constant does: this is the advisory lock two concurrent
// deploys take so they cannot run the migration set at the same time, so its
// VALUE has to stay byte-identical across versions. If a renamed build took a
// different key than a running one, both would hold "the" lock and migrate
// concurrently. A rename here would be a correctness bug wearing a cosmetic
// change's clothes.
const MIGRATION_LOCK_KEY = 0x51495241;

/**
 * True when this database has no application schema yet — a brand new Postgres
 * (CI's service container, a fresh Cloud SQL instance, a clean docker-compose
 * volume) as opposed to an existing one that is merely behind on migrations.
 *
 * Checked by counting tables rather than by looking for schema_migrations,
 * because ensureTrackingTable() has already created that by this point.
 */
async function isEmptyDatabase() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`
  );
  return rows[0].n === 0;
}

/**
 * Builds a new database from the baseline snapshot instead of replaying the
 * migration chain.
 *
 * The chain cannot build one. It was never the source of truth: 107 of the 188
 * live tables are created by no migration and no schema file, having been added
 * to the original database directly, and several migrations contain SQL that
 * has never executed anywhere (see 055) because CREATE TABLE IF NOT EXISTS made
 * them silent no-ops against a database that already had the table. Replaying
 * from empty got 94 migrations in and produced 81 of 188 tables.
 *
 * So a fresh database gets the schema as it actually is — pg_dump --schema-only
 * of the live one, 188 tables, 4 extensions, 103 RLS policies — and every
 * migration named in the manifest is recorded as applied without running.
 * Anything NOT in the manifest is a migration written after the snapshot and
 * still applies normally, which is what keeps this from being a one-off.
 *
 * Regenerate both files together (see database/baseline/README.md) whenever the
 * snapshot is refreshed.
 */
async function bootstrapFromBaseline() {
  if (!fs.existsSync(BASELINE_SQL) || !fs.existsSync(BASELINE_MANIFEST)) {
    console.error(`Empty database and no baseline found at ${BASELINE_DIR}`);
    console.error('Expected 000_baseline_schema.sql and 000_baseline_manifest.txt.');
    process.exit(1);
  }

  const manifest = fs
    .readFileSync(BASELINE_MANIFEST, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  console.log(`Empty database — applying baseline schema (${manifest.length} migrations pre-recorded)...`);

  const sql = fs.readFileSync(BASELINE_SQL, 'utf8');
  const client = await pool.connect();
  try {
    // One transaction: a half-applied baseline is far worse than none, because
    // the next run would no longer look empty and would try to migrate on top
    // of a partial schema.
    await client.query('BEGIN');
    await client.query(sql);
    // pg_dump emits set_config('search_path', '', false) and fully qualifies
    // every identifier of its own, so once the dump has run, an unqualified
    // name no longer resolves for the rest of the session — the inserts below
    // would fail with `relation "schema_migrations" does not exist`.
    await client.query('SET search_path = public');
    for (const filename of manifest) {
      const file = path.join(MIGRATIONS_DIR, filename);
      if (!fs.existsSync(file)) {
        throw new Error(`manifest names ${filename}, which is not in ${MIGRATIONS_DIR}`);
      }
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING',
        [filename, checksum(fs.readFileSync(file, 'utf8'))]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log('✅ Baseline applied.');
}

async function main() {
  const mode = process.argv[2] || '--apply';
  await pool.query('SELECT 1');
  await ensureTrackingTable();

  // Serialize the whole run behind one advisory lock. Blocking, not
  // try-lock: a second instance simply waits for the first to finish, then
  // sees an up-to-date database and exits 0. Only --status may skip the
  // lock (it is read-only; nothing to race).
  const locked = mode !== '--status';
  if (locked) {
    await pool.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  }

  // Bootstrap before computing pending work, so the manifest's migrations are
  // already recorded and only post-baseline ones show up as pending.
  if (mode === '--apply' || mode === '--status') {
    if (await isEmptyDatabase()) {
      if (mode === '--status') {
        console.log('Empty database — a baseline bootstrap would run on --apply.');
      } else {
        await bootstrapFromBaseline();
      }
    }
  }

  const files = listMigrationFiles();
  const applied = await appliedSet();
  const pending = files.filter((f) => !applied.has(f));

  if (mode === '--status') {
    console.log(`Migrations: ${files.length} total, ${applied.size} applied, ${pending.length} pending`);
    pending.forEach((f) => console.log(`  pending  ${f}`));
    const drift = await checksumDrift();
    if (drift.length) {
      console.log(`\n⚠️  ${drift.length} migration(s) drifted from the applied revision:`);
      drift.forEach((d) => console.log(`  drift    ${d.filename} — ${d.reason}`));
    }
    return;
  }

  if (mode === '--baseline') {
    // Optional "up-to" target: baseline only files at or before it, so genuinely
    // new migrations after it remain pending for a real apply run.
    const upto = process.argv[3];
    if (upto && !files.includes(upto)) {
      console.error(`Baseline target not found: ${upto}`);
      console.error('Known files include:', files.slice(-5).join(', '));
      process.exit(1);
    }
    const toBaseline = upto ? pending.filter((f) => f.localeCompare(upto, 'en') <= 0) : pending;
    for (const f of toBaseline) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      await pool.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING',
        [f, checksum(sql)]
      );
    }
    const remaining = pending.length - toBaseline.length;
    console.log(`📌 Baselined ${toBaseline.length} migration(s) (no SQL executed). ${remaining} still pending.`);
    return;
  }

  if (pending.length === 0) {
    console.log('✔ Database is up to date — no pending migrations.');
    await resyncCompanyIsolation();
    return;
  }

  console.log(`Applying ${pending.length} pending migration(s)...\n`);
  let applied2 = 0;
  for (const f of pending) {
    await applyOne(f);
    applied2++;
  }
  console.log(`\n🎉 Done: ${applied2}/${pending.length} migration(s) processed.`);
  await resyncCompanyIsolation();
}

// Exported for tests/companyIsolationResyncRegression.test.js — this file is
// normally run as a script (`node scripts/db-migrate.js`), never required
// elsewhere, so `require.main === module` guards against a test's `require()`
// re-running the whole migration pass as a side effect of importing it.
module.exports = { resyncCompanyIsolation };

if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch((err) => {
      console.error('\nMigration run aborted:', err.message);
      pool.end();
      process.exit(1);
    });
}
