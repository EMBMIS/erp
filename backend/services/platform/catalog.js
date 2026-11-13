/**
 * The unified application catalogue, and the role assignments that make an
 * application usable.
 *
 * ===========================================================================
 * WHY A CATALOGUE
 * ===========================================================================
 * Once applications are data rather than code, "what can this business do?" is
 * a query, not a reading of the source. Simeli needs to answer:
 *
 *     What applications do we have?
 *     What does our supplier quality application do?
 *     Which applications expose supplier data?
 *     What customer portals are active?
 *     Which applications depend on shipments?
 *
 * All five are answered from the specifications in the registry, by the
 * functions here. Nothing about them is hard-coded per application, which is
 * the point: an application deployed this afternoon is in the catalogue this
 * afternoon.
 */

const { asCompany } = require('./db');
const companyContext = require('../companyContext');
const registry = require('./registry');
const canonical = require('./spec/canonical');
const { EXTERNAL_AUDIENCES } = require('./spec/types');

/**
 * Every installed application described in terms a person — or Simeli — can
 * reason about.
 */
async function describe(companyId) {
  const instances = await registry.listInstancesForCompany(companyId);
  const applications = [];

  for (const instance of instances) {
    if (!instance.version_id) continue;
    const version = await registry.getVersion(instance.version_id);
    const spec = version?.spec;
    if (!spec) continue;

    const externalSurfaces = (spec.surfaces || []).filter((s) => EXTERNAL_AUDIENCES.has(s.audience));
    applications.push({
      appKey: instance.app_key,
      name: instance.name,
      description: instance.description,
      icon: instance.icon,
      category: instance.category,
      kind: instance.kind,
      status: instance.status,
      version: instance.running_version,
      entities: (spec.data?.entities || []).map((e) => ({
        key: e.key, label: e.label, description: e.description,
        fields: e.fields.map((f) => ({ name: f.name, label: f.label, type: f.type, sensitive: !!f.sensitive })),
        anchoredTo: e.anchor?.kind || null,
      })),
      dependsOn: spec.data?.canonical_refs || [],
      surfaces: (spec.surfaces || []).map((s) => ({ key: s.key, label: s.label, audience: s.audience })),
      externalAudiences: externalSurfaces.map((s) => s.audience),
      exposes: exposedCanonicalData(spec),
      workflows: (spec.workflows || []).map((w) => ({
        key: w.key, label: w.label, entity: w.entity,
        states: w.states.map((s) => s.key),
      })),
      metrics: (spec.analytics?.metrics || []).map((m) => ({ key: m.key, label: m.label })),
      automations: (spec.automations || []).map((a) => ({ key: a.key, label: a.label, enabled: a.enabled })),
      agents: (spec.ai?.agents || []).map((a) => ({ key: a.key, label: a.label, safetyClass: a.safety_class })),
    });
  }

  return {
    applications,
    summary: {
      installed: applications.length,
      withExternalSurfaces: applications.filter((a) => a.externalAudiences.length).length,
      customerPortals: applications.filter((a) => a.externalAudiences.includes('customer')).map((a) => a.appKey),
      supplierPortals: applications.filter((a) => a.externalAudiences.includes('supplier')).map((a) => a.appKey),
      canonicalDependencies: [...new Set(applications.flatMap((a) => a.dependsOn))],
    },
  };
}

/**
 * Which canonical EMBMIS data an application makes visible, and to whom.
 *
 * The question "which applications expose supplier data?" has two very
 * different answers — reads it internally, and shows it to someone outside the
 * company — and conflating them would be the more dangerous mistake, so they
 * are reported separately.
 */
function exposedCanonicalData(spec) {
  const internal = new Set(spec.data?.canonical_refs || []);
  const external = new Map();

  (spec.surfaces || []).filter((s) => EXTERNAL_AUDIENCES.has(s.audience)).forEach((surface) => {
    const pages = (spec.ui?.pages || []).filter((p) => p.surface === surface.key);
    pages.forEach((page) => {
      const keys = new Set([page.entity, ...(page.layout || []).map((b) => b.entity)].filter(Boolean));
      keys.forEach((key) => {
        if (!canonical.entity(key)) return;
        if (!external.has(surface.audience)) external.set(surface.audience, new Set());
        external.get(surface.audience).add(key);
      });
    });
    // An application entity that references canonical data does not itself
    // expose that data — the reference is a UUID and the runtime only labels it
    // with the target's shareable display columns. Worth stating rather than
    // leaving to inference.
  });

  return {
    readsInternally: [...internal],
    shownExternally: Object.fromEntries([...external.entries()].map(([k, v]) => [k, [...v]])),
  };
}

/**
 * Which applications an answer should mention, given a question.
 *
 * A keyword match rather than an embedding: the catalogue is a handful of
 * applications per company, and a deterministic match is one fewer thing to be
 * subtly wrong.
 */
async function search(companyId, query) {
  const { applications } = await describe(companyId);
  const q = String(query || '').toLowerCase();
  if (!q) return applications;
  return applications.filter((a) => {
    const haystack = [
      a.appKey, a.name, a.description, a.category,
      ...a.entities.flatMap((e) => [e.key, e.label, e.description, ...e.fields.map((f) => f.label)]),
      ...a.dependsOn, ...a.surfaces.map((s) => s.label), ...a.metrics.map((m) => m.label),
    ].join(' ').toLowerCase();
    return q.split(/\s+/).some((word) => word.length > 2 && haystack.includes(word));
  });
}

/**
 * The navigation entries a company's applications contribute to the shell.
 *
 * Only surfaces the user's roles actually reach, so a person with no role in an
 * application does not see a link that would refuse them.
 */
async function navigationFor(companyId, userId, platformRole) {
  const instances = await registry.listInstancesForCompany(companyId);
  const isAdmin = String(platformRole || '').toUpperCase() === 'ADMIN';
  const assignments = userId ? await rolesForUser(companyId, userId) : new Map();
  const sections = [];

  for (const instance of instances) {
    if (instance.status !== 'active' || !instance.version_id) continue;
    const version = await registry.getVersion(instance.version_id);
    const spec = version?.spec;
    if (!spec) continue;

    const held = assignments.get(instance.id) || [];
    const internalSurfaces = (spec.surfaces || []).filter((s) => !EXTERNAL_AUDIENCES.has(s.audience));
    const reachable = internalSurfaces.filter(
      (s) => isAdmin || s.roles.some((r) => held.includes(r))
    );
    if (!reachable.length) continue;

    const surface = reachable[0];
    sections.push({
      appKey: instance.app_key,
      label: instance.name,
      icon: instance.icon || 'layout-grid',
      surface: surface.key,
      defaultPage: surface.default_page || surface.nav[0]?.page,
      items: surface.nav.map((n) => ({ label: n.label, page: n.page, icon: n.icon, section: n.section })),
    });
  }
  return sections;
}

async function rolesForUser(companyId, userId) {
  const { rows } = await companyContext.withCompany(companyId, async (client) => client.query(
    `SELECT app_instance_id, role_key FROM app_role_assignments
      WHERE user_id = $1 AND company_id = $2 AND revoked_at IS NULL`,
    [userId, companyId]
  ));
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.app_instance_id)) map.set(r.app_instance_id, []);
    map.get(r.app_instance_id).push(r.role_key);
  });
  return map;
}

async function roleAssignments(companyId, appKey) {
  const instance = await resolveInstanceByKey(companyId, appKey);
  const version = instance.version_id ? await registry.getVersion(instance.version_id) : null;
  const roles = (version?.spec?.security?.roles || []).filter((r) => !EXTERNAL_AUDIENCES.has(r.audience));

  const { rows } = await companyContext.withCompany(companyId, async (client) => client.query(
    `SELECT a.id, a.role_key, a.granted_at, u.id AS user_id, u.email, u.first_name, u.last_name
       FROM app_role_assignments a
       JOIN users u ON u.id = a.user_id
      WHERE a.app_instance_id = $1 AND a.revoked_at IS NULL
      ORDER BY u.last_name, u.first_name`,
    [instance.id]
  ));

  return {
    roles: roles.map((r) => ({ key: r.key, label: r.label, description: r.description })),
    assignments: rows.map((r) => ({
      id: r.id, roleKey: r.role_key, grantedAt: r.granted_at,
      user: { id: r.user_id, email: r.email, name: [r.first_name, r.last_name].filter(Boolean).join(' ') },
    })),
  };
}

async function assignRole({ companyId, appKey, userId, roleKey, grantedBy }) {
  const instance = await resolveInstanceByKey(companyId, appKey);
  const version = instance.version_id ? await registry.getVersion(instance.version_id) : null;
  const role = (version?.spec?.security?.roles || []).find((r) => r.key === roleKey);
  if (!role) {
    const err = new Error(`This application has no role "${roleKey}".`);
    err.code = 'ROLE_NOT_FOUND'; err.status = 404;
    throw err;
  }
  if (EXTERNAL_AUDIENCES.has(role.audience)) {
    // An external role belongs to an external identity, which is not a `users`
    // row. Granting one to an employee would create an account that is
    // anchor-scoped with no anchor — visible to nobody, and confusing to
    // everybody.
    const err = new Error(`"${roleKey}" is a ${role.audience} role and is held by a portal account, not by an employee.`);
    err.code = 'ROLE_EXTERNAL'; err.status = 400;
    throw err;
  }

  const { rows } = await companyContext.withCompany(companyId, async (client) => client.query(
    `INSERT INTO app_role_assignments (company_id, app_instance_id, user_id, role_key, granted_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (app_instance_id, user_id, role_key)
       DO UPDATE SET revoked_at = NULL, granted_at = CURRENT_TIMESTAMP, granted_by = EXCLUDED.granted_by
     RETURNING *`,
    [companyId, instance.id, userId, roleKey, grantedBy]
  ));

  await registry.recordEvent({
    companyId, applicationId: instance.application_id, instanceId: instance.id,
    eventType: 'application.role_granted',
    provenanceClass: 'authorization',
    actorKind: grantedBy ? 'user' : 'system', actorId: grantedBy,
    summary: `Granted the "${roleKey}" role in ${appKey}.`,
    detail: { userId, roleKey },
  });
  return rows[0];
}

async function revokeRole({ companyId, assignmentId }) {
  await companyContext.withCompany(companyId, async (client) => client.query(
    'UPDATE app_role_assignments SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1 AND company_id = $2',
    [assignmentId, companyId]
  ));
  return { id: assignmentId, revoked: true };
}

async function resolveInstanceByKey(companyId, appKey) {
  const application = await registry.getApplicationByKey(appKey);
  if (!application) {
    const err = new Error('No such application.'); err.code = 'APPLICATION_NOT_FOUND'; err.status = 404; throw err;
  }
  const instance = await registry.getInstance(application.id, companyId);
  if (!instance) {
    const err = new Error('This company has no instance of that application.');
    err.code = 'INSTANCE_NOT_FOUND'; err.status = 404; throw err;
  }
  return instance;
}

// Same reasoning as studio/session.js and deployer.js: an HTTP request has its
// company context established by the auth middleware, but a scheduled job, a
// test or Simeli acting on a company's behalf does not — and without it every
// read of a company-scoped table comes back empty.
module.exports = {
  describe: (companyId) => asCompany(companyId, () => describe(companyId)),
  search: (companyId, query) => asCompany(companyId, () => search(companyId, query)),
  navigationFor: (companyId, userId, platformRole) =>
    asCompany(companyId, () => navigationFor(companyId, userId, platformRole)),
  rolesForUser: (companyId, userId) => asCompany(companyId, () => rolesForUser(companyId, userId)),
  roleAssignments: (companyId, appKey) => asCompany(companyId, () => roleAssignments(companyId, appKey)),
  assignRole: (args = {}) => asCompany(args.companyId, () => assignRole(args)),
  revokeRole: (args = {}) => asCompany(args.companyId, () => revokeRole(args)),
  exposedCanonicalData,
};
