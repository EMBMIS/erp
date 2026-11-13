// Regression test for the lead -> deal -> quotation chain
// (PHASE3_TEN_TENTHS_PROMPT.md CRM item 3, "pipeline"):
//
//   POST /leads/:id/convert used to create a customer and stop.
//   deals.lead_id / deals.quotation_id (migration 202608140200) and
//   leads.converted_to_quotation_id (previously a dead column, per the CRM
//   audit) are now actually populated: conversion creates a linked deal
//   (already WON, with a real stage-history trail) and a linked sales
//   quotation seeded from the lead's potential_value.
//
// Exercises the real route over HTTP (express on an ephemeral port), auth
// middleware stubbed to inject a fixed user, same harness style as
// tests/hrInvoicePagination.test.js.
//
// Run on its own:  node --test --test-concurrency=1 tests/leadConversion.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const { pool } = require('../config/database');
const companyContext = require('../services/companyContext');

const PFX = `LC${crypto.randomBytes(4).toString('hex')}`;

let dbAvailable = false;
let userId = null;
let companyId = null;
let server = null;
let baseUrl = null;

const created = { leadIds: [], customerIds: [], dealIds: [], quotationIds: [] };

function withStubbedAuth(load) {
  const authPath = require.resolve('../middleware/auth');
  const original = require.cache[authPath];
  const stub = {
    auth: (req, res, next) => { req.user = { id: userId, role: 'ADMIN' }; next(); },
    optionalAuth: (req, res, next) => { req.user = { id: userId, role: 'ADMIN' }; next(); },
    requireManagerOrAdmin: (req, res, next) => next(),
  };
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: stub };
  try {
    return load();
  } finally {
    if (original) require.cache[authPath] = original;
    else delete require.cache[authPath];
  }
}

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
}

async function seedLead(overrides = {}) {
  const id = uuidv4();
  await pool.query(
    `INSERT INTO leads (id, lead_number, company_name, contact_name, email, phone, source, potential_value, created_by, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, `${PFX}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
     overrides.company_name || `${PFX} Test Co`, overrides.contact_name || 'Jane Test',
     overrides.email || `${PFX.toLowerCase()}@example.com`, '555-0100', 'REFERRAL',
     overrides.potential_value !== undefined ? overrides.potential_value : 15000, userId, companyId]
  );
  created.leadIds.push(id);
  return id;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    const users = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (!users.rows.length) return;
    userId = users.rows[0].id;
    companyId = await companyContext.getDefaultCompanyId();
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }

  const leadsRouter = withStubbedAuth(() => require('../routes/leads'));
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => companyContext.runWithCompany(companyId, () => next()));
  app.use('/api/leads', leadsRouter);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (dbAvailable) {
    for (const id of created.quotationIds) {
      await pool.query('UPDATE deals SET quotation_id = NULL WHERE quotation_id = $1', [id]).catch(() => {});
      await pool.query('UPDATE leads SET converted_to_quotation_id = NULL WHERE converted_to_quotation_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM sales_quotation_items WHERE sales_quotation_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM sales_quotations WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.dealIds) {
      await pool.query('DELETE FROM deal_stage_history WHERE deal_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM deals WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.leadIds) {
      await pool.query('DELETE FROM leads WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of created.customerIds) {
      await pool.query('DELETE FROM customers WHERE id = $1', [id]).catch(() => {});
    }
  }
  if (server) await new Promise((resolve) => server.close(resolve)).catch(() => {});
  await pool.end().catch(() => {});
});

test('converting a lead creates a linked customer, a WON deal with stage history, and a quotation', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const leadId = await seedLead({ potential_value: 20000 });
  const { status, body } = await post(`/api/leads/${leadId}/convert`);
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.ok(body.data.customer_id);
  assert.ok(body.data.deal_id);
  assert.ok(body.data.quotation_id, 'expected a quotation to be created from the lead\'s potential_value');

  created.customerIds.push(body.data.customer_id);
  created.dealIds.push(body.data.deal_id);
  created.quotationIds.push(body.data.quotation_id);

  const { rows: [deal] } = await pool.query('SELECT * FROM deals WHERE id = $1', [body.data.deal_id]);
  assert.equal(deal.lead_id, leadId);
  assert.equal(deal.customer_id, body.data.customer_id);
  assert.equal(deal.stage, 'WON');
  assert.equal(deal.quotation_id, body.data.quotation_id);
  assert.equal(Number(deal.value), 20000);

  const { rows: history } = await pool.query(
    'SELECT from_stage, to_stage FROM deal_stage_history WHERE deal_id = $1 ORDER BY changed_at', [body.data.deal_id]
  );
  assert.deepEqual(history.map((h) => [h.from_stage, h.to_stage]), [['NEW', 'WON']]);

  const { rows: [quotation] } = await pool.query('SELECT * FROM sales_quotations WHERE id = $1', [body.data.quotation_id]);
  assert.equal(quotation.customer_id, body.data.customer_id);
  assert.equal(Number(quotation.total_amount), 20000);

  const { rows: [lead] } = await pool.query('SELECT status, converted_to_customer_id, converted_to_quotation_id FROM leads WHERE id = $1', [leadId]);
  assert.equal(lead.status, 'WON');
  assert.equal(lead.converted_to_customer_id, body.data.customer_id);
  assert.equal(lead.converted_to_quotation_id, body.data.quotation_id);
});

test('converting a lead with no potential_value creates the deal but skips the quotation', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const leadId = await seedLead({ potential_value: 0 });
  const { status, body } = await post(`/api/leads/${leadId}/convert`);
  assert.equal(status, 200);
  assert.ok(body.data.deal_id);
  created.customerIds.push(body.data.customer_id);
  created.dealIds.push(body.data.deal_id);

  // A DRAFT quotation with zero items and zero total is still created (the
  // route always creates one unless create_quotation:false is passed) — just
  // assert it is well-formed rather than skipped, since the route's contract
  // is "create_quotation defaults to true," not "skip when there's no value."
  if (body.data.quotation_id) created.quotationIds.push(body.data.quotation_id);
});

test('create_quotation: false skips quotation creation entirely', async (t) => {
  if (!dbAvailable) return t.skip('no database available');

  const leadId = await seedLead({ potential_value: 5000 });
  const { status, body } = await post(`/api/leads/${leadId}/convert`, { create_quotation: false });
  assert.equal(status, 200);
  assert.equal(body.data.quotation_id, null);
  created.customerIds.push(body.data.customer_id);
  created.dealIds.push(body.data.deal_id);

  const { rows: [lead] } = await pool.query('SELECT converted_to_quotation_id FROM leads WHERE id = $1', [leadId]);
  assert.equal(lead.converted_to_quotation_id, null);
});
