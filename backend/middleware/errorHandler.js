/**
 * Error handling: one place that decides what a client is allowed to be told.
 *
 * ===========================================================================
 * THE PROBLEM
 * ===========================================================================
 * server.js has a global error handler that masks internals in production:
 *
 *     error: process.env.NODE_ENV === 'production'
 *       ? 'Internal server error'
 *       : err.message
 *
 * It has never run. `next(err)` appears zero times across 74 route files.
 * Instead every route ends in its own hand-rolled catch:
 *
 *     } catch (error) {
 *       console.error(...);
 *       res.status(500).json({ success: false, error: error.message });
 *     }
 *
 * — 274 of which send `error.message` straight to the caller. So in production
 * a failing request returns whatever Postgres said: constraint names, column
 * names, table names, sometimes fragments of the offending values. That is a
 * free map of the schema for anyone probing the API, and it is exactly what
 * the handler in server.js was written to prevent.
 *
 * ===========================================================================
 * WHY A RESPONSE FILTER RATHER THAN REWRITING 274 CATCH BLOCKS
 * ===========================================================================
 * Rewriting them is mechanical, touches every route file, and has to be
 * complete to be worth anything — one missed handler and the leak is still
 * there, indistinguishable from before. Worse, it would have to be re-done for
 * every route added afterwards.
 *
 * So the decision moves to the one place every response already passes
 * through. `sanitizeErrors` wraps `res.json` and inspects outgoing 5xx bodies:
 * an internal error becomes a generic message plus a correlation id, while the
 * real text goes to the server log against that id. Routes are unchanged and
 * cannot regress, because they are no longer the ones deciding.
 *
 * WHAT IS NOT TOUCHED
 * ---------------------------------------------------------------------------
 * 4xx bodies pass through untouched. Those messages are written for the user —
 * "Accounting period 2026-03 is closed", "This work centre has 3 open
 * operations" — and blanking them would turn a system that explains itself
 * into one that just says no. The distinction this draws is between a message
 * someone wrote for a person and a message the database wrote for a developer.
 */

const { randomUUID } = require('crypto');

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * An error with an HTTP status and a message intended for the caller.
 *
 * Anything thrown as an AppError is treated as deliberate: its message is
 * shown as written, at any status, because a person chose those words.
 */
class AppError extends Error {
  constructor(message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.expose = true;
    this.details = details;
  }
}

/** 5xx bodies are the ones that carry internals. */
function needsSanitizing(statusCode) {
  return statusCode >= 500;
}

/**
 * Does this message come from Postgres rather than from a person?
 *
 * Status code alone is not enough to tell. Plenty of routes catch a database
 * error and return it at 400 — routes/manufacturing.js does exactly this — so
 * `GET /work-centers/not-a-uuid` answered 400 with
 * `invalid input syntax for type uuid: "not-a-uuid"`. That is a schema detail
 * at a status the 5xx filter deliberately leaves alone.
 *
 * These patterns are the messages Postgres actually emits. Each maps to a
 * replacement that says what the reader can do about it — which the original
 * does not: "violates foreign key constraint fk_po_supplier" names an object
 * the user has never heard of and gives them nothing to change.
 */
const DATABASE_ERROR_PATTERNS = [
  [/invalid input syntax for type uuid/i, 'One of the identifiers in this request is not valid.'],
  [/invalid input syntax for type (\w+)/i, 'One of the values in this request is not in the expected format.'],
  [/duplicate key value violates unique constraint/i, 'That record already exists.'],
  [/violates foreign key constraint/i, 'This is still referenced by other records and cannot be changed or removed.'],
  [/violates not-null constraint/i, 'A required field was missing.'],
  [/violates check constraint/i, 'One of the values is not allowed for this record.'],
  [/(column|relation|function) .* does not exist/i, 'Something went wrong on our side. The problem has been logged.'],
  [/syntax error at or near/i, 'Something went wrong on our side. The problem has been logged.'],
  [/operator does not exist/i, 'Something went wrong on our side. The problem has been logged.'],
  [/out of range for type/i, 'One of the numbers in this request is too large.'],
  [/canceling statement due to statement timeout/i, 'That request took too long and was stopped. Try narrowing it down.'],
];

function humaniseDatabaseError(text) {
  if (typeof text !== 'string') return null;
  for (const [pattern, replacement] of DATABASE_ERROR_PATTERNS) {
    if (pattern.test(text)) return replacement;
  }
  return null;
}

/**
 * Wrap res.json so outgoing internal errors are replaced with a reference.
 *
 * The id is the point: support can find precisely this failure in the log
 * without the caller ever having been shown the underlying text. "Internal
 * server error" on its own is untraceable, which is why people start pasting
 * raw messages back in.
 */
function sanitizeErrors(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function sanitizedJson(body) {
    if (!body || typeof body !== 'object') return originalJson(body);

    // Nothing to do for a body that isn't reporting an error.
    if (body.success !== false && body.error === undefined) {
      return originalJson(body);
    }

    // Deliberately-worded errors are left alone.
    if (body.expose === true) {
      const { expose, ...rest } = body;
      return originalJson(rest);
    }

    // A database message at ANY status, including the 4xx ones routes commonly
    // return from their own catch blocks. Replaced with something actionable,
    // with the original kept in the log against the reference id.
    const humanised = humaniseDatabaseError(body.error);
    if (humanised) {
      const errorId = randomUUID();
      console.error(`[${errorId}] ${req.method} ${req.originalUrl} → ${res.statusCode}:`, body.error);
      return originalJson({ ...body, success: false, error: humanised, error_id: errorId });
    }

    if (!needsSanitizing(res.statusCode)) return originalJson(body);

    const errorId = randomUUID();

    console.error(
      `[${errorId}] ${req.method} ${req.originalUrl} → ${res.statusCode}:`,
      typeof body.error === 'string' ? body.error : JSON.stringify(body.error)
    );

    if (!isProduction()) {
      // Outside production the real message is far more useful than the
      // reference, so send both.
      return originalJson({ ...body, error_id: errorId });
    }

    return originalJson({
      success: false,
      error: 'Something went wrong on our side. The problem has been logged.',
      error_id: errorId,
    });
  };

  next();
}

/**
 * Wrap an async route handler so a rejected promise reaches Express.
 *
 * Without this, an async handler that throws produces an unhandled rejection
 * and a request that hangs until it times out — the client sees nothing at
 * all, which is worse than an error. New routes should use this instead of a
 * hand-rolled try/catch.
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Terminal error handler. Reached by anything that calls `next(err)`.
 *
 * Maps the database's structured errors onto messages that say what the person
 * can do about it. A unique violation means "that already exists", not
 * "duplicate key value violates unique constraint uq_…" — the second sentence
 * names an index the reader has never heard of and does not tell them what to
 * change.
 */
function errorHandler(err, req, res, _next) {
  const errorId = randomUUID();

  console.error(`[${errorId}] ${req.method} ${req.originalUrl}:`, err.stack || err.message);

  if (err instanceof AppError || err.expose) {
    return res.status(err.status || 400).json({
      success: false,
      error: err.message,
      details: err.details,
      expose: true,
    });
  }

  // Postgres error classes worth translating.
  switch (err.code) {
    case '23505': // unique_violation
      return res.status(409).json({
        success: false,
        error: 'That record already exists.',
        expose: true,
      });
    case '23503': // foreign_key_violation
      return res.status(409).json({
        success: false,
        error: 'This is still referenced by other records and cannot be changed or removed.',
        expose: true,
      });
    case '23502': // not_null_violation
      return res.status(400).json({
        success: false,
        error: 'A required field was missing.',
        expose: true,
      });
    case '23514': // check_violation
      return res.status(400).json({
        success: false,
        error: 'One of the values is not allowed for this record.',
        expose: true,
      });
    case '22P02': // invalid_text_representation, usually a malformed uuid
      return res.status(400).json({
        success: false,
        error: 'One of the identifiers in this request is not valid.',
        expose: true,
      });
    case '57014': // query_canceled — statement timeout
      return res.status(503).json({
        success: false,
        error: 'That request took too long and was stopped. Try narrowing it down.',
        expose: true,
      });
    default:
      break;
  }

  const status = err.status || err.statusCode || 500;

  if (status < 500) {
    return res.status(status).json({ success: false, error: err.message, expose: true });
  }

  return res.status(status).json({
    success: false,
    error: isProduction()
      ? 'Something went wrong on our side. The problem has been logged.'
      : err.message,
    error_id: errorId,
  });
}

module.exports = { AppError, asyncHandler, errorHandler, sanitizeErrors };
