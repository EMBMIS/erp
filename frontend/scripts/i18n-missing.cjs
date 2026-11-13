#!/usr/bin/env node
/**
 * List every translation key the app calls that en.json does not define.
 *
 * A key with no English entry is not a fallback — `translate()` returns the key
 * itself, so the user reads a literal "auth.signInTitle" on screen. This is the
 * check that catches a catalogue and a codebase drifting apart, which is
 * exactly what a partial rollback produces.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const EN = path.join(SRC, 'i18n', 'locales', 'en.json');

const flat = (o, p = '', out = {}) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
};

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
};

const en = JSON.parse(fs.readFileSync(EN, 'utf8'));
const have = new Set(Object.keys(flat(en)));

// t('a.b'), t("a.b") and t(`a.b`) with a literal key. Template keys built at
// runtime (t(`status.${s}`)) cannot be checked statically and are skipped.
const CALL = /\bt\(\s*['"`]([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)['"`]\s*\)/g;

const used = new Map();
for (const file of walk(SRC)) {
  if (file.includes(`${path.sep}i18n${path.sep}`)) continue;
  const s = fs.readFileSync(file, 'utf8');
  for (const m of s.matchAll(CALL)) {
    if (!used.has(m[1])) used.set(m[1], path.relative(SRC, file));
  }
}

const missing = [...used.keys()].filter((k) => !have.has(k)).sort();
const byNs = {};
for (const k of missing) {
  const ns = k.split('.')[0];
  (byNs[ns] = byNs[ns] || []).push(k);
}

console.log(`\n  Keys called with a literal name : ${used.size}`);
console.log(`  Defined in en.json              : ${used.size - missing.length}`);
console.log(`  MISSING (render as raw keys)    : ${missing.length}\n`);

for (const [ns, keys] of Object.entries(byNs).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${ns.padEnd(16)} ${String(keys.length).padStart(5)}   e.g. ${keys.slice(0, 3).join(', ')}`);
}
if (!missing.length) console.log('  Every key the app asks for exists.\n');
else console.log('');

process.exit(missing.length ? 1 : 0);
