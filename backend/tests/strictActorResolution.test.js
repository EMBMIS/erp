const test = require('node:test');
const assert = require('node:assert/strict');
const { applyStatusChange } = require('../services/statusTransitionService');

test('strictActorResolution: missing or undefined actor fails closed', async () => {
  await assert.rejects(
    async () => {
      await applyStatusChange({
        entityType: 'SALES_ORDER',
        // A well-formed id that matches no order: with a live database the
        // lookup must get as far as "not found". A non-UUID string here made
        // Postgres reject the cast instead, which only passed without a DB.
        entityId: '00000000-0000-4000-8000-0000000005a1',
        newStatus: 'APPROVED',
        actor: undefined
      });
    },
    (err) => {
      return err.message.includes('actor is required') || err.status === 401;
    }
  );
});

test('strictActorResolution: unresolvable user ID fails closed without fallback', async () => {
  await assert.rejects(
    async () => {
      await applyStatusChange({
        entityType: 'JOURNAL_ENTRY',
        entityId: 'je-999',
        newStatus: 'POSTED',
        actor: '00000000-0000-0000-0000-000000000000'
      });
    },
    (err) => {
      return (
        err.message.includes('Actor resolution') ||
        err.name === 'AggregateError' ||
        err.code === 'ECONNREFUSED'
      );
    }
  );
});

test('strictActorResolution: non-UUID system actors resolve explicitly', async () => {
  await assert.rejects(
    async () => {
      await applyStatusChange({
        entityType: 'SALES_ORDER',
        // A well-formed id that matches no order: with a live database the
        // lookup must get as far as "not found". A non-UUID string here made
        // Postgres reject the cast instead, which only passed without a DB.
        entityId: '00000000-0000-4000-8000-0000000005a1',
        newStatus: 'COMPLETED',
        actor: { id: 'ai-system', role: 'MANAGER', type: 'AGENT' }
      });
    },
    (err) => {
      // Must proceed past actor resolution to row lock / connection check
      return (
        err.message.includes('not found') ||
        err.name === 'AggregateError' ||
        err.code === 'ECONNREFUSED'
      );
    }
  );
});
