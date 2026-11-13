#!/usr/bin/env node
/**
 * Reuse translations the catalogue already has.
 *
 * The extractor gave every hardcoded string its own `ui.*` key, so the app now
 * asks for `ui.cancel`, `ui.status2`, `ui.loading2` — while `common.cancel`,
 * `common.status` and `common.loading` have been translated into 22 languages
 * for weeks. Nothing links them, so every one of those falls back to English.
 *
 * This copies the existing translation across wherever the ENGLISH SOURCE is
 * the same string. That is the only safe basis for the match: same English,
 * same meaning, therefore same translation. It is deliberately not fuzzy —
 * "Total" and "Total:" match after trimming punctuation, but "Credit" and
 * "Credit note" never will.
 *
 * Existing values are never overwritten, so a locale that already has a better
 * hand-written `ui.*` string keeps it.
 *
 *   node scripts/i18n-dedupe.cjs            # report
 *   node scripts/i18n-dedupe.cjs --apply    # copy them across
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'i18n', 'locales');
const apply = process.argv.includes('--apply');

const flat = (o, p = '', out = {}) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
};

const get = (o, dotted) => dotted.split('.').reduce((n, k) => (n == null ? n : n[k]), o);
const set = (o, dotted, v) => {
  const parts = dotted.split('.');
  let n = o;
  for (const p of parts.slice(0, -1)) {
    if (!n[p] || typeof n[p] !== 'object') n[p] = {};
    n = n[p];
  }
  n[parts[parts.length - 1]] = v;
};

// Trailing colons, asterisks (required-field markers) and case differences are
// presentation, not meaning. "Total:", "Total" and "TOTAL" are one string.
const norm = (s) => String(s).trim().replace(/[\s:*]+$/, '').replace(/\s+/g, ' ').toLowerCase();

const en = JSON.parse(fs.readFileSync(path.join(DIR, 'en.json'), 'utf8'));
const enFlat = flat(en);

// Canonical keys are everything outside ui.* — the hand-translated namespaces.
const canonical = new Map();
for (const [k, v] of Object.entries(enFlat)) {
  if (k.startsWith('ui.') || typeof v !== 'string') continue;
  const n = norm(v);
  if (n && !canonical.has(n)) canonical.set(n, k);
}

const pairs = [];
for (const [key, value] of Object.entries(en.ui || {})) {
  if (typeof value !== 'string') continue;
  const src = canonical.get(norm(value));
  if (src) pairs.push({ uiKey: `ui.${key}`, from: src, english: value });
}

console.log(`\n  ui.* keys                       : ${Object.keys(en.ui || {}).length}`);
console.log(`  matched to an existing key      : ${pairs.length}`);

if (!apply) {
  console.log('\n  Sample:');
  for (const p of pairs.slice(0, 12)) console.log(`    ${p.uiKey.padEnd(28)} <- ${p.from.padEnd(24)} "${p.english}"`);
  console.log(`\n  Dry run — nothing written. Re-run with --apply.\n`);
  process.exit(0);
}

let totalCopied = 0;
for (const file of fs.readdirSync(DIR)) {
  if (!file.endsWith('.json') || file === 'en.json') continue;
  const locale = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  let copied = 0;
  for (const { uiKey, from } of pairs) {
    if (get(locale, uiKey) !== undefined) continue;   // never overwrite
    const value = get(locale, from);
    if (typeof value !== 'string') continue;          // that locale lacks it too
    set(locale, uiKey, value);
    copied += 1;
  }
  if (copied) {
    fs.writeFileSync(path.join(DIR, file), JSON.stringify(locale, null, 2) + '\n', 'utf8');
    totalCopied += copied;
  }
  console.log(`  ${file.replace('.json', '').padEnd(4)} +${copied}`);
}
console.log(`\n  Copied ${totalCopied} translations across ${fs.readdirSync(DIR).length - 1} locales.\n`);
