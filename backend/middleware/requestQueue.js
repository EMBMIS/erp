const rateLimit = require('express-rate-limit');

// Advanced request queuing middleware for high-traffic scenarios
class RequestQueue {
  constructor() {
    this.queue = [];
    this.processing = 0;
    this.maxConcurrent = 15; // Max concurrent requests
    this.maxQueue = 100; // Max queued requests
  }

  async process(req, res, next) {
    return new Promise((resolve, reject) => {
      // If under limit, process immediately
      if (this.processing < this.maxConcurrent) {
        this.processing++;
        this.executeRequest(req, res, next, resolve, reject);
        return;
      }

      // Queue the request if within queue limit
      if (this.queue.length < this.maxQueue) {
        this.queue.push({ req, res, next, resolve, reject });

        // Log queue status for monitoring
        if (this.queue.length > 10) {
          console.warn(`📊 Request queue: ${this.queue.length} waiting, ${this.processing} processing`);
        }
      } else {
        // Queue full - reject request
        res.status(503).json({
          error: 'Server busy, please try again',
          queueFull: true,
          waiting: this.queue.length
        });
        reject(new Error('Queue full'));
      }
    });
  }

  async executeRequest(req, res, next, resolve, reject) {
    try {
      // Execute the actual request
      next();
      resolve();
    } catch (error) {
      reject(error);
    } finally {
      // Request completed, process next in queue
      this.processing--;
      this.processNext();
    }
  }

  processNext() {
    if (this.queue.length > 0 && this.processing < this.maxConcurrent) {
      const { req, res, next, resolve, reject } = this.queue.shift();
      this.processing++;
      setImmediate(() => {
        this.executeRequest(req, res, next, resolve, reject);
      });
    }
  }

  getStats() {
    return {
      processing: this.processing,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueue: this.maxQueue
    };
  }
}

const requestQueue = new RequestQueue();

// Middleware function
const queueMiddleware = async (req, res, next) => {
  try {
    await requestQueue.process(req, res, next);
  } catch (error) {
    console.error('Request queue error:', error.message);
  }
};

// Who a request counts against. This limiter is mounted on /api before any
// route's auth middleware runs, so req.user and req.companyId are never set
// here: keying on them always fell through to req.ip. Behind the reverse proxy
// (Caddy, then Docker) every visitor arrived from the same address, so the
// whole platform shared one 200-a-minute allowance, and a handful of people
// clicking around got every request refused with 429 and were logged out.
// A signed-in user now has an allowance of their own, read from their token
// (verified, so a forged token cannot mint fresh allowances); anyone else
// counts against their real address (server.js sets `trust proxy`).
const jwt = require('jsonwebtoken');
function rateLimitKey(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ') && process.env.JWT_SECRET) {
    try {
      const claims = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      const id = claims.userId || claims.id || claims.sub;
      if (id) return `user:${id}`;
    } catch {
      // invalid or expired token: count it against the address
    }
  }
  return `ip:${req.ip}`;
}

// Enhanced rate limiting for high-traffic endpoints (key by user, else by address)
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  // One page can make 20-40 calls; 600 a minute per user leaves room for fast navigation. API_RATE_LIMIT_MAX overrides.
  max: Number(process.env.API_RATE_LIMIT_MAX) || 600,
  keyGenerator: rateLimitKey,
  message: {
    error: 'Too many requests',
    retryAfter: '1 minute'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limiting for heavy endpoints
const heavyApiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 50, // 50 requests per minute for heavy endpoints
  keyGenerator: rateLimitKey,
  message: {
    error: 'Rate limit exceeded for resource-intensive endpoint',
    retryAfter: '1 minute'
  }
});

module.exports = {
  queueMiddleware,
  apiLimiter,
  heavyApiLimiter,
  getQueueStats: () => requestQueue.getStats()
};