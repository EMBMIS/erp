// Round 7, Task 21 — A6: learning from overrides.
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// The feature is only worth anything if a recorded correction actually reaches
// the model. Two separate things had to be true and neither was:
//
//   1. recordOverride() wrote to `ai_settings (company_id, key, value)`.
//      ai_settings has no key or value column, so every call threw and the
//      feature had never once succeeded.
//   2. getLearnedPreferences() was called from exactly one place — a GET
//      endpoint. Nothing injected it into the agent's system prompt, so even a
//      working write would have changed nothing about the assistant's answers.
//
// So the assertion that matters here is not "a row was stored". It is "the
// stored correction appears in the text handed to the model". That is the only
// version of this test that can fail if the loop is broken again.
//
// Run on its own:  node --test tests/preferenceLearning.test.js

const { test, before, after } = require('./helpers/withCompany').wrapHooks(require('node:test'));
const assert = require('node:assert/strict');

const PreferenceLearningService = require('../services/ai/preferenceLearningService');
const { pool } = require('../config/database');

let dbAvailable = false;
let companyId = null;

before(async () => {
  try {
    const { rows } = await pool.query('SELECT id FROM companies ORDER BY created_at LIMIT 1');
    if (!rows.length) throw new Error('no company to test against');
    companyId = rows[0].id;
    dbAvailable = true;
  } catch (err) {
    console.error('preference-learning test setup failed:', err.message);
    dbAvailable = false;
    return;
  }
  await pool.query('DELETE FROM ai_learned_preferences WHERE company_id = $1', [companyId]);
});

after(async () => {
  if (dbAvailable) {
    await pool.query('DELETE FROM ai_learned_preferences WHERE company_id = $1', [companyId])
      .catch(() => {});
  }
  await pool.end();
});

test('recordOverride persists a correction (it used to throw on every call)', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const saved = await PreferenceLearningService.recordOverride({
    fieldName: 'freight_account',
    originalValue: '5100',
    correctedValue: '5150',
    notes: 'freight always books to 5150 here',
  }, companyId);

  assert.equal(saved.field_name, 'freight_account');
  assert.equal(saved.corrected_value, '5150');
  assert.equal(saved.original_value, '5100');
  assert.equal(saved.occurrences, 1);
});

test('re-correcting the same field updates it and counts the repeat', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  await PreferenceLearningService.recordOverride({
    fieldName: 'freight_account',
    originalValue: '5100',
    correctedValue: '5150',
  }, companyId);

  const prefs = await PreferenceLearningService.getLearnedPreferences(companyId);
  const freight = prefs.filter((p) => p.field_name === 'freight_account');

  assert.equal(freight.length, 1, 're-correcting must update, not duplicate');
  assert.equal(freight[0].occurrences, 2, 'a repeated correction is a stronger signal');
});

test('THE LOOP: a recorded correction appears in the agent system prompt', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  await PreferenceLearningService.recordOverride({
    fieldName: 'freight_account',
    originalValue: '5100',
    correctedValue: '5150',
  }, companyId);

  const fragment = await PreferenceLearningService.buildPromptFragment(companyId);

  assert.ok(fragment.includes('freight_account'), 'the field must be named');
  assert.ok(fragment.includes('5150'), 'the corrected value must be present');
  assert.ok(fragment.includes('5100'), 'the value being corrected away from must be present');
  assert.match(fragment, /LEARNED PREFERENCES/i, 'the model needs a header telling it what these are');
});

// This is the assertion that actually guards the feature. buildPromptFragment
// returning the right string proves nothing on its own — the previous version
// of this feature stored corrections correctly and still changed no answers,
// because nothing appended them to the prompt. So assert against the function
// the agent really calls to build its system message.
test('THE WIRING: agent.buildSystemPrompt embeds the learned preference', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const { buildSystemPrompt } = require('../services/ai/agent');

  await PreferenceLearningService.recordOverride({
    fieldName: 'freight_account',
    originalValue: '5100',
    correctedValue: '5150',
  }, companyId);

  const prompt = await buildSystemPrompt({ companyId });

  assert.ok(prompt.includes('Simeli ERP AI agent'), 'base instructions must survive');
  assert.ok(
    prompt.includes('freight_account') && prompt.includes('5150'),
    'the learned correction must reach the model, not just the database'
  );
});

test('a company with nothing learned gets the base prompt, unchanged', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  const { buildSystemPrompt } = require('../services/ai/agent');
  await pool.query('DELETE FROM ai_learned_preferences WHERE company_id = $1', [companyId]);

  const prompt = await buildSystemPrompt({ companyId });
  assert.ok(!/LEARNED PREFERENCES/i.test(prompt), 'no preferences must mean no header');
});

test('an empty preference set yields an empty fragment, not a dangling header', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  await pool.query('DELETE FROM ai_learned_preferences WHERE company_id = $1', [companyId]);
  const fragment = await PreferenceLearningService.buildPromptFragment(companyId);

  assert.equal(fragment, '', 'nothing learned must contribute nothing to the prompt');
});

test('preferences are company-scoped — one tenant cannot see another\'s', async (t) => {
  if (!dbAvailable) return t.skip('no database');

  await PreferenceLearningService.recordOverride({
    fieldName: 'freight_account',
    correctedValue: '5150',
  }, companyId);

  const otherCompany = '00000000-0000-0000-0000-0000000000ff';
  const prefs = await PreferenceLearningService.getLearnedPreferences(otherCompany);

  assert.equal(prefs.length, 0, 'a different company must see none of these preferences');
});
