const express = require('express')
const Joi = require('joi')
const crypto = require('crypto')
const rateLimit = require('express-rate-limit')
const { OAuth2Client } = require('google-auth-library')
const User = require('../models/User')
const { auth, isPlatformOwner } = require('../middleware/auth')
const db = require('../config/database')
const emailService = require('../services/emailService')
const { sendVerificationEmail } = require('../services/verificationEmail')
const { appBase } = require('../config/appLinks')
const { authFrom } = require('../config/sender')
const ssoCookie = require('../services/ssoCookie')

const router = express.Router()

// Verifying a Google ID token needs only the Client ID (signature check
// against Google's own public keys) — no client secret, unlike a
// server-redirect OAuth flow. Left null when unconfigured so POST /google
// can refuse cleanly instead of throwing on a missing audience.
const googleClient = process.env.GOOGLE_LOGIN_CLIENT_ID
  ? new OAuth2Client(process.env.GOOGLE_LOGIN_CLIENT_ID)
  : null

// The shape every successful sign-in returns — password login, the SSO
// session pickup, and Google login alike — so a frontend (either app) can
// treat all three identically.
function buildAuthPayload(user, token) {
  return {
    success: true,
    data: {
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        must_change_password: user.must_change_password,
        is_platform_owner: isPlatformOwner(user)
      },
      token
    }
  }
}

// Keyed by email (not IP) — the point is to stop someone hammering reset
// requests at one address, regardless of how many IPs they spread it across.
const forgotPasswordRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.body?.email || req.ip).toLowerCase(),
  message: { success: false, error: 'Too many password reset requests. Please try again later.' }
})

// Brute-force / registration-spam guard, scoped to just these two endpoints —
// separate from the general API rate limiter (middleware/requestQueue.js),
// which is far too loose (200/min) to stop credential stuffing.
//
// KEYED BY ACCOUNT, NOT BY ADDRESS
// ---------------------------------------------------------------------------
// The default key is the IP, and an office is one IP. Ten failed attempts by
// any ten people — a stale saved password, a caps-lock morning — locked out the
// entire company for fifteen minutes, with nothing in the UI explaining why.
// Rate limiting the whole building because one person mistyped is a bigger
// outage than the attack it prevents.
//
// Keying on the account under attack fixes both halves: a single account still
// gets ten attempts before it locks, which is what stops credential stuffing,
// while a colleague at the same desk is unaffected. The IP stays in the key as
// a fallback so a request with no email in the body (malformed, or a probe) is
// still limited rather than unlimited, and it keeps one attacker from
// exhausting a victim's budget from many addresses without also holding the
// victim's own address.
//
// The forgot-password limiter directly above already keys by email; this simply
// stops the two from disagreeing.
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = String(req.body?.email || '').trim().toLowerCase()
    return email ? `acct:${email}` : `ip:${req.ip}`
  },
  message: { success: false, error: 'Too many attempts for this account. Please try again in a few minutes.' }
})

// Validation schemas
const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required()
})

// `role` is deliberately not accepted here — every self-registration becomes
// USER. Elevating to MANAGER/ADMIN is an admin action (see routes/users.js),
// never something the registering client controls.
const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  first_name: Joi.string().min(2).max(50).required(),
  last_name: Joi.string().min(2).max(50).required()
})

const registerCompanySchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  first_name: Joi.string().min(2).max(50).required(),
  last_name: Joi.string().min(2).max(50).required(),
  company_name: Joi.string().min(2).max(200).required(),
  // Either given directly (the signup UI's dropdown), or left blank alongside
  // business_description for the AI to suggest one — never both silently
  // disagreeing, so business_type_code wins if both are present.
  //
  // The signup form (frontend/src/pages/Signup.jsx) initializes this field to
  // '' and never omits it from the request, so .optional() alone still
  // rejected every signup that left the dropdown at its default with a raw
  // '"business_type_code" is not allowed to be empty' — blocking the entire
  // self-service signup flow for anyone who didn't explicitly pick one, which
  // the field's own "(optional)" label invites. .allow('') matches the
  // sibling business_description field immediately below, which already
  // handles this correctly.
  business_type_code: Joi.string().allow('').optional(),
  business_description: Joi.string().max(500).allow('').optional(),
})

const profileUpdateSchema = Joi.object({
  first_name: Joi.string().min(2).max(50).required(),
  last_name: Joi.string().min(2).max(50).required()
})

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(6).required()
})

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required()
})

const resetPasswordSchema = Joi.object({
  token: Joi.string().required(),
  new_password: Joi.string().min(6).required()
})

// POST /api/auth/login
router.post('/login', authRateLimit, async (req, res) => {
  try {
    const { error } = loginSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      })
    }

    const { email, password } = req.body

    let user
    try {
      user = await User.authenticate(email, password)
    } catch (authError) {
      if (authError.message === 'ACCOUNT_DEACTIVATED') {
        return res.status(401).json({
          success: false,
          error: 'Account deactivated — contact your administrator'
        })
      }
      if (authError.message === 'EMAIL_NOT_VERIFIED') {
        return res.status(403).json({
          success: false,
          code: 'EMAIL_NOT_VERIFIED',
          error: 'Please verify your email before signing in — check your inbox for the link we sent you.'
        })
      }
      throw authError
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      })
    }

    const token = await User.generateToken(user)

    // Cross-app SSO pickup (see services/ssoCookie.js and GET /session
    // below) — set alongside, not instead of, the Bearer token: the ERP's
    // own SPA keeps using the token exactly as before.
    res.cookie(ssoCookie.COOKIE_NAME, ssoCookie.sign(user), ssoCookie.cookieOptions())

    res.json(buildAuthPayload(user, token))
  } catch (error) {
    console.error('Login error:', error)
    res.status(500).json({
      success: false,
      error: 'Login failed'
    })
  }
})

const googleLoginSchema = Joi.object({
  credential: Joi.string().required()
})

// POST /api/auth/google — "Sign in with Google" via Google Identity
// Services' ID-token flow. The frontend button hands us a signed ID token;
// we verify it against Google's own public keys (no client secret, no
// redirect round-trip needed for this flow) and then treat it exactly like
// a successful password login: same cookie, same response shape, same
// User.generateToken.
router.post('/google', authRateLimit, async (req, res) => {
  try {
    if (!googleClient) {
      return res.status(503).json({ success: false, error: 'Google sign-in is not configured.' })
    }

    const { error } = googleLoginSchema.validate(req.body)
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message })
    }

    let payload
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: req.body.credential,
        audience: process.env.GOOGLE_LOGIN_CLIENT_ID
      })
      payload = ticket.getPayload()
    } catch (verifyError) {
      return res.status(401).json({ success: false, error: 'Invalid Google credential.' })
    }

    if (!payload?.email_verified) {
      return res.status(401).json({ success: false, error: 'Google account email is not verified.' })
    }

    let user = await User.findByGoogleId(payload.sub)
    if (!user) {
      // Recovery address counts too: an account created with a personal Gmail
      // that later moved to a company login email must attach to the existing
      // account rather than spawn a duplicate on the next Google sign-in.
      const existing = await User.findByEmailOrRecovery(payload.email)
      if (existing) {
        // Same Google identity, no prior link — attach it to the matching
        // local account rather than creating a duplicate. See
        // models/User.js's linkGoogleId for the trust assumption this makes.
        user = await User.linkGoogleId(existing.id, payload.sub)
      } else {
        const isFirstUser = await User.isEmpty()
        user = await User.createFromGoogle({
          email: payload.email,
          google_id: payload.sub,
          first_name: payload.given_name || payload.name || 'User',
          last_name: payload.family_name || '',
          role: isFirstUser ? 'ADMIN' : 'USER'
        })
      }
    }

    if (!user.is_active) {
      return res.status(401).json({ success: false, error: 'Account deactivated — contact your administrator' })
    }

    const token = await User.generateToken(user)
    res.cookie(ssoCookie.COOKIE_NAME, ssoCookie.sign(user), ssoCookie.cookieOptions())
    res.json(buildAuthPayload(user, token))
  } catch (error) {
    console.error('Google login error:', error)
    res.status(500).json({ success: false, error: 'Google sign-in failed' })
  }
})

// POST /api/auth/register
router.post('/register', authRateLimit, async (req, res) => {
  try {
    const { error } = registerSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      })
    }

    const { email, password, first_name, last_name } = req.body

    // Check if user already exists
    const existingUser = await User.findByEmail(email)
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'User with this email already exists'
      })
    }

    // Bootstrap: the very first account on a fresh install becomes ADMIN so
    // there is someone able to use routes/users.js afterwards. Every
    // registration after that is forced to USER regardless of what the
    // client sends — `role` is not read from req.body at all.
    const isFirstUser = await User.isEmpty()
    const role = isFirstUser ? 'ADMIN' : 'USER'

    const user = await User.create({
      email,
      password,
      first_name,
      last_name,
      role
    })

    sendVerificationEmail(user).catch((err) => console.error('sendVerificationEmail failed:', err.message))

    // No token here — an account that has not clicked the verification link
    // yet is not signed in. See EMAIL_NOT_VERIFIED in /login above, the
    // matching gate that would refuse this token anyway were one issued.
    res.status(201).json({
      success: true,
      data: {
        email: user.email,
        requiresVerification: true
      }
    })
  } catch (error) {
    console.error('Registration error:', error)
    res.status(500).json({
      success: false,
      error: 'Registration failed'
    })
  }
})

/**
 * POST /auth/register-company — self-service signup: a brand-new company AND
 * its first (ADMIN) user, created together.
 *
 * Distinct from POST /register above, which only ever joins the single
 * existing default company — there was no path to a genuinely new tenant
 * that didn't require an existing admin to create it by hand (routes/
 * companies.js's POST /, requireAdmin). This is that path.
 *
 * The database itself is the real gate on whether a second company is safe
 * to create at all (migration 110-112's guard_company_insert trigger,
 * translated into a clean message by Companies.create) — this route does not
 * duplicate that check, only the things that are this route's own job:
 * validation, picking a business type, and doing the three inserts (user,
 * company, membership) as one signup.
 */
// POST /auth/suggest-business-type — preview-only: lets the signup form show
// what the AI would pick (and let the user confirm/override it in a dropdown)
// before they submit, rather than finding out only after registering.
router.post('/suggest-business-type', authRateLimit, async (req, res) => {
  try {
    const { suggestBusinessType } = require('../services/businessSetupAI')
    const suggestion = await suggestBusinessType(req.body?.description)
    res.json({ success: true, data: suggestion })
  } catch (error) {
    res.json({ success: true, data: null })
  }
})

router.post('/register-company', authRateLimit, async (req, res) => {
  const { error } = registerCompanySchema.validate(req.body)
  if (error) {
    return res.status(400).json({ success: false, error: error.details[0].message })
  }

  const { email, password, first_name, last_name, company_name, business_description } = req.body
  let { business_type_code } = req.body

  try {
    const existingUser = await User.findByEmail(email)
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'User with this email already exists' })
    }

    if (!business_type_code && business_description) {
      const { suggestBusinessType } = require('../services/businessSetupAI')
      const suggestion = await suggestBusinessType(business_description)
      if (suggestion) business_type_code = suggestion.code
    }

    // The founding user administers their own company — global ADMIN, same as
    // the single-tenant bootstrap path above, not the least-privilege USER
    // role a normal registration gets.
    const user = await User.create({ email, password, first_name, last_name, role: 'ADMIN' })
    sendVerificationEmail(user).catch((err) => console.error('sendVerificationEmail failed:', err.message))

    // User.create, Companies.create/assignUser and moduleService.seedForCompany
    // each reach the database through the shared pool independently rather than
    // a passed-in client, so they cannot be composed into one real transaction
    // without changing all three signatures. Given how rarely this path is
    // hit (once per new tenant) and how narrow the failure window is, a
    // compensating delete on failure is the pragmatic fix here: if anything
    // after the user insert fails, undo the user rather than leave a company-
    // less account behind that looks registered but cannot sign in anywhere.
    // Tracks how far provisioning got, so the catch block below knows whether
    // a plain "delete the user" is still a complete rollback (nothing else
    // exists yet) or whether a company now exists too — and, once it does,
    // asking what else references company_id is a moving target (agent
    // definitions get seeded onto it by the scheduler asynchronously, and
    // every company-scoped table is a candidate) rather than something safe
    // to chase with more deletes from a request handler.
    let companyCreated = false

    try {
      const { Companies } = require('../models/Company')
      const company_code = await generateCompanyCode(company_name)
      const company = await Companies.create({ company_code, name: company_name, base_currency: 'USD' }, user.id)
      companyCreated = true
      await Companies.assignUser(user.id, company.id, { role: 'ADMIN', is_primary: true })

      // Claim platform ownership if nobody holds it yet (migration
      // 202608100100). This is how the operator of a fresh deployment gets the
      // instance-wide App Statistics screen without hand-provisioning an
      // account — the first signup is theirs by construction.
      //
      // The WHERE NOT EXISTS makes it a no-op once claimed, and the partial
      // unique index behind it means a genuine race loses with a unique
      // violation rather than producing two owners. Swallowed deliberately:
      // failing to claim ownership must never fail a signup, because for every
      // signup after the first that is the correct and expected outcome.
      try {
        const claim = await db.query(
          `UPDATE users SET is_platform_owner = true
            WHERE id = $1
              AND NOT EXISTS (SELECT 1 FROM users WHERE is_platform_owner)
            RETURNING id`,
          [user.id]
        )
        if (claim.rows.length) {
          console.log(`Platform ownership claimed by ${user.email} (first signup on this deployment).`)
        }
      } catch (claimError) {
        console.warn('Platform-owner claim skipped:', claimError.message)
      }

      // company_subscriptions and company_modules are RLS-scoped (WITH CHECK
      // company_id = current_company_id()) — under real isolation, the
      // session's ambient company is whatever established it before this
      // request (nothing, for this public route, or an admin's own company
      // if they're inviting a second tenant), never the brand-new company
      // being provisioned right now. Writing its own first rows for it has
      // to run WITH that company as the ambient one, or the WITH CHECK
      // rejects every insert as writing into a company that isn't "current."
      const companyScope = require('../services/companyScope')
      await companyScope.runWithCompany(company.id, async () => {
        // Every company is on the free plan, with no end date and no limits:
        // EMBMIS ERP is open source (migration 202608071600 created the table).
        await db.query(
          `INSERT INTO company_subscriptions (company_id, plan_code, status, current_period_end)
           VALUES ($1, 'free', 'ACTIVE', NULL)`,
          [company.id]
        )

        // Every DoA-gated approval queue (suppliers, certifications, purchase
        // requisitions, sales quotations/orders/contracts/RFQs — see
        // pendingAuthority() in routes/delegation-of-authority.js and
        // *.getPendingApprovals()'s DelegationOfAuthority.getUserAuthority()
        // calls) requires an actual delegation_of_authority row for the
        // caller, not just their role. But POST /delegation-of-authority
        // enforces four-eyes (AuthorityEngine's C6 check): creating any DoA
        // grant needs a second, distinct approver's signature. A brand-new
        // company has no DoA rows and, being one founder, no second person
        // who could ever co-sign the first one — so without this, a
        // single-admin company can never approve anything through those
        // queues, permanently, with no way out through the product itself.
        // This is the one and only self-granted exception: a system-issued
        // starter grant at company genesis, made directly (not through the
        // governed endpoint), so four-eyes still applies to every DoA change
        // an admin makes from here on, including narrowing or revoking this
        // very grant.
        //
        // cost_center is NULL here, not the string 'ALL': ApprovalRulesEngine
        // .matchConditions only treats an EMPTY cost_center as a wildcard
        // (`rule.cost_center is a wildcard when empty`) — a literal 'ALL'
        // value only matches a resource whose own cost center is also
        // literally the string 'ALL', which real PRs/POs/journal entries
        // never are. That silently made this "grant everything" starter row
        // grant nothing at all for any transaction that actually carries a
        // cost center, on every company created since this insert was added.
        await db.query(
          `INSERT INTO delegation_of_authority
             (cost_center, user_id, min_amount, max_amount, applies_to, effective_from, created_by)
           VALUES (NULL, $1, 0, 999999999999.99, 'ALL', CURRENT_DATE, $1)`,
          [user.id]
        )

        // The GL seed (migration 202608120500) only ever ran for the
        // deployment's default company — a company created through signup used
        // to get an EMPTY chart_of_accounts, so every GL posting (goods
        // receipt, invoices, payments, payroll) failed with "Required accounts
        // not found" for that tenant (ERP blocker #5). Seed the same standard
        // chart, cost centers and open accounting periods for the brand-new
        // company, idempotently and scoped to it (RLS).
        const ChartOfAccounts = require('../models/ChartOfAccounts')
        await ChartOfAccounts.seedFinanceMasterData(company.id, user.id)

        // Same "provisioning step right after creation" shape as the GL seed
        // above — every company gets company-code@embmis.com the moment it
        // exists, whether created here (self-service) or via POST
        // /api/companies (admin). mailboxes is not RLS-scoped (migration
        // 202608280901), so this doesn't depend on the runWithCompany scope
        // this whole block runs inside.
        const mailboxService = require('../services/mailboxService')
        await mailboxService.createCompanyMailbox(company, user.id)

        if (business_type_code) {
          const moduleService = require('../services/moduleService')
          await moduleService.seedForCompany(company.id, business_type_code)
        }
      })

      if (business_type_code) {
        await db.query('UPDATE companies SET business_type_code = $1 WHERE id = $2', [business_type_code, company.id])
      }

      // No token — same as /register above, this account cannot sign in
      // until the verification link is clicked.
      res.status(201).json({
        success: true,
        data: {
          email: user.email,
          company: { id: company.id, name: company.name, company_code: company.company_code, business_type_code: business_type_code || null },
          requiresVerification: true,
        },
      })
    } catch (innerError) {
      if (companyCreated) {
        // A partially-provisioned company now exists (and possibly rows in
        // other company-scoped tables written by background processes, not
        // just this request) — not something safe to unwind with more
        // app-level deletes. Surfacing it clearly for an admin to finish or
        // remove by hand beats silently leaving it half-built AND silently
        // failing to roll it back.
        console.error(`register-company: company for "${company_name}" (user ${user.id}) partially provisioned, then failed: ${innerError.message}. Needs manual cleanup or completion.`)
      } else {
        await db.query('DELETE FROM users WHERE id = $1', [user.id]).catch((cleanupError) => {
          console.error(`register-company: failed to roll back orphaned user ${user.id}:`, cleanupError.message)
        })
      }
      throw innerError
    }
  } catch (error) {
    console.error('Company registration error:', error)
    res.status(400).json({ success: false, error: error.message || 'Company registration failed' })
  }
})

/** A short, unique, human-readable company_code derived from the company name — signup asks for a name, not a code to invent. */
async function generateCompanyCode(companyName) {
  const base = String(companyName)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 16) || 'COMPANY'

  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = attempt === 0 ? base : `${base}${attempt}`.slice(0, 20)
    const { rows } = await db.query('SELECT 1 FROM companies WHERE company_code = $1', [candidate])
    if (!rows.length) return candidate
  }
  // Exceedingly unlikely (20 collisions on the same name), but a code is
  // required — fall back to something guaranteed unique.
  return `CO${Date.now().toString(36).toUpperCase()}`.slice(0, 20)
}

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        user: {
          id: req.user.id,
          email: req.user.email,
          first_name: req.user.first_name,
          last_name: req.user.last_name,
          role: req.user.role,
          last_login: req.user.last_login,
          created_at: req.user.created_at,
          // Derived from PLATFORM_OWNER_EMAIL on every request, never stored on
          // the user row and never taken from the client. The UI uses it only
          // to decide whether to render the owner-only nav entry; the server
          // re-checks it on the endpoint itself, so a forged flag buys nothing.
          is_platform_owner: isPlatformOwner(req.user)
        }
      }
    })
  } catch (error) {
    console.error('Get profile error:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to fetch profile'
    })
  }
})

// PUT /api/auth/profile
router.put('/profile', auth, async (req, res) => {
  try {
    const { error } = profileUpdateSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      })
    }

    const { first_name, last_name } = req.body
    
    const updatedUser = await User.updateProfile(req.user.id, {
      first_name,
      last_name
    })

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      })
    }

    res.json({
      success: true,
      data: {
        user: updatedUser
      }
    })
  } catch (error) {
    console.error('Profile update error:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to update profile'
    })
  }
})

// PUT /api/auth/change-password
router.put('/change-password', auth, async (req, res) => {
  try {
    const { error } = changePasswordSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      })
    }

    const { currentPassword, newPassword } = req.body
    
    await User.changePassword(req.user.id, currentPassword, newPassword)

    res.json({
      success: true,
      message: 'Password changed successfully'
    })
  } catch (error) {
    if (error.message === 'User not found' || error.message === 'Current password is incorrect') {
      return res.status(400).json({
        success: false,
        error: error.message
      })
    }
    
    console.error('Change password error:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to change password'
    })
  }
})

// POST /api/auth/forgot-password
// Always returns 200 regardless of whether the email matched an account —
// a different response here would let a client enumerate registered emails.
router.post('/forgot-password', forgotPasswordRateLimit, async (req, res) => {
  try {
    const { error } = forgotPasswordSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      })
    }

    const { email } = req.body
    const user = await User.findByEmailOrRecovery(email)

    if (user && user.is_active) {
      const token = crypto.randomBytes(32).toString('hex')
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

      await db.query(
        'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [user.id, tokenHash, expiresAt]
      )

      const resetUrl = `${appBase()}/reset-password?token=${token}`

      // Send to the account email and, when set, the recovery address (the
      // email the account was originally created with — a personal Gmail can
      // stay attached after the login email moved to a company address).
      // De-duped, so an account whose recovery equals its login email gets
      // exactly one message.
      const resetRecipients = [...new Set([user.email, user.recovery_email].filter(Boolean))]
      try {
        for (const to of resetRecipients) {
          await emailService.sendEmail({
            from: authFrom(),
            to,
            subject: 'Reset your Simeli ERP password',
            html: `
              <p>Hi ${user.first_name},</p>
              <p>We received a request to reset your password. This link expires in 1 hour:</p>
              <p><a href="${resetUrl}">${resetUrl}</a></p>
              <p>If you did not request this, you can safely ignore this email.</p>
            `,
            text: `Reset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you did not request this, you can safely ignore this email.`
          })
        }
      } catch (emailError) {
        console.error('Failed to send password reset email:', emailError.message)
      }
    }

    res.json({
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.'
    })
  } catch (error) {
    console.error('Forgot password error:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to process password reset request'
    })
  }
})

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { error } = resetPasswordSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      })
    }

    const { token, new_password } = req.body
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

    const { rows } = await db.query(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used = false AND expires_at > CURRENT_TIMESTAMP`,
      [tokenHash]
    )
    const resetToken = rows[0]

    if (!resetToken) {
      return res.status(400).json({
        success: false,
        error: 'This password reset link is invalid or has expired.'
      })
    }

    await User.setPassword(resetToken.user_id, new_password)
    await db.query('UPDATE password_reset_tokens SET used = true WHERE id = $1', [resetToken.id])
    // Any other outstanding reset tokens for this user are now stale too.
    await db.query(
      'UPDATE password_reset_tokens SET used = true WHERE user_id = $1 AND used = false',
      [resetToken.user_id]
    )

    // JWT sessions are stateless — there is no server-side session store to
    // revoke, so an existing token stays valid until it naturally expires
    // (JWT_EXPIRES_IN). That is an accepted tradeoff of the JWT-only auth
    // model here, not an oversight.

    res.json({
      success: true,
      message: 'Password has been reset successfully. Please sign in with your new password.'
    })
  } catch (error) {
    console.error('Reset password error:', error)
    res.status(500).json({
      success: false,
      error: 'Failed to reset password'
    })
  }
})

// POST /api/auth/verify-email
router.post('/verify-email', async (req, res) => {
  try {
    const token = req.body?.token
    if (!token) return res.status(400).json({ success: false, error: 'A verification token is required.' })

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const { rows } = await db.query(
      `SELECT id, user_id FROM email_verification_tokens
       WHERE token_hash = $1 AND used = false AND expires_at > CURRENT_TIMESTAMP`,
      [tokenHash]
    )
    const verification = rows[0]
    if (!verification) {
      return res.status(400).json({ success: false, error: 'This verification link is invalid or has expired.' })
    }

    const { rows: userRows } = await db.query(
      'UPDATE users SET email_verified = true WHERE id = $1 RETURNING email, first_name',
      [verification.user_id]
    )
    await db.query('UPDATE email_verification_tokens SET used = true WHERE id = $1', [verification.id])

    const user = userRows[0]
    if (user) {
      emailService.sendEmail({
        from: authFrom(),
        to: user.email,
        subject: 'Welcome to Simeli ERP',
        html: `<p>Hi ${user.first_name},</p><p>Your email is verified — you're all set. Welcome aboard!</p>`,
        text: `Hi ${user.first_name}, your email is verified — you're all set. Welcome aboard!`,
      }).catch((err) => console.error('Failed to send welcome email:', err.message))
    }

    res.json({ success: true, message: 'Email verified.' })
  } catch (error) {
    console.error('Email verification error:', error)
    res.status(500).json({ success: false, error: 'Failed to verify email' })
  }
})

// POST /api/auth/resend-verification — same enumeration-safe shape as
// forgot-password: always 200, regardless of whether the email matched an
// unverified account.
router.post('/resend-verification', forgotPasswordRateLimit, async (req, res) => {
  try {
    const user = await User.findByEmail(req.body?.email || '')
    if (user && !user.email_verified) {
      await sendVerificationEmail(user)
    }
    res.json({ success: true, message: 'If that email has a pending verification, a new link has been sent.' })
  } catch (error) {
    console.error('Resend verification error:', error)
    res.status(500).json({ success: false, error: 'Failed to resend verification email' })
  }
})

// GET /api/auth/session — cross-app SSO pickup.
//
// Reads the embmis_sso cookie (set on /login and /google — see
// services/ssoCookie.js) and, if it's valid, mints a fresh session in the
// same shape /login returns. This is how the landing page (embmis-web)
// detects "already logged in via the ERP" without a password: same origin
// as the ERP under /platform in production, so the cookie is already there
// to read, no CORS needed.
//
// Deliberately public (no `auth` middleware) — the whole point is to work
// with only a cookie, before any Bearer token exists on this app.
router.get('/session', async (req, res) => {
  try {
    const decoded = ssoCookie.verify(req.cookies?.[ssoCookie.COOKIE_NAME])
    if (!decoded) {
      return res.status(401).json({ success: false, error: 'No active session' })
    }

    const user = await User.findById(decoded.sub)
    if (!user) {
      return res.status(401).json({ success: false, error: 'No active session' })
    }

    const token = await User.generateToken(user)
    res.json(buildAuthPayload(user, token))
  } catch (error) {
    console.error('Session lookup error:', error)
    res.status(401).json({ success: false, error: 'No active session' })
  }
})

// POST /api/auth/sso-logout — clears the shared cookie on its own, without
// requiring a Bearer token. The landing page never holds one, so it can't
// call the Bearer-gated /logout below; this is how it drops the session.
router.post('/sso-logout', async (req, res) => {
  res.clearCookie(ssoCookie.COOKIE_NAME, ssoCookie.clearOptions())
  res.json({ success: true })
})

// POST /api/auth/logout
router.post('/logout', auth, async (req, res) => {
  try {
    // For JWT tokens, logout is typically handled client-side by removing the token
    // But we can log the action here for audit purposes
    console.log(`User ${req.user.email} logged out at ${new Date().toISOString()}`)

    // Also drops the shared SSO cookie, so logging out of the ERP logs the
    // landing page's session detection out too — otherwise it would keep
    // reporting "logged in" until the cookie's own expiry.
    res.clearCookie(ssoCookie.COOKIE_NAME, ssoCookie.clearOptions())

    res.json({
      success: true,
      message: 'Logged out successfully'
    })
  } catch (error) {
    console.error('Logout error:', error)
    res.status(500).json({
      success: false,
      error: 'Logout failed'
    })
  }
})

// GET /api/auth/verify
router.get('/verify', auth, async (req, res) => {
  try {
    // A valid bearer token means this browser has a real session — make sure
    // the shared embmis_sso cookie exists too. This is the endpoint the ERP
    // calls on every page load (AuthContext.initializeAuth), so any user who
    // logged in before the cookie shipped, or whose cookie expired, gets it
    // re-issued the moment they open the ERP — the landing page then
    // recognises them via GET /session without a fresh login.
    res.cookie(ssoCookie.COOKIE_NAME, ssoCookie.sign(req.user), ssoCookie.cookieOptions())
    res.json({
      success: true,
      data: {
        valid: true,
        user: {
          id: req.user.id,
          email: req.user.email,
          first_name: req.user.first_name,
          last_name: req.user.last_name,
          role: req.user.role,
          must_change_password: req.user.must_change_password
        }
      }
    })
  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Token verification failed'
    })
  }
})

// Attached to the router (the module's only export) rather than changing the
// export shape — lets a regression test validate the schema directly without
// an HTTP harness, which this codebase has none of (see tests/*.test.js).
router.registerCompanySchema = registerCompanySchema

module.exports = router