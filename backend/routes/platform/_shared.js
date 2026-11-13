/**
 * Shared plumbing for the platform routes.
 *
 * The one rule these helpers exist to enforce: a route never decides who the
 * caller is or what company they act for. `req.companyId` is established by the
 * auth middleware from the session and the user's company memberships; every
 * handler below reads it and none of them accepts it from the request body.
 */

const { AuthorizationError } = require('../../services/platform/runtime/authorization');
const { ResolutionError } = require('../../services/platform/runtime/resolver');
const { DataError } = require('../../services/platform/runtime/data');
const { WorkflowError } = require('../../services/platform/runtime/workflow');
const { DeploymentError } = require('../../services/platform/deployer');
const { RegistryError } = require('../../services/platform/registry');
const { SessionError } = require('../../services/platform/studio/session');
const { IterationError } = require('../../services/platform/studio/iterate');
const { IdentityError } = require('../../services/platform/runtime/externalIdentity');
const { CollaborationError } = require('../../services/platform/runtime/collaboration');
const { AnalyticsError } = require('../../services/platform/runtime/analytics');
const { IdentifierError } = require('../../services/platform/identifiers');
const { ExpressionError } = require('../../services/platform/spec/expressions');
const { DirectoryError } = require('../../services/platform/appDirectory');
const { SummaryError } = require('../../services/platform/native/summary');
const { PreferenceError } = require('../../services/platform/shellPreferences');
const { MarketplaceError } = require('../../services/platform/marketplace');

const KNOWN_ERRORS = [
  AuthorizationError, ResolutionError, DataError, WorkflowError, DeploymentError,
  RegistryError, SessionError, IterationError, IdentityError, CollaborationError,
  AnalyticsError, IdentifierError, ExpressionError, DirectoryError, SummaryError, PreferenceError, MarketplaceError,
];

/**
 * Wrap an async handler so a thrown platform error becomes the right status and
 * a readable message, and anything else becomes a 500 that says nothing.
 *
 * The distinction matters: platform errors are written for the person who will
 * read them ("Your role cannot close a finding you raised yourself"), while an
 * unexpected error may contain a table name or a constraint, which is not the
 * caller's business.
 */
function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      const known = KNOWN_ERRORS.some((E) => error instanceof E);
      if (known) {
        return res.status(error.status || 400).json({
          success: false,
          error: error.message,
          code: error.code || 'PLATFORM_ERROR',
          detail: error.detail || null,
        });
      }
      console.error('[platform]', req.method, req.originalUrl, error);
      return res.status(500).json({
        success: false,
        error: 'Something went wrong handling that request.',
        code: 'INTERNAL_ERROR',
      });
    }
  };
}

/** Only an administrator may design, deploy or configure applications. */
function requireAdmin(req, res, next) {
  const role = String(req.user?.role || '').toUpperCase();
  if (role !== 'ADMIN' && !req.user?.isSystemUser) {
    return res.status(403).json({
      success: false,
      error: 'Only an administrator can create or change applications.',
      code: 'ADMIN_REQUIRED',
    });
  }
  return next();
}

const companyOf = (req) => req.companyId;
const userOf = (req) => (req.user?.id && !req.user.isApiKey && req.user.id !== 'ai-system' ? req.user.id : null);

module.exports = { handler, requireAdmin, companyOf, userOf };
