// DoA applies_to drift guard — no database required.
//
// The delegation_of_authority.applies_to CHECK constraint is the write-side
// gate for every DoA grant the product can create. It has drifted from
// backend/config/doaConfig.js (the form options) four separate times
// (migrations 018 → 026 → 035 → 052 → 202608120200), each time silently
// blocking a subset of transaction types that the UI advertises. This test
// pins the two sides together so the drift cannot recur:
//
//   • every transaction type advertised by doaConfig (what the DoA form and
//     ApprovalSimulator offer), and
//   • every transaction-type literal the approval routes actually query
//     ('PO', 'PR', 'PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'RFQ', ...)
//
// must be present in the latest `*doa_applies_to*` migration's CHECK list.
// Adding a type to the config, or to the routes, without widening the
// constraint now fails CI with a message naming the missing value.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');

// Transaction-type literals the DoA read side actually queries, outside the
// config list. Kept explicit so the guard is self-documenting. The engine
// matches rows by `applies_to = 'ALL' OR applies_to = <requested type>`, so a
// grant stored under any of these must be creatable.
const CODE_REFERENCED_TYPES = [
  'PO',        // routes/purchase-orders.js PO approve
  'PR',        // routes/delegation-of-authority.js PR approve
  'PURCHASE_ORDER',   // routes/purchase-orders.js / contracts.js
  'PURCHASE_REQUISITION', // routes/delegation-of-authority.js
  'RFQ',       // routes/delegation-of-authority.js approve RFQ entities
  'SALES',     // models/DelegationOfAuthority.js sales authority paths
  'CONTRACT',  // routes/contracts.js
  // Cross-department dual-approval types seeded by migration 052
  'SALES_RFQ_SALES_APPROVAL', 'SALES_RFQ_PROCUREMENT_APPROVAL',
  'PURCHASE_ORDER_SALES_APPROVAL', 'PURCHASE_ORDER_PROCUREMENT_APPROVAL',
  'DELIVERY_SCHEDULING', 'DELIVERY_POSTPONEMENT', 'DROPSHIP_AUTHORIZATION'
];

function allowedAppliesToValues() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && f.includes('doa_applies_to'))
    .sort((a, b) => a.localeCompare(b, 'en'));

  assert.ok(
    files.length > 0,
    `no *doa_applies_to* migration found in ${MIGRATIONS_DIR} — the drift guard cannot run`
  );

  const latest = files[files.length - 1];
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, latest), 'utf8');
  const values = new Set();
  // Quoted uppercase identifiers inside the CHECK ( ) list.
  const re = /'([A-Z][A-Z_]+)'/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    values.add(m[1]);
  }
  assert.ok(
    values.size > 0,
    `no quoted values parsed from the CHECK in ${latest} — the guard cannot run`
  );
  return { latest, values };
}

test('every doaConfig transaction type is permitted by the applies_to constraint', () => {
  const { latest, values } = allowedAppliesToValues();
  // Fresh require so the test is not order-dependent.
  const doaConfig = require('../config/doaConfig');
  const configTypes = doaConfig.transaction_types.map((t) => t.value);

  const missing = configTypes.filter((t) => !values.has(t));
  assert.deepEqual(
    missing,
    [],
    `doaConfig advertises transaction types the constraint forbids (migration ${latest}): ${missing.join(', ')}. ` +
      'Widen the delegation_of_authority_applies_to_check CHECK in a new migration (and keep this test green).'
  );
});

test('every code-referenced DoA type is permitted by the applies_to constraint', () => {
  const { latest, values } = allowedAppliesToValues();
  const missing = CODE_REFERENCED_TYPES.filter((t) => !values.has(t));
  assert.deepEqual(
    missing,
    [],
    `routes query DoA types the constraint forbids (migration ${latest}): ${missing.join(', ')}. ` +
      'Widen the delegation_of_authority_applies_to_check CHECK in a new migration.'
  );
});
