/**
 * Smoke test: require every route file in routes/ and assert none throw at load time.
 *
 * A route file that throws on require() (broken import, syntax error, missing module)
 * is a runtime 500 waiting to happen. This test catches those at test time.
 */

const fs = require('fs');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../config/database');

const ROUTES_DIR = path.join(__dirname, '..', 'routes');

// Requiring every route file opens config/database.js's pool (min: 2
// keepalive connections) many times over — without closing it, the process
// hangs after the last test forever.
after(() => pool.end());

test('every route file loads without throwing', async (t) => {
  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 10, `expected at least 10 route files, found ${files.length}`);

  const failures = [];
  const loaded = [];

  for (const file of files.sort()) {
    const filePath = path.join(ROUTES_DIR, file);
    try {
      require(filePath);
      loaded.push(file);
    } catch (err) {
      failures.push({ file, message: err.message, code: err.code });
    }
  }

  if (failures.length > 0) {
    const detail = failures.map((f) => `  ${f.file}: ${f.message}`).join('\n');
    assert.fail(`${failures.length}/${files.length} route file(s) failed to load:\n${detail}`);
  }

  console.log(`  All ${loaded.length} route files loaded successfully`);
});
