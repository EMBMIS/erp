import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { roleSatisfies } from '../constants/permissions'
import { useI18n } from '../contexts/I18nContext'

/**
 * @param requiredRole  a tenant role (ADMIN, MANAGER, …)
 * @param ownerOnly     restrict to the platform owner — the operator of this
 *                      deployment, not an administrator of one tenant inside
 *                      it. Separate from requiredRole because it is not a role
 *                      at all: the server derives it from PLATFORM_OWNER_EMAIL,
 *                      so no amount of role assignment inside the product grants
 *                      it. Purely a UI courtesy — the endpoint re-checks.
 */
function ProtectedRoute({ children, requiredRole = null, ownerOnly = false }) {
  const { t } = useI18n()
  const { user, loading, isAuthenticated } = useAuth()
  const location = useLocation()

  // Show loading spinner while checking authentication
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">{t('ui.loading')}</p>
        </div>
      </div>
    )
  }

  // Redirect to login if not authenticated
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  // Platform-owner gate. Checked before the role gate because it is stricter
  // and unrelated: an ADMIN passes roleSatisfies and still must not be here.
  if (ownerOnly && !user?.is_platform_owner) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center max-w-md px-6">
          <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100">
            <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 15.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h3 className="mt-2 text-sm font-medium text-gray-900">{t('ui.accessDenied')}</h3>
          {/* Deliberately does not say "ask your administrator" — no
              administrator can grant this. It is set in the server's
              environment, so the only useful next step is to stop asking. */}
          <p className="mt-1 text-sm text-gray-500">
            This page is restricted to the platform owner.
          </p>
          <div className="mt-6">
            <button
              onClick={() => window.history.back()}
              className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
            >
              {t('ui.goBack')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Check role-based access against the same grants the server enforces.
  if (!roleSatisfies(user?.role, requiredRole)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center max-w-md px-6">
          <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100">
            <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 15.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h3 className="mt-2 text-sm font-medium text-gray-900">{t('ui.accessDenied')}</h3>
          {/* Say which role is needed and which one they hold. "You don't have
              permission" gives someone nothing to act on; this tells them
              exactly what to ask their administrator for. */}
          <p className="mt-1 text-sm text-gray-500">
           {t('ui.thisPageIsRestrictedToThe')} <span className="font-semibold">{requiredRole}</span> {t('ui.roleYourAccountHasThe')} <span className="font-semibold">{user?.role || 'unknown'}</span> {t('ui.role')}
          </p>
          <div className="mt-6">
            <button
              onClick={() => window.history.back()}
              className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
            >
             {t('ui.goBack')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return children
}

export default ProtectedRoute