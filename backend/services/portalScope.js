/**
 * Company context for PUBLIC, token-authenticated portal requests.
 *
 * Every other request learns its company from the caller's session. A portal
 * request has none — a customer confirming a delivery or a supplier answering
 * an RFQ is not a user of the system, and the token in the URL is the entire
 * credential. Under row-level isolation that left these endpoints reading from
 * an empty database: the RLS policy compares company_id to a setting nobody
 * set, so a perfectly valid token returned 404.
 *
 * `withPortalToken` closes exactly that gap. It asks the database which company
 * the token belongs to (portal_company_for_token, migration 202608130200 — a
 * SECURITY DEFINER function that returns a company id and nothing else), then
 * runs the endpoint's own queries inside that company's context. The endpoint's
 * SQL is unchanged and still filters by the token, so the token remains the
 * thing that authorizes the read; this only tells the connection which tenant
 * to look in.
 */

const { pool } = require('../config/database');
const { runWithCompany } = require('./companyScope');

/**
 * Scopes accepted by portal_company_for_token. Kept here as well so a typo in
 * a route fails loudly in JavaScript instead of silently resolving to NULL and
 * looking like an expired token.
 */
const PORTAL_SCOPES = Object.freeze([
  'customer_delivery',
  'customer_order',
  'customer_quotation',
  'customer_contract',
  'supplier_delivery',
  'supplier_rfq',
  'supplier_item',
]);

/**
 * Resolve `token`'s company and run `fn` inside it.
 *
 * @param {string} scope - one of PORTAL_SCOPES
 * @param {string} token - the token from the URL
 * @param {() => Promise<any>} fn - the endpoint's normal work
 * @returns {Promise<any>} whatever `fn` returns
 *
 * When the token matches nothing the callback still runs, with no company
 * context — the endpoint's own query then finds no row and returns its usual
 * "not found or already processed" response. Unknown tokens and expired ones
 * therefore look identical from outside, which is what you want: a caller
 * cannot use the difference to learn that a token once existed.
 */
async function withPortalToken(scope, token, fn) {
  if (!PORTAL_SCOPES.includes(scope)) {
    throw new Error(`Unknown portal scope: ${scope}`);
  }

  let companyId = null;
  try {
    const { rows } = await pool.query('SELECT portal_company_for_token($1, $2) AS company_id', [scope, token]);
    companyId = rows[0]?.company_id || null;
  } catch (err) {
    // A database without the migration (or with isolation off) must not take
    // the portal down — fall through with no company, which is exactly how
    // these endpoints behaved before isolation existed.
    console.error(`[portalScope] token company lookup failed for ${scope}:`, err.message);
  }

  if (!companyId) return fn();
  return runWithCompany(companyId, fn);
}

/**
 * Express middleware form: `router.get('/x/:token', portalCompany('customer_order'), handler)`.
 *
 * `next()` is called from inside the company context, so every async step the
 * handler starts inherits it — including the transactions it opens through
 * pool.connect(), which is where config/database.js applies the SET LOCAL.
 * Handlers need no changes.
 */
function portalCompany(scope, pick = (req) => req.params.token) {
  return async (req, res, next) => {
    try {
      await withPortalToken(scope, pick(req), async () => { next(); });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * The same thing for the supplier RFQ link, whose credential is a SIGNED JWT
 * carrying the RFQ id rather than a token stored in a column.
 *
 * The token is verified here before anything is looked up, so a caller who has
 * not been issued a link gets no further than they did before. A token that
 * does not verify is deliberately NOT rejected here — it is passed through so
 * the handler produces its own "invalid or expired token" response, and this
 * middleware never changes what the endpoint says.
 */
function portalCompanyForRfq(pick = (req) => req.params.token) {
  return async (req, res, next) => {
    let companyId = null;
    try {
      const emailService = require('./emailService');
      const claims = emailService.verifySupplierToken(pick(req));
      if (claims?.rfqId) {
        const { rows } = await pool.query('SELECT portal_company_for_rfq($1::uuid) AS company_id', [claims.rfqId]);
        companyId = rows[0]?.company_id || null;
      }
    } catch {
      // Bad, expired or absent token — the handler will say so.
    }

    if (!companyId) return next();
    try {
      await runWithCompany(companyId, async () => { next(); });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { withPortalToken, portalCompany, portalCompanyForRfq, PORTAL_SCOPES };
