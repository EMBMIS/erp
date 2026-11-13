// Identifier safety: what reaches SQL, and what is refused before it can.
//
// THE CLAIM UNDER TEST
// ===========================================================================
//     No string that arrived from outside this process is ever concatenated
//     into SQL. Logical keys are validated against an allowlist and REJECTED
//     when they fail — never escaped, sanitised, or truncated into something
//     that passes. Physical names are derived by the server from ids it
//     already holds.
//
// These tests need no database, because the property is about what happens
// BEFORE anything reaches one. Run on its own:
//     node --test tests/platformIdentifiers.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const ids = require('../services/platform/identifiers');

// ---------------------------------------------------------------------------
// Hostile logical keys
// ---------------------------------------------------------------------------
const HOSTILE_KEYS = [
  'users; DROP TABLE users',
  'users"; DROP TABLE users; --',
  "findings'); DELETE FROM app_instance_tables; --",
  'findings" ',
  'FINDINGS',                 // case folding surprises
  '"findings"',
  'findings ',
  'findings\n',
  'find ings',
  '1findings',                // must start with a letter
  '_findings',
  'findings_',                // a trailing underscore reads as a truncation
  'find__ings',               // reserved for platform-generated names
  'select', 'table', 'user', 'default', 'order', 'group',  // reserved words
  '',
  null,
  undefined,
  42,
  {},
  'ﬁndings',             // unicode ligature — a confusable for "findings"
  'findings​',           // zero-width space
  'a'.repeat(64),
];

test('every hostile identifier is refused, none is repaired', () => {
  for (const key of HOSTILE_KEYS) {
    assert.equal(ids.isLogicalKey(key), false, `should refuse ${JSON.stringify(key)}`);
    assert.throws(() => ids.assertLogicalKey(key, 'Key'), /must be lowercase snake_case/,
      `assert should throw for ${JSON.stringify(key)}`);
  }
});

test('legitimate keys pass', () => {
  ['findings', 'quality_findings', 'warranty_claim_items', 'a1', 'x_9'].forEach((key) => {
    assert.equal(ids.isLogicalKey(key), true, key);
  });
});

test('field names may not collide with the columns the platform owns', () => {
  ['id', 'company_id', 'app_instance_id', 'created_at', 'updated_at', 'deleted_at',
    'created_by_user_id', 'created_by_external_id'].forEach((name) => {
    assert.throws(() => ids.assertFieldKey(name), /reserved/, name);
  });
  assert.equal(ids.assertFieldKey('root_cause'), 'root_cause');
});

// ---------------------------------------------------------------------------
// quoteIdent — the last line of defence, deliberately hostile
// ---------------------------------------------------------------------------
test('quoteIdent refuses anything not already validated', () => {
  [
    'users; DROP TABLE users', 'Findings', 'findings"', "findings'", 'find ings',
    '', null, undefined, 123, 'a'.repeat(64),
  ].forEach((value) => {
    assert.throws(() => ids.quoteIdent(value), ids.IdentifierError, JSON.stringify(value));
  });
  assert.equal(ids.quoteIdent('quality_findings'), '"quality_findings"');
});

test('quoteLiteral doubles quotes and refuses non-strings', () => {
  assert.equal(ids.quoteLiteral("O'Brien"), "'O''Brien'");
  assert.equal(ids.quoteLiteral("x'; DROP TABLE users; --"), "'x''; DROP TABLE users; --'");
  assert.throws(() => ids.quoteLiteral(5), ids.IdentifierError);
});

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------
const APP_A = '7fa2b1c0-0000-4000-8000-000000000001';
const APP_B = '7fa2b1c0-0000-4000-8000-000000000002';
const CO_A = 'c81d0000-0000-4000-8000-00000000000a';
const CO_B = 'c81d0000-0000-4000-8000-00000000000b';

test('a prefix is deterministic: same inputs, same name, every time', () => {
  const first = ids.instanceTablePrefix(APP_A, CO_A);
  for (let i = 0; i < 25; i += 1) {
    assert.equal(ids.instanceTablePrefix(APP_A, CO_A), first);
  }
  assert.match(first, /^app_[a-f0-9]{8}_[a-f0-9]{8}$/);
});

test('the same application in two companies gets two different prefixes', () => {
  assert.notEqual(ids.instanceTablePrefix(APP_A, CO_A), ids.instanceTablePrefix(APP_A, CO_B));
});

test('two applications in the same company get two different prefixes', () => {
  assert.notEqual(ids.instanceTablePrefix(APP_A, CO_A), ids.instanceTablePrefix(APP_B, CO_A));
});

test('escalating the attempt widens the prefix deterministically', () => {
  const a0 = ids.instanceTablePrefix(APP_A, CO_A, 0);
  const a1 = ids.instanceTablePrefix(APP_A, CO_A, 1);
  const a2 = ids.instanceTablePrefix(APP_A, CO_A, 2);
  assert.notEqual(a0, a1);
  assert.notEqual(a1, a2);
  assert.equal(a1, ids.instanceTablePrefix(APP_A, CO_A, 1));
  assert.ok(a1.length > a0.length);
});

test('a physical table name is the prefix plus the validated entity key', () => {
  const prefix = ids.instanceTablePrefix(APP_A, CO_A);
  assert.equal(ids.physicalTableName(prefix, 'quality_findings'), `${prefix}_quality_findings`);
});

test('a physical name is refused rather than truncated past Postgres limits', () => {
  // Postgres silently truncates at 63 bytes, which would make two entity names
  // that differ only past character 63 the same table. Two guards stop that,
  // and both are load-bearing.
  const prefix = ids.instanceTablePrefix(APP_A, CO_A);

  // 1. The 40-character cap on an entity key, which is what leaves room for
  //    the prefix in the ordinary case.
  assert.throws(
    () => ids.physicalTableName(prefix, 'a'.repeat(41)),
    /at most 40 characters/
  );

  // 2. The byte check, which is what catches a case the cap does not: a prefix
  //    widened by collision escalation leaves less room, and a key that was
  //    legal at attempt 0 can overflow at attempt 3.
  const widened = ids.instanceTablePrefix(APP_A, CO_A, 3);
  assert.throws(
    () => ids.physicalTableName(widened, 'a'.repeat(40)),
    /63-byte limit/
  );

  // The ordinary case still works: a 40-character key under a normal prefix.
  assert.equal(
    ids.physicalTableName(prefix, 'a'.repeat(40)),
    `${prefix}_${'a'.repeat(40)}`
  );
});

test('a prefix this module did not produce is refused', () => {
  ['public', 'app_x', 'users', 'app__', ''].forEach((prefix) => {
    assert.throws(() => ids.physicalTableName(prefix, 'findings'), ids.IdentifierError, prefix);
  });
});

test('derived index and constraint names stay inside the identifier limit', () => {
  const prefix = ids.instanceTablePrefix(APP_A, CO_A);
  const table = ids.physicalTableName(prefix, 'supplier_assessment_r');
  const long = ids.indexName(table, ['a_very_long_column_name_indeed', 'and_another_one']);
  assert.ok(Buffer.byteLength(long) <= 63, `${long} is ${Buffer.byteLength(long)} bytes`);
  // Still deterministic once hashed.
  assert.equal(long, ids.indexName(table, ['a_very_long_column_name_indeed', 'and_another_one']));
});

test('a qualified identifier is fully quoted', () => {
  assert.equal(
    ids.qualifiedIdentifier('public', 'app_ab12cd34_ef56ab78_findings'),
    '"public"."app_ab12cd34_ef56ab78_findings"'
  );
  assert.throws(() => ids.qualifiedIdentifier('public; DROP', 'x'), ids.IdentifierError);
});
