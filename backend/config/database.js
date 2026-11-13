const { Pool } = require('pg');
const path = require('path');
// Load the backend's own .env (backend/.env). Any variable already present in
// process.env (e.g. set by server.js's earlier dotenv call, or by the hosting
// platform) is preserved — dotenv never overrides existing values. This makes
// the DB config self-sufficient for standalone scripts like db-migrate.js.
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// The application's own runtime connection. APP_DATABASE_URL is an opt-in
// override — the restricted, NOBYPASSRLS qira_app role that company isolation
// (migrations 110-112) requires (see docker-compose.yml's `backend` service,
// which sets it via DATABASE_URL directly, and docker/postgres-init/). Falls
// back to DATABASE_URL so a database that hasn't split the two roles, or a
// standalone script that only sets DATABASE_URL, is unaffected.
const appDbUrl = process.env.APP_DATABASE_URL || process.env.DATABASE_URL;

// Dynamic configuration based on environment.
// A connection is treated as "local" when it points at this machine (localhost,
// 127.0.0.1, ::1) via DATABASE_URL or DB_HOST, or when no DATABASE_URL is set.
const dbUrl = appDbUrl || '';
const dbHost = process.env.DB_HOST || '';
const looksLocal = /(localhost|127\.0\.0\.1|\[?::1\]?)/i.test(dbUrl) ||
  ['localhost', '127.0.0.1', '::1'].includes(dbHost) ||
  !dbUrl;
const isLocal = looksLocal;

// SSL: local Postgres usually has SSL disabled, remote (e.g. Render) requires it.
// DB_SSL=true|false forces the choice explicitly for anything in between.
const dbSslEnv = String(process.env.DB_SSL || '').toLowerCase();
const ssl = dbSslEnv === 'true' ? { rejectUnauthorized: false }
  : dbSslEnv === 'false' ? false
  : (isLocal ? false : { rejectUnauthorized: false });

const pool = new Pool({
  connectionString: appDbUrl,
  ssl,

  // Local development - optimized for high traffic.
  // DB_POOL_MAX env override (backend/.env sets 10). The production default was
  // raised from 2 to 10: a posting that runs bill client + journal client on
  // one transaction can exhaust a 2-connection pool the moment any third query
  // is issued, deadlocking procure-to-pay.
  max: parseInt(process.env.DB_POOL_MAX, 10) || (isLocal ? 20 : 10),
  min: isLocal ? 2 : 0,  // Keep 2 connections alive locally
  idleTimeoutMillis: isLocal ? 300000 : 30000, // 5 minutes local, 30 seconds Render
  connectionTimeoutMillis: isLocal ? 60000 : 15000, // 1 minute local, 15 seconds Render
  acquireTimeoutMillis: isLocal ? 60000 : 15000, // 1 minute local, 15 seconds Render

  // TCP keepalive for local connections
  keepAlive: isLocal, // Enable for local, disable for Render
  keepAliveInitialDelayMillis: isLocal ? 30000 : 0,

  // Statement timeouts
  statement_timeout: isLocal ? 60000 : 20000, // 1 minute local, 20 seconds Render
  query_timeout: isLocal ? 60000 : 20000, // 1 minute local, 20 seconds Render
  application_name: 'qira_erp_backend'
});

// ---------------------------------------------------------------------------
// pgvector's `vector` type parser.
//
// node-postgres has no built-in decoder for extension types — without this,
// every `vector` column comes back as its raw text form ("[0.1,0.2,...]"),
// a string, not a number array. That would silently break every caller that
// reads document_embeddings.embedding expecting an array (documentSearch.js,
// vectorSearchService.js's JS-side cosineSimilarity()) the moment migration
// 202608070100 changed that column from float4[] to vector(384).
//
// The type's OID is assigned by CREATE EXTENSION at runtime, not a fixed
// well-known value like built-in types, so it has to be looked up rather than
// hardcoded. Best-effort and non-blocking: on a database without pgvector
// (never expected to happen here, but a bad connection string or a stale
// pool during startup shouldn't crash the process either) this just leaves
// vector columns as text, which is a pre-existing shape, not a new failure.
const { types } = require('pg');
pool.query("SELECT oid FROM pg_type WHERE typname = 'vector'")
  .then(({ rows }) => {
    if (!rows[0]) return;
    types.setTypeParser(rows[0].oid, (value) => (
      value ? value.slice(1, -1).split(',').map(Number) : null
    ));
  })
  .catch(() => {});

// Enhanced connection event handling
pool.on('connect', (client) => {
  console.log('✅ Connected to PostgreSQL database');
  // Set keepalive on new connections
  client.query('SELECT NOW()', (err) => {
    if (err) console.log('Keepalive query failed:', err.message);
  });
});

pool.on('error', (err, client) => {
  console.error('🔴 Database connection error:', err.message);
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
    console.log('🔄 Attempting to reconnect...');
  }

  // Log pool status on error for local development
  if (isLocal) {
    console.log(`🔍 Pool status on error: Total=${pool.totalCount}, Idle=${pool.idleCount}, Waiting=${pool.waitingCount}`);
  }
});

// Add pool monitoring for local development
if (isLocal) {
  const monitorTimer = setInterval(() => {
    const { totalCount, idleCount, waitingCount } = pool;

    // Only log if there are issues
    if (waitingCount > 0 || totalCount >= 15) {
      console.log(`📊 Pool status: Total=${totalCount}/20, Idle=${idleCount}, Waiting=${waitingCount}`);
    }

    // Warn if pool is getting overwhelmed
    if (waitingCount > 5) {
      console.warn(`⚠️ High connection pressure: ${waitingCount} requests waiting`);
    }
  }, 30000); // Check every 30 seconds
  // Don't let this monitoring timer keep the process alive on its own — the
  // long-running server stays up via its HTTP listener, while short-lived
  // scripts/tests can exit cleanly once their work is done.
  monitorTimer.unref();
}

// Removed annoying connection removal logging
// pool.on('remove', () => {
//   console.log('📤 Database connection removed from pool');
// });

// Graceful shutdown is owned by server.js (the actual process entrypoint),
// which closes the HTTP server first — draining in-flight requests — and
// only then ends this pool. A second SIGINT/SIGTERM handler here used to race
// it: both fired on the same signal, and whichever called pool.end() /
// process.exit(0) first could cut the HTTP drain short, defeating the whole
// point of a graceful shutdown ("Called end on pool more than once" is what
// that race looks like in the logs). Standalone scripts (migrations, the
// embeddings backfill, ...) already call pool.end() themselves on completion
// and don't need a signal handler to do it for them.

// ---------------------------------------------------------------------------
// Query wrapper with retry — RETRIES READS ONLY.
//
// WHY THE DISTINCTION MATTERS
// ---------------------------------------------------------------------------
// A connection error does not tell you whether the statement ran. "Connection
// terminated" covers both "the server never saw it" and "the server committed
// it and then the socket died on the way back". Retrying is correct in the
// first case and duplicates the work in the second.
//
// For a SELECT that is harmless: running it twice returns the same rows. For
// an INSERT it is not — this wrapper previously retried anything, so a journal
// entry, a payment, or a stock movement could post twice from a single call,
// with nothing in the logs to say it had. That failure mode is silent, appears
// only when the network misbehaves, and lands in the ledger.
//
// So: reads retry, writes fail fast and let the caller decide. A caller that
// genuinely wants an at-least-once write can retry deliberately, behind its own
// idempotency key — which is a decision that belongs at the call site, where
// the meaning of "the same write twice" is actually known.
// ---------------------------------------------------------------------------

// Leading keyword decides. Comments and CTEs are stripped first so that a
// `WITH ... SELECT` still reads as a query, while `WITH ... INSERT` does not.
const READ_ONLY_LEADING = /^(?:select|show|explain|values|table)\b/i;

function isReadOnlyStatement(text) {
  if (typeof text !== 'string') return false;

  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/--[^\n]*/g, ' ')            // line comments
    .trim();

  // A CTE is read-only only if it contains no writing statement anywhere —
  // `WITH x AS (DELETE ... RETURNING *) SELECT * FROM x` is a write wearing a
  // SELECT's leading keyword.
  if (/^with\b/i.test(stripped)) {
    return !/\b(insert|update|delete|merge)\b/i.test(stripped);
  }

  return READ_ONLY_LEADING.test(stripped);
}

const isTransientConnectionError = (error) =>
  error.code === 'ENOTFOUND' ||
  error.code === 'ECONNREFUSED' ||
  error.code === 'ETIMEDOUT' ||
  (typeof error.message === 'string' && (
    error.message.includes('Connection terminated') ||
    error.message.includes('server closed the connection')
  ));

const query = async (text, params) => {
  const maxRetries = isReadOnlyStatement(text) ? 3 : 1;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      const start = Date.now();
      const res = await pool.query(text, params);
      const duration = Date.now() - start;

      if (duration > 1000) {
        console.log(`⚠️  Slow query executed in ${duration}ms`);
      }

      return res;
    } catch (error) {
      attempt++;
      console.error(`🔴 Database query failed (attempt ${attempt}/${maxRetries}):`, error.message);

      if (isTransientConnectionError(error) && attempt < maxRetries) {
        console.log(`🔄 Retrying in ${attempt * 1000}ms...`);
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        continue;
      }

      // Say plainly that a write was NOT retried, so nobody reading the log
      // later assumes this wrapper covered them.
      if (isTransientConnectionError(error) && maxRetries === 1) {
        console.error(
          '🔴 The connection dropped during a writing statement. It was NOT retried, because '
          + 'whether it committed is unknown — retrying could duplicate it. Check the data before re-running.'
        );
      }

      throw error;
    }
  }
};

// Dynamic keepalive based on environment
const keepDatabaseAlive = () => {
  const interval = isLocal ? 2 * 60 * 1000 : 10 * 60 * 1000; // 2 minutes local, 10 minutes Render

  const keepaliveTimer = setInterval(async () => {
    // For local: always keepalive, for Render: only if idle connections exist
    if (isLocal || pool.idleCount > 0) {
      try {
        const start = Date.now();
        await query('SELECT 1');
        const duration = Date.now() - start;

        if (duration > (isLocal ? 1000 : 2000)) {
          console.warn(`⚠️ Slow database response: ${duration}ms`);
        }
      } catch (error) {
        console.error('❤️‍🩹 Keepalive failed:', error.message);

        // For local development, log pool status when keepalive fails
        if (isLocal) {
          console.log(`🔍 Pool status: Total=${pool.totalCount}, Idle=${pool.idleCount}, Waiting=${pool.waitingCount}`);
        }
      }
    }
  }, interval);
  keepaliveTimer.unref();
};

// Start keepalive earlier for local development
const keepaliveBootTimer = setTimeout(keepDatabaseAlive, isLocal ? 15000 : 60000); // 15 seconds local, 1 minute Render
keepaliveBootTimer.unref();

// ===========================================================================
// COMPANY ISOLATION — THE SEAM THAT MAKES ROW-LEVEL SECURITY REAL
// ===========================================================================
//
// THE PROBLEM THIS SOLVES
// ---------------------------------------------------------------------------
// Migration 110 built company isolation on Postgres row-level security, and
// services/companyContext.js built `withCompany()` to put the company onto the
// connection so the policies can see it. The design is right. The adoption was
// zero: `withCompany` was referenced nowhere outside its own file and its test,
// while 431 model queries went straight to the shared pool.
//
// That gap is not a partial rollout, it is a trap. RLS reads the company from
// `current_setting('app.current_company_id')`. A connection that never had it
// set matches no rows, so the day anyone ran `enable_multi_company()` the
// application would not have leaked — it would simply have gone blank, on every
// screen, with no error to explain it. The mechanism advertised as the tenant
// boundary was load-bearing for nothing.
//
// Retrofitting `withCompany` into 431 call sites is the obvious fix and the
// wrong one: it is a mechanical change across every model, it must be complete
// to be correct, and a single missed query is invisible until it matters.
//
// THE APPROACH
// ---------------------------------------------------------------------------
// Put the context on the connection at the one place every query already
// passes through — the pool itself. Both entry points are covered, which
// matters because the models use both interchangeably (`db.query(...)` in some
// files, `pool.query(...)` in others, from the same import):
//
//   • `pool.query(...)` — the ~431 single-statement model calls. When isolation
//     is on, the statement is run inside its own transaction carrying
//     `SET LOCAL app.current_company_id`. Wrapping the pool's own method rather
//     than the exported `query` helper is what makes this comprehensive: a
//     model that reached past the helper straight to `pool` is still covered.
//
//   • `pool.connect()` — the ~112 places that manage their own transaction.
//     The returned client is wrapped so that its first BEGIN is immediately
//     followed by the same `SET LOCAL`. Those call sites are unchanged and
//     cannot forget, because they are not the ones remembering.
//
// WHY `SET LOCAL`, ALWAYS
// ---------------------------------------------------------------------------
// A plain `SET` lasts for the life of the connection, not the request. On a
// pooled connection that means the next request — possibly another tenant's —
// inherits it. `SET LOCAL` is scoped to the transaction and discarded at COMMIT
// or ROLLBACK, so a connection cannot carry a company back into the pool. There
// is deliberately no code path here that sets it any other way.
//
// COST
// ---------------------------------------------------------------------------
// While isolation is OFF (the single-company default, and every installation
// today) this changes nothing: `query` goes straight to `pool.query` exactly as
// before, and the connect wrapper adds one boolean check per BEGIN. The
// transaction-per-statement cost is paid only by installations that have
// actually turned multi-company on, which is the only place it buys anything.
// ===========================================================================

const companyScope = require('../services/companyScope');

// The pool's own methods, captured before wrapping. Everything below that must
// reach the database WITHOUT re-entering the wrapper uses these — otherwise
// checking whether isolation is enabled would itself try to apply isolation,
// and recurse until the stack ran out.
const rawPoolQuery = pool.query.bind(pool);
const rawConnect = pool.connect.bind(pool);

// Cached after the first successful answer. The function is created by
// migration 110 and only changes when an operator runs enable_multi_company(),
// which is a deliberate act followed by a restart — companyContext.resetCache()
// clears this too, for tests and for the admin endpoint that flips it.
let isolationActive = null;

async function isolationEnabled() {
  if (isolationActive !== null) return isolationActive;
  try {
    const { rows } = await rawPoolQuery('SELECT multi_company_enabled() AS enabled');
    isolationActive = rows[0].enabled === true;
  } catch {
    // Databases predating migration 110 have no such function: single-company.
    isolationActive = false;
  }
  return isolationActive;
}

function resetIsolationCache() {
  isolationActive = null;
}

const SET_COMPANY_SQL = "SELECT set_config('app.current_company_id', $1, true)";

// Matches BEGIN / START TRANSACTION as the leading keyword, after comments.
const BEGIN_RE = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(?:begin|start\s+transaction)\b/i;

function statementText(arg) {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg.text === 'string') return arg.text;
  return '';
}

// ---------------------------------------------------------------------------
// Wrap pool.connect() so that hand-rolled transactions carry company context.
//
// The wrapper is applied to the client object once and is idempotent: pooled
// clients are handed out repeatedly, and re-wrapping one would nest the
// interception a layer deeper on every checkout. The ambient company is read
// at call time, not at wrap time, so a client reused by a different request
// picks up that request's company.
// ---------------------------------------------------------------------------
pool.connect = function connectWithCompanyContext(...args) {
  // pg's own Pool.query calls `this.connect(callback)` internally, so this
  // wrapper is on the hot path for every pooled query whether or not anyone
  // asked for a client. In callback form there is no promise to await and
  // nothing to wrap — hand it straight to pg. Awaiting it instead yields
  // `undefined`, which is how this first announced itself.
  if (args.some((a) => typeof a === 'function')) {
    return rawConnect(...args);
  }
  return connectScoped(...args);
};

async function connectScoped(...args) {
  const client = await rawConnect(...args);

  if (client.__qiraCompanyScoped) return client;
  client.__qiraCompanyScoped = true;

  const rawQuery = client.query.bind(client);

  client.query = function scopedQuery(...queryArgs) {
    if (!BEGIN_RE.test(statementText(queryArgs[0]))) {
      return rawQuery(...queryArgs);
    }

    // A transaction is opening. Start it, then immediately scope it — before
    // the caller's next statement can run, because that statement is the one
    // RLS has to see the company for.
    return (async () => {
      const result = await rawQuery(...queryArgs);
      const companyId = companyScope.currentCompanyId();
      if (companyId && (await isolationEnabled())) {
        await rawQuery(SET_COMPANY_SQL, [companyId]);
      }
      return result;
    })();
  };

  return client;
}

// ---------------------------------------------------------------------------
// Wrap pool.query() so that single-statement model calls carry company context.
//
// While isolation is off this is one null check and a delegation — the same
// call the models were already making. While it is on, the statement runs in
// its own transaction so that `SET LOCAL` has something to be local to.
//
// Callback-style `pool.query(text, params, cb)` is passed straight through:
// nothing in this codebase uses it except the pool's own keepalive, and
// quietly changing its semantics would be a worse trade than leaving the one
// caller unscoped.
// ---------------------------------------------------------------------------
pool.query = function queryWithCompanyContext(text, params, callback) {
  if (typeof params === 'function' || typeof callback === 'function') {
    return rawPoolQuery(text, params, callback);
  }

  const companyId = companyScope.currentCompanyId();
  if (!companyId) return rawPoolQuery(text, params);

  return (async () => {
    if (!(await isolationEnabled())) return rawPoolQuery(text, params);

    const client = await pool.connect();
    try {
      // The connect wrapper applies SET LOCAL as part of this BEGIN.
      await client.query('BEGIN');
      const result = await client.query(text, params);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  })();
};

module.exports = {
  pool,
  query,
  isolationEnabled,
  resetIsolationCache,
};