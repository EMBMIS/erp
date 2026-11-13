/**
 * Portal identities: invitation, credentials, sessions, membership, revocation.
 *
 * ===========================================================================
 * WHY THIS IS NOT `users`
 * ===========================================================================
 * See migration 202609040200 for the modelling argument. The operational
 * consequences that live in this file:
 *
 *   • A portal account is ANCHORED to a canonical record. The anchor is set at
 *     invitation, by an employee who could already see that record, and it is
 *     never settable by the account holder. Everything the account can see
 *     follows from it.
 *   • Sessions are opaque tokens, stored as sha256 and looked up per request.
 *     A JWT would be faster and would make revocation a lie: revoking a
 *     supplier's access after a dispute has to take effect on the next request,
 *     not when their token happens to expire.
 *   • Failed logins lock the account rather than merely slowing it down, and
 *     the lock is on the identity row so it survives a restart and applies
 *     across every process.
 *   • Every failure answer is the same one. "No such account" and "wrong
 *     password" as distinguishable answers turn a login form into a tool for
 *     enumerating a company's supplier list.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { quoteIdent } = require('../identifiers');
const companyContext = require('../../companyContext');
const canonical = require('../spec/canonical');
const registry = require('../registry');

class IdentityError extends Error {
  constructor(message, code = 'IDENTITY_ERROR', status = 400) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
    this.status = status;
  }
}

const INVITE_TTL_HOURS = 14 * 24;
const SESSION_TTL_HOURS = 12;
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

/**
 * Invite an external person, anchored to a canonical record.
 *
 * The anchor is verified to exist inside the inviting company's own data before
 * the identity is created — an invitation naming a supplier id from another
 * company would otherwise create an account with a scope that resolves to
 * somebody else's rows.
 *
 * @returns {{identity, inviteToken}} The raw token is returned ONCE. Only its
 *          hash is stored, so a lost invitation is reissued, never recovered.
 */
async function invite({
  companyId, subjectKind, subjectId, email, displayName = '', invitedBy = null,
}) {
  if (!canonical.ANCHOR_ENTITIES[subjectKind] && subjectKind !== 'public' && subjectKind !== 'partner') {
    throw new IdentityError(`"${subjectKind}" is not a kind of external identity this platform supports.`, 'BAD_SUBJECT_KIND');
  }
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
    throw new IdentityError('That is not a usable email address.', 'BAD_EMAIL');
  }

  if (subjectKind !== 'public') {
    if (!subjectId) {
      throw new IdentityError(
        `A ${subjectKind} identity must be linked to the ${subjectKind} record it speaks for.`,
        'ANCHOR_REQUIRED'
      );
    }
    await assertAnchorBelongsToCompany(companyId, subjectKind, subjectId);
  }

  const token = newToken();
  const { rows } = await companyContext.withCompany(companyId, async (client) => client.query(
    `INSERT INTO app_external_identities
       (company_id, subject_kind, subject_id, email, display_name, status,
        invite_token_hash, invite_expires_at, invited_by)
     VALUES ($1, $2, $3, $4, $5, 'invited', $6, CURRENT_TIMESTAMP + ($7 || ' hours')::interval, $8)
     ON CONFLICT (company_id, lower(email)) DO UPDATE
       SET invite_token_hash = EXCLUDED.invite_token_hash,
           invite_expires_at = EXCLUDED.invite_expires_at,
           display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), app_external_identities.display_name),
           -- Re-inviting a revoked account brings it back as invited, not as
           -- active: it has to be accepted again, with a new credential.
           status = CASE WHEN app_external_identities.status = 'active' THEN 'active' ELSE 'invited' END,
           updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [companyId, subjectKind, subjectKind === 'public' ? null : subjectId, normalizedEmail,
      displayName, sha256(token), String(INVITE_TTL_HOURS), invitedBy]
  ));

  return { identity: redact(rows[0]), inviteToken: token };
}

/**
 * Does this anchor record actually belong to the inviting company?
 *
 * Runs inside the company context, so row-level security answers the question
 * rather than a WHERE clause someone has to remember to write.
 */
async function assertAnchorBelongsToCompany(companyId, subjectKind, subjectId) {
  const entityKey = canonical.ANCHOR_ENTITIES[subjectKind];
  if (!entityKey) return; // partner identities have no canonical anchor
  const entity = canonical.entity(entityKey);
  const found = await companyContext.withCompany(companyId, async (client) => {
    const { rows } = await client.query(
      // The table name comes from the canonical catalogue in this repository,
      // never from a request — and still goes through quoteIdent, because
      // "comes from a trusted place" is a claim about today's call sites.
      `SELECT 1 FROM ${quoteIdent(entity.table)} WHERE id = $1 LIMIT 1`,
      [subjectId]
    );
    return rows.length > 0;
  });
  if (!found) {
    throw new IdentityError(
      `No ${subjectKind} with that id exists in your company's records.`,
      'ANCHOR_NOT_FOUND', 404
    );
  }
}

/** Turn an invitation into a working account by setting a password. */
/**
 * Resolve an invitation token to its company. Same reasoning as resolveSession.
 */
async function companyForInvite(token) {
  if (!token) return null;
  const { rows } = await pool.query('SELECT public.app_portal_invite_company($1) AS company_id', [sha256(token)]);
  return rows[0]?.company_id || null;
}

async function acceptInvite({ companyId, token, password }) {
  if (String(password || '').length < 12) {
    throw new IdentityError('Choose a password of at least 12 characters.', 'WEAK_PASSWORD');
  }
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await companyContext.withCompany(companyId, async (client) => client.query(
    `UPDATE app_external_identities
        SET password_hash = $2, status = 'active', invite_token_hash = NULL,
            invite_expires_at = NULL, failed_logins = 0, locked_until = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE invite_token_hash = $1
        AND invite_expires_at > CURRENT_TIMESTAMP
        AND status <> 'revoked'
      RETURNING *`,
    [sha256(token), hash]
  ));
  if (!rows.length) {
    throw new IdentityError('That invitation is not valid any more. Ask for a new one.', 'INVITE_INVALID', 410);
  }
  return redact(rows[0]);
}

/**
 * Sign in. One failure message for every failure reason.
 */
async function authenticate({ companyId, email, password, userAgent = null }) {
  const generic = new IdentityError('Those details do not match an active portal account.', 'AUTH_FAILED', 401);
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const identity = await companyContext.withCompany(companyId, async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM app_external_identities WHERE company_id = $1 AND lower(email) = $2',
      [companyId, normalizedEmail]
    );
    return rows[0] || null;
  });

  // Hash a throwaway even when there is no account, so the response time does
  // not distinguish "no such account" from "wrong password".
  if (!identity || !identity.password_hash) {
    await bcrypt.compare(String(password || ''), '$2a$12$0000000000000000000000000000000000000000000000000000');
    throw generic;
  }
  if (identity.status !== 'active') throw generic;
  if (identity.locked_until && new Date(identity.locked_until) > new Date()) {
    throw new IdentityError(
      'This account is temporarily locked after too many failed attempts. Try again shortly.',
      'LOCKED', 429
    );
  }

  const ok = await bcrypt.compare(String(password || ''), identity.password_hash);
  if (!ok) {
    await companyContext.withCompany(companyId, async (client) => client.query(
      `UPDATE app_external_identities
          SET failed_logins = failed_logins + 1,
              locked_until = CASE WHEN failed_logins + 1 >= $2
                                  THEN CURRENT_TIMESTAMP + ($3 || ' minutes')::interval
                                  ELSE locked_until END
        WHERE id = $1`,
      [identity.id, MAX_FAILED_LOGINS, String(LOCKOUT_MINUTES)]
    ));
    throw generic;
  }

  const token = newToken();
  await companyContext.withCompany(companyId, async (client) => {
    await client.query(
      `INSERT INTO app_portal_sessions (company_id, external_identity_id, token_hash, expires_at, user_agent)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP + ($4 || ' hours')::interval, $5)`,
      [companyId, identity.id, sha256(token), String(SESSION_TTL_HOURS), String(userAgent || '').slice(0, 500)]
    );
    await client.query(
      `UPDATE app_external_identities
          SET last_login_at = CURRENT_TIMESTAMP, failed_logins = 0, locked_until = NULL
        WHERE id = $1`,
      [identity.id]
    );
  });

  return { token, expiresInHours: SESSION_TTL_HOURS, identity: redact(identity) };
}

/**
 * Resolve a session token to an identity.
 *
 * Checked against the identity's CURRENT status on every request, not against
 * what it was when the session was issued. Revoking an account ends its
 * sessions at once.
 */
async function resolveSession(token) {
  if (!token) return null;
  const hash = sha256(token);

  // Two steps, and the order is the whole point. A portal request arrives with
  // no company, so the ordinary policy on app_portal_sessions would show it
  // nothing — including its own session. app_portal_session_company() (migration
  // 202609040500) is a narrow SECURITY DEFINER function that resolves the hash
  // to a company id and returns nothing else.
  const { rows: resolved } = await pool.query('SELECT public.app_portal_session_company($1) AS company_id', [hash]);
  const companyId = resolved[0]?.company_id;
  if (!companyId) return null;

  // From here on it is an ordinary request in an ordinary company context: the
  // identity row is read through the same policy as everything else, so a
  // session pointing at an identity that has since been revoked resolves to
  // nothing rather than to a stale principal.
  const { rows } = await companyContext.withCompany(companyId, async (client) => client.query(
    `SELECT i.*, s.id AS session_id, s.expires_at
       FROM app_portal_sessions s
       JOIN app_external_identities i ON i.id = s.external_identity_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > CURRENT_TIMESTAMP
        AND i.status = 'active'`,
    [hash]
  ));
  return rows[0] || null;
}

async function endSession(token) {
  await pool.query(
    'UPDATE app_portal_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = $1 AND revoked_at IS NULL',
    [sha256(token)]
  );
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/**
 * Give an identity access to one surface of one application instance.
 *
 * The surface must be external and the role must belong to that surface and
 * match its audience — the specification's own rules, re-checked here, because
 * a membership is written once and read forever.
 */
async function grantMembership({ companyId, identityId, instanceId, surfaceKey, roleKey, grantedBy = null }) {
  const instance = await registry.getInstanceById(instanceId);
  if (!instance || instance.company_id !== companyId) {
    throw new IdentityError('No such application instance.', 'INSTANCE_NOT_FOUND', 404);
  }
  const version = instance.version_id ? await registry.getVersion(instance.version_id) : null;
  const spec = version?.spec;
  if (!spec) throw new IdentityError('That application is not deployed yet.', 'NOT_DEPLOYED', 409);

  const surface = (spec.surfaces || []).find((s) => s.key === surfaceKey);
  if (!surface) throw new IdentityError(`That application has no surface "${surfaceKey}".`, 'SURFACE_NOT_FOUND', 404);
  if (surface.audience === 'internal') {
    throw new IdentityError('An external identity cannot be given an internal surface.', 'SURFACE_INTERNAL');
  }
  if (!surface.roles.includes(roleKey)) {
    throw new IdentityError(`Role "${roleKey}" is not granted by surface "${surfaceKey}".`, 'ROLE_NOT_ON_SURFACE');
  }
  const role = (spec.security?.roles || []).find((r) => r.key === roleKey);
  if (!role || role.audience !== surface.audience) {
    throw new IdentityError(`Role "${roleKey}" does not belong to the ${surface.audience} audience.`, 'ROLE_AUDIENCE');
  }

  const identity = await getIdentity(companyId, identityId);
  if (surface.audience !== 'public' && identity.subject_kind !== surface.audience) {
    throw new IdentityError(
      `This is a ${identity.subject_kind} account and "${surfaceKey}" is the ${surface.audience} surface.`,
      'AUDIENCE_MISMATCH'
    );
  }

  const { rows } = await companyContext.withCompany(companyId, async (client) => client.query(
    `INSERT INTO app_portal_memberships
       (company_id, external_identity_id, app_instance_id, surface_key, role_key, scope, status, granted_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
     ON CONFLICT (external_identity_id, app_instance_id, surface_key)
       DO UPDATE SET role_key = EXCLUDED.role_key, scope = EXCLUDED.scope,
                     status = 'active', revoked_at = NULL, granted_by = EXCLUDED.granted_by
     RETURNING *`,
    [companyId, identityId, instanceId, surfaceKey, roleKey,
      JSON.stringify({ anchorKind: identity.subject_kind, anchorId: identity.subject_id }), grantedBy]
  ));

  await registry.recordEvent({
    companyId,
    applicationId: instance.application_id,
    instanceId,
    eventType: 'portal.membership_granted',
    provenanceClass: 'authorization',
    actorKind: grantedBy ? 'user' : 'system',
    actorId: grantedBy,
    summary: `Granted ${identity.email} the "${roleKey}" role on the ${surfaceKey} surface.`,
    detail: { identityId, surfaceKey, roleKey, anchorKind: identity.subject_kind },
  });

  return rows[0];
}

async function revokeMembership({ companyId, membershipId, revokedBy = null }) {
  const { rows } = await companyContext.withCompany(companyId, async (client) => client.query(
    `UPDATE app_portal_memberships SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND company_id = $2 RETURNING *`,
    [membershipId, companyId]
  ));
  if (!rows.length) throw new IdentityError('No such membership.', 'MEMBERSHIP_NOT_FOUND', 404);
  await registry.recordEvent({
    companyId,
    instanceId: rows[0].app_instance_id,
    eventType: 'portal.membership_revoked',
    provenanceClass: 'authorization',
    actorKind: revokedBy ? 'user' : 'system',
    actorId: revokedBy,
    summary: `Revoked portal access to the ${rows[0].surface_key} surface.`,
    detail: { membershipId },
  });
  return rows[0];
}

/**
 * Revoke an identity entirely: no memberships, no live sessions, no login.
 *
 * All three in one transaction, because revoking access and leaving a live
 * session behind is not revocation.
 */
async function revokeIdentity({ companyId, identityId, revokedBy = null }) {
  await companyContext.withCompany(companyId, async (client) => {
    await client.query(
      `UPDATE app_external_identities
          SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, revoked_by = $3,
              password_hash = NULL, invite_token_hash = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND company_id = $2`,
      [identityId, companyId, revokedBy]
    );
    await client.query(
      `UPDATE app_portal_memberships SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
        WHERE external_identity_id = $1 AND company_id = $2 AND status <> 'revoked'`,
      [identityId, companyId]
    );
    await client.query(
      `UPDATE app_portal_sessions SET revoked_at = CURRENT_TIMESTAMP
        WHERE external_identity_id = $1 AND revoked_at IS NULL`,
      [identityId]
    );
  });
  await registry.recordEvent({
    companyId,
    eventType: 'portal.identity_revoked',
    provenanceClass: 'authorization',
    actorKind: revokedBy ? 'user' : 'system',
    actorId: revokedBy,
    summary: 'Revoked a portal identity, its memberships and its live sessions.',
    detail: { identityId },
  });
  return { id: identityId, status: 'revoked' };
}

async function getIdentity(companyId, identityId) {
  const { rows } = await companyContext.withCompany(companyId, async (client) => client.query(
    'SELECT * FROM app_external_identities WHERE id = $1 AND company_id = $2',
    [identityId, companyId]
  ));
  if (!rows.length) throw new IdentityError('No such portal identity.', 'IDENTITY_NOT_FOUND', 404);
  return rows[0];
}

async function listIdentities({ companyId, instanceId = null }) {
  return companyContext.withCompany(companyId, async (client) => {
    const params = [companyId];
    let join = '';
    if (instanceId) {
      params.push(instanceId);
      join = `JOIN app_portal_memberships m ON m.external_identity_id = i.id AND m.app_instance_id = $2 AND m.status = 'active'`;
    }
    const { rows } = await client.query(
      `SELECT DISTINCT i.id, i.subject_kind, i.subject_id, i.email, i.display_name, i.status,
              i.last_login_at, i.created_at
         FROM app_external_identities i ${join}
        WHERE i.company_id = $1
        ORDER BY i.created_at DESC
        LIMIT 500`,
      params
    );
    return rows;
  });
}

async function listMemberships({ companyId, identityId }) {
  return companyContext.withCompany(companyId, async (client) => {
    const { rows } = await client.query(
      `SELECT m.id, m.surface_key, m.role_key, m.status, m.granted_at,
              a.app_key, a.name AS application_name, i.id AS instance_id
         FROM app_portal_memberships m
         JOIN app_company_instances i ON i.id = m.app_instance_id
         JOIN applications a ON a.id = i.application_id
        WHERE m.external_identity_id = $1 AND m.company_id = $2
        ORDER BY a.name`,
      [identityId, companyId]
    );
    return rows;
  });
}

/** Never return a hash or a token, not even to an administrator. */
function redact(identity) {
  if (!identity) return null;
  const {
    password_hash: _p, invite_token_hash: _i, ...safe
  } = identity;
  return safe;
}

module.exports = {
  IdentityError,
  invite,
  acceptInvite,
  companyForInvite,
  authenticate,
  resolveSession,
  endSession,
  grantMembership,
  revokeMembership,
  revokeIdentity,
  getIdentity,
  listIdentities,
  listMemberships,
  redact,
  SESSION_TTL_HOURS,
};
