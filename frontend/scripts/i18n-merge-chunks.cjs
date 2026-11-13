#!/usr/bin/env node
/**
 * Merge chunk files written by the per-locale translation workers into the
 * locale catalogue.
 *
 * Chunk files live in scripts/_i18n_chunks/<lang>/chunk_01.json etc. and are
 * flat maps of dotted keys ("ui.saveChanges": "Modifiche salvate"). This
 * script:
 *
 *   1. reads every chunk for the given language,
 *   2. expands the dotted keys into the nested JSON shape the catalogue uses,
 *   3. merges them into src/i18n/locales/<lang>.json — ADDING keys that are
 *      missing, never overwriting a value that already exists (a hand-edited
 *      translation must survive),
 *   4. removes the chunk directory when everything landed.
 *
 * Usage: node scripts/i18n-merge-chunks.cjs <lang>   (lang = file stem, e.g. de)
 */
const fs = require('fs');
const path = require('path');

const lang = process.argv[2];
if (!lang) { console.error('usage: node scripts/i18n-merge-chunks.cjs <lang>'); process.exit(1); }

const LOCALES_DIR = path.join(__dirname, '..', 'src', 'i18n', 'locales');
const CHUNKS_DIR = path.join(__dirname, '_i18n_chunks', lang);
const LOCALE_FILE = path.join(LOCALES_DIR, `${lang}.json`);

if (!fs.existsSync(CHUNKS_DIR)) { console.error(`no chunks dir for ${lang}`); process.exit(1); }

function setDeep(obj, dotted, value) {
  const parts = dotted.split('.');
  let node = obj;
  for (const p of parts.slice(0, -1)) {
    if (!node[p] || typeof node[p] !== 'object') node[p] = {};
    node = node[p];
  }
  node[parts[parts.length - 1]] = value;
}

const chunks = fs.readdirSync(CHUNKS_DIR).filter((f) => f.endsWith('.json')).sort();
if (!chunks.length) { console.error(`no chunk files for ${lang}`); process.exit(1); }

const locale = fs.existsSync(LOCALE_FILE) ? JSON.parse(fs.readFileSync(LOCALE_FILE, 'utf8')) : {};
let added = 0;
let skipped = 0;
const flatKeys = new Set();

for (const chunkFile of chunks) {
  const chunk = JSON.parse(fs.readFileSync(path.join(CHUNKS_DIR, chunkFile), 'utf8'));
  for (const [key, value] of Object.entries(chunk)) {
    flatKeys.add(key);
    // Only add keys that are entirely absent (nested path fully undefined).
    const parts = key.split('.');
    let node = locale;
    let exists = true;
    for (const p of parts) {
      if (node[p] === undefined || node[p] === null) { exists = false; break; }
      node = node[p];
    }
    if (exists) { skipped += 1; continue; }
    setDeep(locale, key, value);
    added += 1;
  }
}

fs.writeFileSync(LOCALE_FILE, JSON.stringify(locale, null, 2) + '\n', 'utf8');
fs.rmSync(CHUNKS_DIR, { recursive: true, force: true });
console.log(`${lang}: added ${added} keys, skipped ${skipped} existing, ${chunks.length} chunks merged`);
