/**
 * The deployment engine: an approved application version becomes real tables.
 *
 * ===========================================================================
 * THE PIPELINE
 * ===========================================================================
 *     prepare   plan against the live database, classify safety, record the
 *               plan and its hash. Touches nothing.
 *     approve   a person accepts THAT plan. A destructive plan additionally
 *               requires them to name the destructive steps back.
 *     apply     re-validate the specification from scratch, re-plan, refuse if
 *               the plan changed, then execute everything — DDL and registry
 *               writes — in ONE transaction.
 *
 * WHY THE REGISTRY WRITES ARE IN THE SAME TRANSACTION AS THE DDL
 * ---------------------------------------------------------------------------
 * If the CREATE TABLEs committed and the app_instance_tables inserts did not,
 * the database would hold tables nothing could find; if it went the other way,
 * the registry would point at tables that do not exist and every request for
 * that entity would fail with a Postgres error rather than a sensible one.
 * Both are recoverable only by hand. Postgres does transactional DDL, so the
 * correct answer is available and taken: one BEGIN, everything, one COMMIT.
 *
 * The consequence worth knowing: the deployment record itself is written on a
 * DIFFERENT connection, before and after, precisely so that a rolled-back
 * deployment still leaves its failure recorded. A failure that erases the
 * evidence of itself is not a failure anyone can fix.
 *
 * WHY IT RE-VALIDATES AND RE-PLANS AT APPLY TIME
 * ---------------------------------------------------------------------------
 * Time passes between approval and apply. Another deployment may have run; a
 * canonical table may have changed; the specification may have been iterated.
 * So the approval is bound to a plan hash, and apply recomputes it. Different
 * hash, no deployment — the operator is asked to look again rather than having
 * something they did not approve applied under their name.
 */

const {
  pool, withDdlTransaction, applicationRole, lockKeyFor, asCompany, assertCanCreateSchemaObjects,
} = require('./db');
const registry = require('./registry');
const validator = require('./spec/validator');
const planner = require('./compiler/planner');
const ddl = require('./compiler/ddl');
const identifiers = require('./identifiers');

class DeploymentError extends Error {
  constructor(message, code = 'DEPLOYMENT_ERROR', status = 400, detail = null) {
    super(message);
    this.name = 'DeploymentError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Reading the current physical state
// ---------------------------------------------------------------------------

/**
 * What the database actually looks like for this instance right now.
 *
 * Two sources, and they are combined rather than trusted individually:
 *   • The DEPLOYED SPECIFICATION says what each column means — its logical
 *     type, its enum values. information_schema cannot: TEXT is TEXT whether
 *     it was an enum, an email or a slug.
 *   • The LIVE CATALOGUE says what exists. The specification cannot: a table
 *     dropped by hand, or a deployment that half-failed on an older version of
 *     this code, would otherwise be invisible.
 *
 * Where they disagree, the catalogue wins on existence and the specification
 * wins on meaning — and a table the registry names but the catalogue does not
 * have is reported as drift rather than quietly planned around.
 */
async function currentState(client, instance, deployedSpec) {
  const tables = await registry.listTables(instance.id, client);
  const state = new Map();
  const drift = [];

  const specEntities = new Map(
    ((deployedSpec?.data?.entities) || []).map((e) => [e.key, e])
  );

  for (const row of tables) {
    const { rows: exists } = await client.query(
      'SELECT to_regclass($1) AS oid',
      [`${row.table_schema}.${row.table_name}`]
    );
    if (!exists[0].oid) {
      drift.push({
        entityKey: row.entity_key,
        issue: `The registry maps "${row.entity_key}" to ${row.table_schema}.${row.table_name}, which does not exist in the database.`,
      });
      continue;
    }

    const { rows: columns } = await client.query(
      `SELECT column_name, is_nullable, data_type
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2`,
      [row.table_schema, row.table_name]
    );
    // Indexes, and — critically — whether each one BACKS A CONSTRAINT. A
    // primary key and a UNIQUE constraint each own an index that cannot be
    // dropped independently of the constraint, and proposing to drop one is
    // both wrong and fatal to the whole deployment.
    const { rows: indexes } = await client.query(
      `SELECT i.indexname,
              EXISTS (
                SELECT 1 FROM pg_constraint c
                 WHERE c.conindid = (quote_ident(i.schemaname) || '.' || quote_ident(i.indexname))::regclass
              ) AS backs_constraint
         FROM pg_indexes i
        WHERE i.schemaname = $1 AND i.tablename = $2`,
      [row.table_schema, row.table_name]
    );

    const entity = specEntities.get(row.entity_key);
    const specFields = new Map();
    (entity?.fields || []).forEach((f) => {
      ddl.fieldColumns(f).forEach((c) => specFields.set(c.name, f));
    });

    const columnMap = new Map();
    columns.forEach((col) => {
      const field = specFields.get(col.column_name);
      columnMap.set(col.column_name, {
        nullable: col.is_nullable === 'YES',
        dataType: col.data_type,
        // A column the deployed specification does not know about is either a
        // platform column (id, company_id, …) or something left behind. Marking
        // the platform ones keeps the planner from proposing to drop them.
        system: !field && identifiers.RESERVED_COLUMNS.has(col.column_name),
        specType: field ? field.type : null,
        enumValues: field?.type === 'enum' ? field.values : null,
      });
    });

    state.set(row.entity_key, {
      schema: row.table_schema,
      table: row.table_name,
      columns: columnMap,
      indexes: new Set(indexes.map((i) => i.indexname)),
      // Indexes the planner may consider removing: ones this platform created
      // itself (identifiers.indexName always ends in `_idx`) and that do not
      // back a constraint. An index an operator added by hand for performance
      // is theirs, and a primary key's index is the constraint's.
      managedIndexes: new Set(
        indexes
          .filter((i) => !i.backs_constraint && i.indexname.startsWith(row.table_name) && i.indexname.endsWith('_idx'))
          .map((i) => i.indexname)
      ),
    });
  }

  return { state, drift };
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

/**
 * Plan a deployment and record it. Nothing is created, altered or dropped.
 *
 * @returns {{deployment: object, plan: object, validation: object}}
 */
async function prepare({ companyId, applicationId, versionId, requestedBy = null }) {
  const version = await registry.getVersion(versionId);
  if (!version) throw new DeploymentError('No such application version.', 'VERSION_NOT_FOUND', 404);
  if (version.application_id !== applicationId) {
    throw new DeploymentError('That version does not belong to that application.', 'VERSION_MISMATCH');
  }
  await registry.assertVisible(applicationId, companyId);

  const { spec, report } = validator.validate(version.spec);
  const validation = report.toJSON();
  await registry.markVersionValidated(versionId, validation);

  if (!report.ok) {
    throw new DeploymentError(
      `This application version does not validate: ${report.errors.length} error(s). Fix them before deploying.`,
      'VALIDATION_FAILED', 422, validation
    );
  }

  const instance = await registry.ensureInstance({
    applicationId, companyId, installedBy: requestedBy,
  });

  const deployedVersion = instance.version_id ? await registry.getVersion(instance.version_id) : null;
  const { state, drift } = await currentState(pool, instance, deployedVersion?.spec || null);

  const appRole = await applicationRole();
  const planResult = planner.plan({
    spec,
    instance: { id: instance.id, companyId, tablePrefix: instance.table_prefix },
    current: state,
    appRole,
  });

  if (drift.length) {
    planResult.notes.push(...drift.map((d) => ({ level: 'error', code: 'REGISTRY_DRIFT', message: d.issue })));
  }

  const planHash = planner.hashPlan(planResult);
  const status = planResult.safety === 'safe' && !drift.length ? 'planned' : 'awaiting_approval';

  const { rows } = await pool.query(
    `INSERT INTO app_deployments
       (company_id, application_id, app_instance_id, from_version_id, to_version_id,
        status, safety, plan, validation, plan_hash, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [companyId, applicationId, instance.id, instance.version_id, versionId, status,
      planResult.safety, JSON.stringify(serializePlan(planResult)), JSON.stringify(validation),
      planHash, requestedBy]
  );
  const deployment = rows[0];

  await registry.recordEvent({
    companyId, applicationId, instanceId: instance.id, versionId, deploymentId: deployment.id,
    eventType: 'deployment.planned',
    provenanceClass: 'decision',
    actorKind: requestedBy ? 'user' : 'system',
    actorId: requestedBy,
    summary: `Planned deployment of version ${version.version}: ${planResult.operations.length} schema operation(s), safety "${planResult.safety}".`,
    detail: { safety: planResult.safety, summary: planResult.summary, planHash },
  });

  return { deployment, plan: serializePlan(planResult), validation, instance };
}

/** The plan as it is stored and shown. Excludes the closures the planner carries. */
function serializePlan(planResult) {
  return {
    safety: planResult.safety,
    notes: planResult.notes,
    summary: planResult.summary,
    operations: planResult.operations.map((op) => ({
      kind: op.kind,
      safety: op.safety,
      description: op.description,
      entityKey: op.entityKey || null,
      table: op.table || null,
      column: op.column || op.field?.name || null,
      columns: op.columns || null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

/**
 * Record a person's approval of a specific plan.
 *
 * A destructive plan requires `acknowledge` to contain the exact descriptions
 * of the destructive operations. Not a boolean: a checkbox is something you
 * click past, whereas echoing back "Drop column root_cause from findings.
 * Everything stored in it is destroyed." requires having read it. The UI can
 * make that a copy of the list — the point is that the acknowledgement is
 * derived from the plan, so an approval cannot outlive the plan it was for.
 */
async function approve({ deploymentId, companyId, approvedBy, acknowledge = [] }) {
  const deployment = await getDeployment(deploymentId, companyId);
  if (!['planned', 'awaiting_approval', 'failed'].includes(deployment.status)) {
    throw new DeploymentError(`This deployment is ${deployment.status}; only a planned, awaiting or failed one can be approved.`, 'BAD_STATE');
  }
  if (deployment.safety === 'destructive') {
    const required = deployment.plan.summary.destructive || [];
    const missing = required.filter((d) => !acknowledge.includes(d));
    if (missing.length) {
      throw new DeploymentError(
        'This deployment destroys data. Each destructive step must be acknowledged explicitly.',
        'ACKNOWLEDGEMENT_REQUIRED', 428, { required, missing }
      );
    }
  }

  const { rows } = await pool.query(
    `UPDATE app_deployments
        SET status = 'planned', approved_by = $2, approved_at = CURRENT_TIMESTAMP
      WHERE id = $1 RETURNING *`,
    [deploymentId, approvedBy]
  );

  await registry.recordEvent({
    companyId,
    applicationId: deployment.application_id,
    instanceId: deployment.app_instance_id,
    versionId: deployment.to_version_id,
    deploymentId,
    eventType: 'deployment.approved',
    provenanceClass: 'authorization',
    actorKind: 'user',
    actorId: approvedBy,
    summary: `Approved a ${deployment.safety} deployment plan (${deployment.plan.operations.length} operation(s)).`,
    detail: { acknowledged: acknowledge },
  });

  return rows[0];
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

async function apply({ deploymentId, companyId, actorId = null }) {
  const deployment = await getDeployment(deploymentId, companyId);
  if (deployment.status === 'deployed') return deployment;
  if (!['planned', 'failed'].includes(deployment.status)) {
    throw new DeploymentError(
      `This deployment is ${deployment.status}. ${deployment.status === 'awaiting_approval' ? 'It needs approval first.' : 'It cannot be applied.'}`,
      'BAD_STATE'
    );
  }
  if (deployment.safety !== 'safe' && !deployment.approved_by) {
    throw new DeploymentError('A non-trivial deployment must be approved before it is applied.', 'APPROVAL_REQUIRED', 403);
  }

  const version = await registry.getVersion(deployment.to_version_id);
  const instance = await registry.getInstanceById(deployment.app_instance_id);
  if (!instance) throw new DeploymentError('The application instance has gone.', 'INSTANCE_NOT_FOUND', 404);

  // Before anything is marked as applying: can this server create tables at
  // all? Finding out halfway through a transaction produces "permission denied
  // for schema public", which names neither the cause nor the fix.
  await assertCanCreateSchemaObjects();

  await pool.query(
    `UPDATE app_deployments SET status = 'applying', started_at = CURRENT_TIMESTAMP,
            attempt = attempt + 1, error = NULL
      WHERE id = $1`,
    [deploymentId]
  );

  try {
    const applied = await withDdlTransaction(companyId, async (client) => {
      // Serialize deployments per instance. Transaction-scoped, so it is
      // released on commit, on rollback, and on a process that dies mid-flight.
      const [k1, k2] = lockKeyFor(instance.id);
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);

      // Fresh revalidation. The specification is re-checked from scratch here,
      // not trusted from the prepare step: this is the last moment before it
      // becomes tables.
      const { spec, report } = validator.validate(version.spec);
      if (!report.ok) {
        throw new DeploymentError(
          `The application version stopped validating between approval and deployment: ${report.errors[0].message}`,
          'REVALIDATION_FAILED', 422, report.toJSON()
        );
      }

      const deployedVersion = instance.version_id ? await registry.getVersion(instance.version_id, client) : null;
      const { state, drift } = await currentState(client, instance, deployedVersion?.spec || null);
      if (drift.length) {
        throw new DeploymentError(
          `The database no longer matches the registry: ${drift[0].issue}`,
          'REGISTRY_DRIFT', 409, { drift }
        );
      }

      const appRole = await applicationRole();
      const planResult = planner.plan({
        spec,
        instance: { id: instance.id, companyId, tablePrefix: instance.table_prefix },
        current: state,
        appRole,
      });

      const freshHash = planner.hashPlan(planResult);
      if (freshHash !== deployment.plan_hash) {
        throw new DeploymentError(
          'The database changed since this plan was approved, so the plan is no longer the one that was reviewed. Re-plan and approve again.',
          'PLAN_CHANGED', 409,
          { approvedHash: deployment.plan_hash, currentHash: freshHash, currentPlan: serializePlan(planResult) }
        );
      }

      // -- execute -------------------------------------------------------
      const executed = [];
      for (const op of planResult.operations) {
        const statements = ddl.emit(op);
        for (const sql of statements) {
          await client.query(sql);
          executed.push(sql);
        }
        // Registry updates travel with the DDL that made them true.
        if (op.kind === 'create_table' && op.register) {
          await registry.registerTable({
            instanceId: instance.id, companyId, entityKey: op.entityKey,
            schema: op.schema, table: op.table,
          }, client);
        }
        if (op.kind === 'drop_table' && op.unregister) {
          await registry.unregisterTable(instance.id, op.entityKey, client);
        }
      }

      // Newly created tables join the standard isolation registry, so a future
      // `db-migrate` resync re-applies the policy to them along with everything
      // else. The policy is already on them (enable_rls ran above); this is
      // what keeps it there.
      for (const op of planResult.operations.filter((o) => o.kind === 'create_table')) {
        await client.query(
          'INSERT INTO company_scoped_tables (table_name) VALUES ($1) ON CONFLICT (table_name) DO NOTHING',
          [op.table]
        );
      }
      for (const op of planResult.operations.filter((o) => o.kind === 'drop_table')) {
        await client.query('DELETE FROM company_scoped_tables WHERE table_name = $1', [op.table]);
      }

      await registry.setInstanceVersion(instance.id, version.id, client);
      await registry.publishVersion(version.id, client);

      return { executed: executed.length, operations: planResult.operations.length };
    });

    const { rows } = await pool.query(
      `UPDATE app_deployments
          SET status = 'deployed', finished_at = CURRENT_TIMESTAMP, error = NULL
        WHERE id = $1 RETURNING *`,
      [deploymentId]
    );

    await registry.recordEvent({
      companyId,
      applicationId: deployment.application_id,
      instanceId: instance.id,
      versionId: version.id,
      deploymentId,
      eventType: 'deployment.deployed',
      provenanceClass: 'execution',
      actorKind: actorId ? 'user' : 'system',
      actorId,
      summary: `Deployed version ${version.version}: ${applied.operations} schema operation(s), ${applied.executed} statement(s).`,
      detail: applied,
    });

    return { ...rows[0], applied };
  } catch (error) {
    // The transaction has already rolled back — no table was created, no
    // registry row was written, no version was published. Record why, on a
    // connection the rollback did not touch, and leave the deployment
    // retryable.
    const message = error instanceof DeploymentError ? error.message : `${error.code || 'error'}: ${error.message}`;
    await pool.query(
      `UPDATE app_deployments SET status = 'failed', finished_at = CURRENT_TIMESTAMP, error = $2
        WHERE id = $1`,
      [deploymentId, message]
    ).catch(() => {});

    await registry.recordEvent({
      companyId,
      applicationId: deployment.application_id,
      instanceId: deployment.app_instance_id,
      versionId: deployment.to_version_id,
      deploymentId,
      eventType: 'deployment.failed',
      provenanceClass: 'execution',
      actorKind: actorId ? 'user' : 'system',
      actorId,
      summary: `Deployment failed and was rolled back: ${message}`,
      detail: { code: error.code || null, detail: error.detail || null },
    }).catch(() => {});

    // The instance keeps whatever version it was already running. A failed
    // upgrade must not leave a working application marked broken.
    if (!instance.version_id) {
      await registry.setInstanceStatus(instance.id, 'failed').catch(() => {});
    }

    throw error instanceof DeploymentError
      ? error
      : new DeploymentError(message, 'APPLY_FAILED', 500, { code: error.code || null });
  }
}

/**
 * Plan, approve (when the plan is trivially safe) and apply in one call.
 *
 * The convenience path for a first installation, where there is nothing to
 * destroy because there is nothing there. It deliberately refuses anything but
 * a `safe` plan: "install this new application" should not be the door through
 * which a destructive migration walks unreviewed.
 */
async function deploy({ companyId, applicationId, versionId, actorId = null, acknowledge = null }) {
  const { deployment, plan, validation } = await prepare({
    companyId, applicationId, versionId, requestedBy: actorId,
  });

  // Two reasons to stop short of applying: the plan is not trivially safe, or
  // prepare() found the database and the registry disagreeing. Reading the
  // deployment's own status rather than only the plan's safety class is what
  // makes the second case stop here too — drift on an otherwise additive change
  // would otherwise sail through to apply and fail there.
  if (plan.safety !== 'safe' || deployment.status === 'awaiting_approval') {
    if (acknowledge === null) {
      return { deployment, plan, validation, status: 'awaiting_approval' };
    }
    await approve({ deploymentId: deployment.id, companyId, approvedBy: actorId, acknowledge });
  }

  const applied = await apply({ deploymentId: deployment.id, companyId, actorId });
  return { deployment: applied, plan, validation, status: 'deployed' };
}

async function getDeployment(deploymentId, companyId) {
  const { rows } = await pool.query(
    'SELECT * FROM app_deployments WHERE id = $1 AND company_id = $2',
    [deploymentId, companyId]
  );
  if (!rows.length) throw new DeploymentError('No such deployment.', 'DEPLOYMENT_NOT_FOUND', 404);
  return rows[0];
}

async function listDeployments({ companyId, applicationId = null, limit = 50 }) {
  const params = [companyId, Math.min(Math.max(1, limit), 200)];
  let where = 'd.company_id = $1';
  if (applicationId) { params.push(applicationId); where += ` AND d.application_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT d.id, d.status, d.safety, d.plan_hash, d.error, d.attempt,
            d.created_at, d.started_at, d.finished_at, d.approved_at,
            a.app_key, a.name AS application_name,
            fv.version AS from_version, tv.version AS to_version
       FROM app_deployments d
       JOIN applications a ON a.id = d.application_id
       LEFT JOIN application_versions fv ON fv.id = d.from_version_id
       LEFT JOIN application_versions tv ON tv.id = d.to_version_id
      WHERE ${where}
      ORDER BY d.created_at DESC LIMIT $2`,
    params
  );
  return rows;
}

/**
 * Uninstall: take a company's instance out of service.
 *
 * Deliberately does NOT drop the tables. A company that switches an application
 * off has not asked for its records to be destroyed, and the one thing that
 * cannot be undone is the one thing this should not do by default. Dropping the
 * data is a separate, explicitly destructive deployment.
 */
/**
 * Switch an application off for one company.
 *
 * There is deliberately no uninstall. See the header of migration
 * 202609050100 for why: the definition is shared with every other company
 * running it, and the data is this company's and was not offered up. Disabling
 * removes the application from the shell and refuses its runtime; the tables,
 * the rows, the attachments and the audit trail are all exactly where they
 * were, and enabling puts it back.
 */
async function disable({ companyId, applicationId, actorId = null, reason = null }) {
  const instance = await registry.getInstance(applicationId, companyId);
  if (!instance) throw new DeploymentError('This company has no instance of that application.', 'INSTANCE_NOT_FOUND', 404);
  if (instance.status === 'disabled') return instance;
  if (instance.status === 'installing' || instance.status === 'updating') {
    throw new DeploymentError(
      'That application is mid-deployment. Wait for it to finish, then switch it off.',
      'INSTANCE_BUSY', 409
    );
  }

  const updated = await registry.setInstanceDisabled(instance.id, {
    disabled: true, actorId, reason: reason ? String(reason).slice(0, 500) : null,
  });
  await registry.recordEvent({
    companyId, applicationId, instanceId: instance.id,
    eventType: 'application.disabled',
    provenanceClass: 'execution',
    actorKind: actorId ? 'user' : 'system',
    actorId,
    summary: 'Application switched off for this company. Every record it holds is retained.',
    detail: { reason: reason || null },
  });
  return updated;
}

/**
 * Switch it back on.
 *
 * A failed deployment is not re-enabled from here — it never finished, so
 * there is nothing to resume; it is deployed again.
 */
async function enable({ companyId, applicationId, actorId = null }) {
  const instance = await registry.getInstance(applicationId, companyId);
  if (!instance) throw new DeploymentError('This company has no instance of that application.', 'INSTANCE_NOT_FOUND', 404);
  if (instance.status === 'active') return instance;
  if (instance.status !== 'disabled') {
    throw new DeploymentError(
      `That application is "${instance.status}", not switched off. Deploy it rather than enabling it.`,
      'INSTANCE_NOT_DISABLED', 409
    );
  }
  if (!instance.version_id) {
    throw new DeploymentError('That application has never finished a deployment.', 'INSTANCE_NOT_DEPLOYED', 409);
  }

  const updated = await registry.setInstanceDisabled(instance.id, { disabled: false, actorId });
  await registry.recordEvent({
    companyId, applicationId, instanceId: instance.id,
    eventType: 'application.enabled',
    provenanceClass: 'execution',
    actorKind: actorId ? 'user' : 'system',
    actorId,
    summary: 'Application switched back on for this company.',
  });
  return updated;
}

// Same reasoning as studio/session.js: the platform's own entry points
// establish the company context they need rather than assuming a caller did.
const scoped = (fn) => (args = {}) => asCompany(args.companyId, () => fn(args));

module.exports = {
  DeploymentError,
  prepare: scoped(prepare),
  approve: scoped(approve),
  apply: scoped(apply),
  deploy: scoped(deploy),
  disable: scoped(disable),
  enable: scoped(enable),
  getDeployment: (deploymentId, companyId) => asCompany(companyId, () => getDeployment(deploymentId, companyId)),
  listDeployments: (args = {}) => asCompany(args.companyId, () => listDeployments(args)),
  currentState,
  serializePlan,
};
