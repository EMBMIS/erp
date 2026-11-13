#!/usr/bin/env node
/**
 * Find EVERY user-facing English string still hardcoded in the frontend.
 *
 * WHY THE FIRST PASS MISSED SO MUCH
 * =================================
 *
 * The extraction codemod only looked at two things: JSX text nodes, and four
 * attributes (placeholder/title/aria-label/alt). That is a small fraction of
 * where user-visible text actually lives in this codebase. Everything below
 * was invisible to it, and is why translated pages still showed English:
 *
 *   toast.success('Purchase order approved')      call arguments
 *   throw new Error('Quantity must be positive')  error messages
 *   const COLUMNS = [{ label: 'Unit price' }]     data-driven table headers
 *   {saving ? 'Saving…' : 'Save'}                 ternaries in JSX
 *   <Modal confirmLabel="Delete permanently" />   other JSX attributes
 *   const STATUS = { DRAFT: 'Draft' }             label maps
 *   `Showing ${n} of ${total} results`            template literals
 *
 * This scans for all of them. It is deliberately generous — it would rather
 * show a false positive a human can dismiss than silently leave a string
 * untranslated, because the second failure is the one that has cost us three
 * rounds of "it is still in English".
 *
 * Strings already wrapped in t(...) are ignored: those are done.
 *
 *   node scripts/i18n-scan-all.cjs                 # summary by category
 *   node scripts/i18n-scan-all.cjs --list          # every string with source
 *   node scripts/i18n-scan-all.cjs --export        # write i18n-export/
 */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverseMod = require('@babel/traverse');

const traverse = traverseMod.default || traverseMod;

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, '..', 'i18n-export');

// Attributes whose value the user reads. `className`, `href`, `to`, `id`,
// `name`, `type`, `value`, `key` are deliberately absent — those are machine
// values and pulling them in would bury the real strings in Tailwind noise.
const TEXT_ATTRS = new Set([
  'placeholder', 'title', 'aria-label', 'alt', 'label', 'header', 'heading',
  'description', 'tooltip', 'emptyMessage', 'emptyText', 'confirmLabel',
  'submitLabel', 'cancelLabel', 'buttonText', 'message', 'subtitle', 'caption',
  'helperText', 'errorText', 'hint', 'legend', 'summary', 'prompt', 'text',
  'okText', 'noDataText', 'loadingText', 'ariaLabel',
]);

// Object properties that hold display text.
const TEXT_PROPS = new Set([
  'label', 'title', 'heading', 'description', 'message', 'text', 'placeholder',
  'tooltip', 'subtitle', 'caption', 'hint', 'summary', 'name', 'header',
  'emptyMessage', 'confirmLabel', 'error', 'helpText', 'legend',
]);

// Calls whose string arguments are shown to the user.
const TEXT_CALLS = new Set([
  'toast', 'toast.success', 'toast.error', 'toast.loading', 'toast.custom',
  'alert', 'confirm', 'prompt', 'Error', 'TypeError', 'RangeError',
  'window.alert', 'window.confirm',
]);

/**
 * Does this look like prose a person reads, rather than a machine value?
 *
 * The dominant false positive in this codebase is Tailwind: "flex items-center
 * gap-2 rounded-md" is lowercase, hyphen-and-colon heavy and never sentence
 * shaped. The rules below are tuned to reject that class of string while
 * keeping short real labels like "Save" and "Due date".
 */
function looksLikeProse(raw) {
  const s = String(raw).trim();
  if (s.length < 2 || s.length > 300) return false;
  if (!/[A-Za-z]{2}/.test(s)) return false;

  if (/^https?:\/\//.test(s)) return false;            // URLs
  if (/^[/#.]/.test(s)) return false;                   // paths, selectors
  if (/^[a-z0-9_-]+$/.test(s) && !/^[a-z]{3,}$/.test(s)) return false; // slug-ish
  if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(s)) return false; // camelCaseIdent
  if (/^[A-Z0-9_]{2,}$/.test(s)) return false;          // ENUM_VALUE
  if (/^\d[\d\s.,:/-]*$/.test(s)) return false;         // numbers, dates

  // Tailwind / CSS class soup: several space-separated lowercase tokens that
  // are themselves hyphenated or contain a variant colon.
  const words = s.split(/\s+/);
  if (words.length > 1) {
    const cssish = words.filter((w) => /^[a-z0-9]+([-:/][a-z0-9.[\]%]+)+$/.test(w)).length;
    if (cssish >= Math.max(2, words.length / 2)) return false;
  }
  if (/^[a-z-]+$/.test(s) && s.includes('-')) return false;

  // Must contain a word with a vowel — filters mime types, hashes, codes.
  if (!words.some((w) => /[aeiouAEIOU]/.test(w) && /^[A-Za-z]/.test(w))) return false;

  // A single all-lowercase word is an identifier, not a label. Real UI labels
  // are capitalised: "Customer", "Approved", "Save". This is what separates
  // the label "Draft" from the state value 'draft', and "Suppliers" the
  // heading from 'suppliers' the query key.
  if (words.length === 1 && /^[a-z]/.test(s)) return false;

  // Trailing/embedded underscores mean an identifier or an id prefix
  // ("lineItem_"), never prose.
  if (/_/.test(s) && !/\s/.test(s)) return false;

  // Protocol and wire tokens that read like words but are never shown.
  if (/^(Bearer|Basic|Content-Type|application|multipart|utf-8|POST|GET|PUT|PATCH|DELETE)$/i.test(s)) return false;

  return true;
}

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
};

const calleeName = (node) => {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') {
    return `${calleeName(node.object)}.${node.property?.name || ''}`;
  }
  return '';
};

const findings = new Map(); // text -> { kinds:Set, files:Set, count }
const record = (text, kind, file) => {
  const s = String(text).trim();
  if (!looksLikeProse(s)) return;
  if (!findings.has(s)) findings.set(s, { kinds: new Set(), files: new Set(), count: 0 });
  const f = findings.get(s);
  f.kinds.add(kind);
  f.files.add(path.relative(SRC, file));
  f.count += 1;
};

const parseErrors = [];

for (const file of walk(SRC)) {
  if (file.includes(`${path.sep}i18n${path.sep}`)) continue;
  const code = fs.readFileSync(file, 'utf8');

  let ast;
  try {
    ast = parser.parse(code, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true });
  } catch (e) {
    parseErrors.push(`${path.relative(SRC, file)}: ${e.message.split('\n')[0]}`);
    continue;
  }

  // Anything already inside a t(...) call is done; skip its subtree.
  const insideT = (p) => Boolean(p.findParent((x) =>
    x.isCallExpression() && x.node.callee.type === 'Identifier' && x.node.callee.name === 't'));

  try {
    traverse(ast, {
      JSXText(p) {
        record(p.node.value, 'jsx-text', file);
      },

      JSXAttribute(p) {
        const name = p.node.name?.name;
        if (!name || !TEXT_ATTRS.has(name)) return;
        const v = p.node.value;
        if (v?.type === 'StringLiteral') record(v.value, 'jsx-attr', file);
      },

      StringLiteral(p) {
        if (insideT(p)) return;
        const parent = p.parent;

        // Skip machine values and things already handled above.
        if (parent.type === 'ImportDeclaration' || parent.type === 'ExportNamedDeclaration') return;
        if (parent.type === 'JSXAttribute') return;   // handled by JSXAttribute
        if (parent.type === 'MemberExpression' && parent.computed) return;
        if (parent.type === 'TSLiteralType') return;

        // Object property: only those whose key reads like display text.
        if (parent.type === 'ObjectProperty' && parent.value === p.node) {
          const key = parent.key?.name || parent.key?.value;
          if (!TEXT_PROPS.has(key)) return;
          record(p.node.value, 'object-prop', file);
          return;
        }
        if (parent.type === 'ObjectProperty' && parent.key === p.node) return;

        // Call arguments — toast, alert, new Error(...)
        if (parent.type === 'CallExpression' || parent.type === 'NewExpression') {
          const name = calleeName(parent.callee);
          if (TEXT_CALLS.has(name) || TEXT_CALLS.has(name.split('.').pop())) {
            record(p.node.value, 'call-arg', file);
          }
          return;
        }

        // Ternary branches and JSX expression containers — {x ? 'Yes' : 'No'}
        if (parent.type === 'ConditionalExpression') { record(p.node.value, 'ternary', file); return; }
        if (parent.type === 'JSXExpressionContainer') { record(p.node.value, 'jsx-expr', file); return; }
        if (parent.type === 'LogicalExpression') { record(p.node.value, 'logical', file); return; }
        if (parent.type === 'ArrayExpression') { record(p.node.value, 'array', file); return; }
        if (parent.type === 'ReturnStatement') { record(p.node.value, 'return', file); return; }
        if (parent.type === 'AssignmentPattern') { record(p.node.value, 'default-arg', file); return; }
      },

      TemplateLiteral(p) {
        if (insideT(p)) return;
        // Only the literal chunks; ${expressions} are values, not text.
        for (const q of p.node.quasis) {
          const text = q.value.cooked ?? q.value.raw;
          if (text && text.trim().length > 2) record(text, 'template', file);
        }
      },
    });
  } catch (e) {
    parseErrors.push(`${path.relative(SRC, file)}: traverse — ${e.message.split('\n')[0]}`);
  }
}

const all = [...findings.entries()].sort((a, b) => b[1].count - a[1].count);

const byKind = {};
for (const [, f] of all) for (const k of f.kinds) byKind[k] = (byKind[k] || 0) + 1;

console.log(`\n  Distinct hardcoded user-facing strings : ${all.length}`);
console.log(`  Total occurrences                     : ${all.reduce((n, [, f]) => n + f.count, 0)}`);
if (parseErrors.length) console.log(`  Files that failed to parse            : ${parseErrors.length}`);
console.log('\n  By where they live:');
for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(14)} ${String(n).padStart(5)}`);
}

if (process.argv.includes('--list')) {
  console.log('\n  All strings:\n');
  for (const [text, f] of all) {
    console.log(`  ${String(f.count).padStart(3)}x [${[...f.kinds].join(',')}] ${JSON.stringify(text)}`);
    console.log(`       ${[...f.files].slice(0, 2).join(', ')}${f.files.size > 2 ? ` +${f.files.size - 2}` : ''}`);
  }
}

if (process.argv.includes('--export')) {
  const used = new Set();
  const keyFor = (text) => {
    const words = text.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 6);
    let base = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
    if (!base) base = 'text';
    if (/^\d/.test(base)) base = `t${base}`;
    let k = base;
    let n = 2;
    while (used.has(k)) k = `${base}${n++}`;
    used.add(k);
    return k;
  };

  const entries = {};
  for (const [text] of all) entries[`ui2.${keyFor(text)}`] = text;

  fs.mkdirSync(OUT, { recursive: true });
  const keys = Object.keys(entries);
  const size = 400;
  const chunks = [];
  for (let i = 0; i < keys.length; i += size) chunks.push(keys.slice(i, i + size));
  const pad = String(chunks.length).length;
  chunks.forEach((ks, i) => {
    const obj = {};
    for (const k of ks) obj[k] = entries[k];
    fs.writeFileSync(
      path.join(OUT, `remaining-${String(i + 1).padStart(pad, '0')}-of-${chunks.length}.json`),
      JSON.stringify(obj, null, 2) + '\n', 'utf8'
    );
  });
  console.log(`\n  Exported ${keys.length} strings into ${chunks.length} file(s) in i18n-export/.\n`);
}

console.log('');
if (parseErrors.length) {
  console.log('  Parse failures:');
  for (const e of parseErrors.slice(0, 10)) console.log(`    ${e}`);
  console.log('');
}
