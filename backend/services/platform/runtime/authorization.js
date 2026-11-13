/**
 * Who is asking, what they may do, and which rows they may see.
 *
 * ===========================================================================
 * THE PRINCIPAL
 * ===========================================================================
 * Every runtime request carries a principal, built here and never by a route:
 *
 *   internal   an employee. Roles come from app_role_assignments, plus the
 *              company-ADMIN fallback. Their anchor is null: they act for the
 *              company, so "their own records" means the company's.
 *   external   a portal identity. Roles come from app_portal_memberships,
 *              which also fixes the surface. Their anchor is the canonical
 *              record they ARE — supplier 0f3a…, customer 91bc… — and it is
 *              read from the identity row, never from the request.
 *
 * ===========================================================================
 * WHY VISIBILITY IS A WHERE CLAUSE AND NOT A FILTER ON THE RESULT
 * ===========================================================================
 * `recordScopeClause()` returns SQL that is ANDed into the query before it
 * runs. Nothing downstream can drop it, because nothing downstream sees the
 * query being built — data.js takes the clause and concatenates it in one
 * place. Filtering after the fact would mean the rows were read, which makes
 * every count, aggregate and pagination number wrong even when the list looks
 * right, and makes a single missed call site a full disclosure.
 *
 * For an external principal on an entity with an anchor, the clause is
 *
 *     "supplier_id" = $n     -- $n bound to the identity's own anchor id
 *
 * There is no code path that produces `TRUE` for an external principal on an
 * anchored entity: `anchorClause` throws if the anchor is missing, rather than
 * degrading to something permissive.
 */

const { pool } = require('../db');
const { quoteIdent } = require('../identifiers');
const { EXTERNAL_AUDIENCES } = require('../spec/types');
const canonical = require('../spec/canonical');

class AuthorizationError extends Error {
  constructor(message, code = 'FORBIDDEN', status = 403) {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Build the principal for an internal (employee) request.
 *
 * `platformRole` is the EMBMIS-wide role from `users`. It is used for exactly
 * one thing — the ADMIN fallback — and never as an application permission.
 */
async function internalPrincipal({ companyId, instance, spec, userId, platformRole, surfaceKey }) {
  const { rows } = await pool.query(
    `SELECT role_key FROM app_role_assignments
      WHERE app_instance_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [instance.id, userId]
  );
  let roleKeys = rows.map((r) => r.role_key);

  const internalRoles = (spec.security?.roles || []).filter((r) => !EXTERNAL_AUDIENCES.has(r.audience));
  if (!roleKeys.length && String(platformRole).toUpperCase() === 'ADMIN') {
    // See migration 202609040400: without this, the person who just deployed an
    // application cannot open it. Internal roles only — an ADMIN is not a
    // supplier.
    roleKeys = internalRoles.map((r) => r.key);
  }

  const roles = internalRoles.filter((r) => roleKeys.includes(r.key));
  if (!roles.length) {
    throw new AuthorizationError(
      'You have no role in this application. Ask an administrator to assign you one.',
      'NO_ROLE'
    );
  }

  const surface = resolveSurface(spec, surfaceKey, roles);
  return {
    kind: 'internal',
    companyId,
    instanceId: instance.id,
    userId,
    // The EMBMIS role, carried only so a live measure answers with the same
    // row visibility the person has everywhere else (e.g. whose customer
    // orders they may see). Never an application permission.
    platformRole: platformRole ? String(platformRole).toUpperCase() : null,
    externalIdentityId: null,
    anchor: null,
    roles,
    roleKeys: roles.map((r) => r.key),
    surface,
    label: 'employee',
  };
}

/**
 * Build the principal for an external (portal) request.
 *
 * The membership fixes the surface and the role; the identity fixes the anchor.
 * Neither is influenced by anything in the request beyond the session token
 * that identified the caller.
 */
async function externalPrincipal({ companyId, instance, spec, identity, surfaceKey }) {
  if (identity.status !== 'active') {
    throw new AuthorizationError('This portal account is not active.', 'IDENTITY_INACTIVE', 401);
  }
  const { rows } = await pool.query(
    `SELECT * FROM app_portal_memberships
      WHERE external_identity_id = $1 AND app_instance_id = $2 AND status = 'active'`,
    [identity.id, instance.id]
  );
  if (!rows.length) {
    throw new AuthorizationError('This portal account has no access to this application.', 'NO_MEMBERSHIP');
  }
  const membership = surfaceKey ? rows.find((m) => m.surface_key === surfaceKey) : rows[0];
  if (!membership) {
    throw new AuthorizationError('This portal account has no access to that surface.', 'NO_MEMBERSHIP');
  }

  const surface = (spec.surfaces || []).find((s) => s.key === membership.surface_key);
  if (!surface) {
    throw new AuthorizationError('That surface no longer exists in this application.', 'SURFACE_GONE', 404);
  }
  if (!EXTERNAL_AUDIENCES.has(surface.audience)) {
    // A membership pointing at an internal surface is a data-integrity problem,
    // not a request to serve. Refuse rather than reason about it.
    throw new AuthorizationError('That surface is not an external surface.', 'SURFACE_NOT_EXTERNAL');
  }

  const role = (spec.security?.roles || []).find(
    (r) => r.key === membership.role_key && EXTERNAL_AUDIENCES.has(r.audience)
  );
  if (!role) {
    throw new AuthorizationError('The role this account holds no longer exists in this application.', 'ROLE_GONE');
  }

  if (identity.subject_kind !== 'public' && !identity.subject_id) {
    throw new AuthorizationError(
      'This portal account is not linked to a supplier or customer record, so there is no way to determine which records belong to it.',
      'NO_ANCHOR'
    );
  }

  return {
    kind: 'external',
    companyId,
    instanceId: instance.id,
    userId: null,
    externalIdentityId: identity.id,
    anchor: { kind: identity.subject_kind, id: identity.subject_id },
    roles: [role],
    roleKeys: [role.key],
    surface,
    label: identity.display_name || identity.email,
  };
}

function resolveSurface(spec, surfaceKey, roles) {
  const surfaces = spec.surfaces || [];
  const reachable = surfaces.filter((s) => s.roles.some((k) => roles.some((r) => r.key === k)));
  if (surfaceKey) {
    const wanted = reachable.find((s) => s.key === surfaceKey);
    if (!wanted) {
      throw new AuthorizationError(`You have no role that reaches surface "${surfaceKey}".`, 'SURFACE_FORBIDDEN');
    }
    return wanted;
  }
  const internal = reachable.find((s) => !EXTERNAL_AUDIENCES.has(s.audience));
  if (!internal && !reachable.length) {
    throw new AuthorizationError('No surface of this application is reachable with your roles.', 'NO_SURFACE');
  }
  return internal || reachable[0];
}

// ---------------------------------------------------------------------------
// Permission decisions
// ---------------------------------------------------------------------------

/** Union of a principal's permissions on one entity. */
function permissionsFor(principal, entityKey) {
  const set = new Set();
  principal.roles.forEach((role) => {
    (role.permissions?.[entityKey] || []).forEach((p) => set.add(p));
  });
  return set;
}

function can(principal, entityKey, permission) {
  return permissionsFor(principal, entityKey).has(permission);
}

function assertCan(principal, entityKey, permission) {
  if (!can(principal, entityKey, permission)) {
    throw new AuthorizationError(
      `Your role${principal.roleKeys.length > 1 ? 's' : ''} (${principal.roleKeys.join(', ')}) cannot ${permission} ${entityKey}.`,
      'PERMISSION_DENIED'
    );
  }
}

/**
 * The record scope this principal has on an entity.
 *
 * WIDEST wins among the roles they hold, for the same reason permissions are a
 * union: roles are grants. A person who is both a manager (scope `all`) and a
 * contributor (scope `own`) is a manager, and demoting them for holding the
 * lesser role as well would be a surprise nobody could debug from the
 * specification.
 *
 * With one hard exception. An EXTERNAL principal that any of its roles
 * anchor-scopes is anchor-scoped, full stop. External identities hold exactly
 * one membership per surface today, so this should never fire — which is
 * precisely why it is worth having: the day that changes, the failure mode is
 * a supplier seeing every supplier's records, and this is the line that stops
 * it rather than a review that might not happen.
 */
function recordScopeFor(principal, entityKey) {
  const order = { none: 0, anchor: 1, own: 2, team: 3, all: 4 };
  const declared = principal.roles
    .map((role) => role.record_scope?.[entityKey])
    .filter(Boolean);

  if (principal.kind === 'external' && declared.includes('anchor')) return 'anchor';

  let best = null;
  declared.forEach((scope) => {
    if (best === null || order[scope] > order[best]) best = scope;
  });
  if (best !== null) return best;
  // An external principal with no declared scope gets `none`, not `all`. The
  // validator refuses specifications that leave it unset, so reaching here
  // means something is wrong — and the safe answer to "I do not know what this
  // person may see" is "nothing".
  return principal.kind === 'external' ? 'none' : 'all';
}

/**
 * The SQL that limits a query to the rows this principal may see.
 *
 * @returns {{sql: string, params: any[]}} — `sql` is ANDed into the WHERE; it
 *          contains only quoted identifiers, fixed operators and `$n`
 *          placeholders, with every value in `params`.
 */
function recordScopeClause(principal, entityKey, entity, paramOffset = 0, alias = 't') {
  const scope = recordScopeFor(principal, entityKey);
  const params = [];
  const placeholder = () => `$${paramOffset + params.length}`;
  // Always alias-qualified: the query this lands in joins reference tables, and
  // a bare column name that becomes ambiguous is an error at best and the wrong
  // table's column at worst.
  const col = (name) => `${alias}.${quoteIdent(name)}`;

  switch (scope) {
    case 'all':
      return { sql: 'TRUE', params };

    case 'none':
      // Not an error: a role may legitimately reach an entity for writes only,
      // or a surface may show a page whose data this particular role cannot
      // read. FALSE returns an empty list, which is the honest answer.
      return { sql: 'FALSE', params };

    case 'anchor': {
      if (!entity?.anchor?.field) {
        throw new AuthorizationError(
          `Entity "${entityKey}" is anchor-scoped for your role but declares no anchor field, so there is no rule that says which records are yours.`,
          'ANCHOR_MISSING', 500
        );
      }
      if (!principal.anchor?.id) {
        throw new AuthorizationError(
          'Anchor-scoped access needs an identity linked to a supplier or customer record.',
          'ANCHOR_MISSING'
        );
      }
      const expectedKind = entity.anchor.kind;
      if (expectedKind && principal.anchor.kind !== expectedKind) {
        throw new AuthorizationError(
          `This account is a ${principal.anchor.kind}, but "${entityKey}" is anchored to a ${expectedKind}.`,
          'ANCHOR_KIND_MISMATCH'
        );
      }
      params.push(principal.anchor.id);
      return { sql: `${col(entity.anchor.field)} = ${placeholder()}::uuid`, params };
    }

    case 'own': {
      if (principal.kind === 'external') {
        params.push(principal.externalIdentityId);
        return { sql: `${col('created_by_external_id')} = ${placeholder()}::uuid`, params };
      }
      params.push(principal.userId);
      return { sql: `${col('created_by_user_id')} = ${placeholder()}::uuid`, params };
    }

    case 'team':
      // Team scope needs an org structure this platform does not yet model.
      // Falling back to `all` would silently widen it, so it is refused instead
      // and the specification has to say something it can actually enforce.
      throw new AuthorizationError(
        `Record scope "team" is declared on "${entityKey}" but EMBMIS has no team model to resolve it against. Use "own", "anchor" or "all".`,
        'SCOPE_UNSUPPORTED', 501
      );

    default:
      return { sql: 'FALSE', params };
  }
}

// ---------------------------------------------------------------------------
// Field-level access
// ---------------------------------------------------------------------------

/**
 * Which of an entity's fields this principal may read, and which may be written.
 *
 * The default direction matters: a field with no explicit rule is readable by
 * an internal principal and — for an external one — readable only if it is not
 * marked sensitive. So a new field added to an application does not silently
 * become visible on a portal just because nobody wrote a rule for it.
 */
function fieldAccess(principal, entityKey, entity) {
  const readable = new Set();
  const writable = new Set();
  const external = principal.kind === 'external';
  const RANK = { hidden: 0, read: 1, write: 2 };

  /**
   * What ONE role says about one field.
   *
   * A role with no rule for a field is not silent about it — it means "no
   * restriction", which is a stronger statement than "hidden" and has to be
   * computed as such, or a role that mentions the field would override one
   * that deliberately does not.
   *
   * The defaults differ by audience, in the direction that is safe to be wrong
   * in: a field added to an application later is readable internally and, for
   * an external audience, readable only if it is not marked sensitive — and
   * writable by an external role only when a rule says so explicitly. Being
   * able to read your own claim does not imply being able to change its status.
   */
  const verdictFor = (role, fieldName, isComputed, isSensitive) => {
    const explicit = role.field_access?.[entityKey]?.[fieldName];
    if (explicit) return isComputed && explicit === 'write' ? 'read' : explicit;
    if (external) return isSensitive ? 'hidden' : 'read';
    return isComputed ? 'read' : 'write';
  };

  /**
   * Across the roles held, the MOST permissive verdict wins — the same way
   * permissions combine, because roles are grants. A person who is both a
   * manager and a contributor is a manager; taking a field away from them for
   * also holding the lesser role would be a surprise nobody could debug from
   * reading the specification.
   *
   * Safe because the two cases that matter are handled elsewhere: an external
   * principal holds exactly one role per surface, and the validator refuses a
   * specification that leaves a sensitive field visible to ANY external role
   * on a surface.
   */
  const consider = (fieldName, isComputed, isSensitive) => {
    let best = null;
    principal.roles.forEach((role) => {
      const verdict = verdictFor(role, fieldName, isComputed, isSensitive);
      if (best === null || RANK[verdict] > RANK[best]) best = verdict;
    });
    if (best === null || best === 'hidden') return;
    readable.add(fieldName);
    if (best === 'write' && !isComputed) writable.add(fieldName);
  };

  (entity.fields || []).forEach((f) => consider(f.name, false, f.sensitive));
  (entity.computed || []).forEach((c) => consider(c.name, true, false));

  return { readable, writable };
}

function assertFieldWritable(principal, entityKey, entity, fieldNames) {
  const { writable } = fieldAccess(principal, entityKey, entity);
  const refused = fieldNames.filter((f) => !writable.has(f));
  if (refused.length) {
    throw new AuthorizationError(
      `Your role cannot set ${refused.map((f) => `"${f}"`).join(', ')} on ${entityKey}.`,
      'FIELD_DENIED'
    );
  }
}

/**
 * Which canonical columns this principal may see.
 *
 * An external principal is limited to the columns the canonical catalogue marks
 * shareable, whatever the specification asked for. The validator already
 * refuses a specification that puts an internal column on a portal page; this
 * is the runtime saying the same thing again, because a validator can be
 * bypassed by a specification deployed before a rule existed and a runtime
 * cannot.
 */
function canonicalReadableColumns(principal, entityKey) {
  const entity = canonical.entity(entityKey);
  if (!entity) return [];
  const names = Object.keys(entity.columns);
  if (principal.kind !== 'external') return names;
  return names.filter((n) => entity.columns[n].shared);
}

/** May this principal see this canonical record at all? */
function canonicalScopeClause(principal, entityKey, alias = 't', paramOffset = 0) {
  const entity = canonical.entity(entityKey);
  const params = [];
  if (principal.kind !== 'external') return { sql: 'TRUE', params };
  if (!entity) return { sql: 'FALSE', params };

  // An external identity may see the canonical record it IS, and nothing else
  // of that kind. A supplier reading `suppliers` sees one row: their own.
  if (entity.anchorKind && entity.anchorKind === principal.anchor?.kind) {
    params.push(principal.anchor.id);
    return { sql: `${alias}.${quoteIdent('id')} = $${paramOffset + 1}::uuid`, params };
  }
  // Canonical records reached through their own anchor column (a purchase order
  // belonging to this supplier).
  const anchorColumn = Object.entries(entity.columns).find(
    ([, col]) => col.type === 'reference' && col.target && canonical.entity(col.target)?.anchorKind === principal.anchor?.kind
  );
  if (anchorColumn) {
    params.push(principal.anchor.id);
    return { sql: `${alias}.${quoteIdent(anchorColumn[0])} = $${paramOffset + 1}::uuid`, params };
  }
  return { sql: 'FALSE', params };
}

/** Does the principal hold approval authority over a workflow transition? */
function hasApprovalAuthority(principal, workflowKey, transitionKey) {
  const ref = `${workflowKey}.${transitionKey}`;
  return principal.roles.some((r) => (r.approval_authority || []).includes(ref));
}

module.exports = {
  AuthorizationError,
  internalPrincipal,
  externalPrincipal,
  resolveSurface,
  permissionsFor,
  can,
  assertCan,
  recordScopeFor,
  recordScopeClause,
  fieldAccess,
  assertFieldWritable,
  canonicalReadableColumns,
  canonicalScopeClause,
  hasApprovalAuthority,
};
