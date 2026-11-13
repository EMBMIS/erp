// Build progress: what the Studio shows while it works.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//     A design reports its steps as it makes them. The report is commentary —
//     a build with no listener, or a listener that throws, produces exactly
//     the same application.
//
// The last part is the one worth a test: a progress stream is a nice-to-have
// bolted onto the one operation in the platform that must not become less
// reliable. If a closed browser tab could take a build down, this feature
// would be a net loss.
//
// Run on its own:  node --test tests/platformProgress.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { pool } = require('../config/database');
const seedHelper = require('./helpers/platformSeed');
const app = require('./helpers/platformApp');
const progress = require('../services/platform/studio/progress');
const generator = require('../services/platform/studio/generator');
const session = require('../services/platform/studio/session');

const REQUIREMENT =
  'Build a supplier quality management application where our employees manage findings '
  + 'and suppliers can respond to their own findings in a portal.';

let available = false;
let seeded = null;

before(async () => {
  available = await app.platformAvailable();
  if (!available) return;
  seeded = await seedHelper.seed();
});

after(async () => {
  if (seeded) await seedHelper.cleanup(seeded);
  await pool.end().catch(() => {});
});

const dbTest = (name, fn) => test(name, async (t) => {
  if (!available) { t.skip('no database with the platform schema'); return; }
  await fn(t);
});

// --- the reporter itself, no database needed -------------------------------
test('a step is reported twice: once running, once done', () => {
  const seen = [];
  const emit = progress.reporter((e) => seen.push(e));
  emit('designing', 'thinking');
  emit.done('designing', 'thought');

  assert.deepEqual(seen.map((e) => e.status), ['running', 'done']);
  assert.deepEqual(seen.map((e) => e.detail), ['thinking', 'thought']);
  // The label comes from the closed set, not from the caller — the Studio
  // draws a checklist from it and cannot render a step it does not know.
  assert.equal(seen[0].label, progress.STEPS.designing);
  seen.forEach((e) => assert.ok(Date.parse(e.at), 'every step is timestamped'));
});

test('an unknown step is a programming error, not a blank row in the UI', () => {
  const emit = progress.reporter(() => {});
  assert.throws(() => emit('reticulating_splines'), /Unknown build step/);
});

test('no listener means no cost and no crash', () => {
  const emit = progress.reporter(null);
  assert.doesNotThrow(() => { emit('designing'); emit.done('designing'); });
});

test('a listener that throws does not take the build with it', () => {
  const emit = progress.reporter(() => { throw new Error('the tab was closed'); });
  assert.doesNotThrow(() => { emit('designing'); emit.done('designing'); });
});

// --- the design that produces them -----------------------------------------
dbTest('a design reports the work it is actually doing', async () => {
  const seen = [];
  const designed = await generator.design({
    companyId: seeded.companyA.id,
    requirement: REQUIREMENT,
    onProgress: (e) => seen.push(e),
  });

  const done = seen.filter((e) => e.status === 'done').map((e) => e.step);
  // Every step the analyser path takes, in order. Not a guess at what it
  // might do — the sequence a user watches.
  assert.deepEqual(done, ['reading_context', 'designing', 'composing', 'validating', 'planning']);

  // Each running step is followed by its own completion, so the Studio never
  // leaves a spinner on a step that finished.
  seen.filter((e) => e.status === 'running').forEach((r) => {
    assert.ok(seen.some((d) => d.step === r.step && d.status === 'done'), `${r.step} never completed`);
  });

  // The details describe THIS design, not a generic script.
  const composing = seen.find((e) => e.step === 'composing' && e.status === 'done');
  assert.match(composing.detail, new RegExp(`${designed.spec.data.entities.length} entities`));
  assert.match(composing.detail, new RegExp(`${designed.spec.ui.pages.length} screens`));
});

dbTest('a build with no listener produces the same application as one with', async () => {
  const withListener = [];
  const a = await generator.design({
    companyId: seeded.companyA.id, requirement: REQUIREMENT, onProgress: (e) => withListener.push(e),
  });
  const b = await generator.design({ companyId: seeded.companyA.id, requirement: REQUIREMENT });

  assert.ok(withListener.length > 0);
  assert.deepEqual(a.spec, b.spec);
  assert.equal(a.source, b.source);
});

dbTest('a listener that throws on every step still yields a deployable session', async () => {
  const started = await app.as(seeded.companyA.id, () => session.start({
    companyId: seeded.companyA.id,
    userId: seeded.userA.id,
    requirement: REQUIREMENT,
    onProgress: () => { throw new Error('the connection dropped'); },
  }));

  assert.ok(started.session.id);
  assert.ok(started.version.id);
  assert.equal(started.validation.ok, true);
  assert.ok(started.spec.data.entities.length > 0);
});

dbTest('starting a session reports naming and saving after the design', async () => {
  const seen = [];
  await app.as(seeded.companyA.id, () => session.start({
    companyId: seeded.companyA.id,
    userId: seeded.userA.id,
    requirement: 'Create a construction site inspection application with issues tracked to closure.',
    onProgress: (e) => seen.push(e),
  }));

  const done = seen.filter((e) => e.status === 'done').map((e) => e.step);
  assert.ok(done.includes('naming'));
  assert.ok(done.includes('saving'));
  assert.equal(done[done.length - 1], 'ready', 'the last thing a user sees is that it is ready');
  // Saving comes after designing, because a draft is written only once there
  // is something validated to write.
  assert.ok(done.indexOf('saving') > done.indexOf('validating'));
  // The application key it reserved is reported, since that is the name the
  // user will see everywhere afterwards.
  assert.match(seen.find((e) => e.step === 'naming' && e.status === 'done').detail, /^[a-z][a-z0-9_]+$/);
});
