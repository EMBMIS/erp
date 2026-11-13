const jwt = require('jsonwebtoken')

/**
 * The cross-app SSO session cookie.
 *
 * Separate from the Bearer JWT the ERP's own SPA already uses (JWT_SECRET) —
 * this one is read by browsers, not just sent in an Authorization header, so
 * it needs its own secret for the same rotation-independence reason
 * SUPPLIER_JWT_SECRET is kept apart from JWT_SECRET: rotating a browser
 * session secret must not also invalidate every logged-in API client.
 *
 * embmis-web (the landing page, served at "/") and the ERP (served at
 * "/platform" — see nginx/embmis.conf) are the same literal origin in
 * production, so this cookie needs no Domain attribute and no CORS
 * configuration to be readable from both: Path=/ is enough.
 */

const COOKIE_NAME = 'embmis_sso'

function secret() {
  return process.env.SSO_COOKIE_SECRET
}

function sign(user) {
  return jwt.sign({ sub: user.id }, secret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || '24h'
  })
}

// Never throws — an invalid/expired/tampered cookie just means "no session",
// the same way a missing one does, not a 500.
function verify(token) {
  if (!token) return null
  try {
    return jwt.verify(token, secret())
  } catch (error) {
    return null
  }
}

function baseOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  }
}

function cookieOptions() {
  return { ...baseOptions(), maxAge: msFromExpiry(process.env.JWT_EXPIRES_IN || '24h') }
}

// res.clearCookie(name, options) merges `options` on top of its own
// { expires: new Date(1), path: '/' } default — a maxAge left in `options`
// would win over that forced-past expiry (the `cookie` package prefers
// Max-Age over Expires when both are present), producing a cookie that
// re-sets itself into the future instead of actually clearing. Options
// without maxAge is what makes clearCookie's own default expiry stick.
function clearOptions() {
  return baseOptions()
}

// jsonwebtoken's expiresIn takes a short human string ('8h', '30d') or a bare
// number of seconds; Set-Cookie's maxAge wants milliseconds. Deriving one
// from the other keeps the cookie and the token it wraps expiring together
// rather than drifting if just one gets edited later.
function msFromExpiry(expiresIn) {
  if (typeof expiresIn === 'number') return expiresIn * 1000
  const match = /^(\d+)\s*([smhdw])?$/.exec(String(expiresIn).trim())
  if (!match) return 24 * 60 * 60 * 1000
  const unitMs = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }
  return Number(match[1]) * unitMs[match[2] || 's']
}

module.exports = { COOKIE_NAME, sign, verify, cookieOptions, clearOptions }
