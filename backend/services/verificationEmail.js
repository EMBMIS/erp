const crypto = require('crypto')
const db = require('../config/database')
const emailService = require('./emailService')
const { appBase } = require('../config/appLinks')
const { authFrom } = require('../config/sender')

/**
 * Issue and email a verification link. Same shape as the password-reset
 * token (routes/auth.js) — hash stored, raw token only ever in the URL,
 * single-use, time-limited. Fire-and-forget from the caller's perspective: a
 * signup or invite must never fail because the verification email couldn't
 * send (SMTP down, no SMTP configured at all) — the account is real either
 * way, and the user can ask for the link again via /resend-verification.
 *
 * Shared by /register, /register-company and POST /users/invite — every path
 * that creates a `users` row starts it at email_verified = false (migration
 * 202608071700), and User.authenticate() refuses to log an unverified user
 * in at all. Skipping this call for any creation path leaves that account
 * permanently unable to sign in.
 */
async function sendVerificationEmail(user) {
  const token = crypto.randomBytes(32).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours — longer than the 1-hour reset link, since verifying is lower-stakes than a compromised-account recovery flow

  await db.query(
    'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, tokenHash, expiresAt]
  )

  const verifyUrl = `${appBase()}/verify-email?token=${token}`
  try {
    await emailService.sendEmail({
      from: authFrom(),
      to: user.email,
      subject: 'Verify your email — Simeli ERP',
      html: `
        <p>Hi ${user.first_name},</p>
        <p>Confirm this is your email address to finish setting up your account. This link expires in 24 hours:</p>
        <p><a href="${verifyUrl}">${verifyUrl}</a></p>
      `,
      text: `Verify your email: ${verifyUrl}\n\nThis link expires in 24 hours.`
    })
  } catch (emailError) {
    console.error(`Failed to send verification email to ${user.email}:`, emailError.message)
  }
}

module.exports = { sendVerificationEmail }
