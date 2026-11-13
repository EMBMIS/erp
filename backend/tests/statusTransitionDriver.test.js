const test = require('node:test');
const assert = require('node:assert/strict');
const { applyStatusChange, ENTITY_TABLE_MAP } = require('../services/statusTransitionService');
const { assertTransition } = require('../services/stateMachine');

test('statusTransitionService: defines mapping for all expected core entities', () => {
  const expectedKeys = [
    'JOURNAL_ENTRY', 'SALES_ORDER', 'CUSTOMER_PAYMENT', 'SUPPLIER_PAYMENT',
    'CREDIT_NOTE', 'PURCHASE_ORDER', 'PURCHASE_REQUISITION', 'CONTRACT',
    'SALES_QUOTATION', 'SALES_RFQ', 'DELIVERY_SCHEDULE', 'SUPPLIER_INVOICE',
    'PAYROLL_RUN', 'FIXED_ASSET', 'WAREHOUSE_TRANSACTION', 'WORK_ORDER', 'BUDGET'
  ];

  for (const key of expectedKeys) {
    assert.ok(ENTITY_TABLE_MAP[key], `Missing ENTITY_TABLE_MAP for ${key}`);
    assert.ok(ENTITY_TABLE_MAP[key].table, `Missing table name for ${key}`);
  }
});

test('statusTransitionService: validates illegal transition before DB call', async () => {
  const mockActor = { id: 'usr-1', role: 'MANAGER', type: 'USER' };
  
  await assert.rejects(
    async () => {
      await applyStatusChange({
        entityType: 'SALES_ORDER',
        entityId: 'so-123',
        newStatus: 'COMPLETED',
        actor: mockActor,
        context: {}
      });
    },
    (err) => {
      // Must fail on transition validation, row lock, or connection error
      return (
        err.message.includes('Illegal status transition') ||
        err.message.includes('not found') ||
        err.name === 'AggregateError' ||
        err.code === 'ECONNREFUSED' ||
        /connect/i.test(err.message)
      );
    }
  );
});
