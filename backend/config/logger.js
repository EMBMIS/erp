/**
 * Structured (JSON) logging, replacing the previous console.log/morgan-only
 * setup. A line like `console.log('Error posting cash payment:', error)`
 * cannot be queried, filtered by severity, or correlated to a request in any
 * log aggregation tool — it's just text. pino emits one JSON object per line
 * with a consistent shape (level, time, msg, and whatever fields are passed),
 * which is what makes "why was last Tuesday slow" an answerable question
 * instead of a grep-and-guess exercise.
 *
 * This module is additive: existing `console.*` call sites across the
 * codebase are unchanged and still work. New code, and the request/response
 * logging wired in server.js, should use this instead.
 */
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  redact: {
    // Never let a logged request/error carry a bearer token or password into
    // the log stream, even by accident (e.g. someone logging `req.headers`).
    paths: [
      'req.headers.authorization',
      '*.password',
      '*.password_hash',
      '*.token',
    ],
    censor: '[redacted]',
  },
});

module.exports = logger;
