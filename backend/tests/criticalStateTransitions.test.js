const test = require('node:test');
const assert = require('node:assert/strict');
const { assertTransition, TRANSITION_MAPS } = require('../services/stateMachine');

test('stateMachine: rejects illegal status transitions for Journal Entry', () => {
  assert.throws(
    () => assertTransition('JOURNAL_ENTRY', 'DRAFT', 'REVERSED'),
    { message: /Illegal status transition/ }
  );
  assert.doesNotThrow(() => assertTransition('JOURNAL_ENTRY', 'DRAFT', 'POSTED'));
});

test('stateMachine: rejects direct DRAFT -> COMPLETED jump for Sales Order', () => {
  assert.throws(
    () => assertTransition('SALES_ORDER', 'DRAFT', 'COMPLETED'),
    { message: /Illegal status transition/ }
  );
});

test('stateMachine: supports all expected core entity transition maps', () => {
  const expectedTypes = [
    'JOURNAL_ENTRY', 'SALES_ORDER', 'CUSTOMER_PAYMENT', 'SUPPLIER_PAYMENT',
    'CREDIT_NOTE', 'PURCHASE_ORDER', 'PURCHASE_REQUISITION', 'CONTRACT',
    'SALES_QUOTATION', 'SALES_RFQ', 'DELIVERY_SCHEDULE', 'SUPPLIER_INVOICE',
    'PAYROLL_RUN', 'FIXED_ASSET', 'WAREHOUSE_TRANSACTION', 'WORK_ORDER', 'BUDGET'
  ];

  for (const type of expectedTypes) {
    assert.ok(TRANSITION_MAPS[type], `Missing transition map for ${type}`);
  }
});
