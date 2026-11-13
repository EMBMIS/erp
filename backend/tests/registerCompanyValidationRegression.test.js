// Regression test for a self-service signup blocker: routes/auth.js's
// registerCompanySchema declared business_type_code as
// `Joi.string().optional()`. .optional() only allows the KEY to be absent —
// Joi's default string type still rejects an empty string. But
// frontend/src/pages/Signup.jsx initializes business_type_code to '' in its
// form state and never omits it from the request, so every signup that left
// the (explicitly labeled "optional") business-type dropdown at its default
// failed validation with a raw, untranslated
// `"business_type_code" is not allowed to be empty` — blocking the entire
// self-service signup flow for exactly the path its own UI invites: leaving
// an optional field blank.
//
// Live-reproduced in a real browser session before the fix: filling out
// every required field, leaving "Business type" at "Select a business
// type", and submitting showed that raw Joi message and created no account.
// After adding .allow(''), matching the sibling business_description field
// one line below (which already had it), the same submission succeeds.
//
// This codebase has no HTTP test harness (see every prior session's honesty
// notes), so this validates the Joi schema directly — the same schema
// POST /auth/register-company runs req.body through before any DB write —
// rather than driving the route through a real HTTP request.
//
// No database queries are made, but requiring routes/auth.js transitively
// requires config/database.js, which opens a real pg pool as a side effect —
// pool.end() in after() is still needed or the process never exits, same as
// every DB-touching suite in this codebase.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../config/database');
const authRouter = require('../routes/auth');
const { registerCompanySchema } = authRouter;

after(async () => {
  await pool.end().catch(() => {});
});

const basePayload = {
  email: 'signup-validation-regression@example.com',
  password: 'Reg-x9z7-Q1!',
  first_name: 'Ada',
  last_name: 'Founder',
  company_name: 'Validation Regression Co',
};

test('registerCompanySchema accepts an empty business_type_code (the signup form\'s actual default)', () => {
  const { error } = registerCompanySchema.validate({
    ...basePayload,
    business_type_code: '', // frontend/src/pages/Signup.jsx's initial form state — never omitted
    business_description: '',
  });
  assert.equal(error, undefined, 'a signup that leaves the optional business-type dropdown unselected must not fail validation');
});

test('registerCompanySchema still accepts a real business_type_code when one is chosen', () => {
  const { error } = registerCompanySchema.validate({
    ...basePayload,
    business_type_code: 'manufacturing',
  });
  assert.equal(error, undefined);
});

test('registerCompanySchema still requires the genuinely required fields', () => {
  const { error } = registerCompanySchema.validate({
    email: basePayload.email,
    password: basePayload.password,
    // first_name, last_name, company_name omitted
    business_type_code: '',
  });
  assert.ok(error, 'omitting a required field must still fail validation');
});

test('registerCompanySchema still rejects a malformed email', () => {
  const { error } = registerCompanySchema.validate({
    ...basePayload,
    email: 'not-an-email',
    business_type_code: '',
  });
  assert.ok(error, 'an invalid email must still fail validation regardless of business_type_code');
});
