#!/usr/bin/env node
/**
 * Repair components that call t() without having the hook in scope.
 *
 * The extraction codemod does two things per file: rewrite strings to
 * `t('ui.x')`, and add `import { useI18n }` plus `const { t } = useI18n()` to
 * the component. A partial rollback can undo the second while keeping the
 * first, and the result is not a translation bug — it is a hard crash:
 *
 *     Uncaught ReferenceError: t is not defined
 *
 * React unmounts the whole tree, so one such file takes the entire app down.
 * This finds them and puts the import and the hook declaration back.
 *
 *   node scripts/i18n-fix-hooks.cjs             # report
 *   node scripts/i18n-fix-hooks.cjs --apply     # repair
 */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverseMod = require('@babel/traverse');

const traverse = traverseMod.default || traverseMod;
const SRC = path.join(__dirname, '..', 'src');
const apply = process.argv.includes('--apply');

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.jsx$/.test(e.name)) out.push(p);
  }
  return out;
};

const broken = [];

for (const file of walk(SRC)) {
  if (file.includes(`${path.sep}i18n${path.sep}`)) continue;
  const code = fs.readFileSync(file, 'utf8');
  if (!/\bt\(\s*['"`]/.test(code)) continue;

  let ast;
  try {
    ast = parser.parse(code, { sourceType: 'module', plugins: ['jsx'] });
  } catch {
    continue;
  }

  // Which functions actually call t(...), and which of those declare it?
  //
  // "Declares" means EITHER `const { t } = useI18n()` OR taking `t` as a
  // parameter — several components here receive it as a prop from their
  // parent (`function ContactForm({ t, onClose })`). Missing the parameter
  // case makes this script inject a hook that collides with the prop, and
  // `The symbol "t" has already been declared` is a build failure, not a
  // warning. Treat a parameter as authoritative: it is the caller's contract,
  // and such a component may be rendered outside a provider.
  const callers = new Set();
  const declares = new Set();

  const paramDeclaresT = (fnNode) =>
    (fnNode.params || []).some((p) => {
      if (p.type === 'Identifier') return p.name === 't';
      if (p.type === 'ObjectPattern') {
        return p.properties.some(
          (prop) => prop.type === 'ObjectProperty' && prop.value?.type === 'Identifier' && prop.value.name === 't'
        );
      }
      return false;
    });

  traverse(ast, {
    CallExpression(p) {
      if (p.node.callee.type !== 'Identifier' || p.node.callee.name !== 't') return;
      const fn = p.getFunctionParent();
      if (fn) callers.add(fn.node);
    },
    VariableDeclarator(p) {
      // const { t } = useI18n()
      const init = p.node.init;
      if (!init || init.type !== 'CallExpression') return;
      if (init.callee.type !== 'Identifier' || init.callee.name !== 'useI18n') return;
      const fn = p.getFunctionParent();
      if (fn) declares.add(fn.node);
    },
    Function(p) {
      if (paramDeclaresT(p.node)) declares.add(p.node);

      // A class method can never call a hook. Components written as classes
      // take `t` from `this.props`, supplied by a function wrapper that does
      // call useI18n(). Proposing a hook here produces code React rejects at
      // runtime, so these are declared satisfied and left alone.
      const inClass = p.findParent((x) => x.isClassDeclaration() || x.isClassExpression());
      if (inClass) declares.add(p.node);
    },
  });

  if (!callers.size) continue;

  // A caller is fine if it, or any function enclosing it, declares t.
  const enclosing = new Map();
  traverse(ast, {
    Function(p) { enclosing.set(p.node, p); },
  });

  const unresolved = [...callers].filter((node) => {
    let p = enclosing.get(node);
    while (p) {
      if (declares.has(p.node)) return false;
      p = p.getFunctionParent();
    }
    return true;
  });

  if (!unresolved.length) continue;

  broken.push({ file, ast, code, unresolved, enclosing });
}

console.log(`\n  Files calling t() with no hook in scope: ${broken.length}`);
for (const b of broken.slice(0, 20)) console.log(`    ${path.relative(SRC, b.file)}`);
if (broken.length > 20) console.log(`    … and ${broken.length - 20} more`);

if (!apply) {
  console.log(`\n  Dry run — nothing written. Re-run with --apply.\n`);
  process.exit(broken.length ? 1 : 0);
}

let fixed = 0;
for (const { file, ast, code, unresolved, enclosing } of broken) {
  // Insert the hook at the top of the OUTERMOST component enclosing each
  // unresolved call — a hook inside a map callback or event handler is a
  // violation of the rules of hooks, not a fix.
  const targets = new Set();
  for (const node of unresolved) {
    let p = enclosing.get(node);
    let best = p;
    while (p) {
      let name = p.node.id?.name;
      if (!name && p.parentPath?.isVariableDeclarator()) name = p.parentPath.node.id?.name;
      if (name && /^[A-Z]/.test(name)) best = p;
      p = p.getFunctionParent();
    }
    if (best && best.get('body').isBlockStatement()) targets.add(best.node.body);
  }
  if (!targets.size) continue;

  const edits = [];
  for (const body of targets) edits.push({ pos: body.start + 1, text: '\n  const { t } = useI18n();' });

  const hasImport = /import\s*\{[^}]*\buseI18n\b[^}]*\}\s*from/.test(code);
  if (!hasImport) {
    const rel = path.relative(path.dirname(file), path.join(SRC, 'contexts', 'I18nContext')).split(path.sep).join('/');
    const spec = rel.startsWith('.') ? rel : `./${rel}`;
    const lastImport = ast.program.body.filter((n) => n.type === 'ImportDeclaration').pop();
    const pos = lastImport ? lastImport.end : 0;
    edits.push({ pos, text: `\nimport { useI18n } from '${spec}';` });
  }

  let out = code;
  for (const e of edits.sort((a, b) => b.pos - a.pos)) {
    out = out.slice(0, e.pos) + e.text + out.slice(e.pos);
  }
  fs.writeFileSync(file, out, 'utf8');
  fixed += 1;
}

console.log(`\n  Repaired ${fixed} file(s).\n`);
