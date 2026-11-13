#!/usr/bin/env node
/**
 * Accessibility ratchet.
 *
 * Runs eslint.a11y.config.js over the frontend and fails when the number of
 * jsx-a11y warnings exceeds BUDGET. The budget only ever moves DOWN — same
 * contract as the lint and bundle-size ratchets already in CI.
 *
 * WHY A BUDGET RATHER THAN ZERO
 * ---------------------------------------------------------------------------
 * There are ~400 components here written before any a11y rule existed. Demanding
 * zero would mean no change can land until all of them are fixed, which in
 * practice means the check gets deleted the first time it blocks something
 * urgent. A budget that ratchets converts an unpayable debt into a payable one:
 * new code cannot add to it, and every cleanup permanently lowers the ceiling.
 *
 * WHY IT REPORTS PER RULE
 * ---------------------------------------------------------------------------
 * A single number tells you whether you passed, not what to do next. The
 * breakdown says where the debt actually is — and here it is overwhelmingly one
 * rule (labels not associated with inputs), concentrated in data-entry forms,
 * which is both the highest-impact place to fix and the most mechanical.
 *
 * Lowering the budget: run this script, take the reported total, put it in
 * BUDGET. Do not round up "for headroom" — headroom is where regressions live.
 *
 * Usage:
 *   node scripts/check-a11y-budget.mjs            # enforce
 *   node scripts/check-a11y-budget.mjs --report   # print breakdown, never fail
 */

// The ESLint Node API rather than spawning the CLI: spawning `npx` is not
// portable (it fails with EINVAL on Windows), and shelling out to parse JSON
// back is more moving parts than calling the linter directly.
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The ceiling. Ratcheted down from 806 (2026-07-31) to 0: the accessibility
// debt was paid off rule by rule, so a single warning now fails the check.
const BUDGET = 0;



const reportOnly = process.argv.includes('--report');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let results;
try {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: path.join(repoRoot, 'eslint.a11y.config.js'),
  });
  results = await eslint.lintFiles(['frontend/']);
} catch (err) {
  console.error('Could not run ESLint for the a11y budget check:');
  console.error(err.message);
  process.exit(2);
}

const byRule = new Map();
const byFile = new Map();
let total = 0;

for (const file of results) {
  for (const msg of file.messages) {
    // Count only accessibility findings. Other rules can leak in through inline
    // directives in source files; they are not this budget's business.
    if (!msg.ruleId || !msg.ruleId.startsWith('jsx-a11y/')) continue;
    byRule.set(msg.ruleId, (byRule.get(msg.ruleId) || 0) + 1);
    byFile.set(file.filePath, (byFile.get(file.filePath) || 0) + 1);
    total += 1;
  }
}

console.log('Accessibility budget report');
console.log('---------------------------');
console.log(`Total jsx-a11y warnings: ${total}`);
console.log(`Budget:                  ${BUDGET}`);
console.log('');
console.log('By rule:');
for (const [rule, count] of [...byRule].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)}  ${rule}`);
}

const worst = [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 10);
if (worst.length) {
  console.log('');
  console.log('Worst files:');
  for (const [file, count] of worst) {
    console.log(`  ${String(count).padStart(5)}  ${file.replace(/\\/g, '/').split('/frontend/')[1] || file}`);
  }
}

if (reportOnly) process.exit(0);

if (total > BUDGET) {
  console.error('');
  console.error(`FAIL: ${total} accessibility warnings exceeds the budget of ${BUDGET}.`);
  console.error('Fix the new violations. Do not raise BUDGET — it only moves down.');
  process.exit(1);
}

if (total < BUDGET) {
  console.log('');
  console.log(`PASS — and ${BUDGET - total} under budget.`);
  console.log(`Lower BUDGET in scripts/check-a11y-budget.mjs to ${total} to lock the improvement in.`);
  process.exit(0);
}

console.log('');
console.log('PASS — exactly at budget.');
process.exit(0);
