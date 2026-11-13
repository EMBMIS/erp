/**
 * The internal side of every generated application.
 *
 * Mounted at /api/platform/apps. The principal is an employee: roles from
 * app_role_assignments (with the company-ADMIN fallback), no anchor, and the
 * surface they name — refused if none of their roles reaches it.
 */

const { auth } = require('../../middleware/auth');
const { runtimeRouter } = require('./runtimeRouter');
const authz = require('../../services/platform/runtime/authorization');

const router = require('express').Router();
router.use(auth);

router.use(runtimeRouter({
  companyFor: (req) => req.companyId,
  principalFor: (req, context) => authz.internalPrincipal({
    companyId: req.companyId,
    instance: context.instance,
    spec: context.spec,
    userId: req.user?.id,
    platformRole: req.user?.role,
    // The surface may be named, but only to CHOOSE among the ones this user's
    // roles already reach. It never grants one.
    surfaceKey: typeof req.query.surface === 'string' ? req.query.surface : null,
  }),
}));

module.exports = router;
