const db = require('../config/database')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')

class User {
  // Whether any user already exists. Used only to decide whether a fresh
  // registration should self-bootstrap as ADMIN — once the table is
  // non-empty this always returns false, so the window closes after the
  // very first account.
  static async isEmpty() {
    const result = await db.query('SELECT 1 FROM users LIMIT 1')
    return result.rows.length === 0
  }

  static async create(userData) {
    const {
      email,
      password,
      first_name,
      last_name,
      role = 'USER'
    } = userData

    const hashedPassword = await bcrypt.hash(password, 10)

    const query = `
      INSERT INTO users (email, password_hash, first_name, last_name, role)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, email, first_name, last_name, role, is_active, created_at
    `

    const values = [email, hashedPassword, first_name, last_name, role]
    const result = await db.query(query, values)
    return result.rows[0]
  }

  // Includes inactive/deleted accounts deliberately: callers that need "is
  // this login allowed" (authenticate) must see the account to explain why
  // it was refused, rather than the row silently not existing.
  static async findByEmail(email) {
    const query = `
      SELECT * FROM users
      WHERE email = $1 AND deleted_at IS NULL
    `
    const result = await db.query(query, [email])
    return result.rows[0]
  }

  /**
   * Find by the account email OR its recovery address. An account whose login
   * email moved to a company address keeps working with the address it was
   * originally created with — login and forgot-password accept either.
   */
  static async findByEmailOrRecovery(email) {
    const query = `
      SELECT * FROM users
      WHERE (email = $1 OR recovery_email = $1) AND deleted_at IS NULL
    `
    const result = await db.query(query, [email])
    return result.rows[0]
  }

  static async findById(id) {
    const query = `
      SELECT id, email, first_name, last_name, role, is_active, last_login, created_at, must_change_password, is_platform_owner
      FROM users
      WHERE id = $1 AND is_active = true AND deleted_at IS NULL
    `
    const result = await db.query(query, [id])
    return result.rows[0]
  }

  // Deliberately includes inactive accounts (same reasoning as findByEmail
  // above): the Google-login route needs to see a deactivated account to
  // explain the refusal, not have it read as "no such user".
  static async findByGoogleId(googleId) {
    const query = `
      SELECT id, email, first_name, last_name, role, is_active, must_change_password, is_platform_owner
      FROM users
      WHERE google_id = $1 AND deleted_at IS NULL
    `
    const result = await db.query(query, [googleId])
    return result.rows[0]
  }

  // Attaches a Google identity to an EXISTING local account, matched by
  // email in routes/auth.js's POST /google. This trusts Google's own
  // email_verified claim on the token — whoever controls that Google account
  // can thereafter sign into this one too. Standard for "sign in with
  // Google" account-linking, but worth stating plainly since it is a real
  // trust boundary, not an incidental detail.
  static async linkGoogleId(userId, googleId) {
    const query = `
      UPDATE users
      SET google_id = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND deleted_at IS NULL
      RETURNING id, email, first_name, last_name, role, is_active, must_change_password, is_platform_owner
    `
    const result = await db.query(query, [googleId, userId])
    return result.rows[0]
  }

  // First-time Google sign-in with no matching local account. Mirrors plain
  // /register's bootstrap exactly (role passed in by the caller, which
  // decides ADMIN-vs-USER the same way /register does) — no company
  // assignment here either, same as /register: an unassigned user falls
  // back to the deployment's default company via companyContext, not
  // something registration itself has ever had to arrange.
  //
  // password_hash is left NULL (migration 202608311400 dropped the NOT NULL
  // constraint for exactly this) — authenticate() above already refuses a
  // password login against a null hash rather than throwing.
  static async createFromGoogle({ email, google_id, first_name, last_name, role = 'USER' }) {
    const query = `
      INSERT INTO users (email, google_id, first_name, last_name, role, email_verified)
      VALUES ($1, $2, $3, $4, $5, true)
      RETURNING id, email, first_name, last_name, role, is_active, must_change_password, is_platform_owner, created_at
    `
    const values = [email, google_id, first_name, last_name, role]
    const result = await db.query(query, values)
    return result.rows[0]
  }

  // Throws 'ACCOUNT_DEACTIVATED' rather than returning null for a deactivated
  // account so the route can tell that apart from a wrong password/email —
  // callers that don't care can still treat any thrown error as a failed login.
  static async authenticate(email, password) {
    const user = await this.findByEmailOrRecovery(email)
    if (!user) {
      return null
    }

    // A Google-only account (createFromGoogle) has no password_hash —
    // bcrypt.compare would throw on a null hash. Refuse the same way a wrong
    // password does, rather than 500ing, without hinting which case it was.
    if (!user.password_hash) {
      return null
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash)
    if (!isPasswordValid) {
      return null
    }

    if (!user.is_active) {
      throw new Error('ACCOUNT_DEACTIVATED')
    }

    if (!user.email_verified) {
      throw new Error('EMAIL_NOT_VERIFIED')
    }

    // Update last login
    await db.query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    )

    // Remove password hash from returned user object
    const { password_hash, ...userWithoutPassword } = user
    return userWithoutPassword
  }

  static async generateToken(user) {
    const payload = {
      id: user.id,
      email: user.email,
      role: user.role
    }

    return jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '24h'
    })
  }

  static async verifyToken(token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      const user = await this.findById(decoded.id)
      return user
    } catch (error) {
      return null
    }
  }

  static async updateProfile(id, profileData) {
    const { first_name, last_name } = profileData
    
    const query = `
      UPDATE users 
      SET first_name = $1, last_name = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND is_active = true
      RETURNING id, email, first_name, last_name, role, is_active, created_at
    `
    
    const values = [first_name, last_name, id]
    const result = await db.query(query, values)
    return result.rows[0]
  }

  static async changePassword(id, currentPassword, newPassword) {
    const user = await this.findByEmail(
      (await db.query('SELECT email FROM users WHERE id = $1', [id])).rows[0]?.email
    )
    
    if (!user) {
      throw new Error('User not found')
    }

    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password_hash)
    if (!isCurrentPasswordValid) {
      throw new Error('Current password is incorrect')
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 10)

    // Clears must_change_password — the user has now set a password of their
    // own choosing, proven by knowing the current one (invite's temp
    // password or an earlier real one), so there's nothing left to nag about.
    const query = `
      UPDATE users
      SET password_hash = $1, must_change_password = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `

    await db.query(query, [hashedNewPassword, id])
    return { success: true }
  }

  // Sets a password directly with no current-password check — used by the
  // password-reset flow, which authenticates the user via a one-time token
  // instead of their (forgotten) password. Also clears must_change_password:
  // resetting is the user choosing a password just as much as changePassword
  // above is, only proven via the reset token instead of the old password.
  static async setPassword(id, newPassword) {
    const hashedPassword = await bcrypt.hash(newPassword, 10)
    const query = `
      UPDATE users
      SET password_hash = $1, must_change_password = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND deleted_at IS NULL
      RETURNING id
    `
    const result = await db.query(query, [hashedPassword, id])
    return result.rows[0]
  }

  // `users` is a global table (one account can belong to several companies
  // via user_companies), so every admin action against another user's row
  // must independently confirm that user is a member of the acting admin's
  // own company — requireAdmin only proves the caller is an admin of *some*
  // company, not that the target is one of theirs. Without this join, any
  // company's admin could list, promote, deactivate or delete any user in
  // any other tenant. companyId is required (no default) so a call site can
  // never silently skip the check.
  static async deactivate(id, companyId) {
    const query = `
      UPDATE users
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND id IN (SELECT user_id FROM user_companies WHERE company_id = $2)
      RETURNING id, email, is_active
    `

    const result = await db.query(query, [id, companyId])
    return result.rows[0]
  }

  static async activate(id, companyId) {
    const query = `
      UPDATE users
      SET is_active = true, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND deleted_at IS NULL
        AND id IN (SELECT user_id FROM user_companies WHERE company_id = $2)
      RETURNING id, email, is_active
    `

    const result = await db.query(query, [id, companyId])
    return result.rows[0]
  }

  static async updateRole(id, role, companyId) {
    const query = `
      UPDATE users
      SET role = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND deleted_at IS NULL
        AND id IN (SELECT user_id FROM user_companies WHERE company_id = $3)
      RETURNING id, email, first_name, last_name, role, is_active
    `

    const result = await db.query(query, [role, id, companyId])
    return result.rows[0]
  }

  // Soft delete — the row stays for audit/FK integrity, but findByEmail and
  // findById both exclude deleted_at rows so the account can never log in or
  // be looked up again.
  static async softDelete(id, companyId) {
    const query = `
      UPDATE users
      SET deleted_at = CURRENT_TIMESTAMP, is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND deleted_at IS NULL
        AND id IN (SELECT user_id FROM user_companies WHERE company_id = $2)
      RETURNING id, email
    `

    const result = await db.query(query, [id, companyId])
    return result.rows[0]
  }

  // Invite flow: create the account with a random temp password the invitee
  // must change, and add them to the inviting admin's company — without this,
  // the new account would exist with no user_companies row at all, invisible
  // to findAll/deactivate/etc.'s company-membership scoping above and unable
  // to establish company context on login (middleware/auth.js's
  // establishCompany). The plaintext temp password is returned once here
  // only — callers pass it to the email service, and fall back to including
  // it in the API response if sending mail fails (dev mode).
  static async createWithTempPassword({ email, first_name, last_name, role }, companyId) {
    const tempPassword = crypto.randomBytes(9).toString('base64url')
    const user = await this.create({ email, password: tempPassword, first_name, last_name, role })
    const { Companies } = require('./Company')
    await Companies.assignUser(user.id, companyId, { role, is_primary: true })
    // Flags the account as still on the admin-generated password — cleared
    // by changePassword/setPassword once the invitee actually sets their own.
    await db.query('UPDATE users SET must_change_password = true WHERE id = $1', [user.id])
    user.must_change_password = true
    return { user, tempPassword }
  }

  // companyId is required — see the comment on deactivate/activate/updateRole/
  // softDelete above for why an unscoped list here would leak every tenant's
  // users to any admin.
  static async findAll(companyId, filters = {}) {
    let query = `
      SELECT id, email, first_name, last_name, role, is_active, last_login, created_at
      FROM users
      WHERE deleted_at IS NULL
        AND id IN (SELECT user_id FROM user_companies WHERE company_id = $1)
    `
    const values = [companyId]
    let paramCount = 1

    if (filters.role) {
      paramCount++
      query += ` AND role = $${paramCount}`
      values.push(filters.role)
    }

    if (filters.is_active !== undefined) {
      paramCount++
      query += ` AND is_active = $${paramCount}`
      values.push(filters.is_active)
    }

    if (filters.search) {
      paramCount++
      query += ` AND (first_name ILIKE $${paramCount} OR last_name ILIKE $${paramCount} OR email ILIKE $${paramCount})`
      values.push(`%${filters.search}%`)
    }

    query += ' ORDER BY created_at DESC'

    if (filters.limit) {
      paramCount++
      query += ` LIMIT $${paramCount}`
      values.push(filters.limit)
    }

    const result = await db.query(query, values)
    return result.rows
  }
}

module.exports = User