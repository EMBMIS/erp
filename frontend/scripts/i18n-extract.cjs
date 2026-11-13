#!/usr/bin/env node
/**
 * Externalise every hardcoded user-facing string in the app.
 *
 * Walks the JSX with Babel (not regex — a regex that rewrites 190 source files
 * is how you find out at runtime that it ate a closing brace), collects every
 * literal a user can read, assigns each a stable key, and rewrites the source
 * to call t().
 *
 * ===========================================================================
 * WHAT IT TOUCHES
 * ===========================================================================
 *
 *   JSXText                      >Purchase orders<        -> {t('ui.purchaseOrders')}
 *   placeholder / title /        placeholder="Search…"    -> placeholder={t('ui.search')}
 *   aria-label / alt
 *
 * Strings are deduplicated GLOBALLY: "Status" appears 36 times across the app
 * and becomes one key, translated once. That is the whole reason this is worth
 * doing as one pass rather than page by page.
 *
 * ===========================================================================
 * WHAT IT REFUSES TO TOUCH, AND WHY
 * ===========================================================================
 *
 *   • JSX outside any component function. t() comes from a hook; there is no
 *     hook to call at module scope. Those are reported, not mangled.
 *   • Anything that is not a plain literal — template strings, concatenations,
 *     expressions. Interpolation needs a decision about placeholder naming
 *     that a codemod should not make silently.
 *   • Identifiers dressed as prose: camelCase, SCREAMING_CASE enums, URLs,
 *     CSS-ish tokens, anything with no letters.
 *
 * Whitespace around a replaced text node is preserved as its own text node, so
 * `Hello <b>world</b>` does not lose the space before the bold.
 *
 *   node scripts/i18n-extract.cjs                 # report, write nothing
 *   node scripts/i18n-extract.cjs --apply         # rewrite sources + en.json
 *   node scripts/i18n-extract.cjs --apply --limit 20
 */

// Babel parses; it does NOT regenerate. Running @babel/generator over these
// files produces a correct transform and an unreviewable diff — it collapses
// blank lines, reflows every JSX block and reformats untouched code, so a
// 17-string change shows up as a rewritten file. Instead the AST is used only
// to find exact character ranges, and those ranges are spliced into the
// original source right-to-left. Everything the codemod did not touch comes
// out byte-identical.
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverseMod = require('@babel/traverse');

const traverse = traverseMod.default || traverseMod;

const SRC = path.join(__dirname, '..', 'src');
const EN = path.join(SRC, 'i18n', 'locales', 'en.json');
const ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt']);

const SKIP_DIRS = [`${path.sep}i18n${path.sep}`];
const SKIP_FILES = ['I18nContext.jsx'];

function isTranslatable(raw) {
  const s = String(raw).trim();
  if (s.length < 2) return false;
  if (!/[A-Za-z]/.test(s)) return false;              // no letters at all
  if (/^https?:\/\//.test(s)) return false;           // URLs
  if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(s)) return false; // camelCaseIdentifier
  if (/^[A-Z0-9_]+$/.test(s) && (s.includes('_') || s.length > 4)) return false; // ENUM_VALUE
  if (/^[a-z0-9-]+$/.test(s) && s.includes('-')) return false; // css-token
  if (!/[A-Za-z]{2}/.test(s)) return false;
  return true;
}

const usedKeys = new Set();
function makeKey(text) {
  const words = text
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 6);
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

/**
 * The nearest enclosing thing that is a React component: a function whose name
 * starts with a capital, or the default export. Returns null for JSX that
 * lives at module scope or inside a plain helper — those cannot call a hook.
 */
function componentBodyFor(nodePath) {
  let best = null;
  let p = nodePath;
  while (p) {
    if (p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression()) {
      let name = p.node.id?.name;
      if (!name && p.parentPath?.isVariableDeclarator()) name = p.parentPath.node.id?.name;
      if (name && /^[A-Z]/.test(name)) best = p;           // outermost wins
      else if (!name && p.parentPath?.isExportDefaultDeclaration()) best = p;
    }
    p = p.parentPath;
  }
  return best;
}

/** The leading whitespace of the line containing `offset`. */
function lineIndent(code, offset) {
  const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
  return code.slice(lineStart, offset);
}


/**
 * Whether a component already receives t as a prop (({ t, onClose }) => ...).
 * In that case t is already in scope and declaring it again is a
 * redeclaration that would not even compile - so no hook, no import.
 */
function paramProvidesT(componentPath) {
  const params = componentPath.node.params || [];
  return params.some((p) => {
    if (p.type === 'ObjectPattern') {
      return p.properties.some((prop) =>
        prop.type === 'ObjectProperty' && prop.value?.type === 'Identifier' && prop.value.name === 't'
      );
    }
    return p.type === 'Identifier' && p.name === 't';
  });
}

/**
 * Arrange for a component to have `const { t } = useI18n()`.
 *
 * Records a character-range edit rather than mutating the AST, so the rest of
 * the file stays byte-identical. Skips components that already call useI18n —
 * a partially migrated file must not end up with two hooks.
 */
function ensureHook(componentPath, state, code, edits) {
  if (state.hooked.has(componentPath.node)) return;
  state.hooked.add(componentPath.node);

  if (paramProvidesT(componentPath)) return;

  let body = componentPath.get('body');

  if (!body.isBlockStatement()) {
    // `const C = () => <div/>` — an expression body has no room for a hook.
    // Wrap it in a block, keeping the original expression as the return value.
    const expr = body.node;
    const start = expr.extra?.parenStart ?? expr.start;
    const indent = lineIndent(code, start);
    const inner = code.slice(expr.start, expr.end);
    edits.push({
      start,
      end: expr.end,
      text: `{\n${indent}  const { t } = useI18n()\n${indent}  return (\n${inner}\n${indent}  )\n${indent}}`,
    });
    state.needsImport = true;
    return;
  }

  // A component that already calls useI18n must not get a second hook.
  if (/\buseI18n\s*\(/.test(code.slice(body.node.start, body.node.end))) return;

  const first = body.node.body[0];
  if (first) {
    const indent = lineIndent(code, first.start);
    edits.push({ start: first.start, end: first.start, text: `const { t } = useI18n()\n${indent}` });
  } else {
    const indent = lineIndent(code, body.node.start);
    edits.push({ start: body.node.start + 1, end: body.node.start + 1, text: `\n${indent}  const { t } = useI18n()` });
  }
  state.needsImport = true;
}

/**
 * Arrange for `useI18n` to be imported from the i18n context.
 *
 * Inserted right after the leading import block (or at the very top of a file
 * with no imports), not after the last import anywhere in the file — a
 * mid-file import is legal ESM but reads as a mistake.
 */
function ensureImport(ast, file, edits) {
  const already = ast.program.body.some(
    (n) => n.type === 'ImportDeclaration' && n.specifiers.some((s) => s.local?.name === 'useI18n')
  );
  if (already) return;
  const rel = path
    .relative(path.dirname(file), path.join(SRC, 'contexts', 'I18nContext'))
    .split(path.sep)
    .join('/');
  const spec = rel.startsWith('.') ? rel : `./${rel}`;
  let at = 0;
  for (const n of ast.program.body) {
    if (n.type !== 'ImportDeclaration') break;
    at = n.end;
  }
  // Insert BEFORE the newline that ends the last import, so the two import
  // lines do not end up glued together. A file with no imports gets the line
  // at the very top.
  edits.push({ start: at, end: at, text: at === 0 ? `import { useI18n } from '${spec}'\n` : `\nimport { useI18n } from '${spec}'` });
}

const catalogue = new Map();   // English text -> key
const perFile = [];
const skipped = [];

const apply = process.argv.includes('--apply');
const limitFlag = process.argv.indexOf('--limit');
const limit = limitFlag !== -1 ? Number(process.argv[limitFlag + 1]) : Infinity;

const files = walk(SRC).filter(
  (f) => !SKIP_DIRS.some((d) => f.includes(d)) && !SKIP_FILES.includes(path.basename(f))
);

let processed = 0;
for (const file of files) {
  if (processed >= limit) break;
  const code = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parser.parse(code, { sourceType: 'module', plugins: ['jsx'] });
  } catch (e) {
    skipped.push(`${path.relative(SRC, file)}: parse error — ${e.message.split('\n')[0]}`);
    continue;
  }

  const state = { hooked: new Set(), needsImport: false, wraps: [] };
  const replacements = [];

  traverse(ast, {
    JSXText(p) {
      const raw = p.node.value;
      const text = raw.trim();
      if (!isTranslatable(text)) return;
      const comp = componentBodyFor(p);
      if (!comp) { skipped.push(`${path.relative(SRC, file)}: "${text.slice(0, 40)}" is outside a component`); return; }
      replacements.push({ kind: 'text', p, text, raw, comp });
    },
    JSXAttribute(p) {
      const name = p.node.name?.name;
      if (!ATTRS.has(name)) return;
      const v = p.node.value;
      if (!v || v.type !== 'StringLiteral') return;
      const text = v.value.trim();
      if (!isTranslatable(text)) return;
      const comp = componentBodyFor(p);
      if (!comp) { skipped.push(`${path.relative(SRC, file)}: ${name}="${text.slice(0, 30)}" outside a component`); return; }
      replacements.push({ kind: 'attr', p, text, comp });
    },
  });

  if (!replacements.length) continue;
  processed += 1;

  for (const r of replacements) {
    if (!catalogue.has(r.text)) catalogue.set(r.text, makeKey(r.text));
  }
  perFile.push({ file, count: replacements.length });

  if (!apply) continue;

  // ---------------------------------------------------------------------
  // Build character-range edits, then splice them into the ORIGINAL source
  // right-to-left. Everything the codemod did not touch stays byte-identical.
  // ---------------------------------------------------------------------

  const edits = [];            // file-level edits (outside any wrapped body)
  const wraps = [];            // components with expression bodies
  const wrapOf = new Map();    // component node -> wrap descriptor

  for (const r of replacements) {
    const key = catalogue.get(r.text);
    const tcall = `{t('ui.${key}')}`;
    const edit = r.kind === 'attr'
      ? { start: r.p.node.value.start, end: r.p.node.value.end, text: tcall }
      : (() => {
          const lead = r.raw.slice(0, r.raw.indexOf(r.text));
          const trail = r.raw.slice(r.raw.indexOf(r.text) + r.text.length);
          return {
            start: r.p.node.start + lead.length,
            end: r.p.node.end - trail.length,
            text: tcall,
          };
        })();

    if (paramProvidesT(r.comp)) {
      // t arrives as a prop - the replacement works with no hook and no wrap.
      edits.push(edit);
    } else if (r.comp.get('body').isBlockStatement()) {
      ensureHook(r.comp, state, code, edits);
      edits.push(edit);
    } else {
      // Expression body (`const C = () => <div/>`): the hook lives inside the
      // block we wrap the whole body in, and inner replacements are merged
      // into that block's text rather than spliced into the file separately.
      if (!state.hooked.has(r.comp.node)) {
        state.hooked.add(r.comp.node);
        state.needsImport = true;
      }
      let w = wrapOf.get(r.comp.node);
      if (!w) {
        const expr = r.comp.get('body').node;
        w = { expr, start: expr.extra?.parenStart ?? expr.start, end: expr.end, events: [] };
        wrapOf.set(r.comp.node, w);
        wraps.push(w);
      }
      w.events.push(edit);
    }
  }

  if (state.needsImport) ensureImport(ast, file, edits);

  // Assign each event to the innermost wrap that contains it, so nested
  // expression bodies keep their own translations instead of being clobbered
  // by the outer wrap's text.
  for (const w of wraps) {
    w.events = w.events.filter((e) => {
      const inner = wraps.find((o) => o !== w && o.start <= e.start && e.end <= o.end);
      if (inner) { inner.events.push(e); return false; }
      return true;
    });
  }

  // A wrap's replacement text is built from the ORIGINAL body slice plus its
  // own events (with offsets relativised to the body start).
  const wrapText = (w) => {
    const rel = w.events
      .map((e) => ({ start: e.start - w.expr.start, end: e.end - w.expr.start, text: e.text }))
      .sort((a, b) => b.start - a.start);
    let inner = code.slice(w.expr.start, w.expr.end);
    for (const e of rel) inner = inner.slice(0, e.start) + e.text + inner.slice(e.end);
    const indent = lineIndent(code, w.start);
    return `{\n${indent}  const { t } = useI18n()\n${indent}  return (\n${inner}\n${indent}  )\n${indent}}`;
  };

  const all = [...edits, ...wraps.map((w) => ({ start: w.start, end: w.end, text: wrapText(w) }))]
    .sort((a, b) => b.start - a.start);

  let out = code;
  for (const e of all) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  fs.writeFileSync(file, out, 'utf8');
}

console.log(`\n  Files with translatable strings : ${perFile.length}`);
console.log(`  Unique strings                  : ${catalogue.size}`);
console.log(`  Total occurrences               : ${perFile.reduce((n, f) => n + f.count, 0)}`);
if (skipped.length) console.log(`  Skipped (not hook-reachable)    : ${skipped.length}`);

if (apply) {
  const en = JSON.parse(fs.readFileSync(EN, 'utf8'));
  en.ui = en.ui || {};
  for (const [text, key] of catalogue) if (en.ui[key] === undefined) en.ui[key] = text;
  fs.writeFileSync(EN, JSON.stringify(en, null, 2) + '\n', 'utf8');
  console.log(`\n  Wrote ${catalogue.size} keys into en.json under "ui".`);
  console.log(`  Now run: node scripts/i18n-translate.cjs\n`);
} else {
  console.log(`\n  Dry run — nothing written. Re-run with --apply.\n`);
  if (skipped.length) {
    console.log('  Not hook-reachable (will stay English):');
    for (const s of skipped.slice(0, 10)) console.log(`    ${s}`);
    if (skipped.length > 10) console.log(`    … and ${skipped.length - 10} more`);
  }
}
