/**
 * Database access for the platform, and the one place that holds a connection
 * able to run DDL.
 *
 * ===========================================================================
 * WHY THERE ARE TWO POOLS
 * ===========================================================================
 * Company isolation (migrations 110-112) requires the application's runtime
 * connection to be a role that does NOT bypass row-level security, which also
 * means it does not own the tables it queries and cannot CREATE TABLE. That is
 * correct and deliberate: the connection serving user requests must not be able
 * to reshape the schema.
 *
 * But deploying a generated application is exactly "reshape the schema", at
 * runtime, from an approved plan. So the deployer uses a second pool on
 * MIGRATION_DATABASE_URL — the owner connection migrations already use —
 * falling back to DATABASE_URL for a database that has not split the roles.
 *
 * The separation is the point: `pool` (config/database.js) can read and write
 * application rows and never alter a table; `ddlPool` can alter tables and is
 * reachable only from the deployer, which only ever executes statements
 * produced by compiler/ddl.js from an approved plan.
 */

const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { pool } = require('../../config/database');
const companyContext = require('../companyContext');

let ddlPoolInstance = null;

function ddlPool() {
  if (!ddlPoolInstance) {
    ddlPoolInstance = new Pool({
      connectionString: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: parseInt(process.env.PLATFORM_DDL_POOL_MAX, 10) || 3,
      // DDL for a large application is a lot of statements. The runtime pool's
      // 20-second statement timeout would abort a legitimate deployment
      // halfway; this one is allowed longer, and the advisory lock below stops
      // that turning into two deployments overlapping.
      statement_timeout: parseInt(process.env.PLATFORM_DDL_TIMEOUT_MS, 10) || 120000,
      application_name: 'embmis_platform_ddl',
    });
  }
  return ddlPoolInstance;
}

async function closeDdlPool() {
  if (ddlPoolInstance) {
    await ddlPoolInstance.end();
    ddlPoolInstance = null;
  }
}

/**
 * Can the DDL connection actually create tables?
 *
 * ===========================================================================
 * WHY THIS IS CHECKED RATHER THAN ASSUMED
 * ===========================================================================
 * Deploying a generated application creates tables at runtime, which needs a
 * connection that owns the schema. On a single-role deployment DATABASE_URL is
 * that connection and everything works. On a deployment that has split the
 * roles — which company isolation requires (migration 111: the app role must
 * NOT bypass RLS, which also means it does not own its tables) — DATABASE_URL
 * is the RESTRICTED role, and `MIGRATION_DATABASE_URL` has to be set for the
 * deployer to have anything to work with.
 *
 * Without this check, a deployment on such a database fails halfway through a
 * transaction with `permission denied for schema public`, which names neither
 * the cause nor the fix. With it, the deployer refuses before it starts and
 * says which environment variable is missing.
 *
 * Asked of the database rather than inferred from the connection string: what
 * matters is whether the role can CREATE, and a URL is a claim about intent.
 */
let ddlCapability;
async function assertCanCreateSchemaObjects() {
  if (ddlCapability === undefined) {
    const client = await ddlPool().connect();
    try {
      const { rows } = await client.query(
        `SELECT current_user AS role,
                has_schema_privilege(current_user, 'public', 'CREATE') AS can_create`
      );
      ddlCapability = rows[0];
    } finally {
      client.release();
    }
  }

  if (!ddlCapability.can_create) {
    const error = new Error(
      `Deploying an application creates tables, and this server's schema connection (role "${ddlCapability.role}") `
      + 'cannot create them. That is expected when company isolation has split the database roles: the '
      + 'application connection is deliberately unprivileged. Set MIGRATION_DATABASE_URL to the owner '
      + 'connection migrations already use — it is used ONLY by the deployer, and only for statements the '
      + 'schema compiler produced from an approved plan.'
    );
    error.code = 'DDL_PRIVILEGE_MISSING';
    error.status = 503;
    throw error;
  }
  return ddlCapability;
}

function resetDdlCapabilityCache() { ddlCapability = undefined; }

/**
 * The restricted application role, if company isolation is enabled.
 *
 * Returned so the deployer can GRANT on every table it creates. Null on a
 * database where isolation was never turned on, in which case there is no
 * separate role to grant to and the tables are reachable by the owner already.
 */
let cachedAppRole;
async function applicationRole() {
  if (cachedAppRole !== undefined) return cachedAppRole;
  try {
    const { rows } = await pool.query(
      'SELECT application_role FROM company_isolation_config WHERE id AND application_role IS NOT NULL'
    );
    cachedAppRole = rows[0]?.application_role || null;
  } catch (err) {
    if (err.code === '42P01') cachedAppRole = null; // pre-112 database
    else throw err;
  }
  return cachedAppRole;
}

function resetRoleCache() { cachedAppRole = undefined; }

/**
 * A lock key for one application instance's deployments.
 *
 * Two deployments of the same instance at the same time would plan against the
 * same "current" state and then both apply, with the second one's ALTERs
 * landing on a table the first one had already changed. pg_advisory_xact_lock
 * makes the second wait; because the lock is transaction-scoped it is released
 * whether the first commits or rolls back, including if its process dies.
 *
 * Two 32-bit halves rather than one bigint so the key is derived from the
 * instance id without a bignum library.
 */
function lockKeyFor(instanceId) {
  const crypto = require('crypto');
  const digest = crypto.createHash('sha256').update(`app_instance:${instanceId}`).digest();
  // Signed 32-bit integers, which is what pg_advisory_xact_lock(int, int) takes.
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * Run `fn` on the DDL connection inside one transaction, with company context
 * set the same way the runtime sets it.
 *
 * Setting the company matters even on the owner connection: the generated
 * tables' company_id defaults call current_company_id(), and the registry rows
 * written alongside them do too.
 */
async function withDdlTransaction(companyId, fn) {
  const client = await ddlPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Read-only convenience with company context applied. */
function withCompany(companyId, fn) {
  return companyContext.withCompany(companyId, fn);
}

/**
 * Run `fn` with `companyId` as the AMBIENT company for everything it calls.
 *
 * config/database.js wraps pool.query so that every statement issued while an
 * ambient company is set runs inside a transaction carrying
 * `SET LOCAL app.current_company_id`. In an HTTP request the auth middleware
 * establishes that; a background job, a scheduled automation or a test does
 * not have one, and without it every write to a company-scoped table is
 * refused by its own RLS policy — correctly, but confusingly.
 *
 * So every entry point into the platform that knows its company wraps itself in
 * this. Nesting is harmless: the innermost value wins and it is the same value.
 */
function asCompany(companyId, fn) {
  return companyContext.runWithCompany(companyId, fn);
}

module.exports = {
  pool,
  ddlPool,
  assertCanCreateSchemaObjects,
  resetDdlCapabilityCache,
  closeDdlPool,
  applicationRole,
  resetRoleCache,
  lockKeyFor,
  withDdlTransaction,
  withCompany,
  asCompany,
};
