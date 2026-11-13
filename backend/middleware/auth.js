const jwt = require('jsonwebtoken')
const User = require('../models/User')
const companyContext = require('../services/companyContext')

/**
 * Establish which company this request acts for, then continue.
 *
 * Every authenticated exit from `auth` goes through here rather than calling
 * next() directly. Company context is the input to the database's row-level
 * isolation, so a path that authenticates without establishing it would, under
 * multi-company, either see nothing or — far worse if the fallback were
 * permissive — see everything. Making this the single exit means a new
 * authentication path cannot forget it.
 *
 * A request that names a company it may not act for is refused rather than
 * quietly downgraded to the default; silently serving a different company's
 * data than the one asked for is its own kind of wrong answer.
 */
const establishCompany = async (req, res, next) => {
  try {
    const requested = req.header('X-Company-Id')

    if (requested) {
      const allowed = await companyContext.userCanAccess(req.user?.id, requested)
      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: 'You do not have access to that company.'
        })
      }
      req.companyId = requested
    } else if (req.user?.isApiKey) {
      // An API key carries its own company scope. It has no user_companies rows
      // — req.user.id is the synthetic string `api-key-<uuid>`, not a real user
      // — so resolving it as a user both threw and produced no context.
      req.companyId = req.user.companyId || (await companyContext.getDefaultCompanyId())
    } else {
      req.companyId = (await companyContext.primaryCompanyFor(req.user?.id))
        || (await companyContext.getDefaultCompanyId())
    }

    return companyContext.runWithCompany(req.companyId, () => next())
  } catch (error) {
    // Company resolution failed. What to do about it depends entirely on
    // whether isolation is actually in effect:
    //
    //   • Isolated  — continuing without context is not safe to guess at. RLS
    //     would show the request no rows, which reads to the user as "my data
    //     vanished" rather than as an error. Refuse loudly instead.
    //   • Not isolated — this is a single-company install where company context
    //     is bookkeeping, not a boundary. Failing the request would take the
    //     whole API down over a lookup that does not matter here.
    //
    // This whole block is itself wrapped, because it runs ONLY on a path that
    // has already failed once. An error thrown from inside a catch handler
    // escapes the function entirely: `auth` returns this promise without
    // awaiting it, Express 4 ignores returned promises, so neither next() nor
    // next(err) is ever called and the request hangs — and on Node 15+ the
    // unhandled rejection terminates the process. A recovery path that can
    // crash the server is worse than the failure it was added to handle.
    try {
      console.error('Company context could not be established:', error.message)
      if (await companyContext.isolationEnabled()) {
        return res.status(500).json({
          success: false,
          error: 'Failed to establish tenant company context.'
        })
      }
      return next()
    } catch (fallbackError) {
      console.error('Company context fallback also failed:', fallbackError.message)
      return next()
    }
  }
}


const auth = async (req, res, next) => {
  try {
    // Trusted server-to-server path. This is NEVER driven by a client-supplied
    // flag — the caller must present a shared secret that only the server holds
    // (INTERNAL_SERVICE_TOKEN). A missing/blank env disables the path entirely,
    // so it cannot be abused if the secret is not configured.
    const serviceToken = req.header('X-Internal-Service-Token');
    if (serviceToken && process.env.INTERNAL_SERVICE_TOKEN &&
        serviceToken === process.env.INTERNAL_SERVICE_TOKEN) {
      req.user = {
        id: 'ai-system',
        email: 'ai-service@system.internal',
        role: 'ADMIN',
        isSystemUser: true
      };
      req.userId = 'ai-system';
      return establishCompany(req, res, next);
    }

    // External-integration path (ERP-Roadmap P3 #20): a hashed, revocable,
    // scoped API key — never a bare client-controlled flag. Only the sha256
    // hash is ever compared/stored (models/ApiKey.js), so a leaked database
    // dump does not itself expose usable keys.
    const apiKey = req.header('X-API-Key');
    if (apiKey) {
      const ApiKey = require('../models/ApiKey');
      const record = await ApiKey.validate(apiKey);
      if (!record) {
        return res.status(401).json({ success: false, error: 'Invalid or revoked API key.' });
      }
      req.user = {
        id: `api-key-${record.id}`,
        email: `${record.name}@api-key.internal`,
        role: record.role,
        isApiKey: true,
        apiKeyScopes: record.scopes,
        // The key's own company scope — an API key belongs to one company's data.
        companyId: record.company_id,
      };
      req.userId = req.user.id;
      return establishCompany(req, res, next);
    }

    const token = req.header('Authorization')?.replace('Bearer ', '')
    
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access denied. No token provided.'
      })
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const user = await User.findById(decoded.id)
    
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token. User not found.'
      })
    }

    req.user = user
    req.userId = user.id // Add userId for backward compatibility
    return establishCompany(req, res, next)
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token.'
      })
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired. Please login again.'
      })
    }

    res.status(500).json({
      success: false,
      error: 'Authentication error'
    })
  }
}

const optionalAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '')
    
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      const user = await User.findById(decoded.id)
      req.user = user
      req.userId = user?.id // Add userId for backward compatibility
    }
    
    next()
  } catch (error) {
    next()
  }
}

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      })
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'Insufficient permissions'
      })
    }

    next()
  }
}

const requireAdmin = requireRole('ADMIN')
const requireManagerOrAdmin = requireRole('ADMIN', 'MANAGER')

/**
 * The platform owner — the person who runs this deployment, as opposed to an
 * administrator of one tenant inside it.
 *
 * ADMIN is a TENANT role: every customer company has its own, and each one is
 * fully entitled to administer their own data. That makes it the wrong gate for
 * anything describing the instance rather than a tenant — request volume,
 * database size, table row counts — because a customer's admin would see
 * activity that is partly other customers'.
 *
 * Identified by email against PLATFORM_OWNER_EMAIL rather than by a role column
 * or a flag on `users`, deliberately: this is deployment configuration, not
 * tenant data. Nothing reachable through the product can grant it — a tenant
 * admin with full control of their own company's rows, including the ability to
 * set another user's role, still cannot make themselves the platform owner.
 * Changing it requires access to the server's environment.
 *
 * Unset means nobody qualifies. A deployment that forgot to configure it locks
 * the owner out of a statistics page; the opposite default would silently open
 * instance-wide figures to every tenant admin, which is not a mistake worth
 * being lenient about.
 */
function isPlatformOwner(user) {
  // Synthetic principals carry fabricated addresses (ai-service@system.internal,
  // <name>@api-key.internal). Excluded outright, ahead of both checks, so no
  // configuration or claim can hand ownership to a service token or an API key.
  if (!user || user.isSystemUser || user.isApiKey) return false

  // The environment WINS when set. Two reasons it stays as an override rather
  // than being replaced by the claim: it is the recovery path if the one-time
  // claim lands on the wrong account (a stranger who found the public URL
  // before the operator did), and it cannot be altered from inside the product
  // by anyone, including whoever currently holds the claim.
  const configured = (process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase()
  if (configured) {
    return String(user.email || '').trim().toLowerCase() === configured
  }

  // Otherwise the claimed owner — set once, at signup, while nobody held it
  // (migration 202608100100). A partial unique index guarantees at most one.
  return user.is_platform_owner === true
}

const requirePlatformOwner = (req, res, next) => {
  if (!isPlatformOwner(req.user)) {
    return res.status(403).json({
      success: false,
      error: 'This view is restricted to the platform owner.'
    })
  }
  next()
}

// Finance-specific access. Dedicated finance roles (for larger orgs that split
// finance staff out of general management) OR the general MANAGER/ADMIN roles,
// which carry finance authority everywhere else in this system.
const requireFinanceUser = requireRole('FINANCE_USER', 'FINANCE_MANAGER', 'MANAGER', 'ADMIN')
const requireFinanceManager = requireRole('FINANCE_MANAGER', 'MANAGER', 'ADMIN')

module.exports = {
  auth,
  optionalAuth,
  requireRole,
  requireAdmin,
  requireManagerOrAdmin,
  requireFinanceUser,
  requireFinanceManager,
  isPlatformOwner,
  requirePlatformOwner
}