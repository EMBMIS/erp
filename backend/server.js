const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const path = require('path');
require('dotenv').config();

const logger = require('./config/logger');
const { register: metricsRegister, metricsMiddleware } = require('./config/metrics');
const { pool } = require('./config/database');
const { auth } = require('./middleware/auth');

const itemRoutes = require('./routes/items');
const notificationRoutes = require('./routes/notifications');
const authRoutes = require('./routes/auth');
const storageLocationRoutes = require('./routes/storage-locations');
const binRoutes = require('./routes/bins');
const inventoryItemRoutes = require('./routes/inventory-items');
const supplierRoutes = require('./routes/suppliers');
const supplierItemRoutes = require('./routes/supplier-items');
const contractRoutes = require('./routes/contracts');
const contractItemRoutes = require('./routes/contract-items');
const purchaseRequisitionRoutes = require('./routes/purchase-requisitions');
const rfqRoutes = require('./routes/request-for-quotations');
const purchaseOrderRoutes = require('./routes/purchase-orders');
const delegationOfAuthorityRoutes = require('./routes/delegation-of-authority');
const goodsReceiptsRoutes = require('./routes/goods-receipts');
const supplierPortalRoutes = require('./routes/supplier-portal');
const supplierConfirmationRoutes = require('./routes/supplier-confirmation');
const healthRoutes = require('./routes/health');
const warehouseTransactionRoutes = require('./routes/warehouse-transactions');
const kpiSeriesRoutes = require('./routes/kpi-series');
const customerRoutes = require('./routes/customers');
const salesOrderRoutes = require('./routes/sales-orders');
const salesQuotationRoutes = require('./routes/sales-quotations');
const deliveryScheduleRoutes = require('./routes/delivery-schedules');
const salesContractRoutes = require('./routes/sales-contracts');
const salesRfqRoutes = require('./routes/sales-rfqs');
const { dbHealthCheck, logPoolStatus } = require('./middleware/dbHealth');
const { queueMiddleware, apiLimiter, getQueueStats } = require('./middleware/requestQueue');
const { errorHandler, sanitizeErrors } = require('./middleware/errorHandler');

// Fail fast on missing/weak secrets instead of starting and 500-ing at the
// first login. A JWT_SECRET under 32 chars is brute-forceable enough to be
// worse than no secret at all.
const REQUIRED_ENV_VARS = ['JWT_SECRET', 'DATABASE_URL', 'SSO_COOKIE_SECRET'];
for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    console.error(`FATAL: ${key} is not set. Refusing to start.`);
    process.exit(1);
  }
}
if (process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET is too short (minimum 32 characters). Refusing to start.');
  process.exit(1);
}
if (process.env.SSO_COOKIE_SECRET.length < 32) {
  console.error('FATAL: SSO_COOKIE_SECRET is too short (minimum 32 characters). Refusing to start.');
  process.exit(1);
}

const app = express();
// The API runs behind a reverse proxy (Caddy) and Docker's port forwarding, both on private addresses. Trust them for
// X-Forwarded-For, so req.ip is the visitor's real address (rate limits, audit logs) instead of the proxy's address,
// which every visitor shared. Only private and loopback hops are trusted, so a visitor cannot spoof the header.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
const PORT = process.env.PORT || 3001;

// Request ID tracing. One UUID per request, attached to req.id, echoed on
// every response as X-Request-Id, and bound into every pino log line for that
// request (via pinoHttp's genReqId below) -- what makes "find every log line
// for the request the client just reported" a lookup instead of a guess.
// Honors an inbound X-Request-Id so a request already tagged by an upstream
// proxy/load balancer keeps the same id end to end, rather than getting a
// second, disconnected one at this hop.
const { randomUUID } = require('crypto');
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Security middleware
app.use(helmet());

// Only ever reads the one signed SSO cookie (services/ssoCookie.js) — no
// secret passed here since that cookie is a signed JWT already verified with
// its own secret, not an express-signed cookie.
app.use(cookieParser());

// ---------------------------------------------------------------------------
// API version prefix
// ---------------------------------------------------------------------------
// Every route is mounted at /api/<resource>, with no version anywhere. That is
// free right now and expensive the moment a second product binds to this API:
// without a version in the URL there is no way to change a response shape
// without breaking every consumer at once, so in practice you stop making
// changes you should make.
//
// This makes /api/v1/<resource> an equivalent address for everything, in one
// place rather than by editing 82 mount points. New consumers pin /api/v1 and
// keep working when /api/v2 appears; existing consumers (this repo's own
// frontend included) are untouched, because /api still resolves exactly as
// before. When there is a v2, it mounts its own routers and this rewrite stays
// as the v1 compatibility path.
const API_VERSIONS = ['v1'];
const CURRENT_API_VERSION = 'v1';

app.use((req, res, next) => {
  const match = /^\/api\/(v\d+)(?=\/|$)/.exec(req.url);
  if (match) {
    if (!API_VERSIONS.includes(match[1])) {
      return res.status(404).json({
        success: false,
        error: `Unknown API version ${match[1]}. Supported: ${API_VERSIONS.join(', ')}.`,
      });
    }
    res.set('X-API-Version', match[1]);
    req.apiVersion = match[1];
    req.url = '/api' + req.url.slice(match[0].length);
  } else if (req.url.startsWith('/api/')) {
    // Unversioned callers get told, in a header, what they are actually
    // talking to — so a client can detect drift instead of discovering it.
    res.set('X-API-Version', `${CURRENT_API_VERSION}; unversioned request`);
    req.apiVersion = CURRENT_API_VERSION;
  }
  next();
});

// Request queue middleware (before rate limiting)
app.use('/api', queueMiddleware);

// Enhanced rate limiting
app.use('/api', apiLimiter);

// Enhanced CORS configuration for development
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:5173', // Vite default
      // .env.example documents CORS_ORIGIN as a comma-separated list; treat it
      // that way rather than as one literal origin, or a multi-host deployment
      // (app.embmis.com, embmis.com, www.embmis.com) would never match.
      ...(process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean)
    ].filter(Boolean);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // For development, be more permissive
    if (process.env.NODE_ENV === 'development') {
      return callback(null, true);
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'X-Company-Id',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers'
  ],
  exposedHeaders: ['X-DB-Pool-Total', 'X-DB-Pool-Idle', 'X-DB-Pool-Waiting'],
  optionsSuccessStatus: 200, // For legacy browser support
  preflightContinue: false // Pass control to next handler
}));

// NOTE: there is deliberately no second `app.options('*')` handler here.
//
// One used to sit at this point, echoing whatever `Origin` the request carried
// back as `Access-Control-Allow-Origin` together with
// `Access-Control-Allow-Credentials: true` — which is precisely the pairing the
// allowlist above exists to prevent, since it grants any site on the internet
// the ability to make credentialed calls to this API. It was dormant, because
// `cors()` answers preflights before reaching it, but "dormant" only held for
// as long as nobody reordered the middleware. Removing it is the difference
// between safe-by-accident and safe-by-construction.
//
// `cors()` already handles OPTIONS for every route.

// Resend's inbound-mail webhook — mounted BEFORE the JSON body parser below: Svix signature verification needs the exact raw bytes
// Resend signed, which express.json() below would otherwise consume first
// (this request's Content-Type: application/json is exactly what it matches).
app.use('/api/mailboxes/webhook/resend-inbound', require('./routes/resendInboundWebhook'));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Structured (JSON) request logging -- one queryable object per request
// (method, path, status, duration, request id) instead of morgan's
// plain-text combined-log line. See config/logger.js for why this replaced it.
app.use(pinoHttp({
  logger,
  genReqId: (req) => req.id,
  autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' },
}));

// Per-request duration/count metrics, scraped via GET /metrics below.
app.use(metricsMiddleware);

// Database health monitoring (apply to all API routes)
app.use('/api', logPoolStatus);

// Stop internal error text escaping to clients.
//
// Must be registered BEFORE the routes, because it works by wrapping res.json
// on the way in so it can inspect what the routes send on the way out. The 274
// hand-rolled `res.status(500).json({ error: error.message })` blocks across
// the route files are unchanged and do not need to be — see
// middleware/errorHandler.js for why this is a response filter rather than a
// rewrite of every catch block.
app.use('/api', sanitizeErrors);

// Enhanced health check with database status
app.use('/health', healthRoutes);

// GET /api/health -- minimal liveness/readiness probe for load balancers and
// orchestrators (a fixed, tiny shape they can assert on), distinct from
// GET /health above which reports full diagnostic detail for a human.
app.get('/api/health', async (req, res) => {
  try {
    await require('./config/database').query('SELECT 1');
    res.json({
      status: 'ok',
      db: 'connected',
      uptime: Math.round(process.uptime()),
      version: require('./package.json').version,
    });
  } catch (error) {
    res.status(503).json({ status: 'error', db: 'unreachable' });
  }
});

// Prometheus-format scrape endpoint. Unauthenticated, matching /health's
// existing posture (both leak only operational shape, not tenant data) and
// standard Prometheus scrape conventions -- put behind network-level access
// control (not application auth) in a real deployment, the same way /health
// would be.
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', metricsRegister.contentType);
    res.end(await metricsRegister.metrics());
  } catch (error) {
    res.status(500).end(error.message);
  }
});

// What a consumer needs in order to bind to this API deliberately: which
// versions exist, which one they got, and where the event contract lives.
app.get('/api/version', (req, res) => {
  res.json({
    success: true,
    data: {
      current: CURRENT_API_VERSION,
      supported: API_VERSIONS,
      resolved: req.apiVersion || CURRENT_API_VERSION,
      events_endpoint: '/api/v1/webhooks/event-types',
    },
  });
});

// API routes
app.use('/api/auth', authRoutes);
// Sales-representative picker: any signed-in user can list the company's
// non-admin users to assign as a customer's sales rep. The /api/users router
// itself is ADMIN-only, so this lives outside it — a sales person creating a
// customer must not 403 on their own form.
app.get('/api/users/sales-reps', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.first_name, u.last_name, u.email
      FROM users u
      JOIN user_companies uc ON uc.user_id = u.id
      WHERE uc.company_id = $1
        AND u.deleted_at IS NULL
        AND u.is_active = TRUE
        AND u.role <> 'ADMIN'
      ORDER BY u.first_name, u.last_name
    `, [req.companyId]);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('List sales reps error:', error);
    res.status(500).json({ success: false, error: 'Failed to list sales representatives' });
  }
});
app.use('/api/users', require('./routes/users'));
app.use('/api/items', itemRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/storage-locations', storageLocationRoutes);
app.use('/api/bins', binRoutes);
app.use('/api/inventory-items', inventoryItemRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/supplier-items', supplierItemRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/contract-items', contractItemRoutes);
app.use('/api/purchase-requisitions', purchaseRequisitionRoutes);
app.use('/api/request-for-quotations', rfqRoutes);
app.use('/api/purchase-orders', purchaseOrderRoutes);
app.use('/api/delegation-of-authority', delegationOfAuthorityRoutes);
app.use('/api/goods-receipts', goodsReceiptsRoutes);
app.use('/api/supplier-portal', supplierPortalRoutes);
app.use('/api/supplier-confirmation', supplierConfirmationRoutes);
app.use('/api/warehouse/transactions', warehouseTransactionRoutes);
app.use('/api/kpi-series', kpiSeriesRoutes);
app.use('/api/inventory-transfers', require('./routes/inventory-transfers'));
app.use('/api/stocktake', require('./routes/stocktake'));
app.use('/api/inventory-traceability', require('./routes/inventory-traceability'));
app.use('/api/credit-notes', require('./routes/credit-notes'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/customers', customerRoutes);
app.use('/api/sales-orders', salesOrderRoutes);
app.use('/api/sales-quotations', salesQuotationRoutes);
app.use('/api/delivery-schedules', deliveryScheduleRoutes);
app.use('/api/sales-contracts', salesContractRoutes);
app.use('/api/sales-rfqs', salesRfqRoutes);
app.use('/api/chart-of-accounts', require('./routes/chart-of-accounts'));
app.use('/api/journal-entries', require('./routes/journal-entries'));
app.use('/api/financial-reports', require('./routes/financial-reports'));
app.use('/api/finance', require('./routes/finance'));
app.use('/api/customer-invoices', require('./routes/customer-invoices'));
app.use('/api/recurring-invoices', require('./routes/recurring-invoices'));
app.use('/api/audit-trail', require('./routes/audit-trail'));
app.use('/api/api-keys', require('./routes/api-keys'));
app.use('/api/approval-chains', require('./routes/approval-chains'));
app.use('/api/ai-findings', require('./routes/ai-findings'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/customer-payments', require('./routes/customer-payments'));
app.use('/api/supplier-invoices', require('./routes/supplier-invoices'));
app.use('/api/supplier-payments', require('./routes/supplier-payments'));
app.use('/api/fixed-assets', require('./routes/fixed-assets'));
app.use('/api/bank', require('./routes/bank'));
app.use('/api/cost-centers', require('./routes/cost-centers'));
app.use('/api/budgets', require('./routes/budgets'));
app.use('/api/currencies', require('./routes/currencies'));
app.use('/api/hr', require('./routes/hr'));
app.use('/api/accounting-periods', require('./routes/accounting-periods'));
app.use('/api/ai-insights', require('./routes/ai-insights'));
app.use('/api/ai-chat', require('./routes/ai-chat'));
app.use('/api/ai-analytics', require('./routes/ai-analytics'));
app.use('/api/ai-agent', require('./routes/ai-agent'));
app.use('/api/gateway', require('./routes/gateway'));
app.use('/api/ai-intelligence', require('./routes/ai-intelligence'));
app.use('/api/agents', require('./routes/agents'));
// Counterfactual decisions — courses of action measured against the real
// ledger inside a rolled-back transaction. See services/ai/counterfactual/.
app.use('/api/decisions', require('./routes/decisions'));
app.use('/api/ai-tools', require('./routes/ai-tools'));
app.use('/api/ai', require('./routes/ai-builder'));
app.use('/api/ai', require('./routes/ai-mcp'));
// Unauthenticated by design — an OAuth provider redirects a browser here with
// no token. Gated by a single-use, expiring state parameter instead; see the
// file for why that is the right gate rather than a weaker one.
app.use('/api/mcp-oauth', require('./routes/mcp-oauth-callback'));
app.use('/api/connectors', require('./routes/ai-connectors'));
// Also unauthenticated by design — the provider redirects a browser here.
app.use('/api/connector-oauth', require('./routes/connector-oauth-callback'));
app.use('/api/ai-documents', require('./routes/ai-documents'));
app.use('/api/knowledge-base', require('./routes/knowledge-base'));
app.use('/api/pdf-templates', require('./routes/pdf-templates'));
app.use('/api/ai-credentials', require('./routes/ai-credentials'));
app.use('/api/ai-provider', require('./routes/ai-provider'));
app.use('/api/ai-settings', require('./routes/ai-settings'));
app.use('/api/manufacturing', require('./routes/manufacturing'));
app.use('/api/delivery-risk', require('./routes/delivery-risk'));
app.use('/api/what-matters', require('./routes/what-matters'));
app.use('/api/supplier-risk', require('./routes/supplier-risk'));
app.use('/api/process-flow', require('./routes/process-flow'));
app.use('/api/people-coverage', require('./routes/people-coverage'));
app.use('/api/runs-on', require('./routes/runs-on'));
app.use('/api/warehouse-twin', require('./routes/warehouse-twin'));
app.use('/api/decisions-held-open', require('./routes/decisions-held-open'));
app.use('/api/companies', require('./routes/companies'));

// ---------------------------------------------------------------------------
// The application platform.
//
// Four mounts, and the split between them is the security model:
//
//   /platform/applications  the catalogue, versions and deployments (auth'd)
//   /platform/marketplace   applications one company built, offered to the
//                           rest. Browsing is open; publishing and installing
//                           are ADMIN.
//   /platform/shell         the operating system's own screens: the company
//                           home, and the cross-application inbox
//   /platform/apps-directory  every application this company runs — built-in
//                           and built-here — and the one switch that turns
//                           either kind off. Also composes the home page.
//   /platform/studio        designing and changing applications (ADMIN)
//   /platform/apps          the generic runtime, internal side (auth'd)
//   /platform/portal        the generic runtime, external side — its OWN
//                           authentication, because a portal account is not a
//                           `users` row and must never be reachable by code
//                           that assumes one is
//   /platform/portal-identities  administering those accounts (ADMIN)
//   /platform/opportunities Capability Discovery, which proposes and never
//                           deploys
// ---------------------------------------------------------------------------
app.use('/api/platform/applications', require('./routes/platform/applications'));
app.use('/api/platform/apps-directory', require('./routes/platform/directory'));
app.use('/api/platform/shell', require('./routes/platform/shell'));
app.use('/api/platform/marketplace', require('./routes/platform/marketplace'));
app.use('/api/platform/studio', require('./routes/platform/studio'));
app.use('/api/platform/apps', require('./routes/platform/apps'));
app.use('/api/platform/portal-identities', require('./routes/platform/identities'));
app.use('/api/platform/portal', require('./routes/platform/portal'));
app.use('/api/platform/opportunities', require('./routes/platform/opportunities'));
app.use('/api/mailboxes', require('./routes/mailboxes'));
app.use('/api/mail-branding', require('./routes/mailBranding'));
// Admin-only application statistics (business volume, AI spend, request
// counters). Distinct from /metrics, which is the unauthenticated Prometheus
// scrape endpoint for machines — this is the same picture rendered for a human
// inside the product, behind the normal auth stack.
app.use('/api/app-stats', require('./routes/app-stats'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/crm', require('./routes/crm'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/modules', require('./routes/modules'));
// Per-module AI analysis endpoints. Mounted at /api/ai-modules because that is
// the path the frontend already calls (WarehouseTransactions.jsx); the router
// file existed but was never mounted, so every one of those calls 404'd.
app.use('/api/ai-modules', require('./routes/ai-modules'));
// Business-type-driven feature toggles (migration 202608071500) — distinct
// from /api/modules above, which is an unrelated schema-discovery API.
app.use('/api/company-modules', require('./routes/companyModules'));

// Serve the built frontend from this same process, when it is present.
//
// Only single-container deployments need this. Cloud Run gives you exactly one
// container per service, so the nginx + frontend + backend split that
// docker-compose.yml uses has nowhere to live there; the root Dockerfile builds
// the SPA and drops it here instead. In compose (and in dev, where Vite serves
// the app itself) SERVE_STATIC is unset and this whole block is skipped, so the
// existing topology is unaffected.
//
// Mounted after every /api route and before the 404 handler, so an unknown
// /api/* path still returns the JSON 404 rather than being answered with
// index.html — a mistyped endpoint returning 200 and a page of HTML is a
// genuinely awful thing to debug from the client side.
const SERVE_STATIC = process.env.SERVE_STATIC === 'true';
if (SERVE_STATIC) {
  const fs = require('fs');
  const staticRoot = process.env.STATIC_ROOT || path.join(__dirname, 'public');

  if (!fs.existsSync(path.join(staticRoot, 'index.html'))) {
    // Fail loudly at boot rather than serving 404s for every page load. A
    // container that starts "successfully" and then cannot serve the app is
    // worse than one that refuses to start.
    console.error(`SERVE_STATIC=true but no index.html under ${staticRoot}`);
    process.exit(1);
  }

  // Hashed assets are immutable and safe to cache hard; index.html must not be,
  // or a returning browser keeps booting the previous deploy's JS.
  app.use(express.static(staticRoot, { index: false, maxAge: '1y', etag: true }));

  app.get(/^(?!\/(api|health|metrics)(\/|$)).*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(staticRoot, 'index.html'));
  });
}

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Terminal error handler. Reached by anything calling next(err) — including
// every handler wrapped in asyncHandler — and it translates Postgres error
// codes into messages that tell the reader what to change. See
// middleware/errorHandler.js.
app.use(errorHandler);

// Graceful shutdown.
//
// 1. server.close() makes the HTTP server stop ACCEPTING new connections
//    immediately, while letting in-flight requests finish and calling back
//    once every connection has closed on its own.
// 2. A 5s watchdog force-exits if that callback never fires -- a request
//    stuck on a slow query or a hung upstream AI call must not block a
//    deploy/restart forever.
// 3. The DB pool is closed either way, so a forced exit doesn't leave
//    dangling connections at the database.
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000;
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down gracefully`);

  const forceExit = setTimeout(() => {
    console.error(`Graceful shutdown did not finish within ${GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms — forcing exit.`);
    require('./config/database').pool.end().finally(() => process.exit(1));
  }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close(async () => {
    console.log('HTTP server closed — no more in-flight requests.');
    clearTimeout(forceExit);
    try {
      await require('./config/database').pool.end();
      console.log('Database pool closed.');
    } catch (err) {
      console.error('Error closing database pool:', err.message);
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const server = app.listen(PORT, async () => {
  console.log(`🚀 Simeli ERP Inventory API running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);

  // An AI provider key the platform owner set in Settings → AI replaces the environment's (providerKey.js).
  try { await require('./services/ai/providerKey').load(); } catch (err) { console.error('⚠️  AI provider key not loaded:', err.message); }

  // Autonomous agents. syncDefinitions only registers what exists in code — it
  // never enables anything, so a deploy cannot silently start an agent acting.
  // The scheduler itself is gated on AGENT_SCHEDULER_ENABLED, so unattended
  // execution is opt-in per environment rather than a property of running the
  // server.
  try {
    const agents = require('./services/agents');
    // syncDefinitions() INSERTs into agent_definitions, which is company-scoped
    // (migration 140) — under isolation, an INSERT with no ambient company
    // context fails WITH CHECK outright (current_company_id() is NULL here;
    // boot runs before any request, so nothing has set it). forEachCompany
    // establishes that context per company and is a no-op wrapper — safe
    // whether isolation is on or off — the same pattern the schedulers use.
    const { forEachCompany } = require('./services/companyContext');
    await forEachCompany(() => agents.syncDefinitions());
    const started = agents.startScheduler();
    if (!started.started) {
      console.log(`🤖 Agent scheduler idle (${started.reason}) — agents run only when triggered manually.`);
    }
  } catch (err) {
    // A problem in the agent layer must never stop the API from serving.
    console.error('⚠️  Agent runtime failed to initialise:', err.message);
  }

  // Scheduled automations declared by generated applications — "chase anything
  // overdue", and whatever else an application asked for. Gated on
  // PLATFORM_SCHEDULER_ENABLED for exactly the reason the two below are: the
  // actions it dispatches notify people, and starting a server should not.
  try {
    const started = require('./services/platform/scheduler').startScheduler();
    if (!started.started) {
      console.log(`🧩 Application scheduler idle (${started.reason}) — scheduled automations run only on request.`);
    }
  } catch (err) {
    console.error('⚠️  Application scheduler failed to initialise:', err.message);
  }

  // Simeli's watch: runs the brief as each person every few minutes and tells them what is new or worse.
  // It reads and notifies in-app; it changes no business record. Off with SIMELI_WATCH_ENABLED=false.
  try {
    const started = require('./services/simeliWatch').startWatch();
    if (!started.started) console.log(`👁️  Simeli watch idle (${started.reason}) — the brief runs only when asked.`);
  } catch (err) {
    console.error('⚠️  Simeli watch failed to initialise:', err.message);
  }

  // Scheduled report distribution. Gated on REPORT_SCHEDULER_ENABLED for the
  // same reason as the agents: starting the server should not begin emailing
  // people, least of all from a developer's machine pointed at real data.
  try {
    const started = require('./services/reportScheduler').startScheduler();
    if (!started.started) {
      console.log(`📈 Report scheduler idle (${started.reason}) — reports run only on request.`);
    }
  } catch (err) {
    console.error('⚠️  Report scheduler failed to initialise:', err.message);
  }
});