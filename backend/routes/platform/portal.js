/**
 * The external side: customer, supplier and partner portals.
 *
 * ===========================================================================
 * A SEPARATE FRONT DOOR, THE SAME ROOMS BEHIND IT
 * ===========================================================================
 * Portal authentication is its own thing — its own identities, its own
 * sessions, its own login route — because a portal account is not a `users`
 * row and must not be reachable by anything that assumes one is.
 *
 * But the application endpoints behind it are the SAME router the internal side
 * mounts. There is no portal-specific list, no portal-specific filter, no
 * second implementation of "only their own records". The principal carries the
 * anchor and the shared code does the rest — which is the only arrangement in
 * which the two sides cannot drift apart.
 *
 * The company a portal request acts for comes from the SESSION, resolved from
 * the token. A portal caller never names a company; there is no header, query
 * parameter or body field that would be read if they did.
 */

const express = require('express');
const router = express.Router();

const { handler } = require('./_shared');
const { runtimeRouter } = require('./runtimeRouter');
const identity = require('../../services/platform/runtime/externalIdentity');
const authz = require('../../services/platform/runtime/authorization');
const companyContext = require('../../services/companyContext');
const { asCompany } = require('../../services/platform/db');

/**
 * Portal authentication.
 *
 * Resolves the bearer token to an identity, then establishes that identity's
 * company as the ambient context for the whole request — the same mechanism
 * the internal auth middleware uses, so row-level security applies identically.
 */
async function portalAuth(req, res, next) {
  const token = req.header('Authorization')?.replace(/^Bearer /i, '')
    || (typeof req.query.portal_token === 'string' ? req.query.portal_token : null);
  if (!token) {
    return res.status(401).json({ success: false, error: 'Sign in to the portal first.', code: 'NO_PORTAL_SESSION' });
  }
  try {
    const resolved = await identity.resolveSession(token);
    if (!resolved) {
      return res.status(401).json({ success: false, error: 'That portal session is no longer valid.', code: 'PORTAL_SESSION_INVALID' });
    }
    req.portalIdentity = resolved;
    req.companyId = resolved.company_id;
    return companyContext.runWithCompany(resolved.company_id, () => next());
  } catch (error) {
    console.error('[portal] session resolution failed:', error.message);
    return res.status(500).json({ success: false, error: 'Could not establish your portal session.', code: 'PORTAL_SESSION_ERROR' });
  }
}

// ---------------------------------------------------------------------------
// Unauthenticated: sign in, accept an invitation.
//
// Both need a company, and a caller outside the company cannot be trusted to
// name one — but they have to identify which company's portal they are using.
// The company code (not its id) is the public handle, matching how the rest of
// the product refers to a company externally.
// ---------------------------------------------------------------------------
async function companyFromCode(code) {
  const { pool } = require('../../config/database');
  // Through the SECURITY DEFINER resolver rather than a direct read: a portal
  // caller has no company context, so the ordinary read would return nothing
  // the moment `companies` is brought under a policy.
  const { rows } = await pool.query('SELECT public.app_portal_company_by_code($1) AS id', [String(code || '').trim()]);
  return rows[0]?.id || null;
}

router.post('/login', handler(async (req, res) => {
  const companyId = await companyFromCode(req.body?.company);
  if (!companyId) {
    // Same answer as a wrong password: an unknown company code must not be
    // distinguishable, or the login form enumerates the customer list.
    return res.status(401).json({
      success: false, error: 'Those details do not match an active portal account.', code: 'AUTH_FAILED',
    });
  }
  const result = await asCompany(companyId, () => identity.authenticate({
    companyId,
    email: req.body?.email,
    password: req.body?.password,
    userAgent: req.header('User-Agent'),
  }));
  const memberships = await asCompany(companyId, () => identity.listMemberships({
    companyId, identityId: result.identity.id,
  }));
  res.json({ success: true, data: { ...result, memberships } });
}));

router.post('/accept-invite', handler(async (req, res) => {
  // The company comes from the TOKEN, not from the form: an invitation link is
  // opened from an email, and asking the recipient to also know a company code
  // is asking them to fail.
  const companyId = await identity.companyForInvite(req.body?.token)
    || await companyFromCode(req.body?.company);
  if (!companyId) {
    return res.status(410).json({ success: false, error: 'That invitation is not valid any more.', code: 'INVITE_INVALID' });
  }
  const result = await asCompany(companyId, () => identity.acceptInvite({
    companyId, token: req.body?.token, password: req.body?.password,
  }));
  res.json({ success: true, data: result });
}));

// ---------------------------------------------------------------------------
// Authenticated portal
// ---------------------------------------------------------------------------
router.use(portalAuth);

router.post('/logout', handler(async (req, res) => {
  const token = req.header('Authorization')?.replace(/^Bearer /i, '');
  await identity.endSession(token);
  res.json({ success: true });
}));

/** Who am I, and which applications can I open? */
router.get('/me', handler(async (req, res) => {
  const memberships = await identity.listMemberships({
    companyId: req.companyId, identityId: req.portalIdentity.id,
  });
  res.json({
    success: true,
    data: {
      identity: identity.redact(req.portalIdentity),
      applications: memberships.filter((m) => m.status === 'active').map((m) => ({
        appKey: m.app_key, name: m.application_name, surface: m.surface_key, role: m.role_key,
      })),
    },
  });
}));

router.use('/apps', runtimeRouter({
  companyFor: (req) => req.companyId,
  principalFor: async (req, context) => {
    // The surface comes from the membership, not from the request. A portal
    // caller naming a surface can only pick among the ones they hold.
    const requested = typeof req.query.surface === 'string' ? req.query.surface : null;
    return authz.externalPrincipal({
      companyId: req.companyId,
      instance: context.instance,
      spec: context.spec,
      identity: req.portalIdentity,
      surfaceKey: requested,
    });
  },
}));

module.exports = router;
