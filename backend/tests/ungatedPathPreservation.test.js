const test = require('node:test');
const assert = require('node:assert/strict');
const AuthorityEngine = require('../services/authority');

test('Ungated path preservation: drafting and viewing documents remain ungated for regular users', async () => {
  const userActor = { id: 'usr-regular-1', role: 'USER', type: 'USER' };
  
  // Non-commitment actions like DRAFT, READ, REPORT should pass smoothly
  const draftRes = await AuthorityEngine.can(userActor, 'CREATE_DRAFT', { type: 'PURCHASE_ORDER', amount: 50000 });
  assert.strictEqual(draftRes.allow, true);

  const viewRes = await AuthorityEngine.can(userActor, 'VIEW_REPORT', { type: 'JOURNAL_ENTRY' });
  assert.strictEqual(viewRes.allow, true);
});
