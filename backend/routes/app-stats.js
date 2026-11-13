/**
 * Application statistics — one payload for the admin "App Statistics" screen.
 *
 * Deliberately a single endpoint. The page is a dashboard, so a dozen parallel
 * requests would only add latency and failure modes; everything here is cheap
 * enough to gather in one round trip.
 *
 * Three sources, and they answer different questions:
 *   - Postgres, for what the tenant HAS (business volume, storage).
 *   - ai_usage_log, for what the tenant SPENT (model calls, tokens, cost).
 *   - the in-process prom-client registry, for what the server DID (request
 *     counts and latency). That last one is per-process and resets on restart,
 *     which the response states explicitly rather than letting the reader
 *     assume it is historical.
 *
 * PLATFORM OWNER only — not ADMIN.
 *
 * ADMIN is a tenant role: every customer company has one, and each is entitled
 * to administer their own data. It is the wrong gate here because two panels
 * describe the INSTANCE rather than a tenant — request counters and table
 * sizes are instance-wide, so a customer's admin would be reading traffic and
 * storage that is partly other customers'. requirePlatformOwner keys off
 * PLATFORM_OWNER_EMAIL, which lives in the server environment and cannot be
 * granted from inside the product.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { auth, requirePlatformOwner } = require('../middleware/auth');
const { register: metricsRegister } = require('../config/metrics');

/**
 * COUNT(*) for a table that might not exist on this deployment.
 *
 * to_regclass first, because a missing table would otherwise abort the whole
 * request and blank the entire dashboard over one absent feature. Migrations
 * are applied unevenly across environments (see the baseline work in
 * scripts/regenerate-baseline.cjs), so "this table is not here" is a normal
 * state, not an error.
 */
async function safeCount(table) {
  try {
    const { rows } = await pool.query('SELECT to_regclass($1) AS reg', [`public.${table}`]);
    if (!rows[0].reg) return null;
    // Table name is not user input — it comes from the fixed list below — so
    // interpolation here cannot be influenced by a caller.
    const { rows: c } = await pool.query(`SELECT count(*)::int AS n FROM "${table}"`);
    return c[0].n;
  } catch {
    return null;
  }
}

// Business volume. Every one of these is company-scoped, so RLS narrows the
// counts to the caller's own tenant without this route filtering explicitly.
const BUSINESS_TABLES = [
  ['users', 'Users'],
  ['inventory_items', 'Inventory items'],
  ['suppliers', 'Suppliers'],
  ['customers', 'Customers'],
  ['purchase_orders', 'Purchase orders'],
  ['sales_orders', 'Sales orders'],
  ['customer_invoices', 'Customer invoices'],
  ['journal_entries', 'Journal entries'],
];

/** Request totals and latency from the live prom-client registry. */
async function httpStats() {
  try {
    const metrics = await metricsRegister.getMetricsAsJSON();
    const total = metrics.find((m) => m.name === 'http_requests_total');
    const duration = metrics.find((m) => m.name === 'http_request_duration_seconds');

    // Group by status CLASS (2xx/3xx/4xx/5xx) rather than exact code: the
    // question this panel answers is "is the app healthy", and 200 vs 204 is
    // noise at that altitude.
    const byClass = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    let requests = 0;
    for (const v of total?.values || []) {
      const code = String(v.labels.status_code || '');
      const bucket = `${code[0]}xx`;
      if (bucket in byClass) byClass[bucket] += v.value;
      requests += v.value;
    }

    // Mean latency from the histogram's _sum/_count pair. Not a percentile —
    // prom-client exposes buckets, and computing a real p95 from them here
    // would be more machinery than this panel warrants. Labelled as a mean so
    // nobody reads it as one.
    const sum = (duration?.values || []).filter((v) => v.metricName?.endsWith('_sum')).reduce((a, v) => a + v.value, 0);
    const count = (duration?.values || []).filter((v) => v.metricName?.endsWith('_count')).reduce((a, v) => a + v.value, 0);

    return {
      requests: Math.round(requests),
      by_class: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, Math.round(v)])),
      mean_ms: count > 0 ? Number(((sum / count) * 1000).toFixed(1)) : null,
      // Stated, not implied: these counters live in this process only.
      since_process_start: true,
    };
  } catch {
    return null;
  }
}

// GET /api/app-stats — everything the statistics screen renders.
router.get('/', auth, requirePlatformOwner, async (req, res) => {
  try {
    const [business, ai, aiDaily, aiByModel, storage, http, signups] = await Promise.all([
      (async () => {
        const out = [];
        for (const [table, label] of BUSINESS_TABLES) {
          out.push({ table, label, count: await safeCount(table) });
        }
        return out.filter((r) => r.count !== null);
      })(),

      pool
        .query(
          `SELECT count(*)::int                             AS calls,
                  COALESCE(sum(total_tokens), 0)::bigint    AS tokens,
                  COALESCE(sum(estimated_cost_usd), 0)::float AS cost_usd
             FROM ai_usage_log
            WHERE created_at >= date_trunc('month', now())`
        )
        .then((r) => r.rows[0])
        .catch(() => null),

      // 30-day daily series for the usage chart. generate_series so days with
      // no activity are present as zeroes — a line that silently skips empty
      // days misrepresents the shape of usage.
      pool
        .query(
          `SELECT to_char(d.day, 'YYYY-MM-DD')                  AS day,
                  COALESCE(sum(l.prompt_tokens), 0)::int        AS prompt_tokens,
                  COALESCE(sum(l.completion_tokens), 0)::int    AS completion_tokens,
                  count(l.id)::int                              AS calls
             FROM generate_series(current_date - interval '29 days', current_date, interval '1 day') AS d(day)
             LEFT JOIN ai_usage_log l ON l.created_at::date = d.day
            GROUP BY d.day
            ORDER BY d.day`
        )
        .then((r) => r.rows)
        .catch(() => []),

      pool
        .query(
          `SELECT model,
                  count(*)::int                               AS calls,
                  COALESCE(sum(total_tokens), 0)::bigint      AS tokens,
                  COALESCE(sum(estimated_cost_usd), 0)::float AS cost_usd
             FROM ai_usage_log
            WHERE created_at >= date_trunc('month', now())
            GROUP BY model
            ORDER BY calls DESC
            LIMIT 8`
        )
        .then((r) => r.rows)
        .catch(() => []),

      // reltuples, not COUNT(*): an estimate is right for a "biggest tables"
      // panel and does not sequential-scan every table on the instance to
      // render one card.
      pool
        .query(
          `SELECT c.relname                                   AS table,
                  GREATEST(c.reltuples, 0)::bigint            AS est_rows,
                  pg_total_relation_size(c.oid)::bigint       AS bytes,
                  pg_size_pretty(pg_total_relation_size(c.oid)) AS size
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r'
            ORDER BY pg_total_relation_size(c.oid) DESC
            LIMIT 10`
        )
        .then((r) => r.rows)
        .catch(() => []),

      httpStats(),

      // Recent signups, across every tenant.
      //
      // Cross-tenant on purpose and only defensible because this route is
      // platform-owner-only: knowing who has registered on the instance is an
      // operator's question, not an administrator's, and a tenant admin must
      // never reach it. `users` is exempt from company scoping (a user may
      // belong to several tenants via user_companies), so RLS does not narrow
      // this — the requirePlatformOwner gate is what holds, which is why it is
      // enforced on the endpoint rather than only in the UI.
      //
      // Email is the identifying field and is deliberately the point; nothing
      // else personal is selected, and password hashes are never in scope.
      pool
        .query(
          `SELECT u.email,
                  u.role,
                  u.email_verified,
                  u.is_platform_owner,
                  u.is_active,
                  u.created_at,
                  c.name AS company
             FROM users u
             LEFT JOIN user_companies uc ON uc.user_id = u.id AND uc.is_primary
             LEFT JOIN companies c ON c.id = uc.company_id
            WHERE u.deleted_at IS NULL
            ORDER BY u.created_at DESC
            LIMIT 50`
        )
        .then((r) => r.rows)
        .catch(() => []),
    ]);

    const dbSize = await pool
      .query('SELECT pg_size_pretty(pg_database_size(current_database())) AS size')
      .then((r) => r.rows[0].size)
      .catch(() => null);

    res.json({
      success: true,
      data: {
        platform: {
          uptime_seconds: Math.round(process.uptime()),
          node_version: process.version,
          environment: process.env.NODE_ENV || 'development',
          ai_provider: process.env.AI_PROVIDER || 'openai',
          ai_model: process.env.AI_MODEL || null,
          ai_configured: Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY),
          email_configured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER),
        },
        database: {
          size: dbSize,
          pool: {
            total: pool.totalCount,
            idle: pool.idleCount,
            waiting: pool.waitingCount,
          },
          largest_tables: storage,
        },
        business,
        ai: {
          month_to_date: ai,
          daily: aiDaily,
          by_model: aiByModel,
        },
        http,
        signups,
      },
    });
  } catch (error) {
    console.error('Error building app statistics:', error);
    res.status(500).json({ success: false, error: 'Failed to build application statistics' });
  }
});

module.exports = router;
