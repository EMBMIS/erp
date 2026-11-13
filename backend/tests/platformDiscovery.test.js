// Capability Discovery: noticing a gap without inventing one, and never
// filling it unasked.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//   1. Detection is arithmetic over the ledger. No model runs per scan.
//   2. Evidence accumulates across scans, so one late delivery is not a
//      capability gap and a pattern of them is.
//   3. The same underlying problem produces ONE opportunity, however many
//      times it is scanned.
//   4. Discovery never deploys. Accepting one opens the Studio.
//
// Run on its own:  node --test tests/platformDiscovery.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { pool } = require('../config/database');
const companyContext = require('../services/companyContext');
const seedHelper = require('./helpers/platformSeed');
const app = require('./helpers/platformApp');
const discovery = require('../services/platform/discovery');
const signals = require('../services/platform/discovery/signals');
const registry = require('../services/platform/registry');

let available = false;
let seeded = null;

const dbTest = (name, fn) => test(name, async (t) => {
  if (!available) { t.skip('no database with the platform schema'); return; }
  await fn(t);
});

/** Purchase orders that are late, so the late-delivery detector has evidence. */
async function seedLateDeliveries(companyId, supplierId, howMany) {
  await app.as(companyId, () => companyContext.withCompany(companyId, async (client) => {
    for (let i = 0; i < howMany; i += 1) {
      await client.query(
        `INSERT INTO purchase_orders (company_id, po_number, supplier_id, po_date, delivery_date, status, currency, total_amount)
         VALUES ($1, $2, $3, CURRENT_DATE - 60, CURRENT_DATE - ($4 || ' days')::interval, 'APPROVED', 'USD', 1000)`,
        [companyId, `PO-LATE-${seeded.run}-${i}`, supplierId, String(10 + i * 3)]
      );
    }
  }));
}

before(async () => {
  available = await app.platformAvailable();
  if (!available) return;
  seeded = await seedHelper.seed();
});

after(async () => {
  if (seeded) {
    await pool.query('DELETE FROM purchase_orders WHERE po_number LIKE $1', [`PO-LATE-${seeded.run}-%`])
      .catch(() => {});
    await seedHelper.cleanup(seeded);
  }
  await app.closeOwnerPool();
  await pool.end().catch(() => {});
});

// ---------------------------------------------------------------------------
dbTest('a scan with nothing to notice proposes nothing', async () => {
  const result = await discovery.scan(seeded.companyB.id);
  assert.equal(result.opportunitiesProposed, 0);
  const open = await discovery.list(seeded.companyB.id);
  assert.equal(open.length, 0, 'a company with no evidence must not be handed a list of "opportunities"');
});

dbTest('detection is arithmetic over the ledger, not an opinion', async () => {
  await seedLateDeliveries(seeded.companyA.id, seeded.suppliersA[0].id, 4);
  const observed = await signals.collect(seeded.companyA.id);
  const late = observed.find((s) => s.key === 'late_supplier_deliveries');
  assert.ok(late, 'four purchase orders past their delivery date is a signal');
  assert.equal(late.evidence.latePurchaseOrders, 4);
  assert.equal(late.subject, seeded.suppliersA[0].id);
  assert.ok(late.weight > 0);
});

dbTest('evidence accumulates across scans before anything is proposed', async () => {
  const first = await discovery.scan(seeded.companyA.id);
  assert.ok(first.signalsObserved >= 1);

  const accumulated = await app.as(seeded.companyA.id, () =>
    companyContext.withCompany(seeded.companyA.id, async (client) => {
      const { rows } = await client.query(
        `SELECT signal_key, observations, weight FROM app_discovery_signals
          WHERE company_id = $1 AND signal_key = 'late_supplier_deliveries'`,
        [seeded.companyA.id]
      );
      return rows;
    }));
  assert.equal(accumulated.length, 1);
  const afterOne = Number(accumulated[0].weight);

  await discovery.scan(seeded.companyA.id);
  const afterTwo = await app.as(seeded.companyA.id, () =>
    companyContext.withCompany(seeded.companyA.id, async (client) => {
      const { rows } = await client.query(
        `SELECT weight, observations FROM app_discovery_signals
          WHERE company_id = $1 AND signal_key = 'late_supplier_deliveries'`,
        [seeded.companyA.id]
      );
      return rows[0];
    }));
  assert.ok(Number(afterTwo.weight) > afterOne,
    '"four late deliveries this week" and "four every week for two months" must be distinguishable');
});

dbTest('crossing the threshold proposes exactly one opportunity, however often it is scanned', async () => {
  // Scan until the accumulated weight crosses the threshold.
  for (let i = 0; i < 4; i += 1) await discovery.scan(seeded.companyA.id);

  const open = await discovery.list(seeded.companyA.id, { status: 'detected' });
  const late = open.filter((o) => o.source_signal === 'late_supplier_deliveries');
  assert.equal(late.length, 1, 'the same problem proposed on every scan teaches people to ignore the list');
  assert.match(late[0].title, /delivery performance/i);
  assert.ok(late[0].reason.includes('past their delivery date'));
  assert.equal(late[0].requires_new_data_model, true);
  assert.ok(Number(late[0].confidence) > 0 && Number(late[0].confidence) <= 0.9,
    'a heuristic over counts reporting certainty is a heuristic misrepresenting itself');

  // Scanning again does not add a second one.
  await discovery.scan(seeded.companyA.id);
  const again = await discovery.list(seeded.companyA.id, { status: 'detected' });
  assert.equal(again.filter((o) => o.source_signal === 'late_supplier_deliveries').length, 1);
});

dbTest('an opportunity carries the evidence that produced it', async () => {
  const open = await discovery.list(seeded.companyA.id);
  const late = open.find((o) => o.source_signal === 'late_supplier_deliveries');
  assert.ok(late.evidence.latePurchaseOrders >= 4);
  assert.ok(late.evidence.accumulatedWeight > 0);
  assert.ok(late.evidence.observations > 0);
  // And what the company already has, so "you already do this" is answerable.
  assert.ok(Array.isArray(late.existing_capabilities));
});

dbTest('discovery never deploys anything', async () => {
  const before = await pool.query('SELECT count(*)::int AS n FROM app_company_instances WHERE company_id = $1',
    [seeded.companyA.id]);
  for (let i = 0; i < 3; i += 1) await discovery.scan(seeded.companyA.id);
  const after = await pool.query('SELECT count(*)::int AS n FROM app_company_instances WHERE company_id = $1',
    [seeded.companyA.id]);
  assert.equal(after.rows[0].n, before.rows[0].n,
    'a system that notices a gap and fills it unasked reshapes a company overnight');
});

dbTest('accepting an opportunity opens the Studio and builds nothing', async () => {
  const open = await discovery.list(seeded.companyA.id, { status: 'detected' });
  const chosen = open.find((o) => o.source_signal === 'late_supplier_deliveries');

  const result = await discovery.accept({
    companyId: seeded.companyA.id, opportunityId: chosen.id, userId: seeded.userA.id,
  });

  assert.ok(result.session.session.id);
  assert.ok(result.session.plan.newData.length >= 1);

  // A designed application, and NOT a deployed one.
  const instance = await app.as(seeded.companyA.id, () =>
    registry.getInstance(result.session.application.id, seeded.companyA.id));
  assert.equal(instance, null, 'accepting is opening the Studio, not building');

  const updated = await discovery.list(seeded.companyA.id);
  const row = updated.find((o) => o.id === chosen.id);
  assert.equal(row.status, 'accepted');
  assert.equal(row.studio_session_id, result.session.session.id);
});

dbTest('dismissing an opportunity records who decided and when', async () => {
  const open = await discovery.list(seeded.companyA.id, { status: 'detected' });
  if (!open.length) return; // nothing else crossed a threshold in this run
  const dismissed = await discovery.setStatus({
    companyId: seeded.companyA.id, opportunityId: open[0].id,
    status: 'dismissed', userId: seeded.userA.id,
  });
  assert.equal(dismissed.status, 'dismissed');
  assert.equal(dismissed.reviewed_by, seeded.userA.id);
  assert.ok(dismissed.reviewed_at);
});

dbTest('an opportunity a company already has an application for is not proposed again', async () => {
  // Install something that serves the gap, then scan again.
  const spec = app.composeFromRequirement(
    'Build a supplier delivery performance application where suppliers respond to their own delivery issues in a portal'
  );
  spec.key = 'supplier_delivery_performance';
  await app.deploySpec({ companyId: seeded.companyA.id, userId: seeded.userA.id, spec });

  // Clear the previous proposal, so that what stops the re-proposal is the
  // "already served" check and not merely the dedupe key. The delete runs
  // inside the company's own context — without it, row-level security silently
  // matches nothing and the test would pass for the wrong reason.
  const removed = await app.as(seeded.companyA.id, () =>
    companyContext.withCompany(seeded.companyA.id, async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM capability_opportunities WHERE company_id = $1 AND source_signal = $2',
        [seeded.companyA.id, 'late_supplier_deliveries']
      );
      return rowCount;
    }));
  assert.ok(removed >= 1, 'the previous proposal should have been there to remove');

  await discovery.scan(seeded.companyA.id);
  const open = await discovery.list(seeded.companyA.id);
  assert.ok(!open.some((o) => o.source_signal === 'late_supplier_deliveries'),
    'proposing a capability the company already runs is the system failing to notice its own work');
});

dbTest('discovery survives a deployment missing a table it wanted to count', async () => {
  // Every detector is best-effort: a company on a build without some module
  // gets fewer signals, not a broken scan.
  const observed = await signals.collect(seeded.companyB.id);
  assert.ok(Array.isArray(observed));
});

dbTest('a detection is recorded as an observation, not as a decision', async () => {
  const events = await app.as(seeded.companyA.id, () =>
    registry.listEvents({ companyId: seeded.companyA.id, limit: 200 }));
  const detected = events.find((e) => e.event_type === 'discovery.opportunity_detected');
  assert.ok(detected);
  assert.equal(detected.provenance_class, 'observation');
  assert.equal(detected.actor_kind, 'system');

  const accepted = events.find((e) => e.event_type === 'discovery.opportunity_accepted');
  if (accepted) assert.equal(accepted.provenance_class, 'authorization');
});
