/**
 * CRM import — the parts that are not the model.
 *
 * There is no parser to test any more. What is left in code is the machinery
 * around the read: cutting a long document into windows so nothing is skipped,
 * cleaning what comes back, checking that a quoted source is really in the
 * file, and merging one person seen twice across an overlap.
 *
 * Those are where a silent failure would live now, so those are what is tested.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  windows, cleanPerson, identity, WINDOW,
} = require('../services/ai/crmImport');

/* -------------------------------------------------------------- windowing */

test('windows: a short document is one window', () => {
  assert.strictEqual(windows('Jane Smith, Acme, jane@acme.com').length, 1);
});

test('windows: a long document is cut, and every character is covered', () => {
  // Exhaustiveness is the whole reason this is sequential rather than
  // retrieved. A window scheme that leaves a gap loses a contact silently.
  // Each line is unique. With identical lines indexOf finds the first match
  // rather than the expected one, and the test measures nothing.
  const text = Array.from({ length: 1200 },
    (_, i) => `Contact ${i}, Head of Procurement, Acme ${i}, c${i}@acme.com`).join('\n');
  const parts = windows(text);

  assert.ok(parts.length > 1, 'should have been cut into several windows');
  // Rebuilding from the windows must reproduce the document. Overlap means
  // joins repeat, so the test is that nothing is MISSING.
  let cursor = 0;
  for (const p of parts) {
    const at = text.indexOf(p, Math.max(0, cursor - p.length));
    assert.ok(at >= 0, 'window is not a substring of the source');
    assert.ok(at <= cursor, `gap between windows at ${cursor}`);
    cursor = at + p.length;
  }
  assert.strictEqual(cursor, text.length, 'the last window must reach the end');
});

test('windows: overlap so a person on a boundary is seen whole', () => {
  const text = 'x'.repeat(WINDOW * 2);
  const parts = windows(text);
  const joined = parts.reduce((n, p) => n + p.length, 0);
  assert.ok(joined > text.length, 'windows should overlap, not abut');
});

test('windows: cuts on a line break so a spreadsheet row stays intact', () => {
  const row = `${'a'.repeat(200)}\n`;
  const parts = windows(row.repeat(200));
  // Every window but the last should end at a newline.
  for (const p of parts.slice(0, -1)) {
    assert.ok(p.endsWith('\n'), 'window did not end on a complete line');
  }
});

/* ---------------------------------------------------------------- cleaning */

test('cleanPerson: placeholder values become empty, not literal text', () => {
  // "n/a" written into an email field is the kind of thing that reaches a
  // mail merge six months later.
  const text = 'Jane Smith';
  const p = cleanPerson({
    first_name: 'Jane', last_name: 'Smith', email: 'n/a', phone: '-',
    job_title: 'unknown', company_name: 'TBC', source: 'Jane Smith',
  }, text, 0);
  assert.strictEqual(p.email, '');
  assert.strictEqual(p.phone, '');
  assert.strictEqual(p.job_title, '');
  assert.strictEqual(p.company_name, '');
});

test('cleanPerson: a malformed email is dropped and flagged', () => {
  const p = cleanPerson({ first_name: 'Jane', email: 'not-an-email', source: 'Jane' }, 'Jane', 0);
  assert.strictEqual(p.email, '');
  assert.match(p.problems[0], /not a valid email/);
});

test('cleanPerson: an email is lowered so the duplicate check is not defeated', () => {
  const p = cleanPerson({ first_name: 'Jane', email: 'JANE@ACME.COM', source: 'Jane' }, 'Jane', 0);
  assert.strictEqual(p.email, 'jane@acme.com');
});

test('cleanPerson: a nameless row with a company uses the company as the lead name', () => {
  // The common case in practice: a supplier/company list, one email per
  // organisation, no named individual. The company the row is actually
  // about is a real, useful name for the lead — not a placeholder — so it
  // is used rather than a generic "Not specified".
  const p = cleanPerson(
    { email: 'svoboda@klimaservis.cz', company_name: 'Klimaservis Ostrava', source: 'Klimaservis Ostrava' },
    'Klimaservis Ostrava', 0,
  );
  assert.strictEqual(p.first_name, 'Klimaservis Ostrava');
  assert.strictEqual(p.last_name, '');
  assert.deepStrictEqual(p.problems, []);
});

test('cleanPerson: a row with no name and no company falls back to "Not specified"', () => {
  // Nothing to name the lead after at all — used to be rejected outright,
  // which dropped every row of an otherwise-fine import. contacts.first_name
  // is NOT NULL, so it gets a placeholder instead, and nothing is flagged.
  const p = cleanPerson({ email: 'x@y.com', source: 'x@y.com' }, 'x@y.com', 0);
  assert.strictEqual(p.first_name, 'Not specified');
  assert.strictEqual(p.last_name, '');
  assert.deepStrictEqual(p.problems, []);
});

test('cleanPerson: a surname alone is kept as the surname, not overwritten', () => {
  const p = cleanPerson({ last_name: 'Smith', source: 'Smith' }, 'Smith', 0);
  assert.strictEqual(p.first_name, '');
  assert.strictEqual(p.last_name, 'Smith');
});

test('cleanPerson: a source that is not in the file is flagged', () => {
  // This is the safeguard that replaces the parser's guarantee. A model that
  // paraphrases its quote has removed the reviewer's only way to check the row,
  // so the row has to say so.
  const text = 'Met Jane Smith from Acme on Tuesday.';
  const p = cleanPerson({
    first_name: 'Jane', last_name: 'Smith',
    source: 'Jane Smith is the CFO of a company we have never heard of',
  }, text, 0);
  assert.match(p.problems.join(' '), /not in the file/);
});

test('cleanPerson: a source copied from the file is not flagged', () => {
  const text = 'Met Jane Smith from Acme Industrial on Tuesday.';
  const p = cleanPerson({
    first_name: 'Jane', last_name: 'Smith', source: 'Jane Smith from Acme Industrial',
  }, text, 0);
  assert.deepStrictEqual(p.problems, []);
});

/* ---------------------------------------------------------------- identity */

test('identity: email wins, so the same person written two ways merges', () => {
  const a = { first_name: 'Jane', last_name: 'Smith', email: 'jane@acme.com' };
  const b = { first_name: 'J.', last_name: 'Smith', email: 'jane@acme.com' };
  assert.strictEqual(identity(a), identity(b));
});

test('identity: without an email it falls back to the name', () => {
  const a = { first_name: 'Jane', last_name: 'Smith', email: '' };
  const b = { first_name: 'jane', last_name: 'SMITH', email: '' };
  assert.strictEqual(identity(a), identity(b));
});

test('identity: two different people do not collide', () => {
  const a = { first_name: 'Jane', last_name: 'Smith', email: '' };
  const b = { first_name: 'John', last_name: 'Smith', email: '' };
  assert.notStrictEqual(identity(a), identity(b));
});
