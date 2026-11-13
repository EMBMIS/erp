/**
 * Basic operational metrics, in Prometheus text-exposition format via
 * prom-client. This is what "why was last Tuesday slow" needs on top of
 * structured logs: logs answer "what happened on this one request," metrics
 * answer "what did the whole system look like over time" without having to
 * grep every log line ever written.
 *
 * Kept intentionally small: request counts/durations by route+status, plus
 * prom-client's own default process metrics (heap, event loop lag, GC). Not
 * trying to instrument every internal service call here -- that's a much
 * larger, deliberate effort (see ERP_HONEST_AUDIT.md), not a one-file bolt-on.
 */
const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

/**
 * Express middleware recording every request's duration and outcome.
 * Uses req.route?.path (falls back to the raw path) so /items/:id and
 * /items/:otherId aggregate into one series instead of one per literal id --
 * an unbounded label cardinality is the classic way to quietly wreck a
 * Prometheus instance's memory.
 */
function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = (req.baseUrl || '') + (req.route?.path || req.path || 'unknown');
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    httpRequestDuration.observe(labels, durationSeconds);
    httpRequestsTotal.inc(labels);
  });
  next();
}

module.exports = { register, metricsMiddleware };
