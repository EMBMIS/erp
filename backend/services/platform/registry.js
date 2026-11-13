/**
 * The application registry: applications, their versions, each company's
 * instance of them, and the authoritative table map.
 *
 * ===========================================================================
 * THE RESOLUTION CHAIN
 * ===========================================================================
 *     company + app_key
 *       -> applications             (the global design)
 *       -> app_company_instances    (this company's installation)
 *       -> app_instance_tables      (logical entity -> physical table)
 *
 * `resolveTable()` at the bottom of this file is the only function in EMBMIS
 * that returns a generated table's physical name, and it takes an instance id
 * and a logical entity key. There is no function that takes a table name. That
 * is the whole defence: a request can ask for `findings`, and the server
 * decides what that means; a request cannot ask for
 * `app_ab12_cd34_findings`, because nothing would accept it.
 *
 * VISIBILITY OF THE GLOBAL TABLES
 * ---------------------------------------------------------------------------
 * `applications` and `application_versions` have no company_id and therefore no
 * RLS policy — a design belongs to no company. Their visibility rule lives in
 * `listForCompany` and `assertVisible` here: a company sees a private
 * application only if it authored it or holds an instance of it. Every read
 * path that returns application definitions goes through one of those two.
 */

const crypto = require('crypto');
const { pool, applicationRole } = require('./db');
const identifiers = require('./identifiers');

class RegistryError extends Error {
  constructor(message, code = 'REGISTRY_ERROR', status = 400) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
    this.status = status;
  }
}

const q = (client) => client || pool;

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------
async function createApplication({
  appKey, name, description = '', icon = 'layout-grid', category = 'operations',
  kind = 'generated', originCompanyId = null, createdBy = null, visibility = 'private',
}, client) {
  if (!identifiers.isLogicalKey(appKey, { maxLength: 47 })) {
    throw new RegistryError(`Application key "${appKey}" is not a legal key.`, 'INVALID_APP_KEY');
  }
  const { rows } = await q(client).query(
    `INSERT INTO applications (app_key, name, description, icon, category, kind, visibility, origin_company_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [appKey, name, description, icon, category, kind, visibility, originCompanyId, createdBy]
  );
  return rows[0];
}

async function getApplicationByKey(appKey, client) {
  const { rows } = await q(client).query('SELECT * FROM applications WHERE app_key = $1', [appKey]);
  return rows[0] || null;
}

async function getApplication(id, client) {
  const { rows } = await q(client).query('SELECT * FROM applications WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * A key the company may use for a new application.
 *
 * Application keys are global, so two companies both asking for "supplier
 * quality" would collide. Rather than failing, the second gets a suffixed key —
 * deterministically derived from its own company id, so re-running the same
 * request produces the same key rather than a growing pile of _2, _3, _4.
 */
const MAX_KEY_ATTEMPTS = 50;

/**
 * A key that is FREE, derived from the one the designer wanted.
 *
 * Every candidate is checked against the registry, including the derived one.
 * An earlier version returned the derived key whenever the asking company
 * already owned it — on the theory that a company's own key is "theirs" — and
 * that was wrong in the one case people actually hit: designing a second
 * application the analyser names the same thing. The key was returned, the
 * INSERT hit uq_applications_key, and the build died at the very last step
 * with a database error. A key names a DESIGN, not a company; two designs need
 * two keys even when one company made both.
 *
 * The suffix stays derived from the company for the first alternative, so the
 * common case (a second company designing the same kind of application) still
 * produces a stable, meaningful key rather than a counter.
 */
async function availableApplicationKey(desired, companyId, client) {
  const base = desired.slice(0, 40);
  if (!await getApplicationByKey(base, client)) return base;

  const suffix = identifiers.shortHash(`company:${companyId}`, 6);
  const derived = `${base}_${suffix}`;
  if (!await getApplicationByKey(derived, client)) return derived;

  // Same company, same name, again. Number it — but bounded, because a loop
  // that probes forever on an unexpected condition is how one bug becomes an
  // outage.
  for (let n = 2; n <= MAX_KEY_ATTEMPTS; n += 1) {
    const candidate = `${derived}_${n}`;
    if (!await getApplicationByKey(candidate, client)) return candidate;
  }
  throw new RegistryError(
    `Application key "${base}" and ${MAX_KEY_ATTEMPTS} alternatives are all taken. Give this application a different name.`,
    'APP_KEY_TAKEN'
  );
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------
function hashSpec(spec) {
  // Key order must not change the hash: a specification is a value, not a
  // serialization, and an iteration that only reordered keys is not a change.
  return crypto.createHash('sha256').update(stableStringify(spec)).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Append a version.
 *
 * The version number is MAX + 1, which is a read followed by a write and
 * therefore racy: two Studio iterations of the same application at the same
 * moment both read the same maximum and both try to insert it. The UNIQUE
 * constraint on (application_id, version) catches that — correctly — and the
 * right response is to take the next number and try again rather than to hand
 * the user a database error for something that is not their problem.
 *
 * Bounded, because a loop that retries forever on a unique violation is how a
 * different bug becomes an outage.
 */
async function createVersion({
  applicationId, spec, parentVersionId = null, changeSummary = '', authoredBy = 'ai',
  provenance = {}, createdBy = null, validation = null, status = 'draft',
}, client) {
  const db = q(client);
  const payload = [
    JSON.stringify(spec), hashSpec(spec), status,
    validation ? JSON.stringify(validation) : null, changeSummary, authoredBy,
    JSON.stringify(provenance), createdBy,
  ];

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { rows: numbers } = await db.query(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM application_versions WHERE application_id = $1',
      [applicationId]
    );
    try {
      const { rows } = await db.query(
        `INSERT INTO application_versions
           (application_id, version, parent_version_id, spec, spec_hash, status, validation,
            change_summary, authored_by, provenance, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [applicationId, numbers[0].next, parentVersionId, ...payload]
      );
      return rows[0];
    } catch (error) {
      // 23505 on this table means somebody else took the number we just read.
      // Any other error is a real problem and is not retried.
      if (error.code !== '23505' || !String(error.constraint || '').includes('app_versions')) throw error;
      // Inside a caller's transaction the failed statement has aborted it, so
      // retrying here would fail on every subsequent statement. Let it out.
      if (client) throw error;
    }
  }
  throw new RegistryError(
    'Could not allocate a version number for this application after five attempts — something is writing versions faster than they can be numbered.',
    'VERSION_CONTENTION', 503
  );
}

async function getVersion(id, client) {
  const { rows } = await q(client).query('SELECT * FROM application_versions WHERE id = $1', [id]);
  return rows[0] || null;
}

async function latestVersion(applicationId, client) {
  const { rows } = await q(client).query(
    'SELECT * FROM application_versions WHERE application_id = $1 ORDER BY version DESC LIMIT 1',
    [applicationId]
  );
  return rows[0] || null;
}

async function listVersions(applicationId, client) {
  const { rows } = await q(client).query(
    `SELECT id, version, parent_version_id, spec_hash, status, change_summary, authored_by,
            created_by, created_at
       FROM application_versions WHERE application_id = $1 ORDER BY version DESC`,
    [applicationId]
  );
  return rows;
}

async function markVersionValidated(versionId, validation, client) {
  const { rows } = await q(client).query(
    `UPDATE application_versions
        SET status = CASE WHEN status = 'draft' THEN 'validated' ELSE status END,
            validation = $2
      WHERE id = $1 RETURNING *`,
    [versionId, JSON.stringify(validation)]
  );
  return rows[0] || null;
}

async function publishVersion(versionId, client) {
  const db = q(client);
  const version = await getVersion(versionId, db);
  if (!version) throw new RegistryError('No such application version.', 'VERSION_NOT_FOUND', 404);
  await db.query(
    `UPDATE application_versions SET status = 'superseded'
      WHERE application_id = $1 AND status = 'published' AND id <> $2`,
    [version.application_id, versionId]
  );
  await db.query("UPDATE application_versions SET status = 'published' WHERE id = $1", [versionId]);
  await db.query(
    `UPDATE applications
        SET current_version_id = $2, status = 'published', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [version.application_id, versionId]
  );
  return getVersion(versionId, db);
}

// ---------------------------------------------------------------------------
// Company instances
// ---------------------------------------------------------------------------

/**
 * Find or create this company's instance of an application.
 *
 * The table prefix is derived, then checked for collision against every prefix
 * already in use, escalating deterministically. The check is belt to the
 * database's braces: `app_instance_tables` has a UNIQUE index on
 * (table_schema, table_name), so a collision that slipped through here would
 * fail the deployment rather than silently share a table.
 */
async function ensureInstance({ applicationId, companyId, versionId = null, installedBy = null }, client) {
  const db = q(client);
  const existing = await getInstance(applicationId, companyId, db);
  if (existing) return existing;

  let prefix = null;
  for (let attempt = 0; attempt < 4 && !prefix; attempt += 1) {
    const candidate = identifiers.instanceTablePrefix(applicationId, companyId, attempt);
    const { rows } = await db.query(
      'SELECT 1 FROM app_company_instances WHERE table_prefix = $1 LIMIT 1',
      [candidate]
    );
    if (!rows.length) prefix = candidate;
  }
  if (!prefix) {
    throw new RegistryError(
      'Could not derive a free table prefix for this application instance after four attempts.',
      'PREFIX_COLLISION', 500
    );
  }

  const { rows } = await db.query(
    `INSERT INTO app_company_instances (application_id, company_id, version_id, status, table_prefix, installed_by)
     VALUES ($1, $2, $3, 'installing', $4, $5)
     ON CONFLICT (application_id, company_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [applicationId, companyId, versionId, prefix, installedBy]
  );
  return rows[0];
}

async function getInstance(applicationId, companyId, client) {
  const { rows } = await q(client).query(
    'SELECT * FROM app_company_instances WHERE application_id = $1 AND company_id = $2',
    [applicationId, companyId]
  );
  return rows[0] || null;
}

async function getInstanceById(id, client) {
  const { rows } = await q(client).query('SELECT * FROM app_company_instances WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * Resolve "this company, this application key" to a running instance and the
 * specification it is running. The entry point for every runtime request.
 */
async function resolveInstance(companyId, appKey, client) {
  const { rows } = await q(client).query(
    `SELECT i.*, a.app_key, a.name AS application_name, a.description AS application_description,
            a.icon, a.category, a.kind,
            v.spec, v.version AS spec_version, v.id AS running_version_id
       FROM app_company_instances i
       JOIN applications a ON a.id = i.application_id
       LEFT JOIN application_versions v ON v.id = i.version_id
      WHERE i.company_id = $1 AND a.app_key = $2`,
    [companyId, appKey]
  );
  return rows[0] || null;
}

async function setInstanceStatus(instanceId, status, client) {
  const { rows } = await q(client).query(
    'UPDATE app_company_instances SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
    [instanceId, status]
  );
  return rows[0] || null;
}

async function setInstanceVersion(instanceId, versionId, client) {
  const { rows } = await q(client).query(
    `UPDATE app_company_instances
        SET version_id = $2, status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 RETURNING *`,
    [instanceId, versionId]
  );
  return rows[0] || null;
}

async function listInstancesForCompany(companyId, client) {
  const { rows } = await q(client).query(
    `SELECT i.id, i.status, i.installed_at, i.table_prefix,
            a.id AS application_id, a.app_key, a.name, a.description, a.icon, a.category, a.kind,
            v.version AS running_version, v.id AS version_id
       FROM app_company_instances i
       JOIN applications a ON a.id = i.application_id
       LEFT JOIN application_versions v ON v.id = i.version_id
      WHERE i.company_id = $1
      ORDER BY a.name`,
    [companyId]
  );
  return rows;
}

/** Applications this company may see: its own, its installed ones, and global ones. */
/**
 * Switch an instance off or on, recording who and when.
 *
 * Separate from setInstanceStatus because this is the one status change a
 * person makes deliberately, and the row has to remember that: the App
 * Library shows "switched off by X on Y" without reading the event log.
 */
async function setInstanceDisabled(instanceId, { disabled, actorId = null, reason = null }, client) {
  const { rows } = await q(client).query(
    disabled
      ? `UPDATE app_company_instances
            SET status = 'disabled', disabled_at = CURRENT_TIMESTAMP,
                disabled_by = $2, disabled_reason = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 RETURNING *`
      : `UPDATE app_company_instances
            SET status = 'active', disabled_at = NULL,
                disabled_by = NULL, disabled_reason = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 RETURNING *`,
    disabled ? [instanceId, actorId, reason] : [instanceId]
  );
  if (!rows[0]) throw new RegistryError('No such application instance.', 'INSTANCE_NOT_FOUND', 404);
  return rows[0];
}

/**
 * The applications this company has actually installed, with the specification
 * each one is RUNNING and the disable trail.
 *
 * Separate from listForCompany, which answers "what could this company see?"
 * for the catalogue screen and deliberately does not carry specifications —
 * they are large, and most callers of that function do not want them. This one
 * is for the directory, which does.
 */
async function listInstalledForCompany(companyId, client) {
  const { rows } = await q(client).query(
    `SELECT a.*,
            i.id AS instance_id, i.status AS instance_status, i.version_id AS instance_version_id,
            i.installed_at, i.disabled_at, i.disabled_by, i.disabled_reason,
            v.spec AS spec, v.version AS running_version
       FROM app_company_instances i
       JOIN applications a         ON a.id = i.application_id
       LEFT JOIN application_versions v ON v.id = i.version_id
      WHERE i.company_id = $1
      ORDER BY a.name ASC`,
    [companyId]
  );
  return rows;
}

async function listForCompany(companyId, client) {
  const { rows } = await q(client).query(
    `SELECT a.*, 
            i.id AS instance_id, i.status AS instance_status, i.version_id AS instance_version_id,
            (SELECT count(*) FROM app_company_instances x WHERE x.application_id = a.id)::int AS install_count
       FROM applications a
       LEFT JOIN app_company_instances i ON i.application_id = a.id AND i.company_id = $1
      WHERE a.visibility = 'global'
         OR a.origin_company_id = $1
         OR i.id IS NOT NULL
      ORDER BY a.name`,
    [companyId]
  );
  return rows;
}

/**
 * Refuse to hand this company an application definition it has no relationship
 * with. Called by every route that returns a specification.
 */
async function assertVisible(applicationId, companyId, client) {
  const { rows } = await q(client).query(
    `SELECT 1 FROM applications a
       LEFT JOIN app_company_instances i ON i.application_id = a.id AND i.company_id = $2
      WHERE a.id = $1
        AND (a.visibility = 'global' OR a.origin_company_id = $2 OR i.id IS NOT NULL)`,
    [applicationId, companyId]
  );
  if (!rows.length) {
    throw new RegistryError('No such application.', 'APPLICATION_NOT_FOUND', 404);
  }
  return true;
}

// ---------------------------------------------------------------------------
// The table map — the authoritative part
// ---------------------------------------------------------------------------
async function registerTable({ instanceId, companyId, entityKey, schema = 'public', table }, client) {
  identifiers.assertEntityKey(entityKey);
  const physical = identifiers.qualifiedIdentifier(schema, table);
  const { rows } = await q(client).query(
    `INSERT INTO app_instance_tables (company_id, app_instance_id, entity_key, table_schema, table_name, physical_table_identifier)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (app_instance_id, entity_key)
       DO UPDATE SET table_schema = EXCLUDED.table_schema,
                     table_name = EXCLUDED.table_name,
                     physical_table_identifier = EXCLUDED.physical_table_identifier
     RETURNING *`,
    [companyId, instanceId, entityKey, schema, table, physical]
  );
  return rows[0];
}

async function unregisterTable(instanceId, entityKey, client) {
  await q(client).query(
    'DELETE FROM app_instance_tables WHERE app_instance_id = $1 AND entity_key = $2',
    [instanceId, entityKey]
  );
}

async function listTables(instanceId, client) {
  const { rows } = await q(client).query(
    'SELECT * FROM app_instance_tables WHERE app_instance_id = $1 ORDER BY entity_key',
    [instanceId]
  );
  return rows;
}

/**
 * THE resolver. Logical entity in, physical table out — and nothing else in
 * the codebase performs this mapping.
 *
 * Re-validates the names it read back from the registry before returning them.
 * The registry is trusted, but "trusted" is a statement about intent, not about
 * what is actually in the row; a name that cannot pass the identifier rules is
 * a corrupted registry, and the right response to that is to stop, not to
 * quote it and hope.
 */
async function resolveTable(instanceId, entityKey, client) {
  if (!identifiers.isLogicalKey(entityKey, { maxLength: identifiers.MAX_ENTITY_KEY_LENGTH })) {
    throw new RegistryError(`"${entityKey}" is not a legal entity key.`, 'INVALID_ENTITY_KEY', 400);
  }
  const { rows } = await q(client).query(
    `SELECT t.table_schema, t.table_name, t.entity_key, t.app_instance_id, t.company_id
       FROM app_instance_tables t
      WHERE t.app_instance_id = $1 AND t.entity_key = $2`,
    [instanceId, entityKey]
  );
  if (!rows.length) {
    throw new RegistryError(
      `Application instance ${instanceId} has no entity "${entityKey}".`, 'ENTITY_NOT_FOUND', 404
    );
  }
  const row = rows[0];
  // Quoting here rather than at the call site means every consumer receives an
  // already-safe string and none of them has the opportunity to build one.
  return {
    schema: row.table_schema,
    table: row.table_name,
    entityKey: row.entity_key,
    instanceId: row.app_instance_id,
    companyId: row.company_id,
    qualified: identifiers.qualifiedIdentifier(row.table_schema, row.table_name),
  };
}

// ---------------------------------------------------------------------------
// Events — the observability spine
// ---------------------------------------------------------------------------
async function recordEvent({
  companyId, applicationId = null, instanceId = null, versionId = null, deploymentId = null,
  eventType, summary, detail = {}, actorKind = 'system', actorId = null, provenanceClass = 'execution',
}, client) {
  const { rows } = await q(client).query(
    `INSERT INTO app_platform_events
       (company_id, application_id, app_instance_id, version_id, deployment_id,
        event_type, provenance_class, actor_kind, actor_id, summary, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, created_at`,
    [companyId, applicationId, instanceId, versionId, deploymentId, eventType, provenanceClass,
      actorKind, actorId ? String(actorId) : null, summary, JSON.stringify(detail)]
  );
  return rows[0];
}

async function listEvents({ companyId, applicationId = null, limit = 100 }, client) {
  const params = [companyId, Math.min(Math.max(1, limit), 500)];
  let where = 'company_id = $1';
  if (applicationId) { params.push(applicationId); where += ` AND application_id = $${params.length}`; }
  const { rows } = await q(client).query(
    `SELECT * FROM app_platform_events WHERE ${where} ORDER BY created_at DESC LIMIT $2`,
    params
  );
  return rows;
}

module.exports = {
  RegistryError,
  hashSpec,
  stableStringify,
  createApplication,
  getApplication,
  getApplicationByKey,
  availableApplicationKey,
  createVersion,
  getVersion,
  latestVersion,
  listVersions,
  markVersionValidated,
  publishVersion,
  ensureInstance,
  getInstance,
  getInstanceById,
  resolveInstance,
  setInstanceStatus,
  setInstanceVersion,
  listInstancesForCompany,
  setInstanceDisabled,
  listForCompany,
  listInstalledForCompany,
  assertVisible,
  registerTable,
  unregisterTable,
  listTables,
  resolveTable,
  recordEvent,
  listEvents,
  applicationRole,
};
