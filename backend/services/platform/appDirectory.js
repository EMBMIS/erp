/**
 * Every application this company has, of either kind, through one interface.
 *
 * ===========================================================================
 * WHY A FAÇADE AND NOT ONE STORE
 * ===========================================================================
 * A native application's code ships with EMBMIS and its switch has lived in
 * `company_modules` since long before the platform existed. A generated
 * application's tables are created per company and its switch is the status on
 * `app_company_instances`. Those are genuinely different facts about
 * genuinely different things, and forcing Finance to carry a synthetic
 * specification and a fake `table_prefix` so both could live in one table
 * would be a lie told to make a diagram tidier — the kind that costs a day
 * every time someone reads it afterwards.
 *
 * So: two stores, one interface. Callers — the shell, the home page, the App
 * Library, Simeli — ask this module and never learn which store answered.
 * That is the only place the distinction is allowed to exist.
 *
 * ===========================================================================
 * DISABLED, NEVER UNINSTALLED
 * ===========================================================================
 * Both kinds switch off the same way and neither is ever removed. For a
 * generated application that is migration 202609050100's promise: the rows
 * stay. For a native one it always was: turning Finance off has never deleted
 * an invoice. `setEnabled` is one call for both, so a caller cannot get this
 * wrong for one kind and right for the other.
 *
 * Core modules are the exception the database already enforces:
 * moduleService.setModuleEnabled refuses them, and the refusal surfaces here
 * as a plain message rather than a stack trace.
 */

const registry = require('./registry');
const resolver = require('./runtime/resolver');
const authorization = require('./runtime/authorization');
const analytics = require('./runtime/analytics');
const manifests = require('./native/manifests');
const nativeSummary = require('./native/summary');
const moduleService = require('../moduleService');
const { asCompany } = require('./db');

class DirectoryError extends Error {
  constructor(message, code = 'DIRECTORY_ERROR', status = 400) {
    super(message);
    this.name = 'DirectoryError';
    this.code = code;
    this.status = status;
  }
}

/**
 * What every application looks like to a caller, whichever store it came from.
 *
 * `reads` and `writes` are the honest answer to "what can this thing touch?",
 * which is the question an App Library exists to answer and the one an ERP
 * cannot answer at all.
 */
function describeNative(manifest, moduleRow) {
  return {
    key: manifest.key,
    name: manifest.name,
    description: manifest.description,
    icon: manifest.icon,
    category: manifest.category,
    kind: 'native',
    enabled: !!moduleRow?.enabled,
    core: !!moduleRow?.is_core,
    // A core module has no switch. Saying so here means the App Library can
    // render it correctly without knowing what "core" means.
    removable: !moduleRow?.is_core,
    route: manifest.route,
    reads: manifest.references,
    writes: manifest.writes,
    owns: [],
    // False only for Mail, whose data is deliberately outside the canonical
    // catalogue. Reported rather than inferred from an empty `reads`, because
    // "reads nothing" and "holds data nothing else can reach" are different
    // facts and the App Library has to be able to say which one it means.
    catalogued: manifest.catalogued !== false,
    tiles: (manifest.home?.tiles || []).length,
    disabledAt: null, disabledBy: null, disabledReason: null,
  };
}

function describeGenerated(row) {
  const spec = row.spec || null;
  const entities = spec?.data?.entities?.map((e) => e.key) || [];
  return {
    key: row.app_key,
    name: row.name,
    description: row.description,
    icon: row.icon,
    category: row.category,
    kind: 'generated',
    enabled: row.instance_status === 'active',
    core: false,
    removable: true,
    route: `/apps/${row.app_key}`,
    // A generated application reads canonical data and OWNS its own tables.
    // Keeping those apart is not cosmetic: only one of them is private to
    // this company, and an App Library that blurred it would misdescribe
    // exactly the thing people worry about.
    reads: spec?.data?.canonical_refs || [],
    writes: [],
    owns: entities,
    catalogued: true,
    tiles: (spec?.analytics?.metrics || []).length,
    installed: !!row.instance_id,
    status: row.instance_status || null,
    disabledAt: row.disabled_at || null,
    disabledBy: row.disabled_by || null,
    disabledReason: row.disabled_reason || null,
  };
}

/**
 * The company's applications: built-in first, then the ones it built.
 *
 * Includes DISABLED ones — an App Library that hides what you switched off
 * gives you no way to switch it back on.
 */
async function list(companyId) {
  // `company_modules` is company-scoped and governed by row-level security, so
  // reading it outside a company context does not fail — it returns nothing,
  // and every non-core module reads as switched off. A silently wrong answer,
  // which is why every call into moduleService from here is wrapped.
  const [moduleRows, appRows] = await Promise.all([
    asCompany(companyId, () => moduleService.getModulesWithStatus(companyId)),
    asCompany(companyId, () => registry.listInstalledForCompany(companyId)),
  ]);
  const byModuleKey = new Map(moduleRows.map((m) => [m.key, m]));

  const native = manifests.list()
    // A module this deployment does not define is simply not offered.
    .filter((m) => byModuleKey.has(m.moduleKey))
    .map((m) => describeNative(m, byModuleKey.get(m.moduleKey)));

  const generated = appRows
    .filter((row) => row.kind !== 'native')
    .map(describeGenerated);

  return [...native, ...generated];
}

/** Just the ones that are on — what the shell and the home page render. */
async function enabled(companyId) {
  return (await list(companyId)).filter((a) => a.enabled);
}

/**
 * Switch one application on or off, whichever kind it is.
 *
 * The caller says "turn this off" and does not say how. That is the whole
 * point of this module existing.
 */
async function setEnabled(companyId, appKey, isEnabled, { actorId = null, reason = null } = {}) {
  const manifest = manifests.get(appKey);
  if (manifest) {
    try {
      await asCompany(companyId, () => moduleService.setModuleEnabled(companyId, manifest.moduleKey, isEnabled));
    } catch (error) {
      throw new DirectoryError(error.message, 'MODULE_NOT_TOGGLEABLE', 409);
    }
    const rows = await asCompany(companyId, () => moduleService.getModulesWithStatus(companyId));
    return describeNative(manifest, rows.find((m) => m.key === manifest.moduleKey));
  }

  const application = await asCompany(companyId, () => registry.getApplicationByKey(appKey));
  if (!application) throw new DirectoryError(`No application "${appKey}".`, 'APPLICATION_NOT_FOUND', 404);
  await asCompany(companyId, () => registry.assertVisible(application.id, companyId));

  // Required lazily: the deployer requires this module back for its own
  // catalogue reads, and the cycle is harmless but only if it is not resolved
  // at load time.
  const deployer = require('./deployer');
  await (isEnabled
    ? deployer.enable({ companyId, applicationId: application.id, actorId })
    : deployer.disable({ companyId, applicationId: application.id, actorId, reason }));

  const after = (await list(companyId)).find((a) => a.key === appKey);
  return after;
}

/**
 * The home page: one section per enabled application, in one round trip.
 *
 * The shell does not know what applications exist. It renders what this
 * returns. A company that builds a capability at 11am has a home section for
 * it at 11am, and nobody deployed a frontend to make that happen — which is
 * the property that makes this an operating system rather than a product with
 * a plugin directory.
 */
async function home(companyId, { userId = null, role = null } = {}) {
  const apps = await enabled(companyId);
  const sections = [];

  for (const app of apps) {
    if (!app.tiles) continue;                       // contributes nothing; not a section
    try {
      const tiles = app.kind === 'native'
        ? await nativeSummary.summarize(companyId, app.key)
        : await generatedTiles(companyId, app.key, userId, role);
      if (!tiles.length) continue;
      sections.push({
        appKey: app.key, name: app.name, icon: app.icon, kind: app.kind,
        route: app.route, tiles,
      });
    } catch (error) {
      // One application's numbers failing is not the home page failing.
      console.warn(`[platform] home section ${app.key} failed:`, error.message);
    }
  }
  return sections;
}

/**
 * A generated application's home tiles.
 *
 * Runs through the ordinary runtime path — resolve the instance, build the
 * principal, ask analytics — rather than reading the tables directly. The home
 * page must not be able to show a person a number they would be refused on the
 * application's own dashboard, and the only way to guarantee that is to make
 * it the same code.
 */
async function generatedTiles(companyId, appKey, userId, role) {
  const context = await resolver.resolveApplication(companyId, appKey);
  const principal = await authorization.internalPrincipal({
    companyId, instance: context.instance, spec: context.spec, userId, platformRole: role,
  });
  const results = await analytics.metrics(context, principal, []);
  return results
    // analytics reports a metric the caller may not read as a denied entry
    // rather than throwing; a home tile with nothing in it is just noise.
    .filter((m) => !m.denied && m.value !== undefined)
    .map((m) => ({
      key: m.key, label: m.label, hint: null,
      format: m.format || 'number', value: m.value === null ? null : Number(m.value),
    }));
}

// Same reasoning as deployer.js and studio/session.js: this module's entry
// points establish the company context their queries need rather than trusting
// a caller to have done it. Everything here reads company-scoped tables, and
// under row-level security a missing context is not an error — it is an empty
// answer, which is worse.
module.exports = {
  list: (companyId) => asCompany(companyId, () => list(companyId)),
  enabled: (companyId) => asCompany(companyId, () => enabled(companyId)),
  setEnabled: (companyId, appKey, isEnabled, opts) =>
    asCompany(companyId, () => setEnabled(companyId, appKey, isEnabled, opts)),
  home: (companyId, opts) => asCompany(companyId, () => home(companyId, opts)),
  DirectoryError,
};
