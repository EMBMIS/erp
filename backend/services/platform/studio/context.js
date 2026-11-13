/**
 * What the Studio knows about a company before it designs anything.
 *
 * "Inspect existing EMBMIS data and capabilities" is the step that separates
 * this from a generic app builder: an application for a company that already
 * has 412 suppliers and 3,900 purchase orders should reference those, not
 * invent a Supplier table beside them. So before any design happens, the Studio
 * reads what is actually there — which canonical entities hold data, how much,
 * and what applications the company already runs — and that becomes both the
 * plan shown to the user and the context given to the model.
 *
 * Counts are read through the company's own context, so they are this company's
 * data and nobody else's.
 */

const companyContext = require('../../companyContext');
const { quoteIdent } = require('../identifiers');
const canonical = require('../spec/canonical');
const registry = require('../registry');

/**
 * @returns {{company, canonical: [{key,label,count,columns,anchorKind}], applications, entityCatalogue}}
 */
async function gather(companyId) {
  const [company, counts, installed] = await Promise.all([
    companyProfile(companyId),
    canonicalCounts(companyId),
    registry.listInstancesForCompany(companyId),
  ]);

  const available = canonical.list().map((entity) => ({
    ...entity,
    count: counts[entity.key] ?? 0,
    populated: (counts[entity.key] ?? 0) > 0,
  }));

  // Every entity every installed application owns, so the Studio can say "you
  // already have somewhere to put this" instead of building a second one.
  const existingEntities = [];
  for (const instance of installed) {
    if (!instance.version_id) continue;
    const version = await registry.getVersion(instance.version_id);
    (version?.spec?.data?.entities || []).forEach((e) => {
      existingEntities.push({
        application: instance.app_key,
        applicationName: instance.name,
        entity: e.key,
        label: e.label,
        description: e.description,
      });
    });
  }

  return {
    company,
    canonical: available,
    applications: installed.map((i) => ({
      appKey: i.app_key, name: i.name, description: i.description,
      status: i.status, version: i.running_version,
    })),
    existingEntities,
  };
}

async function companyProfile(companyId) {
  return companyContext.withCompany(companyId, async (client) => {
    const { rows } = await client.query(
      'SELECT id, company_code, name, base_currency, locale, timezone FROM companies WHERE id = $1',
      [companyId]
    );
    return rows[0] || { id: companyId, name: 'This company' };
  });
}

/**
 * How much of each canonical entity this company actually holds.
 *
 * One query per entity, each a plain count against a table named by the
 * catalogue in this repository. A count that fails (a table this deployment
 * does not have) is recorded as zero rather than taking the whole Studio down:
 * not knowing how many shipments exist is a worse plan, not a broken one.
 */
async function canonicalCounts(companyId) {
  const counts = {};
  await companyContext.withCompany(companyId, async (client) => {
    for (const entity of Object.values(canonical.CANONICAL_ENTITIES)) {
      try {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${quoteIdent(entity.table)}`);
        counts[entity.key] = rows[0].n;
      } catch {
        counts[entity.key] = 0;
      }
    }
  });
  return counts;
}

/**
 * The context as prose, for a model prompt.
 *
 * Deliberately compact: a model given 190 tables and every column will design
 * against the wrong ones. It gets the thirteen entities the platform actually
 * exposes, with counts so it can tell what this company really does.
 */
function toPromptContext(context) {
  const lines = [];
  lines.push(`Company: ${context.company.name}`);
  lines.push('');
  lines.push('CANONICAL EMBMIS ENTITIES (reference these; never redeclare them):');
  context.canonical.forEach((e) => {
    const cols = e.columns.map((c) => `${c.name}:${c.type}${c.shared ? '' : ' [internal-only]'}`).join(', ');
    lines.push(`- ${e.key} (${e.label}) — ${e.count} record(s)${e.anchorKind ? `, anchors ${e.anchorKind} portal identities` : ''}`);
    lines.push(`    columns: ${cols}`);
  });
  if (context.applications.length) {
    lines.push('');
    lines.push('APPLICATIONS THIS COMPANY ALREADY RUNS:');
    context.applications.forEach((a) => lines.push(`- ${a.appKey}: ${a.name} — ${a.description || ''}`));
  }
  if (context.existingEntities.length) {
    lines.push('');
    lines.push('DATA THOSE APPLICATIONS ALREADY OWN:');
    context.existingEntities.forEach((e) => lines.push(`- ${e.application}.${e.entity} (${e.label})`));
  }
  return lines.join('\n');
}

module.exports = { gather, toPromptContext, canonicalCounts };
