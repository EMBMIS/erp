// Platform-owner (creator admin) approval privileges.
//
// The deployment's creator admin — the first account, or the account named by
// PLATFORM_OWNER_EMAIL — is the one identity that is:
//   1. authorized for EVERY Delegation-of-Authority transaction type, amount,
//      and cost center without needing DoA rows, and
//   2. allowed to approve its own submitted operations (SoD exemption).
//
// Both properties are asserted here against a real migrated database. No test
// ever writes the is_platform_owner flag (a partial unique index allows at
// most one owner, and racing a real deployment's claim would be wrong): the
// owner designation is simulated with the PLATFORM_OWNER_EMAIL environment
// override, which is the same precedence middleware/auth.js honors.
//
// Requires a migrated database; self-skips when none is reachable, mirroring
// integration.test.js. Run on its own with:
//   npm run db:migrate && node --test tests/platformOwnerApprovals.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const { isPlatformOwnerId } = require('../services/platformOwner');
const ApprovalRulesEngine = require('../services/approvalRulesEngine');
const AuthorityEngine = require('../services/authority');
const ApprovalChain = require('../models/ApprovalChain');
const PurchaseOrder = require('../models/PurchaseOrder');

let dbAvailable = false;
let savedOwnerEmail = undefined;
let owner = null;   // the simulated platform owner (creator admin)
let other = null;   // an ordinary ADMIN, for contrast
let companyId = null;
const cleanup = [];

before(async () => {
  try {
    await pool.query('SELECT 1');

    // Company-scoped fixture tables need an explicit company_id (their column
    // default may point at a deleted company on restored databases).
    const comp = await pool.query(
      'SELECT id FROM companies WHERE is_default = true AND deleted_at IS NULL LIMIT 1'
    );
    companyId = comp.rows[0]?.id || null;

    const stamp = Date.now();
    const insOwner = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, is_active)
       VALUES ($1, $2, 'Platform', 'Owner', 'ADMIN', true)
       RETURNING id, email`,
      [`platform-owner-test-${stamp}@qira.test`, 'not-a-real-password']
    );
    owner = insOwner.rows[0];
    cleanup.push(() => pool.query('DELETE FROM users WHERE id = $1', [owner.id]));

    const insOther = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, is_active)
       VALUES ($1, $2, 'Ordinary', 'Admin', 'ADMIN', true)
       RETURNING id, email`,
      [`ordinary-admin-test-${stamp}@qira.test`, 'not-a-real-password']
    );
    other = insOther.rows[0];
    cleanup.push(() => pool.query('DELETE FROM users WHERE id = $1', [other.id]));

    // Designate `owner` as the platform owner via the environment override —
    // no flag writes, no unique-index race.
    savedOwnerEmail = process.env.PLATFORM_OWNER_EMAIL;
    process.env.PLATFORM_OWNER_EMAIL = owner.email;

    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  for (const fn of cleanup.reverse()) {
    await fn().catch(() => {});
  }
  if (savedOwnerEmail !== undefined) process.env.PLATFORM_OWNER_EMAIL = savedOwnerEmail;
  else delete process.env.PLATFORM_OWNER_EMAIL;
  await pool.end().catch(() => {});
});

test('isPlatformOwnerId: env-designated owner is recognized, everyone else is not', async () => {
  if (!dbAvailable) return;
  assert.equal(await isPlatformOwnerId(owner.id), true);
  assert.equal(await isPlatformOwnerId(other.id), false);
  assert.equal(await isPlatformOwnerId('00000000-0000-0000-0000-000000000000'), false);
  assert.equal(await isPlatformOwnerId(null), false);
});

test('DoA engine: the owner holds authority for every transaction type and amount', async () => {
  if (!dbAvailable) return;

  for (const type of ['PURCHASE_ORDERS', 'SUPPLIERS', 'CERTIFICATION', 'CONTRACTS', 'SALES', 'INVENTORY_ITEMS']) {
    assert.equal(
      await ApprovalRulesEngine.userHasAuthority(owner.id, type),
      true,
      `owner must hold ${type} authority by identity`
    );
  }

  // Any amount, any cost center, any category.
  const check = await ApprovalRulesEngine.checkUserAuthority(owner.id, 999999999, 'SALES', 'CONTRACTS');
  assert.ok(check, 'owner must have authority for a huge amount in any cost center');
  assert.equal(check.is_platform_owner_override, true);
  assert.equal(check.max_amount, null);

  // The ordinary ADMIN has no DoA rows and no identity override.
  assert.equal(await ApprovalRulesEngine.userHasAuthority(other.id, 'PURCHASE_ORDERS'), false);
  assert.equal(await ApprovalRulesEngine.checkUserAuthority(other.id, 100, null, 'PURCHASE_ORDERS'), null);
});

test('DoA engine: the owner appears in authorized-user listings', async () => {
  if (!dbAvailable) return;
  const users = await ApprovalRulesEngine.getAuthorizedUsers(5000000, null, 'CONTRACTS');
  assert.ok(
    users.some((u) => String(u.user_id) === String(owner.id)),
    'the owner must be listed among users authorized to approve a $5M contract'
  );
});

test('AuthorityEngine: the owner may approve their own record; other ADMINS may not', async () => {
  if (!dbAvailable) return;

  const ownerSelf = await AuthorityEngine.can(
    { id: owner.id, role: 'ADMIN', type: 'USER' },
    'APPROVE',
    { type: 'PURCHASE_ORDER', id: 'x', amount: 1000, created_by: owner.id }
  );
  assert.equal(ownerSelf.allow, true, 'owner must be able to approve their own operation');

  const otherAdminSelf = await AuthorityEngine.can(
    { id: other.id, role: 'ADMIN', type: 'USER' },
    'APPROVE',
    { type: 'PURCHASE_ORDER', id: 'x', amount: 1000, created_by: other.id }
  );
  assert.equal(otherAdminSelf.allow, false, 'a non-owner ADMIN stays bound by SoD');
  assert.match(otherAdminSelf.reason, /segregation of duties/i);
});

test('ApprovalChain.decide: the owner may decide a step assigned to someone else', async () => {
  if (!dbAvailable) return;

  const template = await pool.query(
    `INSERT INTO approval_chain_templates (name, document_type, created_by, company_id)
     VALUES ($1, 'PURCHASE_ORDER', $2, $3) RETURNING id`,
    [`platform-owner-test-template-${Date.now()}`, owner.id, companyId]
  );
  const templateId = template.rows[0].id;
  cleanup.push(() => pool.query('DELETE FROM approval_chain_templates WHERE id = $1', [templateId]));

  const makeRequest = async (namedApproverId) => {
    const req = await pool.query(
      `INSERT INTO approval_requests (template_id, document_type, document_id, requested_by, amount, status, current_step, company_id)
       VALUES ($1, 'PURCHASE_ORDER', gen_random_uuid(), $2, 100, 'PENDING', 1, $3)
       RETURNING id`,
      [templateId, owner.id, companyId]
    );
    await pool.query(
      `INSERT INTO approval_request_steps (request_id, step_number, approver_role, approver_user_id, status)
       VALUES ($1, 1, 'MANAGER', $2, 'PENDING')`,
      [req.rows[0].id, namedApproverId]
    );
    return req.rows[0].id;
  };

  // Positive: the step is named to a DIFFERENT user; the owner decides anyway.
  const ownerDecides = await makeRequest(other.id);
  cleanup.push(() => pool.query('DELETE FROM approval_requests WHERE id = $1', [ownerDecides]));
  const decided = await ApprovalChain.decide(ownerDecides, owner.id, 'ADMIN', 'APPROVE');
  assert.equal(decided.status, 'APPROVED', 'owner must be able to approve a request assigned to someone else');

  // Negative: the same step is refused to a non-owner ADMIN.
  const otherDecides = await makeRequest(owner.id);
  cleanup.push(() => pool.query('DELETE FROM approval_requests WHERE id = $1', [otherDecides]));
  await assert.rejects(
    () => ApprovalChain.decide(otherDecides, other.id, 'ADMIN', 'APPROVE'),
    /not authorized/i,
    'a non-owner ADMIN must not decide a step named to someone else'
  );
});

test('SalesContract: the owner sees every pending contract and may approve their own', async () => {
  if (!dbAvailable) return;
  const SalesContract = require('../models/SalesContract');

  const customer = await pool.query(
    `INSERT INTO customers (customer_code, customer_name, company_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [`SC${Date.now()}`, 'Platform Owner Test Customer', companyId]
  );
  const customerId = customer.rows[0].id;
  cleanup.push(() => pool.query('DELETE FROM customers WHERE id = $1', [customerId]));

  const contract = await pool.query(
    `INSERT INTO sales_contracts
       (contract_number, contract_name, customer_id, customer_name, contract_value, start_date, end_date, status, approval_status, created_by, company_id)
     VALUES ($1, $2, $3, $4, 250000, CURRENT_DATE, CURRENT_DATE + 365, 'PENDING_APPROVAL', 'PENDING', $5, $6)
     RETURNING id, contract_number`,
    [`SC-TEST-${Date.now()}`, 'Platform Owner Test Contract', customerId, 'Platform Owner Test Customer', owner.id, companyId]
  );
  const contractId = contract.rows[0].id;
  cleanup.push(() => pool.query('DELETE FROM sales_contracts WHERE id = $1', [contractId]));

  // The owner sees the pending contract with no DoA row required.
  const ownerPending = await SalesContract.getPendingApprovals(owner.id);
  assert.ok(
    ownerPending.some((c) => String(c.id) === String(contractId)),
    'owner must see every pending sales contract'
  );

  // An ordinary ADMIN without a DoA row sees nothing.
  const otherPending = await SalesContract.getPendingApprovals(other.id);
  assert.equal(
    otherPending.some((c) => String(c.id) === String(contractId)),
    false,
    'a non-owner ADMIN without a DoA row must not see the contract'
  );

  // The owner may approve their own contract.
  const approved = await SalesContract.approveContract(contractId, owner.id, 'owner self-approval');
  assert.equal(approved.status, 'SENT_TO_CUSTOMER', 'owner must be able to approve their own sales contract');

  // A non-owner ADMIN is still refused by the DoA check.
  const second = await pool.query(
    `INSERT INTO sales_contracts
       (contract_number, contract_name, customer_id, customer_name, contract_value, start_date, end_date, status, approval_status, created_by, company_id)
     VALUES ($1, $2, $3, $4, 1000, CURRENT_DATE, CURRENT_DATE + 365, 'PENDING_APPROVAL', 'PENDING', $5, $6)
     RETURNING id`,
    [`SC-TEST-2-${Date.now()}`, 'Platform Owner Test Contract 2', customerId, 'Platform Owner Test Customer', other.id, companyId]
  );
  const secondId = second.rows[0].id;
  cleanup.push(() => pool.query('DELETE FROM sales_contracts WHERE id = $1', [secondId]));

  await assert.rejects(
    () => SalesContract.approveContract(secondId, other.id, 'trying'),
    /do not have authority/i,
    'a non-owner ADMIN must still pass the DoA check'
  );
});

test('PurchaseOrder.approve: the owner may approve their own PO; other ADMINS may not', async () => {
  if (!dbAvailable) return;

  const makePo = async (creatorId) => {
    const supplier = await pool.query(
      `INSERT INTO suppliers (supplier_code, legal_name, company_id) VALUES ($1, $2, $3) RETURNING id`,
      [`PO-TEST-SUP-${Date.now()}-${Math.floor(Math.random() * 100000)}`, 'Platform Owner Test Supplier', companyId]
    );
    cleanup.push(() => pool.query('DELETE FROM suppliers WHERE id = $1', [supplier.rows[0].id]));

    const po = await pool.query(
      `INSERT INTO purchase_orders (po_number, supplier_id, status, total_amount, created_by, company_id)
       VALUES ($1, $2, 'PENDING_APPROVAL', 1500, $3, $4) RETURNING id`,
      [`PO-TEST-${Date.now()}-${Math.floor(Math.random() * 100000)}`, supplier.rows[0].id, creatorId, companyId]
    );
    cleanup.push(() => pool.query('DELETE FROM purchase_orders WHERE id = $1', [po.rows[0].id]));
    return po.rows[0].id;
  };

  // Positive: creator admin approves their own PO.
  const ownPo = await makePo(owner.id);
  const approved = await PurchaseOrder.approve(ownPo, owner.id);
  assert.equal(approved.status, 'APPROVED', 'owner must be able to approve their own purchase order');

  // Negative: an ordinary ADMIN who created the PO is still refused.
  const adminPo = await makePo(other.id);
  await assert.rejects(
    () => PurchaseOrder.approve(adminPo, other.id),
    /segregation of duties/i,
    'a non-owner ADMIN must not approve their own purchase order'
  );
});
