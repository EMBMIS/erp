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

// Enhanced rate limiting for high-traffic endpoints (key by tenant or IP)
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: Number(process.env.API_RATE_LIMIT_MAX) || 200, // 200/min per tenant/IP; E2E/CI raise via API_RATE_LIMIT_MAX
  keyGenerator: (req) => req.user?.companyId || req.companyId || req.ip,
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
  keyGenerator: (req) => req.user?.companyId || req.companyId || req.ip,
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