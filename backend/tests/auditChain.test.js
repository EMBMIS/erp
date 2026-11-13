// Task 18 tests — F5: prove the audit trail is tamper-evident (ROADMAP_TO_10).
//
// Hash chaining (prev_hash → current_hash) is persisted in the audit_chain
// table and appended by auditTrailService.appendAuditRecord(). These tests:
//   1. write N audit rows through the service,
//   2. mutate one of them DIRECTLY via SQL,
//   3. assert verifyAuditChain() reports THAT EXACT row as the first break.
// Without this test the hash chain is decorative — it proves nothing nobody
// ever checks.
//
// Also covered: deleted rows are detected as a link break at the next row, the
// signed export verifies with only the public key (no database access), and
// DDL changes are recorded by the audit_ddl_log event trigger (the pgaudit
// equivalent — pgaudit is not available in this PostgreSQL build).
//
// The suite is deliberately careful with the shared database: chain rows it
// creates are removed only when they are still the tail of the chain, so a
// concurrent append by another suite can never be orphaned.

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { pool } = require('../config/database');
const {
  appendAuditRecord,
  verifyAuditChain,
  exportSignedAuditTrail,
  verifySignedExport,
} = require('../services/auditTrailService');

let dbAvailable = false;
let userId = null;
const createdIds = [];

async function tailSafeDeleteChain(ids) {
  if (!ids.length) return;
  const max = Math.max(...ids);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM audit_chain WHERE id > $1', [max]);
  if (rows[0].n === 0) {
    await pool.query('DELETE FROM audit_chain WHERE id = ANY($1::bigint[])', [ids]);
  }
}

async function appendRows(count, marker) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const row = await appendAuditRecord({
      entity_type: 'AUDIT_CHAIN_TEST',
      entity_id: marker,
      from_status: `S${i}`,
      to_status: `T${i}`,
      changed_by: userId,
      reason: `audit chain test row ${i}`,
    });
    ids.push(row.id);
  }
  createdIds.push(...ids);
  return ids;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const user = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!user.rows.length) return;
    userId = user.rows[0].id;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (!dbAvailable) return;
  await tailSafeDeleteChain(createdIds);
});

test('chain verifier identifies the EXACT row mutated directly via SQL', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const pre = await verifyAuditChain();
  assert.equal(pre.valid, true, 'chain must be valid before the test starts');

  const marker = `T18-${randomUUID()}`;
  const ids = await appendRows(8, marker);

  const afterAppend = await verifyAuditChain();
  assert.equal(afterAppend.valid, true, 'appending through the service keeps the chain valid');
  assert.ok(afterAppend.total_rows >= 8);

  // Mutate one row directly via SQL — no service involved.
  const target = ids[3];
  const original = (await pool.query('SELECT to_status FROM audit_chain WHERE id = $1', [target])).rows[0].to_status;
  await pool.query('UPDATE audit_chain SET to_status = $1 WHERE id = $2', ['TAMPERED-BYSQL', target]);

  const v = await verifyAuditChain();
  assert.equal(v.valid, false, 'tampering must invalidate the chain');
  assert.ok(v.first_broken, 'verifier must report a broken row');
  assert.equal(v.first_broken.seq, target, 'verifier must identify the EXACT mutated row');
  assert.equal(v.first_broken.broken, 'hash_mismatch');
  assert.equal(v.first_broken.entity_type, 'AUDIT_CHAIN_TEST');

  // Restore the row — the chain must verify clean again.
  await pool.query('UPDATE audit_chain SET to_status = $1 WHERE id = $2', [original, target]);
  const restored = await verifyAuditChain();
  assert.equal(restored.valid, true, 'restoring the row repairs the chain');
});

test('deleted chain row is reported as a link break at the next row', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const pre = await verifyAuditChain();
  assert.equal(pre.valid, true, 'chain must be valid before the test starts');

  const marker = `T18-DEL-${randomUUID()}`;
  const ids = await appendRows(5, marker);

  await pool.query('DELETE FROM audit_chain WHERE id = $1', [ids[2]]);

  const v = await verifyAuditChain();
  assert.equal(v.valid, false);
  assert.ok(v.first_broken, 'verifier must report a broken row');
  assert.equal(v.first_broken.seq, ids[3], 'the row AFTER the deleted one carries the break');
  assert.equal(v.first_broken.broken, 'prev_hash_mismatch');

  // Remove the remaining rows of this test (tail-safe: they are the tail).
  await tailSafeDeleteChain([ids[0], ids[1], ids[3], ids[4]]);
});

test('signed export verifies by a third party without database access', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const marker = `T18-EXP-${randomUUID()}`;
  const ids = await appendRows(3, marker);

  const exported = await exportSignedAuditTrail();
  assert.equal(exported.manifest.algorithm, 'ed25519');
  assert.equal(exported.manifest.records_count, exported.records.length);
  assert.ok(exported.manifest.public_key_pem.includes('BEGIN PUBLIC KEY'));
  assert.ok(exported.manifest.signature.length > 0);

  // Third-party verification: only the export payload (embedded public key).
  const ok = verifySignedExport(exported);
  assert.equal(ok.valid, true);
  assert.equal(ok.signature_valid, true);
  assert.equal(ok.root_hash_valid, true);

  // Same check with the public key pinned explicitly (out-of-band pinning).
  const pinned = verifySignedExport(exported, { publicKeyPem: exported.manifest.public_key_pem });
  assert.equal(pinned.valid, true);

  // Tamper with one exported record: the verifier must pinpoint it.
  const copy = JSON.parse(JSON.stringify(exported));
  copy.records[2].from_status = 'FORGED';
  const bad = verifySignedExport(copy);
  assert.equal(bad.valid, false);
  assert.equal(bad.first_broken.index, 2, 'the forged record is the first broken one');

  // Tamper with the manifest root hash: the signature no longer verifies.
  const copy2 = JSON.parse(JSON.stringify(exported));
  copy2.manifest.root_hash = 'f'.repeat(64);
  const bad2 = verifySignedExport(copy2);
  assert.equal(bad2.valid, false);
  assert.equal(bad2.signature_valid, false);
});

test('DDL changes are recorded by the audit_ddl_log event trigger', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const tableName = `tmp_ddl_probe_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
  // On the owner connection: the application's own role (qira_app) cannot
  // create tables, deliberately (migration 111), so this failed with
  // "permission denied for schema public" wherever the app ran as that role.
  const { runAsOwner } = require('./helpers/multiCompany');
  await runAsOwner(`CREATE TABLE ${tableName} (id integer)`);
  await runAsOwner(`DROP TABLE ${tableName}`);

  const { rows } = await pool.query(
    `SELECT ddl_tag, object_identity FROM audit_ddl_log
      WHERE object_identity ILIKE '%' || $1 || '%' ORDER BY id DESC`,
    [tableName]
  );
  assert.ok(rows.some((r) => r.ddl_tag === 'CREATE TABLE'), 'CREATE TABLE must appear in the DDL audit log');
  assert.ok(rows.some((r) => r.ddl_tag === 'DROP TABLE'), 'DROP TABLE must appear in the DDL audit log');
});


after(async () => {
  // node:test cannot exit while the pg pool's sockets stay open; bound the close.
  await Promise.race([pool.end(), new Promise((r) => setTimeout(r, 5000))]);
});
