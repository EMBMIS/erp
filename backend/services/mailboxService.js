/**
 * Company and per-user mailboxes on embmis.com.
 *
 * A company mailbox (company-code@embmis.com) is created automatically the
 * moment a company is created. A user mailbox (firstname.company-code@embmis.com)
 * is created by an admin, one at a time, for a member of their own company.
 *
 * `mailboxes` is deliberately NOT row-level-isolated (see migration
 * 202608280901) — every query here filters `company_id` explicitly instead,
 * the same boundary `user_companies` already relies on and for the same
 * bootstrapping reason: the inbound webhook has to look an address up before
 * any company context exists.
 */

const { pool } = require('../config/database');

const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'example.com';
const DEFAULT_QUOTA_BYTES = Math.round(Number(process.env.MAILBOX_QUOTA_MB || 50) * 1024 * 1024);

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents (e.g. \u00e9 -> e)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'x';
}

async function addressTaken(address) {
  const { rows } = await pool.query(
    'SELECT 1 FROM mailboxes WHERE lower(address) = lower($1) AND deleted_at IS NULL',
    [address]
  );
  return rows.length > 0;
}

/** Appends -2, -3, ... to the local part until `${local}@domain` is free. */
async function firstFreeAddress(local) {
  let candidate = `${local}@${MAIL_DOMAIN}`;
  let n = 2;
  while (await addressTaken(candidate)) {
    candidate = `${local}-${n}@${MAIL_DOMAIN}`;
    n += 1;
  }
  return candidate;
}

/**
 * Create the company-level mailbox for a newly created company.
 *
 * Called right after Companies.create() in both places a company can come
 * into existence (routes/companies.js's admin-created path, and
 * routes/auth.js's self-service register-company path) — same "provisioning
 * step after creation" shape as ChartOfAccounts.seedFinanceMasterData.
 */
async function createCompanyMailbox(company, actorUserId) {
  const local = slugify(company.company_code || company.name);
  const address = await firstFreeAddress(local);

  const { rows } = await pool.query(
    `INSERT INTO mailboxes (company_id, user_id, address, display_name, quota_bytes, created_by)
     VALUES ($1, NULL, $2, $3, $4, $5)
     RETURNING *`,
    [company.id, address, company.name, DEFAULT_QUOTA_BYTES, actorUserId || null]
  );
  return rows[0];
}

/**
 * Create a mailbox for one user, within the acting admin's own company.
 *
 * `companyId` must come from `req.companyId` (the caller's own company),
 * never from the request body — this is what keeps one company's admin from
 * provisioning a mailbox that claims to belong to another company. The
 * caller is also responsible for confirming the target user is actually a
 * member of that company (same check routes/users.js already does via
 * user_companies) before calling this.
 */
async function createUserMailbox(user, companyId, companyName, actorUserId) {
  const firstName = slugify(user.first_name || user.email.split('@')[0]);
  const companySlug = slugify(companyName);
  const lastInitial = slugify((user.last_name || '')[0] || '');

  let local = `${firstName}.${companySlug}`;
  if (await addressTaken(`${local}@${MAIL_DOMAIN}`) && lastInitial) {
    local = `${firstName}.${lastInitial}.${companySlug}`;
  }
  const address = await firstFreeAddress(local);

  const { rows } = await pool.query(
    `INSERT INTO mailboxes (company_id, user_id, address, display_name, quota_bytes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [companyId, user.id, address, `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email,
     DEFAULT_QUOTA_BYTES, actorUserId || null]
  );
  return rows[0];
}

/**
 * Resolve the mailbox an inbound message should be stored in.
 *
 * Redirects win: if the recipient address has a mailbox_redirects row, mail
 * goes to the target mailbox (the source mailbox row stays — history intact —
 * but new mail to a deprecated address belongs in the target's inbox).
 * Otherwise the address's own mailbox is used. Every inbound webhook goes
 * through here, so the redirect works regardless of which path delivers
 * (Resend is the live MX for embmis.com; the routes/mailboxes.js webhook is
 * a legacy/secondary path).
 */
async function resolveInboundMailbox(address) {
  const redirected = await findRedirect(address);
  if (redirected) {
    console.log(`[mailbox] inbound redirect: ${address} -> ${redirected.address}`);
    return redirected;
  }
  return findByAddress(address);
}

async function findByAddress(address) {
  const { rows } = await pool.query(
    `SELECT * FROM mailboxes WHERE lower(address) = lower($1) AND deleted_at IS NULL AND status = 'ACTIVE'`,
    [address]
  );
  return rows[0] || null;
}

/**
 * Inbound redirect: mail to `sourceAddress` (a deprecated address that still
 * appears on contracts or in past emails) is stored in the target mailbox's
 * inbox. Consulted by the inbound webhook only after a direct address match
 * fails — see routes/mailboxes.js and migration 202609010100.
 */
async function findRedirect(sourceAddress) {
  const { rows } = await pool.query(
    `SELECT m.*
       FROM mailbox_redirects r
       JOIN mailboxes m ON m.id = r.target_mailbox_id
      WHERE lower(r.source_address) = lower($1)
        AND m.deleted_at IS NULL
        AND m.status = 'ACTIVE'`,
    [sourceAddress]
  );
  return rows[0] || null;
}

async function findById(id, companyId) {
  const { rows } = await pool.query(
    'SELECT * FROM mailboxes WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
    [id, companyId]
  );
  return rows[0] || null;
}

/** The mailbox belonging to one user within one company, if they have one. */
async function findByUser(userId, companyId) {
  const { rows } = await pool.query(
    'SELECT * FROM mailboxes WHERE user_id = $1 AND company_id = $2 AND deleted_at IS NULL',
    [userId, companyId]
  );
  return rows[0] || null;
}

async function listForCompany(companyId) {
  const { rows } = await pool.query(
    `SELECT m.*, u.first_name, u.last_name, u.email AS user_email
       FROM mailboxes m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.company_id = $1 AND m.deleted_at IS NULL
      ORDER BY m.user_id IS NULL DESC, m.created_at`,
    [companyId]
  );
  return rows;
}

module.exports = {
  MAIL_DOMAIN,
  DEFAULT_QUOTA_BYTES,
  slugify,
  createCompanyMailbox,
  createUserMailbox,
  findByAddress,
  findRedirect,
  resolveInboundMailbox,
  findById,
  findByUser,
  listForCompany,
};
