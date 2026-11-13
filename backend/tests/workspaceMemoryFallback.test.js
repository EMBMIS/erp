// The conversation list must survive a deploy that lands before its migration.
//
// `objective`, `modules`, `entities`, `actions`, `pinned` and `last_stage`
// arrive with 202608230100_simeli_workspace_memory.sql. Code reaching
// production ahead of a migration is the normal order of a deploy, not a
// mistake — but `ORDER BY c.pinned` against a table that has no such column is
// a hard error, and it took the whole sidebar down with it: no conversations,
// no explanation, nothing to act on.
//
// These tests pin the property that matters: with the columns absent, every
// read still answers, and only the features that genuinely need them are off.
//
// Run on its own:  node --test tests/workspaceMemoryFallback.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const DB = require.resolve('../config/database');
const SERVICE = require.resolve('../services/conversationService');

const FULL = ['objective', 'modules', 'entities', 'actions', 'pinned', 'last_stage'];

/**
 * Load the service against a stub pool that reports a given set of columns.
 * Returns the service plus the SQL it issued, so the assertions can be about
 * the query actually sent rather than about the return value alone.
 */
function withColumns(present) {
  const sent = [];
  const pool = {
    query: async (sql, params) => {
      sent.push(sql);
      if (/information_schema/.test(sql)) {
        return { rows: present.map((column_name) => ({ column_name })) };
      }
      // The ownership check has to succeed, or the write tests would pass for
      // the wrong reason — rejecting on "not found" instead of on the schema.
      if (/SELECT id FROM conversations/.test(sql)) return { rows: [{ id: 'conv-1' }] };
      return { rows: [] };
    },
  };
  require.cache[DB] = { id: DB, filename: DB, loaded: true, exports: { pool } };
  delete require.cache[SERVICE];
  // documentSearch is pulled in by the service; it must not reach out either.
  const service = require(SERVICE);
  return { service, sent };
}

test('with the migration applied, the list orders pinned conversations first', async () => {
  const { service, sent } = withColumns(FULL);
  await service.listForUser('u1');
  const list = sent.find((s) => s.includes('message_count'));
  assert.match(list, /ORDER BY c\.pinned DESC, c\.updated_at DESC/);
});

test('without the migration, the list still answers — just without pinning', async () => {
  const { service, sent } = withColumns([]);
  await service.listForUser('u1');
  const list = sent.find((s) => s.includes('message_count'));
  assert.ok(list, 'the list query was still issued');
  assert.doesNotMatch(list, /c\.pinned/, 'no reference to a column that does not exist');
  assert.match(list, /ORDER BY c\.updated_at DESC/);
});

test('a partly applied migration counts as missing', async () => {
  // Half the columns is not "mostly working": any query touching the absent
  // half still fails, so the fallback has to be all-or-nothing.
  const { service } = withColumns(['pinned', 'objective']);
  assert.equal(await service.workspaceMemoryReady(), false);
});

test('recording a turn is skipped rather than failing when memory is off', async () => {
  const { service, sent } = withColumns([]);
  await service.recordTurn('conv-1', { modules: ['finance'], stage: 'report' });
  assert.ok(!sent.some((s) => s.includes('UPDATE conversations SET')),
    'no write is attempted against columns that are not there');
});

test('setting an objective says why, rather than failing opaquely', async () => {
  const { service } = withColumns([]);
  await assert.rejects(
    () => service.updateObjective('conv-1', 'Close the quarter', 'u1'),
    /WORKSPACE_MEMORY_PENDING/,
  );
});

test('with the migration applied, an objective is written normally', async () => {
  const { service, sent } = withColumns(FULL);
  await service.updateObjective('conv-1', 'Close the quarter', 'u1');
  assert.ok(sent.some((q) => /UPDATE conversations SET objective/.test(q)),
    'the guard does not stand in the way once the columns exist');
});

test('the probe caches a positive and does not re-ask', async () => {
  const { service, sent } = withColumns(FULL);
  await service.workspaceMemoryReady();
  await service.workspaceMemoryReady();
  await service.workspaceMemoryReady();
  const probes = sent.filter((s) => s.includes('information_schema'));
  assert.equal(probes.length, 1, 'the catalogue is asked once, not once per call');
});
