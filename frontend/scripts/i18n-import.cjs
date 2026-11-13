#!/usr/bin/env node
/**
 * Load translated files back into a locale catalogue.
 *
 * This is the gate between "someone pasted JSON from a translator" and the
 * catalogue the app actually ships. It validates before it writes, because the
 * failure modes here are silent ones:
 *
 *   • a translated KEY   -> the app asks for a key that no longer exists and
 *                           renders English forever, with nothing to notice
 *   • a mangled {count}  -> the user sees a literal "{count}" in a sentence
 *   • an English value   -> looks translated in the file, isn't in the product
 *
 * Existing translations are never overwritten. Re-importing a corrected file
 * for keys that are already filled does nothing unless --force is passed.
 *
 *   node scripts/i18n-import.cjs ko-KR i18n-export/done/ko-KR
 *   node scripts/i18n-import.cjs ko-KR path/to/one-file.json
 *   node scripts/i18n-import.cjs ko-KR <dir> --force     # overwrite existing
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'i18n', 'locales');

const [localeArg, sourceArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const force = process.argv.includes('--force');

if (!localeArg || !sourceArg) {
  console.error('usage: node scripts/i18n-import.cjs <locale> <file-or-dir> [--force]');
  process.exit(1);
}

const short = localeArg.split('-')[0];
const targetFile = path.join(DIR, `${short}.json`);
if (!fs.existsSync(targetFile)) {
  console.error(`No catalogue at ${path.relative(process.cwd(), targetFile)} — is "${localeArg}" a locale this app ships?`);
  process.exit(1);
}

const flat = (o, p = '', out = {}) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
};
const get = (o, d) => d.split('.').reduce((n, k) => (n == null ? n : n[k]), o);
const set = (o, d, v) => {
  const parts = d.split('.');
  let n = o;
  for (const p of parts.slice(0, -1)) {
    if (!n[p] || typeof n[p] !== 'object') n[p] = {};
    n = n[p];
  }
  n[parts[parts.length - 1]] = v;
};

const PH = /\{(\w+)\}/g;
const phOf = (s) => (String(s).match(PH) || []).sort().join(',');

const en = flat(JSON.parse(fs.readFileSync(path.join(DIR, 'en.json'), 'utf8')));
const target = JSON.parse(fs.readFileSync(targetFile, 'utf8'));

const stat = fs.statSync(sourceArg);
const files = stat.isDirectory()
  ? fs.readdirSync(sourceArg).filter((f) => f.endsWith('.json')).map((f) => path.join(sourceArg, f))
  : [sourceArg];

let written = 0;
let skippedExisting = 0;
const problems = [];
const untranslated = [];

for (const file of files) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    problems.push(`${path.basename(file)}: not valid JSON — ${e.message.split('\n')[0]}`);
    continue;
  }

  for (const [key, value] of Object.entries(flat(data))) {
    if (en[key] === undefined) { problems.push(`${path.basename(file)}: "${key}" is not a key in en.json`); continue; }
    if (typeof value !== 'string' || !value.trim()) { problems.push(`${path.basename(file)}: "${key}" has no value`); continue; }
    if (phOf(en[key]) !== phOf(value)) {
      problems.push(`${path.basename(file)}: "${key}" placeholders changed (${phOf(en[key]) || 'none'} -> ${phOf(value) || 'none'})`);
      continue;
    }
    if (value.trim() === String(en[key]).trim()) untranslated.push(key);
    if (!force && get(target, key) !== undefined) { skippedExisting += 1; continue; }
    set(target, key, value);
    written += 1;
  }
}

if (problems.length) {
  console.error(`\n  ${problems.length} problem(s) — nothing written:\n`);
  for (const p of problems.slice(0, 25)) console.error(`    ${p}`);
  if (problems.length > 25) console.error(`    … and ${problems.length - 25} more`);
  console.error('\n  Fix the file and re-run. Keys must be left exactly as exported.\n');
  process.exit(1);
}

fs.writeFileSync(targetFile, JSON.stringify(target, null, 2) + '\n', 'utf8');

console.log(`\n  ${short}: wrote ${written} translations from ${files.length} file(s).`);
if (skippedExisting) console.log(`  ${skippedExisting} already had a value (kept — pass --force to overwrite).`);
if (untranslated.length) {
  console.log(`  ${untranslated.length} value(s) are identical to the English — check these were meant to be:`);
  for (const k of untranslated.slice(0, 8)) console.log(`    ${k} = ${JSON.stringify(en[k])}`);
  if (untranslated.length > 8) console.log(`    … and ${untranslated.length - 8} more`);
}

const remaining = Object.keys(en).filter((k) => typeof en[k] === 'string' && get(target, k) === undefined).length;
console.log(`  ${remaining} key(s) still untranslated in ${short}.\n`);
