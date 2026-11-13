/**
 * The marketplace: an application one company built, offered to the rest.
 *
 * ===========================================================================
 * ALMOST NONE OF THIS IS NEW
 * ===========================================================================
 * An application has been GLOBAL since the registry was written — one
 * definition, installed per company, each company's data in its own tables.
 * That is exactly the shape a marketplace needs, so publishing is not a new
 * kind of object and installing somebody else's application is the same
 * ensureInstance-then-deploy that installing your own has always been.
 *
 * What is new is the offer: who is publishing, how they describe it to people
 * who have never seen it, which version strangers get, and what they want for
 * it.
 *
 * ===========================================================================
 * WHAT AN INSTALL DOES AND DOES NOT SHARE
 * ===========================================================================
 * Installing a listed application copies NO DATA. The buyer gets the design —
 * the entities, screens, workflows and permissions — compiled into their own
 * tables, named for their own instance, with row-level security over them. The
 * publisher cannot see a row of it and neither can any other installer. This
 * is the promise the whole architecture was built around, and a marketplace is
 * where it stops being theoretical.
 *
 * The version is PINNED at publication. A publisher iterating in the Studio
 * tomorrow does not silently change what strangers receive.
 *
 * ===========================================================================
 * PRICE IS RECORDED, NOT CHARGED
 * ===========================================================================
 * A publisher can name a price and a buyer can see it. Installing a paid
 * listing is refused, and says why.
 *
 * Charging needs answers this module cannot invent: who receives the money,
 * what the platform's share is, what happens to an installed application when
 * a payment fails, how a refund interacts with data the buyer has since
 * created, and whose tax applies when a company in one country buys from a
 * company in another. Taking money and leaving those unanswered is worse than
 * not taking it.
 */

const companyContext = require('../companyContext');
const { pool } = require('../../config/database');
const { asCompany } = require('./db');
const registry = require('./registry');
const canonical = require('./spec/canonical');

class MarketplaceError extends Error {
  constructor(message, code = 'MARKETPLACE_ERROR', status = 400) {
    super(message);
    this.name = 'MarketplaceError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Listings are read with the plain pool, deliberately.
 *
 * Every other table in the platform is company-scoped and read through the
 * company context. This one is the opposite by design: a marketplace nobody
 * outside the publishing company can see is not a marketplace. The rows carry
 * no company data — a name, a summary, a price and a version id — and the
 * company-scoped things they point at are still read through the context.
 */
async function listingRows(where = '', params = []) {
  const { rows } = await pool.query(
    `SELECT l.*, a.app_key, a.name, a.icon, a.category AS app_category, a.description,
            c.name AS publisher_name,
            v.version AS version_number, v.spec AS spec,
            (SELECT count(*) FROM app_company_instances i
              WHERE i.application_id = l.application_id)::int AS install_count
       FROM app_marketplace_listings l
       JOIN applications a          ON a.id = l.application_id
       JOIN companies c             ON c.id = l.publisher_company_id
       JOIN application_versions v  ON v.id = l.version_id
      ${where}
      ORDER BY l.listed_at DESC`,
    params
  );
  return rows;
}

/** What a listing looks like to somebody deciding whether to install it. */
function describe(row, { installed = false, mine = false, suggestion = null } = {}) {
  const spec = row.spec || {};
  return {
    appKey: row.app_key,
    name: row.name,
    icon: row.icon,
    category: row.category || row.app_category,
    summary: row.summary,
    publisher: row.publisher_name,
    publishedVersion: row.version_number,
    price: { cents: row.price_cents, currency: row.currency, free: row.price_cents === 0 },
    installs: row.install_count,
    status: row.status,
    listedAt: row.listed_at,
    // What it will build, and what of yours it will read. The second is the
    // question anybody sensible asks before installing a stranger's software.
    owns: (spec.data?.entities || []).map((e) => e.label || e.key),
    reads: spec.data?.canonical_refs || [],
    externalAudiences: [...new Set((spec.surfaces || [])
      .filter((s) => s.audience !== 'internal').map((s) => s.audience))],
    installed,
    mine,
    suggestion,
  };
}

/**
 * Offer an application to other companies.
 *
 * Only the company that built it, and only a version that has actually been
 * published — a draft is a work in progress and nobody else should be able to
 * install one.
 */
async function publish({ companyId, appKey, summary, priceCents = 0, currency = 'USD', category = null, actorId = null }) {
  const application = await asCompany(companyId, () => registry.getApplicationByKey(appKey));
  if (!application) throw new MarketplaceError(`No application "${appKey}".`, 'APPLICATION_NOT_FOUND', 404);
  if (application.origin_company_id !== companyId) {
    throw new MarketplaceError(
      'Only the company that built an application can offer it to others.', 'NOT_THE_PUBLISHER', 403
    );
  }
  if (application.kind === 'native') {
    throw new MarketplaceError('Core applications ship with EMBMIS and are not listed.', 'NATIVE_NOT_LISTABLE', 400);
  }

  const text = String(summary || '').trim();
  if (text.length < 10 || text.length > 500) {
    throw new MarketplaceError(
      'Describe it for somebody who has never seen it — between 10 and 500 characters.', 'SUMMARY_LENGTH'
    );
  }
  const price = Number.isInteger(priceCents) && priceCents >= 0 ? priceCents : 0;
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new MarketplaceError('Currency must be a three-letter code.', 'BAD_CURRENCY');
  }

  const version = await asCompany(companyId, () => registry.latestVersion(application.id));
  if (!version) throw new MarketplaceError('That application has no version to offer.', 'NO_VERSION', 409);
  if (version.status === 'draft') {
    throw new MarketplaceError(
      'Deploy it before offering it. A draft is a work in progress and nobody else should install one.',
      'VERSION_IS_DRAFT', 409
    );
  }

  const { rows } = await pool.query(
    `INSERT INTO app_marketplace_listings
       (application_id, publisher_company_id, published_by, version_id, summary, category, price_cents, currency, status, listed_at, withdrawn_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'listed', CURRENT_TIMESTAMP, NULL)
     ON CONFLICT (application_id) DO UPDATE SET
       version_id = EXCLUDED.version_id, summary = EXCLUDED.summary, category = EXCLUDED.category,
       price_cents = EXCLUDED.price_cents, currency = EXCLUDED.currency,
       status = 'listed', listed_at = CURRENT_TIMESTAMP, withdrawn_at = NULL,
       published_by = EXCLUDED.published_by, updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [application.id, companyId, actorId, version.id, text, category || application.category, price, currency]
  );

  // The load-bearing change. Every read path already honours visibility, so
  // one update makes it visible everywhere rather than in the places somebody
  // remembered to check.
  await pool.query("UPDATE applications SET visibility = 'global' WHERE id = $1", [application.id]);

  await asCompany(companyId, () => registry.recordEvent({
    companyId, applicationId: application.id, versionId: version.id,
    eventType: 'application.listed',
    provenanceClass: 'execution',
    actorKind: actorId ? 'user' : 'system', actorId,
    summary: `Offered "${application.name}" to other companies at ${price === 0 ? 'no charge' : `${price / 100} ${currency}`}.`,
    detail: { priceCents: price, currency, version: version.version },
  }));

  return describe({ ...rows[0], app_key: application.app_key, name: application.name,
    icon: application.icon, app_category: application.category, description: application.description,
    publisher_name: null, version_number: version.version, spec: version.spec, install_count: 0 },
  { mine: true });
}

/**
 * Stop offering it.
 *
 * Companies that already installed it keep it, and keep their data. Withdrawal
 * is about the shop window, not about reaching into somebody else's business
 * and removing what they are using.
 */
async function withdraw({ companyId, appKey, actorId = null }) {
  const application = await asCompany(companyId, () => registry.getApplicationByKey(appKey));
  if (!application) throw new MarketplaceError(`No application "${appKey}".`, 'APPLICATION_NOT_FOUND', 404);
  if (application.origin_company_id !== companyId) {
    throw new MarketplaceError('Only the publisher can withdraw a listing.', 'NOT_THE_PUBLISHER', 403);
  }

  const { rowCount } = await pool.query(
    `UPDATE app_marketplace_listings
        SET status = 'withdrawn', withdrawn_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE application_id = $1 AND status = 'listed'`,
    [application.id]
  );
  if (!rowCount) throw new MarketplaceError('That application is not listed.', 'NOT_LISTED', 404);

  await pool.query("UPDATE applications SET visibility = 'private' WHERE id = $1", [application.id]);
  await asCompany(companyId, () => registry.recordEvent({
    companyId, applicationId: application.id,
    eventType: 'application.withdrawn',
    provenanceClass: 'execution',
    actorKind: actorId ? 'user' : 'system', actorId,
    summary: `Withdrew "${application.name}" from the marketplace. Companies already running it keep it.`,
  }));
  return { appKey, status: 'withdrawn' };
}

/**
 * What is on offer, from this company's point of view.
 *
 * Marked up with the two things that decide whether a row is worth reading:
 * whether they already have it, and whether it would work here.
 */
async function browse(companyId) {
  const [rows, mine] = await Promise.all([
    listingRows("WHERE l.status = 'listed'"),
    asCompany(companyId, () => registry.listInstalledForCompany(companyId)),
  ]);
  const installed = new Set(mine.map((r) => r.app_key));
  const populated = await populatedCanonicalKeys(companyId);

  return rows.map((row) => describe(row, {
    installed: installed.has(row.app_key),
    mine: row.publisher_company_id === companyId,
    suggestion: suggest(row, populated),
  }));
}

/**
 * Which canonical record types this company actually holds data for.
 *
 * One count per entity, from the catalogue in this repository — never
 * information_schema, and never a name from a request.
 */
async function populatedCanonicalKeys(companyId) {
  return companyContext.withCompany(companyId, async (client) => {
    const held = new Set();
    for (const entity of canonical.list()) {
      try {
        const { rows } = await client.query(`SELECT EXISTS (SELECT 1 FROM ${entity.table}) AS present`);
        if (rows[0]?.present) held.add(entity.key);
      } catch { /* a table this deployment does not have is simply not held */ }
    }
    return held;
  });
}

/**
 * Why this company might want it — a rule, not a model.
 *
 * An application is worth suggesting when the company already holds the data
 * it reads. "You have 340 suppliers and this is a supplier quality
 * application" is a reason somebody can check. An LLM's opinion per listing
 * per page load would cost money, take seconds, and say something different
 * tomorrow about the same two facts.
 */
function suggest(row, populated) {
  const refs = row.spec?.data?.canonical_refs || [];
  const matched = refs.filter((key) => populated.has(key));
  if (!matched.length) return null;
  const labels = matched.map((key) => canonical.entity(key)?.label || key);
  return {
    reason: `You already keep ${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ` and ${labels.length - 3} more` : ''}, which this uses.`,
    matched,
    strength: matched.length / Math.max(refs.length, 1),
  };
}

/**
 * Install somebody else's application.
 *
 * The buyer gets the DESIGN. Their tables are created for their instance, with
 * their own row-level security over them, and no row moves between companies —
 * which is the promise the architecture was built around.
 */
async function install({ companyId, appKey, actorId = null }) {
  const rows = await listingRows("WHERE a.app_key = $1 AND l.status = 'listed'", [appKey]);
  const listing = rows[0];
  if (!listing) throw new MarketplaceError(`"${appKey}" is not on offer.`, 'NOT_LISTED', 404);

  if (listing.price_cents > 0) {
    throw new MarketplaceError(
      'This application has a price and payments are not connected yet, so it cannot be installed. '
      + 'Free applications install immediately.',
      'PAYMENT_REQUIRED', 402
    );
  }

  const existing = await asCompany(companyId, () => registry.getInstance(listing.application_id, companyId));
  if (existing) throw new MarketplaceError('You already have this application.', 'ALREADY_INSTALLED', 409);

  await asCompany(companyId, () => registry.ensureInstance({
    applicationId: listing.application_id, companyId, installedBy: actorId,
  }));

  // Required lazily: the deployer reads this module's catalogue in places, and
  // the cycle is harmless only if it is not resolved at load time.
  const deployer = require('./deployer');
  const result = await deployer.deploy({
    companyId,
    applicationId: listing.application_id,
    versionId: listing.version_id,           // the PINNED version, not the latest
    actorId,
  });

  await asCompany(companyId, () => registry.recordEvent({
    companyId, applicationId: listing.application_id, versionId: listing.version_id,
    eventType: 'application.installed_from_marketplace',
    provenanceClass: 'execution',
    actorKind: actorId ? 'user' : 'system', actorId,
    summary: `Installed "${listing.name}" from the marketplace, published by ${listing.publisher_name}.`,
    detail: { publisher: listing.publisher_name, version: listing.version_number },
  }));

  return { appKey, status: result.status || 'deployed', name: listing.name };
}

/** This company's own listings, listed or withdrawn. */
async function published(companyId) {
  const rows = await listingRows('WHERE l.publisher_company_id = $1', [companyId]);
  return rows.map((row) => describe(row, { mine: true, installed: true }));
}

module.exports = { publish, withdraw, browse, install, published, suggest, MarketplaceError };
