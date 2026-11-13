/**
 * My Work — everything waiting on one person, from every application.
 *
 * ===========================================================================
 * WHY THIS IS THE PROOF
 * ===========================================================================
 * The screen this replaces called eight hardcoded endpoints, one per kind of
 * approval, listed in the frontend. That is the ERP shape exactly: the shell
 * knows the modules, so adding a ninth kind of work means editing the shell.
 *
 * Here the shell asks and each application answers. A core application answers
 * from a declaration in its manifest; an application somebody designed on
 * Tuesday answers from its own workflow — and nobody edited this file to make
 * that happen. If a company builds a capability with an approval step this
 * afternoon, that approval is in this list this afternoon.
 *
 * ===========================================================================
 * WHAT COUNTS AS "WAITING ON YOU"
 * ===========================================================================
 * Not "everything open". Work is only yours if you can actually move it:
 *
 *   native      a declared work tile — overdue invoices, late purchase
 *               orders — scoped to the applications this company runs.
 *
 *   generated   records sitting in a state that has a transition out of it
 *               REQUIRING a role you hold. A finding in UNDER_REVIEW is your
 *               work if reviewing is your role and nobody else's problem if
 *               it is not.
 *
 *   notified    unread notifications addressed to you or to a role you hold.
 *
 * Counting rather than listing every record is deliberate: "4 findings
 * awaiting your review" plus a link that lands on those four is more useful
 * than four rows, and it is one query per state instead of one per record.
 */

const companyContext = require('../companyContext');
const { asCompany } = require('./db');
const appDirectory = require('./appDirectory');
const manifests = require('./native/manifests');
const nativeSummary = require('./native/summary');
const resolver = require('./runtime/resolver');
const authorization = require('./runtime/authorization');
const registry = require('./registry');
const ids = require('./identifiers');

/** A core application's declared work, counted. */
async function nativeWork(companyId, appKey) {
  const manifest = manifests.get(appKey);
  const declared = manifest?.work?.tiles || [];
  if (!declared.length) return [];

  return companyContext.withCompany(companyId, async (client) => {
    const items = [];
    for (const tile of declared) {
      try {
        const { text, params } = nativeSummary.tileSql({ ...tile, appKey });
        const { rows } = await client.query(text, params);
        const count = Number(rows[0]?.value || 0);
        if (!count) continue;                       // nothing waiting is not an item
        items.push({
          key: `${appKey}:${tile.key}`,
          appKey, appName: manifest.name, icon: manifest.icon, kind: 'native',
          title: tile.label, count, route: tile.route || manifest.route,
        });
      } catch (error) {
        console.warn(`[platform] work tile ${appKey}.${tile.key} failed:`, error.message);
      }
    }
    return items;
  });
}

/**
 * A generated application's work: records in a state this person can move.
 *
 * The spec says which transitions leave which state and what each requires.
 * Intersecting that with the roles this person actually holds is the whole
 * calculation — and it is why a workflow step added this afternoon appears
 * here without anybody touching this file.
 */
async function generatedWork(companyId, app, userId, role) {
  const context = await resolver.resolveApplication(companyId, app.key);
  const principal = await authorization.internalPrincipal({
    companyId, instance: context.instance, spec: context.spec, userId, platformRole: role,
  });
  const held = new Set(principal.roleKeys || []);
  if (!held.size) return [];

  const items = [];
  for (const workflow of context.spec.workflows || []) {
    const entity = context.spec.data.entities.find((e) => e.key === workflow.entity);
    if (!entity) continue;

    // Which states have a way out that needs a role this person holds?
    const actionable = new Map();
    for (const transition of workflow.transitions || []) {
      const needs = (transition.requires || [])
        .filter((r) => r.type === 'role' || r.type === 'approval')
        .map((r) => r.role)
        .filter(Boolean);
      if (!needs.length || !needs.some((r) => held.has(r))) continue;
      if (!actionable.has(transition.from)) actionable.set(transition.from, []);
      actionable.get(transition.from).push(transition.label || transition.key);
    }
    if (!actionable.size) continue;

    const table = await registry.resolveTable(context.instance.id, entity.key);
    for (const [state, transitions] of actionable) {
      const { rows } = await companyContext.withCompany(companyId, (client) => client.query(
        // The state column is named by the SPEC, so it is validated as an
        // identifier before it is quoted — a specification is untrusted input
        // no matter how it got here.
        `SELECT count(*) AS value FROM ${table.qualified}
          WHERE ${ids.quoteIdent(workflow.state_field)} = $1 AND deleted_at IS NULL`,
        [state]
      ));
      const count = Number(rows[0]?.value || 0);
      if (!count) continue;
      items.push({
        key: `${app.key}:${workflow.key}:${state}`,
        appKey: app.key, appName: app.name, icon: app.icon, kind: 'generated',
        title: `${entity.label} awaiting ${transitions.join(' or ').toLowerCase()}`,
        count,
        route: `/apps/${app.key}`,
      });
    }
  }
  return items;
}

/** Unread notifications addressed to this person or a role they hold. */
async function notifications(companyId, userId) {
  return companyContext.withCompany(companyId, async (client) => {
    const { rows } = await client.query(
      `SELECT n.id, n.subject, n.body, n.created_at, n.entity_key, n.record_id,
              a.app_key, a.name AS app_name, a.icon
         FROM app_notifications n
         JOIN app_company_instances i ON i.id = n.app_instance_id
         JOIN applications a          ON a.id = i.application_id
        WHERE n.read_at IS NULL
          AND i.status = 'active'
          AND (n.recipient_user_id = $1
               OR (n.recipient_kind = 'role' AND n.recipient_role IN (
                     SELECT role_key FROM app_role_assignments
                      WHERE user_id = $1 AND app_instance_id = i.id AND revoked_at IS NULL)))
        ORDER BY n.created_at DESC
        LIMIT 50`,
      [userId]
    );
    return rows.map((r) => ({
      key: `notification:${r.id}`,
      appKey: r.app_key, appName: r.app_name, icon: r.icon, kind: 'notification',
      title: r.subject, detail: r.body, count: 1,
      at: r.created_at,
      route: `/apps/${r.app_key}`,
    }));
  });
}

/** Everything waiting, from every application this company runs. */
async function build(companyId, { userId, role } = {}) {
  if (!userId) return { items: [], total: 0 };
  const apps = await appDirectory.enabled(companyId);
  const items = [];

  for (const app of apps) {
    try {
      items.push(...(app.kind === 'native'
        ? await nativeWork(companyId, app.key)
        : await generatedWork(companyId, app, userId, role)));
    } catch (error) {
      // One application failing to report is not the inbox failing. The
      // alternative — an empty inbox because something unrelated broke — is
      // how people miss approvals.
      console.warn(`[platform] work from ${app.key} unavailable:`, error.message);
    }
  }

  try {
    items.push(...await notifications(companyId, userId));
  } catch (error) {
    console.warn('[platform] notifications unavailable:', error.message);
  }

  // Most waiting first, so the inbox opens on the biggest pile.
  items.sort((a, b) => b.count - a.count);
  return { items, total: items.reduce((sum, i) => sum + i.count, 0) };
}

module.exports = { build: (companyId, opts) => asCompany(companyId, () => build(companyId, opts)) };
