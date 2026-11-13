const test = require('node:test');
const assert = require('node:assert/strict');
const AuthorityEngine = require('../services/authority');

test('C6 Governance: MANAGER role is rejected for approval template modification', async () => {
  const managerActor = { id: 'usr-manager-1', role: 'MANAGER', type: 'USER' };
  const res = await AuthorityEngine.can(managerActor, 'MODIFY_APPROVAL_TEMPLATE', { type: 'PURCHASE_ORDER' });
  assert.strictEqual(res.allow, false);
  assert.match(res.reason, /require ADMIN role/i);
});

test('C6 Governance: ADMIN without second approver triggers four-eyes requirement', async () => {
  const adminActor = { id: 'usr-admin-1', role: 'ADMIN', type: 'USER' };
  
  // Without second approver
  const resNoSecond = await AuthorityEngine.can(adminActor, 'MODIFY_APPROVAL_TEMPLATE', { type: 'PURCHASE_ORDER' });
  assert.strictEqual(resNoSecond.allow, false);
  assert.strictEqual(resNoSecond.needsApproval, true);
  assert.match(resNoSecond.reason, /Four-eyes control violation/i);

  // Self as second approver is rejected
  const resSelfSecond = await AuthorityEngine.can(adminActor, 'MODIFY_APPROVAL_TEMPLATE', { type: 'PURCHASE_ORDER' }, { second_approver_id: 'usr-admin-1' });
  assert.strictEqual(resSelfSecond.allow, false);

  // Distinct second approver is allowed
  const resValid = await AuthorityEngine.can(adminActor, 'MODIFY_APPROVAL_TEMPLATE', { type: 'PURCHASE_ORDER' }, { second_approver_id: 'usr-admin-2' });
  assert.strictEqual(resValid.allow, true);
});

test('C6 Governance: Autonomous agents are strictly forbidden from modifying governance or roles', async () => {
  const agentActor = { id: 'agent-bot-1', role: 'AGENT', type: 'AGENT' };
  const actions = ['MODIFY_APPROVAL_TEMPLATE', 'MODIFY_DOA', 'CHANGE_ROLE', 'GRANT_AGENT_AUTONOMY'];

  for (const action of actions) {
    const res = await AuthorityEngine.can(agentActor, action, { type: 'GENERAL' });
    assert.strictEqual(res.allow, false);
    assert.match(res.reason, /forbidden/i);
  }
});
