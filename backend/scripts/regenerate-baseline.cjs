/**
 * Regenerates the from-scratch database baseline.
 *
 * Why a baseline exists at all: the migration chain cannot build a database.
 * 107 of the 188 live tables are created by no migration and no schema file —
 * they were added to the original database directly — and several migrations
 * hold SQL that has never executed anywhere, because CREATE TABLE IF NOT EXISTS
 * made them silent no-ops against a database that already had the table.
 * Replaying from empty reaches migration 94 of 188 and yields 81 tables.
 *
 * So a new database is built from a snapshot of the real schema, and every
 * migration that predates the snapshot is recorded as applied without running.
 * scripts/db-migrate.js does that automatically when it finds an empty
 * database. Migrations written after the snapshot are absent from the manifest
 * and still apply normally.
 *
 * Writes two files, which must always be regenerated together:
 *   database/baseline/000_baseline_schema.sql    pg_dump --schema-only
 *   database/baseline/000_baseline_manifest.txt  migrations the dump includes
 *
 * Usage (SOURCE_DB defaults to the DATABASE_URL in .env):
 *   node scripts/regenerate-baseline.cjs
 *   SOURCE_DB=postgresql://user:pw@host:5432/db node scripts/regenerate-baseline.cjs
 *
 * Requires pg_dump on PATH, or a running container named by PG_CONTAINER
 * (default qira-postgres) to run it inside.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config();

const OUT_DIR = path.join(__dirname, '..', 'database', 'baseline');
const SCHEMA_OUT = path.join(OUT_DIR, '000_baseline_schema.sql');
const MANIFEST_OUT = path.join(OUT_DIR, '000_baseline_manifest.txt');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');

const sourceUrl = process.env.SOURCE_DB || process.env.DATABASE_URL;
if (!sourceUrl) {
  console.error('Set SOURCE_DB or DATABASE_URL to the database to snapshot.');
  process.exit(1);
}

const url = new URL(sourceUrl);
const dbName = url.pathname.replace(/^\//, '');
const container = process.env.PG_CONTAINER || 'qira-postgres';

const dumpArgs = [
  '-U', decodeURIComponent(url.username),
  '-d', dbName,
  '--schema-only',
  '--no-owner',
  '--no-privileges',
  '--quote-all-identifiers',
  // schema_migrations is the migration runner's own bookkeeping, not
  // application schema. db-migrate.js creates it via ensureTrackingTable()
  // before the bootstrap runs, so including it here makes the baseline fail
  // with `relation "schema_migrations" already exists`.
  '--exclude-table=schema_migrations',
];

console.log(`Dumping schema of "${dbName}"...`);
let dump;
try {
  dump = execFileSync('pg_dump', dumpArgs, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password || '') },
  });
} catch {
  console.log(`pg_dump not on PATH — running it inside container "${container}".`);
  dump = execFileSync('docker', ['exec', container, 'pg_dump', ...dumpArgs], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Reference tables whose ROWS are part of a working database, not tenant data.
 *
 * A schema-only baseline is not enough: companies.base_currency has a foreign
 * key to currencies, so a fresh database cannot create a single company until
 * the ISO currency list exists. 17 tests fail on a schema-only baseline for
 * exactly this reason, all of them "violates foreign key constraint
 * companies_base_currency_fkey".
 *
 * The list is read from tests/tenancyGuard.test.js rather than duplicated here.
 * That file already classifies every table, and its GLOBAL entries mean
 * precisely "shared reference data, identical for every tenant" — the same
 * question this needs answered. Deriving it means a new global table starts
 * being seeded automatically, and the two lists cannot drift apart.
 */
function globalReferenceTables() {
  const guard = fs.readFileSync(path.join(__dirname, '..', 'tests', 'tenancyGuard.test.js'), 'utf8');
  const names = [];
  for (const line of guard.split('\n')) {
    const m = line.match(/^\s{2}([a-z_]+):\s*'GLOBAL/);
    if (m) names.push(m[1]);
  }
  if (!names.length) {
    console.error('Found no GLOBAL tables in tenancyGuard.test.js — has its format changed?');
    process.exit(1);
  }
  return names.concat(PLATFORM_REGISTRIES).sort();
}

/**
 * PLATFORM tables whose rows are schema definition rather than data.
 *
 * Deliberately a hand-written list and NOT derived from the guard's PLATFORM
 * category, because that category mixes registries with real tenant data —
 * `companies` (83 rows) and `users` (87) are PLATFORM too, and deriving would
 * bake every tenant and every user account into a file that ships in the
 * container image and the repo.
 *
 * company_scoped_tables is the register of which tables RLS applies to.
 * company_policies_active() reads it, and with the table empty that function
 * returns false over an empty bool_and, so a fresh database refuses to create
 * a second company with "isolation policies are off" even though all 102
 * policies are present and forced. It describes the schema, so it belongs with
 * the schema.
 *
 * company_isolation_config is deliberately NOT here: it records which role
 * isolation protects, which is per-deployment. enable_multi_company() writes it
 * at setup time, and baking in a role name from another environment would be
 * actively wrong.
 */
const PLATFORM_REGISTRIES = ['company_scoped_tables'];

// Strip psql meta-commands. pg_dump 16.6+ brackets its output with
// \restrict / \unrestrict, which psql understands and a driver connection does
// not — db-migrate.js applies this file over node-postgres, where a leading
// backslash is a syntax error. This is the one transformation the file needs,
// and forgetting it fails with a bare `syntax error at or near "\"`.
const BACKSLASH = String.fromCharCode(92);
const lines = dump.split('\n');
const kept = lines.filter((l) => !l.startsWith(BACKSLASH));
const stripped = lines.length - kept.length;

// Reference-data pass. Separate invocation because pg_dump cannot mix
// "schema for everything" with "data for these eight tables" in one run.
const refTables = globalReferenceTables();
console.log(`Dumping reference data for ${refTables.length} global table(s)...`);
const dataArgs = [
  '-U', decodeURIComponent(url.username),
  '-d', dbName,
  '--data-only',
  '--no-owner',
  '--no-privileges',
  '--quote-all-identifiers',
  // Emits INSERTs rather than COPY. Slower to load and irrelevant at this size,
  // but it survives being wrapped in the bootstrap's single transaction and
  // produces a readable, reviewable diff when the reference data changes.
  '--inserts',
  ...refTables.flatMap((t) => ['--table', t]),
];

let dataDump;
try {
  dataDump = execFileSync('pg_dump', dataArgs, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password || '') },
  });
} catch {
  dataDump = execFileSync('docker', ['exec', container, 'pg_dump', ...dataArgs], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}
const dataKept = dataDump.split('\n').filter((l) => !l.startsWith(BACKSLASH));
const insertCount = (dataKept.join('\n').match(/^INSERT INTO /gm) || []).length;

const combined = [
  kept.join('\n'),
  '',
  '-- ---------------------------------------------------------------------',
  '-- Global reference data.',
  '--',
  '-- Rows, not schema, and deliberately so: these are the tables the tenancy',
  '-- guard classifies as GLOBAL ("identical for every tenant"). Without the',
  '-- currency list in particular, a fresh database cannot create a company at',
  '-- all - companies.base_currency has a foreign key to currencies.',
  '--',
  '-- No tenant data is included. Only the eight global tables.',
  '-- ---------------------------------------------------------------------',
  '',
  dataKept.join('\n'),
].join('\n');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(SCHEMA_OUT, combined);

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b, 'en'));
fs.writeFileSync(MANIFEST_OUT, migrations.join('\n') + '\n');

const tables = (kept.join('\n').match(/^CREATE TABLE /gm) || []).length;
const policies = (kept.join('\n').match(/^CREATE POLICY /gm) || []).length;

console.log(`✅ ${path.relative(process.cwd(), SCHEMA_OUT)}`);
console.log(`   ${tables} tables, ${policies} RLS policies, ${stripped} psql meta-command(s) stripped`);
console.log(`   ${insertCount} reference rows across ${refTables.length} global table(s): ${refTables.join(', ')}`);
console.log(`✅ ${path.relative(process.cwd(), MANIFEST_OUT)}`);
console.log(`   ${migrations.length} migrations recorded as included in the snapshot`);
