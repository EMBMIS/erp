#!/usr/bin/env node
/**
 * Report which ui.* keys of the English catalogue are still missing from a
 * locale file. Used by the per-locale translation workers as their acceptance
 * gate, and by CI/humans to check the translation debt of one language.
 *
 * Usage: node scripts/i18n-verify-locale.cjs <lang>
 * Exit code 0 when the locale covers every ui.* key.
 */
const fs = require('fs');
const path = require('path');

const lang = process.argv[2];
if (!lang) { console.error('usage: node scripts/i18n-verify-locale.cjs <lang>'); process.exit(2); }

const LOCALES_DIR = path.join(__dirname, '..', 'src', 'i18n', 'locales');

function flat(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
}

const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
const localeFile = path.join(LOCALES_DIR, `${lang}.json`);
if (!fs.existsSync(localeFile)) { console.error(`${lang}.json missing`); process.exit(2); }
const locale = JSON.parse(fs.readFileSync(localeFile, 'utf8'));

const enUi = flat(en.ui || {});
const loc = flat(locale);
const missing = Object.keys(enUi).filter((k) => loc[k] === undefined);

if (missing.length) {
  console.log(`${lang}: ${missing.length} missing ui.* keys`);
  console.log('  ' + missing.slice(0, 5).join(', ') + (missing.length > 5 ? ', …' : ''));
  process.exit(1);
}
console.log(`${lang}: 0 missing ui.* keys`);
process.exit(0);
