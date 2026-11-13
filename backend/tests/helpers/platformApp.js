/**
 * Building, deploying and using an application inside a test.
 *
 * The suites below the platform all need the same four steps — design, deploy,
 * get a principal, act — and doing them by hand in each file would mean four
 * slightly different versions of "is the platform available here?".
 *
 * Everything goes through the REAL services: the composer, the validator, the
 * deployer, the runtime. A helper that shortcut any of them would be testing a
 * different system than the one that ships.
 */

const { Pool } = require('pg');
const { pool } = require('../../config/database');
const companyContext = require('../../services/companyContext');
const { asCompany } = require('../../services/platform/db');
const registry = require('../../services/platform/registry');
const deployer = require('../../services/platform/deployer');
const session = require('../../services/platform/studio/session');
const resolver = require('../../services/platform/runtime/resolver');
const authz = require('../../services/platform/runtime/authorization');
const analyzer = require('../../services/platform/studio/analyzer');
const composer = require('../../services/platform/studio/composer');
const validator = require('../../services/platform/spec/validator');

/**
 * A connection that can run DDL.
 *
 * `pool` is the application's own connection, which under company isolation is
 * a role that deliberately cannot own or alter tables (migration 111). Tests
 * that need to manipulate the schema directly — to simulate drift, to occupy a
 * name, to check what the compiler actually built — need the owner connection
 * migrations use, exactly as the deployer does.
 */
let ownerPoolInstance = null;
function ownerPool() {
  if (!ownerPoolInstance) {
    ownerPoolInstance = new Pool({
      connectionString: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: 3,
    });
  }
  return ownerPoolInstance;
}

async function closeOwnerPool() {
  if (ownerPoolInstance) {
    await ownerPoolInstance.end().catch(() => {});
    ownerPoolInstance = null;
  }
}

/** Is a database with the platform schema reachable? */
async function platformAvailable() {
  try {
    await pool.query('SELECT 1');
    const { rows } = await pool.query("SELECT to_regclass('app_instance_tables') AS t");
    return !!rows[0].t;
  } catch {
    return false;
  }
}

/**
 * Design and deploy an application for a company, from a requirement.
 *
 * @returns {{application, version, instance, spec, sessionId}}
 */
async function deployFromRequirement({ companyId, userId, requirement, appKeyHint = null }) {
  const started = await session.start({ companyId, userId, requirement });
  if (appKeyHint) {
    // Tests that want a predictable key rename before deploying — the key is
    // global, so parallel runs would otherwise collide.
    await pool.query('UPDATE applications SET app_key = $2 WHERE id = $1', [started.application.id, appKeyHint]);
  }
  const deployed = await session.deploy({ companyId, sessionId: started.session.id, userId });
  const instance = await asCompany(companyId, () => registry.getInstance(started.application.id, companyId));
  return {
    application: started.application,
    version: started.version,
    instance,
    spec: started.spec,
    sessionId: started.session.id,
    deployment: deployed,
    plan: started.plan,
  };
}

/** Deploy a specification directly, bypassing the designer. */
async function deploySpec({ companyId, userId, spec: rawSpec }) {
  const { spec, report } = validator.validate(rawSpec);
  if (!report.ok) {
    throw new Error(`Test specification does not validate: ${report.errors.map((e) => e.message).join('; ')}`);
  }
  return asCompany(companyId, async () => {
    const appKey = await registry.availableApplicationKey(spec.key, companyId);
    spec.key = appKey;
    const application = await registry.createApplication({
      appKey, name: spec.name, description: spec.description, icon: spec.icon,
      category: spec.category, originCompanyId: companyId, createdBy: userId,
    });
    const version = await registry.createVersion({
      applicationId: application.id, spec, createdBy: userId, status: 'validated',
      changeSummary: 'Created directly by a test.', authoredBy: 'system',
    });
    const result = await deployer.deploy({
      companyId, applicationId: application.id, versionId: version.id, actorId: userId,
    });
    const instance = await registry.getInstance(application.id, companyId);
    return { application, version, instance, spec, deployment: result };
  });
}

/** A specification composed from a requirement, without deploying it. */
function composeFromRequirement(requirement) {
  const { brief } = analyzer.analyze(requirement);
  return validator.validate(composer.compose(brief)).spec;
}

/** Resolve an application and build an internal principal for a user. */
async function internalContext({ companyId, appKey, userId, platformRole = 'ADMIN', surfaceKey = null }) {
  return asCompany(companyId, async () => {
    const context = await resolver.resolveApplication(companyId, appKey);
    const principal = await authz.internalPrincipal({
      companyId, instance: context.instance, spec: context.spec, userId, platformRole, surfaceKey,
    });
    return { context, principal };
  });
}

/** Resolve an application and build an external principal for a portal identity. */
async function externalContext({ companyId, appKey, identity, surfaceKey = null }) {
  return asCompany(companyId, async () => {
    const context = await resolver.resolveApplication(companyId, appKey);
    const principal = await authz.externalPrincipal({
      companyId, instance: context.instance, spec: context.spec, identity, surfaceKey,
    });
    return { context, principal };
  });
}

/** Run `fn` with the company as ambient context — what the auth middleware does. */
const as = (companyId, fn) => asCompany(companyId, fn);

/** Raw read of a generated table, for asserting what is physically there. */
async function readPhysical(companyId, instanceId, entityKey) {
  return asCompany(companyId, async () => {
    const table = await registry.resolveTable(instanceId, entityKey);
    return companyContext.withCompany(companyId, async (client) => {
      const { rows } = await client.query(`SELECT * FROM ${table.qualified}`);
      return rows;
    });
  });
}

module.exports = {
  ownerPool,
  closeOwnerPool,
  platformAvailable,
  deployFromRequirement,
  deploySpec,
  composeFromRequirement,
  internalContext,
  externalContext,
  readPhysical,
  as,
};
