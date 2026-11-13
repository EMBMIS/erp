/**
 * The application catalogue, definitions, versions and deployments.
 *
 * Read paths are open to any authenticated user of the company — knowing which
 * applications exist is not privileged. Anything that changes a design or the
 * schema requires an administrator, and every one of those goes through the
 * deployer rather than touching the database here.
 */

const express = require('express');
const router = express.Router();

const { auth } = require('../../middleware/auth');
const { handler, requireAdmin, companyOf, userOf } = require('./_shared');
const registry = require('../../services/platform/registry');
const deployer = require('../../services/platform/deployer');
const validator = require('../../services/platform/spec/validator');
const sandbox = require('../../services/platform/sandbox');
const canonical = require('../../services/platform/spec/canonical');
const catalog = require('../../services/platform/catalog');

router.use(auth);

/** Everything this company can see: installed applications and available designs. */
router.get('/', handler(async (req, res) => {
  const companyId = companyOf(req);
  const [applications, instances] = await Promise.all([
    registry.listForCompany(companyId),
    registry.listInstancesForCompany(companyId),
  ]);
  res.json({
    success: true,
    data: {
      applications: applications.map((a) => ({
        id: a.id,
        appKey: a.app_key,
        name: a.name,
        description: a.description,
        icon: a.icon,
        category: a.category,
        kind: a.kind,
        status: a.status,
        installed: !!a.instance_id,
        instanceStatus: a.instance_status,
        installCount: a.install_count,
        createdAt: a.created_at,
      })),
      installed: instances,
    },
  });
}));

/** The navigation an installed application contributes, for the shell sidebar. */
router.get('/navigation', handler(async (req, res) => {
  res.json({ success: true, data: await catalog.navigationFor(companyOf(req), userOf(req), req.user?.role) });
}));

/** The canonical EMBMIS entities an application may reference. */
router.get('/canonical-entities', handler(async (req, res) => {
  res.json({ success: true, data: canonical.list() });
}));

/** The unified catalogue Simeli reads: what exists, what it does, what it touches. */
router.get('/catalogue', handler(async (req, res) => {
  res.json({ success: true, data: await catalog.describe(companyOf(req)) });
}));

router.get('/:appKey', handler(async (req, res) => {
  const companyId = companyOf(req);
  const application = await registry.getApplicationByKey(req.params.appKey);
  if (!application) {
    return res.status(404).json({ success: false, error: 'No such application.', code: 'APPLICATION_NOT_FOUND' });
  }
  await registry.assertVisible(application.id, companyId);
  const [versions, instance] = await Promise.all([
    registry.listVersions(application.id),
    registry.getInstance(application.id, companyId),
  ]);
  const running = instance?.version_id ? await registry.getVersion(instance.version_id) : null;

  res.json({
    success: true,
    data: {
      application: {
        id: application.id, appKey: application.app_key, name: application.name,
        description: application.description, icon: application.icon, category: application.category,
        kind: application.kind, status: application.status, createdAt: application.created_at,
      },
      versions,
      instance: instance ? {
        id: instance.id, status: instance.status, installedAt: instance.installed_at,
        versionId: instance.version_id, tablePrefix: instance.table_prefix,
      } : null,
      spec: running?.spec || null,
      runningVersion: running?.version || null,
    },
  });
}));

/** One version's full specification. */
router.get('/:appKey/versions/:versionId', handler(async (req, res) => {
  const application = await registry.getApplicationByKey(req.params.appKey);
  if (!application) {
    return res.status(404).json({ success: false, error: 'No such application.', code: 'APPLICATION_NOT_FOUND' });
  }
  await registry.assertVisible(application.id, companyOf(req));
  const version = await registry.getVersion(req.params.versionId);
  if (!version || version.application_id !== application.id) {
    return res.status(404).json({ success: false, error: 'No such version.', code: 'VERSION_NOT_FOUND' });
  }
  res.json({ success: true, data: version });
}));

/** The physical tables backing this company's instance. Administrators only. */
router.get('/:appKey/tables', requireAdmin, handler(async (req, res) => {
  const companyId = companyOf(req);
  const application = await registry.getApplicationByKey(req.params.appKey);
  if (!application) {
    return res.status(404).json({ success: false, error: 'No such application.', code: 'APPLICATION_NOT_FOUND' });
  }
  await registry.assertVisible(application.id, companyId);
  const instance = await registry.getInstance(application.id, companyId);
  if (!instance) return res.json({ success: true, data: [] });
  const tables = await registry.listTables(instance.id);
  res.json({
    success: true,
    data: tables.map((t) => ({
      entityKey: t.entity_key, schema: t.table_schema, table: t.table_name, createdAt: t.created_at,
    })),
  });
}));

/** Validate a specification without saving it. Used by the Studio's editor. */
router.post('/validate', requireAdmin, handler(async (req, res) => {
  const { report } = validator.validate(req.body?.spec);
  res.json({ success: true, data: report.toJSON() });
}));

/** Run the sandbox against a specification. */
router.post('/sandbox', requireAdmin, handler(async (req, res) => {
  const report = await sandbox.run({
    spec: req.body?.spec,
    companyId: companyOf(req),
    applicationId: req.body?.applicationId || null,
    withPreview: req.body?.withPreview !== false,
  });
  res.json({ success: true, data: report });
}));

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

router.get('/:appKey/deployments', requireAdmin, handler(async (req, res) => {
  const application = await registry.getApplicationByKey(req.params.appKey);
  if (!application) {
    return res.status(404).json({ success: false, error: 'No such application.', code: 'APPLICATION_NOT_FOUND' });
  }
  res.json({
    success: true,
    data: await deployer.listDeployments({ companyId: companyOf(req), applicationId: application.id }),
  });
}));

/** Plan a deployment. Creates nothing; returns the plan and its safety class. */
router.post('/:appKey/deployments', requireAdmin, handler(async (req, res) => {
  const application = await registry.getApplicationByKey(req.params.appKey);
  if (!application) {
    return res.status(404).json({ success: false, error: 'No such application.', code: 'APPLICATION_NOT_FOUND' });
  }
  const versionId = req.body?.versionId || (await registry.latestVersion(application.id))?.id;
  const result = await deployer.prepare({
    companyId: companyOf(req), applicationId: application.id, versionId, requestedBy: userOf(req),
  });
  res.status(201).json({ success: true, data: result });
}));

/**
 * Approve a planned deployment.
 *
 * A destructive plan requires `acknowledge` to echo back each destructive step.
 * See deployer.approve() for why that is not a boolean.
 */
router.post('/deployments/:deploymentId/approve', requireAdmin, handler(async (req, res) => {
  const deployment = await deployer.approve({
    deploymentId: req.params.deploymentId,
    companyId: companyOf(req),
    approvedBy: userOf(req),
    acknowledge: Array.isArray(req.body?.acknowledge) ? req.body.acknowledge : [],
  });
  res.json({ success: true, data: deployment });
}));

/** Apply an approved deployment. Re-validates and re-plans first. */
router.post('/deployments/:deploymentId/apply', requireAdmin, handler(async (req, res) => {
  const deployment = await deployer.apply({
    deploymentId: req.params.deploymentId, companyId: companyOf(req), actorId: userOf(req),
  });
  res.json({ success: true, data: deployment });
}));

/** Switch an application off for this company. Keeps its data. */
/**
 * Switch an application off for this company, and back on.
 *
 * There is no uninstall endpoint and there is not meant to be one. The
 * definition belongs to every company running it, and the records belong to
 * this one — see migration 202609050100. Disabling is reversible and lossless;
 * a caller that wants data gone is asking for something else, which is not
 * built.
 */
router.post('/:appKey/disable', requireAdmin, handler(async (req, res) => {
  const companyId = companyOf(req);
  const application = await registry.getApplicationByKey(req.params.appKey);
  await registry.assertVisible(application?.id, companyId);
  const instance = await deployer.disable({
    companyId, applicationId: application.id, actorId: userOf(req), reason: req.body?.reason || null,
  });
  res.json({ success: true, data: instance });
}));

router.post('/:appKey/enable', requireAdmin, handler(async (req, res) => {
  const companyId = companyOf(req);
  const application = await registry.getApplicationByKey(req.params.appKey);
  await registry.assertVisible(application?.id, companyId);
  const instance = await deployer.enable({
    companyId, applicationId: application.id, actorId: userOf(req),
  });
  res.json({ success: true, data: instance });
}));

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

router.get('/:appKey/events', handler(async (req, res) => {
  const application = await registry.getApplicationByKey(req.params.appKey);
  if (!application) {
    return res.status(404).json({ success: false, error: 'No such application.', code: 'APPLICATION_NOT_FOUND' });
  }
  await registry.assertVisible(application.id, companyOf(req));
  res.json({
    success: true,
    data: await registry.listEvents({
      companyId: companyOf(req), applicationId: application.id, limit: Number(req.query.limit) || 100,
    }),
  });
}));

// ---------------------------------------------------------------------------
// Role assignment
// ---------------------------------------------------------------------------

router.get('/:appKey/roles', requireAdmin, handler(async (req, res) => {
  res.json({ success: true, data: await catalog.roleAssignments(companyOf(req), req.params.appKey) });
}));

router.post('/:appKey/roles', requireAdmin, handler(async (req, res) => {
  const assignment = await catalog.assignRole({
    companyId: companyOf(req),
    appKey: req.params.appKey,
    userId: req.body?.userId,
    roleKey: req.body?.roleKey,
    grantedBy: userOf(req),
  });
  res.status(201).json({ success: true, data: assignment });
}));

router.delete('/:appKey/roles/:assignmentId', requireAdmin, handler(async (req, res) => {
  await catalog.revokeRole({ companyId: companyOf(req), assignmentId: req.params.assignmentId });
  res.json({ success: true });
}));

module.exports = router;
