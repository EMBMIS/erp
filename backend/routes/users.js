const express = require('express')
const Joi = require('joi')
const User = require('../models/User')
const { auth, requireAdmin } = require('../middleware/auth')
const emailService = require('../services/emailService')
const { sendVerificationEmail } = require('../services/verificationEmail')
const { authFrom } = require('../config/sender')

const router = express.Router()

// Admin-only: creating, promoting, deactivating or deleting accounts is
// exactly the set of actions BLOCKER 1 exists to keep away from a client that
// merely holds a valid session — it must also hold ADMIN.
router.use(auth, requireAdmin)

const inviteSchema = Joi.object({
  email: Joi.string().email().required(),
  first_name: Joi.string().min(2).max(50).required(),
  last_name: Joi.string().min(2).max(50).required(),
  role: Joi.string().valid('USER', 'MANAGER', 'ADMIN').default('USER')
})

const roleSchema = Joi.object({
  role: Joi.string().valid('USER', 'MANAGER', 'ADMIN').required()
})

// GET /api/users — list this company's users (never another tenant's — see
// User.findAll's comment on why an unscoped list would leak cross-tenant).
router.get('/', async (req, res) => {
  try {
    const users = await User.findAll(req.companyId)
    res.json({ success: true, data: users })
  } catch (error) {
    console.error('List users error:', error)
    res.status(500).json({ success: false, error: 'Failed to list users' })
  }
})

// POST /api/users/invite — create a user with a temp password and email it.
// If the email fails to send, the temp password is returned in the response
// so the admin can still hand it over manually (dev mode / no SMTP configured).
router.post('/invite', async (req, res) => {
  try {
    const { error } = inviteSchema.validate(req.body)
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message })
    }

    const { email, first_name, last_name, role } = req.body

    const existingUser = await User.findByEmail(email)
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'User with this email already exists' })
    }

    const { user, tempPassword } = await User.createWithTempPassword({ email, first_name, last_name, role }, req.companyId)

    // Every users row starts email_verified = false (migration 202608071700),
    // and User.authenticate() refuses to log an unverified user in — without
    // this, an invited user's temp password would never actually work.
    sendVerificationEmail(user).catch((err) => console.error('sendVerificationEmail failed:', err.message))

    let emailSent = false
    let emailError = null
    try {
      await emailService.sendEmail({
        from: authFrom(),
        to: email,
        subject: 'Welcome to Simeli ERP — your account is ready',
        html: `
          <p>Hi ${first_name},</p>
          <p>An administrator created an account for you on Simeli ERP.</p>
          <p><strong>Email:</strong> ${email}<br/>
             <strong>Temporary password:</strong> ${tempPassword}</p>
          <p>Please sign in and change your password as soon as possible.</p>
        `,
        text: `Hi ${first_name},\n\nAn administrator created an account for you on Simeli ERP.\nEmail: ${email}\nTemporary password: ${tempPassword}\n\nPlease sign in and change your password as soon as possible.`
      })
      emailSent = true
    } catch (err) {
      emailError = err.message
      console.error('Invite email failed to send:', err.message)
    }

    res.status(201).json({
      success: true,
      data: { user, emailSent },
      // Only handed back over the wire when the email genuinely could not be
      // delivered — never alongside a successful send.
      ...(emailSent ? {} : { tempPassword, note: `Email delivery failed (${emailError}) — share this temporary password with the user directly.` })
    })
  } catch (error) {
    console.error('Invite user error:', error)
    res.status(500).json({ success: false, error: 'Failed to invite user' })
  }
})

// PUT /api/users/:id/role — change a user's role
router.put('/:id/role', async (req, res) => {
  try {
    const { error } = roleSchema.validate(req.body)
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message })
    }

    if (req.params.id === req.user.id) {
      return res.status(400).json({ success: false, error: 'You cannot change your own role' })
    }

    const updated = await User.updateRole(req.params.id, req.body.role, req.companyId)
    if (!updated) {
      return res.status(404).json({ success: false, error: 'User not found' })
    }

    res.json({ success: true, data: updated })
  } catch (error) {
    console.error('Update role error:', error)
    res.status(500).json({ success: false, error: 'Failed to update role' })
  }
})

// PUT /api/users/:id/deactivate
router.put('/:id/deactivate', async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ success: false, error: 'You cannot deactivate your own account' })
    }

    const updated = await User.deactivate(req.params.id, req.companyId)
    if (!updated) {
      return res.status(404).json({ success: false, error: 'User not found' })
    }

    res.json({ success: true, data: updated })
  } catch (error) {
    console.error('Deactivate user error:', error)
    res.status(500).json({ success: false, error: 'Failed to deactivate user' })
  }
})

// PUT /api/users/:id/activate
router.put('/:id/activate', async (req, res) => {
  try {
    const updated = await User.activate(req.params.id, req.companyId)
    if (!updated) {
      return res.status(404).json({ success: false, error: 'User not found' })
    }

    res.json({ success: true, data: updated })
  } catch (error) {
    console.error('Activate user error:', error)
    res.status(500).json({ success: false, error: 'Failed to activate user' })
  }
})

// DELETE /api/users/:id — soft delete
router.delete('/:id', async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ success: false, error: 'You cannot delete your own account' })
    }

    const deleted = await User.softDelete(req.params.id, req.companyId)
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'User not found' })
    }

    res.json({ success: true, message: 'User deleted' })
  } catch (error) {
    console.error('Delete user error:', error)
    res.status(500).json({ success: false, error: 'Failed to delete user' })
  }
})

module.exports = router
