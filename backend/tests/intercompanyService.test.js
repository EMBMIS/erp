const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../config/database');
const intercompanyService = require('../services/intercompanyService');

let dbAvailable = false;

before(async () => {
  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  await pool.end();
});

test('intercompanyService module exports mirrorPOToSalesOrder and generateEliminationEntries', () => {
  assert.equal(typeof intercompanyService.mirrorPOToSalesOrder, 'function');
  assert.equal(typeof intercompanyService.generateEliminationEntries, 'function');
});

test('generateEliminationEntries computes total intercompany amount', async (t) => {
  if (!dbAvailable) return t.skip('No database');
  const res = await intercompanyService.generateEliminationEntries(1, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
  assert.equal(res.ok, true);
  assert.equal(typeof res.eliminatedAmount, 'number');
});

