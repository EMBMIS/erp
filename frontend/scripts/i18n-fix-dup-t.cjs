#!/usr/bin/env node
/**
 * Remove `const { t } = useI18n()` where `t` is already a function parameter.
 *
 * Some components take `t` as a prop rather than calling the hook —
 * `function ContactForm({ t, onClose })`. Adding the hook inside one declares
 * the same binding twice in a scope, which is a build failure:
 *
 *     ERROR: The symbol "t" has already been declared
 *
 * The parameter wins: it is the existing contract with the caller, and such a
 * component may be rendered outside a provider.
 *
 * DELIBERATELY LINE-BASED, NOT AST-BASED
 * ======================================
 * A duplicate binding is a hard error in @babel/parser, and @babel/traverse
 * throws again during scope registration even with errorRecovery. Both refuse
 * to look at precisely the files this repairs. The pattern is narrow enough to
 * match on text: a function signature that destructures `t`, immediately
 * followed by the injected hook line.
 */

const fs = require('fs');
const path = require('path');

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

// A signature destructuring `t` out of props: `({ t, onClose })`, `({ t })`,
// `({ onClose, t })`. Requires the brace so `({ total })` cannot match.
const SIG_TAKES_T = /\(\s*\{[^}]*\bt\b\s*[,}]/;
const HOOK_LINE = /^\s*const\s*\{\s*t\s*\}\s*=\s*useI18n\(\)\s*;?\s*$/;

let filesChanged = 0;
let removed = 0;

for (const file of walk(SRC)) {
  const code = fs.readFileSync(file, 'utf8');
  if (!code.includes('useI18n()')) continue;

  const lines = code.split('\n');
  const drop = new Set();

  for (let i = 1; i < lines.length; i += 1) {
    if (!HOOK_LINE.test(lines[i])) continue;
    // Look back over the signature, which may wrap across a couple of lines.
    const window = lines.slice(Math.max(0, i - 3), i).join(' ');
    if (!/\b(function|=>|\()/.test(window)) continue;
    if (SIG_TAKES_T.test(window)) drop.add(i);
  }

  if (!drop.size) continue;
  filesChanged += 1;
  removed += drop.size;
  console.log(`  ${path.relative(SRC, file)}  (${drop.size})`);

  if (!apply) continue;
  fs.writeFileSync(file, lines.filter((_, i) => !drop.has(i)).join('\n'), 'utf8');
}

console.log(`\n  ${removed} redundant hook(s) in ${filesChanged} file(s).`);
console.log(apply ? '  Removed.\n' : '  Dry run — nothing written. Re-run with --apply.\n');
