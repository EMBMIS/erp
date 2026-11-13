#!/usr/bin/env node
/**
 * Report how much of the UI is actually translatable.
 *
 * Translation is not a thing you finish in one pass — it is a per-screen debt
 * that has to be paid down and then *kept* paid as new screens land. This makes
 * the balance visible: which files still hold hardcoded English, ranked by how
 * much, so the next person knows where to start and CI can stop the number
 * going up.
 *
 * The detector is deliberately crude — JSX text nodes, placeholders, titles and
 * aria-labels that start with a capital letter and are not obviously an
 * identifier. It over-reports slightly (a proper noun is not a translation bug)
 * and under-reports strings built by concatenation. It is a ranking tool, not
 * an oracle: treat the trend as the signal, not the absolute number.
 *
 *   node scripts/i18n-coverage.js            # summary + worst 25 files
 *   node scripts/i18n-coverage.js --all      # every file with debt
 *   node scripts/i18n-coverage.js --max 900  # fail if total exceeds a budget
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

const PATTERNS = [
  />\s*([A-Z][A-Za-z][A-Za-z ,'’&/()-]{2,60})\s*</g,
  /placeholder="([^"]{3,60})"/g,
  /aria-label="([^"]{3,60})"/g,
  /title="([^"]{3,60})"/g,
];

// Things that look like prose but are not: CSS-ish tokens, single caps, code.
const IGNORE = /^(Simeli ERP|[A-Z]{2,6}|[A-Z][a-z]{0,2}|https?:.*|\d)$/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.jsx?$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

// Plural categories a language actually uses. English has one/other, but
// Japanese has only `other` and Russian needs few/many — so "this locale is
// missing the key en.json has" is the wrong test for a plural form. Exported
// for the sibling translate script's benefit and used by --keys below.
const pluralCategoriesFor = (locale) => {
  const rules = new Intl.PluralRules(locale);
  return new Set([0, 1, 2, 3, 5, 11, 21, 100, 1.5].map((n) => rules.select(n)));
};

// --keys reports catalogue completeness instead of JSX debt: which locales are
// missing which translation keys, with plural forms judged against the target
// language's own CLDR categories rather than English's.
if (process.argv.includes('--keys')) {
  const dir = path.join(SRC, 'i18n', 'locales');
  const flat = (o, p = '', out = {}) => {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? `${p}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
      else out[key] = v;
    }
    return out;
  };
  const CATEGORY = /\.(zero|one|two|few|many|other)$/;
  const en = flat(JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8')));
  let incomplete = 0;

  for (const f of fs.readdirSync(dir).filter((x) => x !== 'en.json')) {
    const short = f.replace('.json', '');
    const cats = pluralCategoriesFor(short);
    const t = flat(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    const missing = Object.keys(en).filter((k) => {
      if (t[k] !== undefined) return false;
      const m = k.match(CATEGORY);
      return !m || cats.has(m[1]);
    });
    if (missing.length) {
      incomplete += 1;
      console.log(`  ${short.padEnd(4)} ${String(missing.length).padStart(4)} missing  ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`);
    }
  }
  console.log(incomplete
    ? `\n  ${incomplete} locale(s) incomplete\n`
    : `\n  All locales cover every key (plural forms judged per language)\n`);
  process.exit(0);
}

const rows = [];
let total = 0;

for (const file of walk(SRC)) {
  const src = fs.readFileSync(file, 'utf8');
  if (file.includes(`${path.sep}i18n${path.sep}`)) continue;

  const found = new Set();
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const s = m[1].trim();
      if (!IGNORE.test(s) && /[a-z]/.test(s)) found.add(s);
    }
  }
  if (!found.size) continue;

  rows.push({
    file: path.relative(path.join(__dirname, '..'), file),
    count: found.size,
    translated: /useI18n/.test(src),
  });
  total += found.size;
}

rows.sort((a, b) => b.count - a.count);

const wired = rows.filter((r) => r.translated).length;
const all = rows.length;

const showAll = process.argv.includes('--all');
const shown = showAll ? rows : rows.slice(0, 25);

console.log('\nHardcoded user-facing strings by file\n');
for (const r of shown) {
  console.log(`  ${String(r.count).padStart(4)}  ${r.translated ? '~' : ' '} ${r.file}`);
}
if (!showAll && rows.length > shown.length) {
  console.log(`  … and ${rows.length - shown.length} more (--all to list)`);
}

console.log(`\n  ~ = file already calls useI18n (partially migrated)\n`);
console.log(`  Files with untranslated strings : ${all}`);
console.log(`  Of those, already wired to i18n : ${wired}`);
console.log(`  Total distinct strings remaining: ${total}\n`);

const maxFlag = process.argv.indexOf('--max');
if (maxFlag !== -1) {
  const budget = Number(process.argv[maxFlag + 1]);
  if (Number.isFinite(budget) && total > budget) {
    console.error(`i18n debt ${total} exceeds budget ${budget}. Migrate a screen before adding another.`);
    process.exit(1);
  }
}
