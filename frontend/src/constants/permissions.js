/**
 * Who may see what — the frontend's mirror of the server's authorisation rules.
 *
 * ===========================================================================
 * THIS IS A MIRROR, NOT A CONTROL
 * ===========================================================================
 * The server decides. Everything here exists so the UI does not offer people
 * doors that will slam in their face, and so it does not hide doors that are
 * actually open to them. Both failures are real:
 *
 *   • Too strict — ProtectedRoute used to rank roles on a USER/MANAGER/ADMIN
 *     ladder, so ACCOUNTANT, FINANCE_USER and FINANCE_MANAGER (all issued by
 *     backend/middleware/auth.js) scored below USER and were refused routes the
 *     API would have served them. The lockout existed only in the browser.
 *
 *   • Too loose — the sidebar showed every module to everyone, so a warehouse
 *     clerk browsed to Payroll, waited for a spinner, and got a 403. That is a
 *     worse experience than never seeing the link, and it leaks the shape of
 *     the organisation to people who have no business seeing it.
 *
 * A LADDER CANNOT EXPRESS THESE RULES
 * ===========================================================================
 * "MANAGER or ADMIN" and "FINANCE_MANAGER, MANAGER or ADMIN" are different
 * sets, and no single ranking produces both — put FINANCE_MANAGER above
 * MANAGER and it wrongly gains procurement approval; put it below and it
 * wrongly loses the finance screens it is named for. So each requirement names
 * the roles that satisfy it, exactly as the server's middleware does.
 *
 * Keep in step with backend/middleware/auth.js (requireRole and friends) and
 * backend/middleware/rbac.js (PERMISSION_MATRIX).
 */

export const ROLES = {
  USER: 'USER',
  ACCOUNTANT: 'ACCOUNTANT',
  FINANCE_USER: 'FINANCE_USER',
  FINANCE_MANAGER: 'FINANCE_MANAGER',
  MANAGER: 'MANAGER',
  ADMIN: 'ADMIN',
};

/**
 * requiredRole → the set of roles that satisfy it.
 * Each entry corresponds to one middleware in backend/middleware/auth.js.
 */
export const ROLE_GRANTS = {
  // requireRole('ADMIN')
  ADMIN: [ROLES.ADMIN],

  // requireManagerOrAdmin — deliberately excludes the finance roles. Approving
  // a purchase requisition is not a finance duty in this system.
  MANAGER: [ROLES.MANAGER, ROLES.ADMIN],

  // requireFinanceManager
  FINANCE_MANAGER: [ROLES.FINANCE_MANAGER, ROLES.MANAGER, ROLES.ADMIN],

  // requireFinanceUser
  FINANCE_USER: [
    ROLES.FINANCE_USER, ROLES.FINANCE_MANAGER, ROLES.ACCOUNTANT,
    ROLES.MANAGER, ROLES.ADMIN,
  ],

  // Any authenticated identity.
  USER: Object.values(ROLES),
};

/**
 * Does `role` satisfy `requiredRole`?
 *
 * An unrecognised requirement resolves to ADMIN-only. A typo in a route
 * definition should over-restrict and be noticed, never quietly open a screen
 * to everybody.
 */
export function roleSatisfies(role, requiredRole) {
  if (!requiredRole) return true;
  if (!role) return false;
  const granted = ROLE_GRANTS[requiredRole] || ROLE_GRANTS.ADMIN;
  return granted.includes(role);
}

/**
 * Navigation visibility, by functional area.
 *
 * Coarser than the route guards on purpose: a menu is about whether a whole
 * area is any of your business, while a route guard is about one action. An
 * area with no entry here is visible to every signed-in user — the safe
 * default for a menu, since the routes behind it still enforce their own rules.
 */
export const NAV_VISIBILITY = {
  finance: ROLE_GRANTS.FINANCE_USER,
  hr: [ROLES.ADMIN, ROLES.MANAGER, ROLES.FINANCE_MANAGER],
  admin: [ROLES.ADMIN],
  ai: Object.values(ROLES),
  approvals: [ROLES.ADMIN, ROLES.MANAGER, ROLES.FINANCE_MANAGER],
};

export function canSeeArea(role, area) {
  if (!area) return true;
  const allowed = NAV_VISIBILITY[area];
  if (!allowed) return true;
  return !!role && allowed.includes(role);
}
