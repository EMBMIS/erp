// Segregation of Duties.
//
// This control was written and then called by nothing. `checkSoD` lived in
// middleware/rbac.js with zero call sites, alongside a PERMISSION_MATRIX that
// also had zero, and a role (`ACCOUNTANT`) that the users table does not even
// permit. A system with a delegation-of-authority module that lets the person
// who raised a purchase requisition also approve it has no segregation of
// duties, whatever a file in the repository says.
//
// These tests hold the control to its actual job, and — as much as anything —
// assert that it remains wired into the approval routes, because the failure
// mode is not the check returning the wrong answer. It is the check quietly
// not being called.
//
// Run on its own:  node --test tests/segregationOfDuties.test.js

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// Most of this file is pure logic and needs no database; one test checks the
// owner columns against the live schema, so the pool has to be closed or the
// runner hangs waiting on an idle connection.
after(async () => {
  await require('../config/database').pool.end().catch(() => {});
});

const { checkSoD, requireSoD, PERMISSION_MATRIX, ROLES, hasPermission } = require('../middleware/rbac');

const ALICE = '3f1c2a54-1111-4bbb-8ccc-000000000001';
const BOB = '3f1c2a54-2222-4bbb-8ccc-000000000002';

test('a user cannot approve what they created', () => {
  assert.throws(
    () => checkSoD(ALICE, ALICE, 'approval'),
    /segregation of duties/i,
    'approving your own record must be refused'
  );
});

test('a different user can approve', () => {
  assert.doesNotThrow(() => checkSoD(ALICE, BOB, 'approval'));
});

test('the refusal says what to do about it', () => {
  // A control that only says "no" gets worked around. This one has to explain
  // that someone else must approve, or the user's next move is a support ticket.
  try {
    checkSoD(ALICE, ALICE, 'approval');
    assert.fail('expected a refusal');
  } catch (error) {
    assert.match(error.message, /someone else/i);
    assert.equal(error.status, 403);
  }
});

test('ids are compared as strings, so a type mismatch cannot bypass the check', () => {
  // The kind of hole that opens when one side arrives from a JSON body and the
  // other from a database driver. A strict === between 1 and '1' is false, and
  // the check silently passes.
  assert.throws(() => checkSoD(1, '1', 'approval'), /segregation of duties/i);
});

test('missing ids do not throw', () => {
  // An unauthenticated or not-yet-loaded record is the route's problem to
  // report (401/404). This guard must not convert it into a confusing
  // permissions error.
  assert.doesNotThrow(() => checkSoD(null, BOB));
  assert.doesNotThrow(() => checkSoD(ALICE, null));
  assert.doesNotThrow(() => checkSoD(undefined, undefined));
});

test('no role is exempt, including ADMIN', async () => {
  // An exemption for the most privileged role is an exemption for exactly the
  // account worth compromising. The guard decides on identity alone and is
  // never handed a role, so there is nothing for an exemption to key off —
  // this asserts that stays true through the middleware, where a role IS in
  // scope on req.user and would be the tempting thing to consult.
  //
  // The platform-owner exemption is identity-based (is_platform_owner / the
  // PLATFORM_OWNER_EMAIL claim), not role-based, and is asserted separately
  // below.
  for (const role of ['ADMIN', 'MANAGER', 'FINANCE_MANAGER', 'USER']) {
    const middleware = requireSoD(async () => ALICE, 'approval');
    let forwarded;
    await middleware(
      { user: { id: ALICE, role }, params: { id: 'x' } }, {}, (err) => { forwarded = err; }
    );
    assert.ok(forwarded, `${role} must not be able to approve its own record`);
    assert.equal(forwarded.status, 403);
  }
});

test('the platform owner may approve their own record — the sole identity-based exemption', async () => {
  // The deployment's creator admin (first account, or PLATFORM_OWNER_EMAIL)
  // is allowed to approve their own submitted operations. This is an identity
  // exemption: the flag travels with the account and cannot be granted by
  // changing a role, so no ADMIN, MANAGER, or other account gets it.
  const saved = process.env.PLATFORM_OWNER_EMAIL;
  delete process.env.PLATFORM_OWNER_EMAIL;
  try {
    const middleware = requireSoD(async () => ALICE, 'approval');
    let forwarded;
    await middleware(
      { user: { id: ALICE, role: 'ADMIN', is_platform_owner: true }, params: { id: 'x' } },
      {},
      (err) => { forwarded = err; }
    );
    assert.equal(forwarded, undefined, 'the platform owner must be able to approve their own record');

    // Without the flag, the same ADMIN is still bound by SoD.
    forwarded = undefined;
    await middleware(
      { user: { id: ALICE, role: 'ADMIN' }, params: { id: 'x' } },
      {},
      (err) => { forwarded = err; }
    );
    assert.ok(forwarded, 'an ADMIN who is not the platform owner stays bound by SoD');
    assert.equal(forwarded.status, 403);
  } finally {
    if (saved !== undefined) process.env.PLATFORM_OWNER_EMAIL = saved;
  }
});

test('the middleware form refuses self-approval and passes everything else through', async () => {
  const run = async (creatorId, userId) => {
    const middleware = requireSoD(async () => creatorId, 'approval');
    let forwarded;
    await middleware({ user: { id: userId }, params: { id: 'x' } }, {}, (err) => { forwarded = err; });
    return forwarded;
  };

  const refused = await run(ALICE, ALICE);
  assert.ok(refused, 'self-approval should reach next() as an error');
  assert.equal(refused.status, 403);

  const allowed = await run(ALICE, BOB);
  assert.equal(allowed, undefined, 'a different approver should pass cleanly');
});

test('the permission matrix only names roles the database permits', () => {
  // It used to define an ACCOUNTANT tier. No account could ever hold that role
  // (users.role is constrained to ADMIN/MANAGER/USER/FINANCE_MANAGER/
  // FINANCE_USER by migration 088), so the row governed nobody while the two
  // finance roles that do exist fell through to [] and were denied everything.
  for (const role of Object.keys(PERMISSION_MATRIX)) {
    assert.ok(ROLES.includes(role), `PERMISSION_MATRIX names "${role}", which is not a real role`);
  }
  for (const role of ROLES) {
    assert.ok(PERMISSION_MATRIX[role], `role "${role}" has no entry in PERMISSION_MATRIX`);
  }
});

test('finance roles carry finance permissions and not procurement authority', () => {
  assert.ok(hasPermission('FINANCE_MANAGER', 'FINANCE_APPROVE'));
  assert.ok(hasPermission('FINANCE_USER', 'FINANCE_WRITE'));

  // The boundary that makes the roles worth separating: whoever approves the
  // payment should not also be choosing the supplier.
  assert.equal(hasPermission('FINANCE_MANAGER', 'PROCUREMENT_APPROVE'), false);
  assert.equal(hasPermission('FINANCE_USER', 'FINANCE_APPROVE'), false);
  assert.equal(hasPermission('USER', 'FINANCE_READ'), false);
});

test('every owner column named for SoD actually exists', async (t) => {
  // The guard resolves who raised a record by reading one column per table,
  // and that column is NOT `created_by` everywhere: purchase_requisitions uses
  // `requested_by`, items and inventory_items use `user_id`. A wrong name here
  // does not weaken the check, it breaks the approval route outright with
  // "column does not exist" — so it has to be verified against the live
  // schema, not assumed.
  const { pool } = require('../config/database');
  const { OWNER_COLUMNS } = require('../middleware/recordOwner');

  let dbUp = true;
  try { await pool.query('SELECT 1'); } catch { dbUp = false; }
  if (!dbUp) return t.skip('no database');

  for (const [table, column] of Object.entries(OWNER_COLUMNS)) {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2`,
      [table, column]
    );
    assert.equal(rows.length, 1, `${table}.${column} does not exist`);
  }
});

test('the approval routes still have the SoD guard attached', () => {
  // The real regression risk is not this function misbehaving — it is someone
  // adding an approval route, or refactoring an existing one, without the
  // guard. That reintroduces the exact hole with no test failing anywhere else.
  const fs = require('fs');
  const path = require('path');

  const guarded = {
    'purchase-requisitions.js': 'purchase_requisitions',
    'purchase-orders.js': 'purchase_orders',
    'contracts.js': 'contracts',
    'sales-orders.js': 'sales_orders',
  };

  for (const [file, table] of Object.entries(guarded)) {
    const source = fs.readFileSync(path.join(__dirname, '../routes', file), 'utf8');
    const approveLine = source.split('\n').find((l) => l.includes("'/:id/approve'"));
    assert.ok(approveLine, `${file} should still have an /:id/approve route`);
    assert.match(
      approveLine, new RegExp(`requireSoD\\(recordCreator\\('${table}'\\)`),
      `${file}'s approve route must keep its segregation-of-duties guard`
    );
  }
});
