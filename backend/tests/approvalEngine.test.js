/**
 * Unit tests for the Approval Rules Engine (services/approvalRulesEngine.js).
 *
 * These exercise the pure evaluation path (no database): conditions (amount,
 * cost center, category, entity), approver resolution (named user, role,
 * manager-of), delegation-while-absent, and SLA escalation on timeout.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../services/approvalRulesEngine');
const { pool } = require('../config/database');

// No test here touches the database, but approvalRulesEngine.js requires
// config/database.js, which opens the pool (min: 2 keepalive connections) —
// without closing it, the process hangs after the last test forever.
after(() => pool.end());

const HOUR = 3600 * 1000;

// ---------------------------------------------------------------------------
// Exactly-at-threshold routing
// ---------------------------------------------------------------------------

test('exactly-at-threshold: amount equal to max_amount is still within authority', () => {
  const definition = [
    { id: 'doa-1', user_id: 'u-approver', min_amount: 0, max_amount: 10000, applies_to: 'PURCHASE_ORDER', source: 'doa' }
  ];

  const atThreshold = Engine.evaluate(definition, { amount: 10000, category: 'PURCHASE_ORDER' });
  assert.equal(atThreshold.requires_approval, true);
  assert.equal(atThreshold.approvers.length, 1);
  assert.equal(atThreshold.approvers[0].approver, 'u-approver');

  const aboveThreshold = Engine.evaluate(definition, { amount: 10000.01, category: 'PURCHASE_ORDER' });
  assert.equal(aboveThreshold.requires_approval, false);
  assert.equal(aboveThreshold.approvers.length, 0);
});

test('exactly-at-threshold: amount equal to min_amount is within authority', () => {
  const definition = [
    { id: 'doa-1', user_id: 'u-approver', min_amount: 1000, max_amount: 5000, applies_to: 'ALL', source: 'doa' }
  ];

  const atMin = Engine.evaluate(definition, { amount: 1000, category: 'SUPPLIERS' });
  assert.equal(atMin.requires_approval, true);
  assert.equal(atMin.approvers[0].approver, 'u-approver');

  const belowMin = Engine.evaluate(definition, { amount: 999.99, category: 'SUPPLIERS' });
  assert.equal(belowMin.requires_approval, false);
});

test('exactly-at-threshold: chain step is required when amount equals step min_amount', () => {
  const definition = [
    { id: 'step-1', template_id: 'tpl-1', step_number: 1, min_amount: 0, approver_role: 'MANAGER', source: 'chain' },
    { id: 'step-2', template_id: 'tpl-1', step_number: 2, min_amount: 5000, approver_role: 'ADMIN', source: 'chain' }
  ];

  const atStep = Engine.evaluate(definition, { amount: 5000, category: 'PURCHASE_ORDER' });
  assert.equal(atStep.approvers.length, 2);
  assert.deepEqual(atStep.approvers.map((a) => a.level), [1, 2]);

  const belowStep = Engine.evaluate(definition, { amount: 4999.99, category: 'PURCHASE_ORDER' });
  assert.equal(belowStep.approvers.length, 1);
  assert.equal(belowStep.approvers[0].level, 1);
});

test('thresholds are inclusive: zero-amount requests never require approval', () => {
  const definition = [
    { id: 'doa-1', user_id: 'u-approver', min_amount: 0, max_amount: 10000, applies_to: 'ALL', source: 'doa' }
  ];
  const zero = Engine.evaluate(definition, { amount: 0, category: 'PURCHASE_ORDER' });
  assert.equal(zero.requires_approval, false);
});

// ---------------------------------------------------------------------------
// Conditions: cost center, category, entity
// ---------------------------------------------------------------------------

test('conditions: cost center mismatch excludes a rule', () => {
  const definition = [
    { id: 'doa-1', user_id: 'u-approver', min_amount: 0, max_amount: 1000, cost_center: 'FINANCE', applies_to: 'ALL', source: 'doa' }
  ];

  const matching = Engine.evaluate(definition, { amount: 500, costCenter: 'FINANCE', category: 'PO' });
  assert.equal(matching.requires_approval, true);

  const otherCc = Engine.evaluate(definition, { amount: 500, costCenter: 'PROCUREMENT', category: 'PO' });
  assert.equal(otherCc.requires_approval, false);
});

test('conditions: category (applies_to) wildcard ALL matches any transaction type', () => {
  const definition = [
    { id: 'doa-1', user_id: 'u-approver', min_amount: 0, max_amount: 1000, applies_to: 'ALL', source: 'doa' }
  ];
  for (const category of ['SUPPLIERS', 'CERTIFICATION', 'SALES_ORDER', 'PURCHASE_ORDERS']) {
    const result = Engine.evaluate(definition, { amount: 100, category });
    assert.equal(result.requires_approval, true, `expected authority for ${category}`);
  }
});

test('conditions: entity filter restricts a rule to one entity', () => {
  const definition = [
    { id: 'doa-1', user_id: 'u-approver', min_amount: 0, max_amount: 1000, entity_id: 'vendor-42', applies_to: 'ALL', source: 'doa' }
  ];

  const target = Engine.evaluate(definition, { amount: 100, entity: 'vendor-42', category: 'CONTRACTS' });
  assert.equal(target.requires_approval, true);

  const other = Engine.evaluate(definition, { amount: 100, entity: 'vendor-7', category: 'CONTRACTS' });
  assert.equal(other.requires_approval, false);
});

// ---------------------------------------------------------------------------
// Approver resolution: named user, role, manager-of
// ---------------------------------------------------------------------------

test('approver resolution: named user wins over role', () => {
  const definition = [
    { id: 'step-1', template_id: 'tpl-1', step_number: 1, min_amount: 0, approver_role: 'MANAGER', approver_user_id: 'u-named', source: 'chain' }
  ];
  const result = Engine.evaluate(definition, { amount: 100, category: 'PO' });
  assert.equal(result.approvers[0].approver, 'u-named');
  assert.equal(result.approvers[0].role, 'MANAGER');
});

test('approver resolution: manager-of resolves to the requester manager', () => {
  const definition = [
    { id: 'step-1', template_id: 'tpl-1', step_number: 1, min_amount: 0, approver_role: 'MANAGER_OF', source: 'chain' }
  ];
  const result = Engine.evaluate(definition, { amount: 100, requesterId: 'u-junior', requesterManagerId: 'u-boss', category: 'PO' });
  assert.equal(result.approvers[0].approver, 'u-boss');
  assert.equal(result.approvers[0].role, 'MANAGER_OF');
});

test('approver resolution: manager-of via injected resolver', () => {
  const definition = [
    { id: 'step-1', template_id: 'tpl-1', step_number: 1, min_amount: 0, approver_role: 'MANAGER_OF', source: 'chain' }
  ];
  const result = Engine.evaluate(
    definition,
    { amount: 100, requesterId: 'u-junior', category: 'PO' },
    { resolveManager: (requesterId) => `manager-of-${requesterId}` }
  );
  assert.equal(result.approvers[0].approver, 'manager-of-u-junior');
});

// ---------------------------------------------------------------------------
// Delegation while absent
// ---------------------------------------------------------------------------

test('delegation: active delegation replaces the approver and records the original', () => {
  const definition = [
    { id: 'doa-1', user_id: 'u-approver', min_amount: 0, max_amount: 10000, applies_to: 'ALL', source: 'doa' }
  ];
  const now = new Date('2026-07-31T12:00:00Z');
  const delegations = [
    {
      delegator_id: 'u-approver',
      delegate_id: 'u-standin',
      start_date: '2026-07-01T00:00:00Z',
      end_date: '2026-08-31T00:00:00Z',
      status: 'ACTIVE'
    }
  ];

  const result = Engine.evaluate(definition, { amount: 500, category: 'PO', delegations, now });
  assert.equal(result.requires_approval, true);
  assert.equal(result.approvers.length, 1);
  assert.equal(result.approvers[0].approver, 'u-standin');
  assert.equal(result.approvers[0].is_delegated, true);
  assert.equal(result.approvers[0].original_approver, 'u-approver');
});

test('delegation: expired delegation is ignored (approver stays the principal)', () => {
  const definition = [
    { id: 'doa-1', user_id: 'u-approver', min_amount: 0, max_amount: 10000, applies_to: 'ALL', source: 'doa' }
  ];
  const now = new Date('2026-07-31T12:00:00Z');
  const delegations = [
    {
      delegator_id: 'u-approver',
      delegate_id: 'u-standin',
      start_date: '2026-01-01T00:00:00Z',
      end_date: '2026-06-30T00:00:00Z',
      status: 'ACTIVE'
    }
  ];

  const result = Engine.evaluate(definition, { amount: 500, category: 'PO', delegations, now });
  assert.equal(result.approvers[0].approver, 'u-approver');
  assert.equal(result.approvers[0].is_delegated, false);
});

test('delegation: cancelled or future delegation is ignored', () => {
  const definition = [
    { id: 'doa-1', user_id: 'u-approver', min_amount: 0, max_amount: 10000, applies_to: 'ALL', source: 'doa' }
  ];
  const now = new Date('2026-07-31T12:00:00Z');
  const delegations = [
    { delegator_id: 'u-approver', delegate_id: 'u-a', start_date: '2026-01-01T00:00:00Z', end_date: '2026-12-31T00:00:00Z', status: 'CANCELLED' },
    { delegator_id: 'u-approver', delegate_id: 'u-b', start_date: '2026-09-01T00:00:00Z', end_date: '2026-12-31T00:00:00Z', status: 'ACTIVE' }
  ];

  const result = Engine.evaluate(definition, { amount: 500, category: 'PO', delegations, now });
  assert.equal(result.approvers[0].approver, 'u-approver');
  assert.equal(result.approvers[0].is_delegated, false);
});

// ---------------------------------------------------------------------------
// SLA and escalation on timeout
// ---------------------------------------------------------------------------

test('escalation on timeout: overdue request escalates to the next tier', () => {
  const definition = [
    { id: 'step-1', template_id: 'tpl-1', step_number: 1, min_amount: 0, approver_role: 'MANAGER', source: 'chain' },
    { id: 'step-2', template_id: 'tpl-1', step_number: 2, min_amount: 5000, approver_role: 'ADMIN', source: 'chain' }
  ];
  const now = new Date('2026-07-31T12:00:00Z');
  const requestCreatedAt = new Date(now.getTime() - 100 * HOUR); // 100h ago > 48h SLA

  const result = Engine.evaluate(definition, {
    amount: 1000, // only tier 1 is normally required
    category: 'PURCHASE_ORDER',
    requestCreatedAt,
    now
  }, { slaHours: 48 });

  assert.equal(result.escalation.escalated, true);
  assert.equal(result.escalation.reason, 'sla_timeout');

  // Tier 1 is overdue and escalated...
  const tier1 = result.approvers.find((a) => a.level === 1);
  assert.ok(tier1, 'tier 1 approver present');
  assert.equal(tier1.is_overdue, true);
  assert.equal(tier1.escalated, true);

  // ...and tier 2 (normally above the amount band) was pulled in.
  const tier2 = result.approvers.find((a) => a.level === 2);
  assert.ok(tier2, 'tier 2 approver pulled in on timeout');
  assert.equal(tier2.escalated, true);
  assert.equal(tier2.escalation_reason, 'sla_timeout');
});

test('escalation on timeout: within SLA there is no escalation', () => {
  const definition = [
    { id: 'step-1', template_id: 'tpl-1', step_number: 1, min_amount: 0, approver_role: 'MANAGER', source: 'chain' },
    { id: 'step-2', template_id: 'tpl-1', step_number: 2, min_amount: 5000, approver_role: 'ADMIN', source: 'chain' }
  ];
  const now = new Date('2026-07-31T12:00:00Z');
  const requestCreatedAt = new Date(now.getTime() - 10 * HOUR); // within 48h SLA

  const result = Engine.evaluate(definition, {
    amount: 1000,
    category: 'PURCHASE_ORDER',
    requestCreatedAt,
    now
  }, { slaHours: 48 });

  assert.equal(result.escalation.escalated, false);
  assert.equal(result.approvers.length, 1);
  assert.equal(result.approvers[0].level, 1);
  assert.equal(result.approvers[0].is_overdue, undefined);
  assert.ok(result.approvers[0].sla_deadline, 'sla_deadline is attached');
});
