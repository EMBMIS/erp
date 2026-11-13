#!/usr/bin/env node
/**
 * Rebuild en.json's `ui` block from the pre-codemod sources.
 *
 * WHY THIS EXISTS
 * ===============
 *
 * i18n-extract.cjs did two things at once: it replaced every hardcoded string
 * in the JSX with `t('ui.someKey')`, and it wrote the key→English mapping into
 * en.json. Those two outputs are useless apart. If the catalogue is lost or
 * rolled back while the rewritten JSX survives, the app asks for 3,000 keys
 * that no longer exist — and `translate()` returns the key itself, so the user
 * reads a literal "ui.inventoryItems" on screen. That is strictly worse than
 * the untranslated English it replaced.
 *
 * The English text is not recoverable from the working tree, because the
 * codemod consumed it. It IS recoverable from whatever holds the sources as
 * they were before the codemod ran — normally git HEAD, since the codemod's
 * changes were never committed.
 *
 * This re-runs the SAME extraction over those original sources, in the same
 * order, with the same key-generation rules, and emits the mapping only. It
 * writes no JSX. Determinism is the whole point: identical inputs must produce
 * identical keys, or the recovered catalogue would not match the calls the
 * rewritten JSX is already making. The script verifies that before writing.
 *
 *   node scripts/i18n-recover.cjs <original-src-dir>            # check
 *   node scripts/i18n-recover.cjs <original-src-dir> --apply    # write en.json
 */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverseMod = require('@babel/traverse');

const traverse = traverseMod.default || traverseMod;

const LIVE_SRC = path.join(__dirname, '..', 'src');
const EN = path.join(LIVE_SRC, 'i18n', 'locales', 'en.json');
const ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt']);
const SKIP_FILES = ['I18nContext.jsx'];

const originalSrc = process.argv[2];
const apply = process.argv.includes('--apply');

if (!originalSrc || !fs.existsSync(originalSrc)) {
  console.error('usage: node scripts/i18n-recover.cjs <dir-with-pre-codemod-src> [--apply]');
  console.error('  e.g. git archive HEAD frontend/src | tar -x -C /tmp/orig');
  console.error('       node scripts/i18n-recover.cjs /tmp/orig/frontend/src');
  process.exit(1);
}

// --- identical to i18n-extract.cjs; keep in lockstep -----------------------
function isTranslatable(raw) {
  const s = String(raw).trim();
  if (s.length < 2) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  if (/^https?:\/\//.test(s)) return false;
  if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(s)) return false;
  if (/^[A-Z0-9_]+$/.test(s) && (s.includes('_') || s.length > 4)) return false;
  if (/^[a-z0-9-]+$/.test(s) && s.includes('-')) return false;
  if (!/[A-Za-z]{2}/.test(s)) return false;
  return true;
}

const usedKeys = new Set();
function makeKey(text) {
  const words = text.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 6);
  let base = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  if (!base) base = 'text';
  if (/^\d/.test(base)) base = `t${base}`;
  let key = base;
  let n = 2;
  while (usedKeys.has(key)) key = `${base}${n++}`;
  usedKeys.add(key);
  return key;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.jsx$/.test(e.name)) out.push(p);
  }
  return out;
}
// ---------------------------------------------------------------------------

const catalogue = new Map();
const files = walk(originalSrc).filter(
  (f) => !f.includes(`${path.sep}i18n${path.sep}`) && !SKIP_FILES.includes(path.basename(f))
);

for (const file of files) {
  const code = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parser.parse(code, { sourceType: 'module', plugins: ['jsx'] });
  } catch {
    continue;
  }
  const found = [];
  traverse(ast, {
    JSXText(p) {
      const text = p.node.value.trim();
      if (isTranslatable(text)) found.push(text);
    },
    JSXAttribute(p) {
      if (!ATTRS.has(p.node.name?.name)) return;
      const v = p.node.value;
      if (!v || v.type !== 'StringLiteral') return;
      const text = v.value.trim();
      if (isTranslatable(text)) found.push(text);
    },
  });
  for (const text of found) if (!catalogue.has(text)) catalogue.set(text, makeKey(text));
}

// What the rewritten JSX actually asks for.
const referenced = new Set();
for (const file of walk(LIVE_SRC)) {
  const s = fs.readFileSync(file, 'utf8');
  for (const m of s.matchAll(/t\(['"]ui\.([A-Za-z0-9]+)['"]\)/g)) referenced.add(m[1]);
}

const recovered = new Map();
for (const [text, key] of catalogue) recovered.set(key, text);

const matched = [...referenced].filter((k) => recovered.has(k));
const unmatched = [...referenced].filter((k) => !recovered.has(k));

console.log(`\n  Keys the app calls        : ${referenced.size}`);
console.log(`  Recovered from originals  : ${matched.length}`);
console.log(`  Still unresolved          : ${unmatched.length}`);
if (unmatched.length) console.log(`  e.g. ${unmatched.slice(0, 8).join(', ')}`);

if (!apply) {
  console.log('\n  Dry run — nothing written. Re-run with --apply.\n');
  process.exit(unmatched.length ? 1 : 0);
}

const en = JSON.parse(fs.readFileSync(EN, 'utf8'));
en.ui = en.ui || {};
let added = 0;
for (const k of matched) {
  if (en.ui[k] === undefined) { en.ui[k] = recovered.get(k); added += 1; }
}
fs.writeFileSync(EN, JSON.stringify(en, null, 2) + '\n', 'utf8');
console.log(`\n  Wrote ${added} keys into en.json "ui" (now ${Object.keys(en.ui).length}).\n`);
