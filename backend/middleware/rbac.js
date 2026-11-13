/**
 * Permissions and Segregation of Duties.
 *
 * ===========================================================================
 * THIS FILE USED TO BE DEAD CODE
 * ===========================================================================
 * `checkPermission` was referenced by zero routes and `checkSoD` by zero call
 * sites. A permission matrix nothing consults and a segregation-of-duties check
 * nothing calls are worse than absent: they read, to anyone auditing the
 * codebase, as controls that exist. The SoD one especially — "user cannot
 * approve an entity they created" is the single control most likely to be
 * asked about in a review of a system with a delegation-of-authority module,
 * and this system enforced it nowhere.
 *
 * It also invented a role. `PERMISSION_MATRIX` had an `ACCOUNTANT` tier, but
 * the users table permits only ADMIN, MANAGER, USER, FINANCE_MANAGER and
 * FINANCE_USER (migrations 003 and 088). No account could ever hold
 * ACCOUNTANT, so that row governed nobody, while the two finance roles that do
 * exist fell through to `[]` and were denied everything this file was asked
 * about.
 *
 * Both are fixed here: the vocabulary now matches the database, and the checks
 * are wired into the routes that need them.
 */

const { AppError } = require('./errorHandler');
const { isPlatformOwner } = require('./auth');

// The roles the database actually permits. Keep in step with the CHECK
// constraint on users.role (migration 088) and with
// frontend/src/constants/permissions.js.
const ROLES = ['ADMIN', 'MANAGER', 'FINANCE_MANAGER', 'FINANCE_USER', 'USER'];

const PERMISSION_MATRIX = {
  ADMIN: ['*'],

  MANAGER: [
    'FINANCE_READ', 'FINANCE_WRITE', 'FINANCE_APPROVE',
    'SALES_READ', 'SALES_WRITE', 'SALES_APPROVE',
    'PROCUREMENT_READ', 'PROCUREMENT_WRITE', 'PROCUREMENT_APPROVE',
    'MANUFACTURING_READ', 'MANUFACTURING_WRITE', 'MANUFACTURING_EXECUTE',
    'INVENTORY_READ', 'INVENTORY_WRITE',
    'AI_READ', 'AI_EXECUTE',
  ],

  // Finance authority, but no authority over what the company buys or sells.
  // That boundary is the point: whoever approves the payment should not also
  // be the one who chose the supplier.
  FINANCE_MANAGER: [
    'FINANCE_READ', 'FINANCE_WRITE', 'FINANCE_APPROVE',
    'SALES_READ', 'PROCUREMENT_READ', 'INVENTORY_READ',
    'AI_READ', 'AI_EXECUTE',
  ],

  FINANCE_USER: [
    'FINANCE_READ', 'FINANCE_WRITE',
    'SALES_READ', 'PROCUREMENT_READ', 'INVENTORY_READ',
    'AI_READ',
  ],

  USER: [
    'SALES_READ', 'PROCUREMENT_READ', 'MANUFACTURING_READ', 'INVENTORY_READ',
    'AI_READ',
  ],
};

function hasPermission(role, permission) {
  const permissions = PERMISSION_MATRIX[role] || [];
  return permissions.includes('*') || permissions.includes(permission);
}

/** Express middleware requiring one named permission. */
function checkPermission(requiredPermission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }
    if (hasPermission(req.user.role || 'USER', requiredPermission)) {
      return next();
    }
    return res.status(403).json({
      success: false,
      error: `Your role (${req.user.role || 'USER'}) does not carry the ${requiredPermission} permission.`,
      expose: true,
    });
  };
}

/**
 * Segregation of Duties: nobody approves their own work.
 *
 * The control exists because the alternative is that one person can raise a
 * purchase requisition to a supplier they control, approve it themselves, and
 * receipt it — the textbook fraud this module is named for. It is also the
 * thing every auditor asks about first in a system that has a
 * delegation-of-authority module, which this one does.
 *
 * ADMIN is deliberately NOT exempt. An exemption for the most privileged role
 * is an exemption for exactly the account an attacker wants, and "the admin
 * needed to approve their own thing" is a process problem with a process
 * answer — have someone else approve it. The single exception is the platform
 * owner (the deployment's creator admin), which is an identity, not a role;
 * that exemption lives in the async callers (`requireSoD` middleware,
 * services/authority.js, models/PurchaseOrder.js), so this pure check stays
 * role-agnostic and DB-free.
 *
 * Throws AppError(403), so the message reaches the user as written rather than
 * being flattened into a generic failure.
 *
 * @param {string} creatorId    who created the record
 * @param {string} approverId   who is trying to approve it
 * @param {string} [actionName] what they are trying to do, for the message
 */
function checkSoD(creatorId, approverId, actionName = 'approval') {
  if (creatorId && approverId && String(creatorId) === String(approverId)) {
    throw new AppError(
      `Segregation of duties: you raised this record, so you cannot perform its ${actionName}. `
      + 'Someone else with the necessary authority has to.',
      403
    );
  }
}

/**
 * Middleware form, for routes whose record is loaded by a lookup.
 *
 * The ONE exemption is the platform owner — the deployment's creator admin
 * (first account to sign up, or PLATFORM_OWNER_EMAIL). Ownership is an
 * identity, not a role: no other ADMIN is exempt, and the exemption cannot
 * be granted by changing a role. The owner runs the deployment and is
 * expected to be able to approve their own submitted operations; every other
 * account keeps the four-eyes rule intact.
 *
 * @param {(req) => Promise<string|null>} getCreatorId resolves the record's author
 * @param {string} [actionName]
 */
function requireSoD(getCreatorId, actionName = 'approval') {
  return async (req, res, next) => {
    try {
      if (isPlatformOwner(req.user)) {
        return next();
      }
      const creatorId = await getCreatorId(req);
      checkSoD(creatorId, req.user?.id, actionName);
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = {
  ROLES,
  PERMISSION_MATRIX,
  hasPermission,
  checkPermission,
  checkSoD,
  requireSoD,
};
