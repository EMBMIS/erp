#!/usr/bin/env node
/**
 * Export the strings that still need translating, as plain key→English JSON.
 *
 * Produces chunked files rather than one 3,000-entry blob: most translation
 * tools and chat windows have an input ceiling, and a chunk that comes back
 * mangled costs you 400 strings to redo instead of everything.
 *
 * The output is deliberately flat and boring — `{"ui.someKey": "Some text"}`.
 * Translate the VALUES, leave the KEYS exactly as they are, and hand the files
 * to i18n-import.cjs. It re-checks the keys and the {placeholders} before
 * writing anything into a locale.
 *
 *   node scripts/i18n-export.cjs                     # what every locale lacks
 *   node scripts/i18n-export.cjs --locale ko-KR      # just one locale's gaps
 *   node scripts/i18n-export.cjs --chunk 250         # smaller files
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'i18n', 'locales');
const OUT = path.join(__dirname, '..', 'i18n-export');

const argv = process.argv.slice(2);
const only = argv.includes('--locale') ? argv[argv.indexOf('--locale') + 1] : null;
const chunkSize = argv.includes('--chunk') ? Number(argv[argv.indexOf('--chunk') + 1]) : 400;

const flat = (o, p = '', out = {}) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
};

const PLURAL = /\.(zero|one|two|few|many|other)$/;
const categoriesFor = (locale) => {
  const rules = new Intl.PluralRules(locale);
  return new Set([0, 1, 2, 3, 5, 11, 21, 100, 1.5].map((n) => rules.select(n)));
};

const en = flat(JSON.parse(fs.readFileSync(path.join(DIR, 'en.json'), 'utf8')));

// Union of what is missing anywhere, so one translated set serves every
// language. Plural forms a given language cannot use are excluded per locale.
const missingAnywhere = new Set();
const perLocale = {};

for (const file of fs.readdirSync(DIR)) {
  if (!file.endsWith('.json') || file === 'en.json') continue;
  const short = file.replace('.json', '');
  if (only && short !== only && !only.startsWith(`${short}-`)) continue;

  const cats = categoriesFor(short);
  const target = flat(JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')));
  const missing = Object.keys(en).filter((k) => {
    if (target[k] !== undefined && target[k] !== en[k] && en[k].length > 2 && !/^[0-9\.\,\-\+\/]+$/.test(en[k])) return false;
    if (typeof en[k] !== 'string') return false;
    const m = k.match(PLURAL);
    return !m || cats.has(m[1]);
  });
  perLocale[short] = missing.length;
  for (const k of missing) missingAnywhere.add(k);
}

const keys = [...missingAnywhere].sort();
if (!keys.length) {
  console.log('\n  Nothing to export — every locale is complete.\n');
  process.exit(0);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const chunks = [];
for (let i = 0; i < keys.length; i += chunkSize) chunks.push(keys.slice(i, i + chunkSize));

const pad = String(chunks.length).length;
chunks.forEach((chunkKeys, i) => {
  const obj = {};
  for (const k of chunkKeys) obj[k] = en[k];
  const name = `part-${String(i + 1).padStart(pad, '0')}-of-${chunks.length}.json`;
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2) + '\n', 'utf8');
});

const readme = `# Strings to translate

${keys.length} strings, split into ${chunks.length} files of up to ${chunkSize}.

## How to use

For EACH target language, translate every file in this folder and save the
result somewhere per-language, e.g.:

    i18n-export/done/ko-KR/part-1-of-${chunks.length}.json

Rules that matter:

  * Translate the VALUES only. Never change, translate or reorder the KEYS.
  * Keep {placeholders} exactly as they appear — {count}, {name}. They are
    substituted at runtime; changing one shows the user a literal "{count}".
  * These are UI labels. Keep them about as short as the English, sentence
    case, and use the terminology an accountant or warehouse manager in that
    language actually uses at work. "Credit" is the right-hand side of a
    journal entry, "Post" means commit to the ledger, "Draft" is a document
    state.

## Loading them back

    node scripts/i18n-import.cjs ko-KR i18n-export/done/ko-KR

The importer re-checks every key and placeholder and refuses a file that does
not match, so a bad paste cannot quietly corrupt a catalogue. It only fills
blanks — anything already translated is left alone.

## Languages still needing these

${Object.entries(perLocale).map(([l, n]) => `  ${l.padEnd(4)} ${n} missing`).join('\n')}
`;
fs.writeFileSync(path.join(OUT, 'README.md'), readme, 'utf8');

console.log(`\n  Exported ${keys.length} strings into ${chunks.length} files.`);
console.log(`  Folder: frontend/i18n-export/`);
console.log(`  Read frontend/i18n-export/README.md for the rules and the import command.\n`);
