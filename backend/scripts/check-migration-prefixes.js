/**
 * Script: check-migration-prefixes.js
 *
 * Verifies that no NEW migrations introduce duplicate number prefixes.
 * Historical legacy numeric prefixes (e.g. 139, 140, 141) are recorded in an allowlist.
 * All new migrations must use timestamp-based prefixes (e.g. YYYYMMDDHHMM_name.sql).
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');
const LEGACY_ALLOWLIST = ['001', '020', '026', '027', '029', '035', '056', '066', '070', '113', '139', '140', '141'];

const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
const prefixMap = {};

for (const file of files) {
  const match = file.match(/^(\d+)_/);
  if (!match) continue;
  const prefix = match[1];

  if (!prefixMap[prefix]) {
    prefixMap[prefix] = [];
  }
  prefixMap[prefix].push(file);
}

let errors = 0;
for (const [prefix, fileList] of Object.entries(prefixMap)) {
  if (fileList.length > 1 && !LEGACY_ALLOWLIST.includes(prefix)) {
    console.error(`❌ Duplicate migration prefix "${prefix}" detected: ${fileList.join(', ')}`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`❌ Found ${errors} new duplicate migration prefix violation(s). Use YYYYMMDDHHMM_*.sql timestamps.`);
  process.exit(1);
} else {
  console.log('✅ Migration prefix check passed.');
  process.exit(0);
}
