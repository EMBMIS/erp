/**
 * One-shot codemod: renames a callback parameter named `t` that shadows the
 * i18n translator, leaving the translator calls inside it alone.
 *
 * The string-extraction pass rewrote literals into `t('ui.x')` inside
 * `.map((t) => …)` callbacks whose parameter was already named `t`. Every one
 * of those calls invokes the mapped element as a function and throws at
 * runtime. Renaming the parameter fixes both halves at once: element accesses
 * follow the new name, and the bare `t(...)` calls fall through to the outer
 * `const { t } = useI18n()` binding, which is what they always meant.
 *
 * Works on byte offsets from the AST rather than regenerating the file, so
 * formatting, comments and JSX are untouched.
 *
 * Usage: node scripts/i18n-rename-shadowed-param.cjs <file> <line> <newName>
 *   <line> is the line holding the `(t) =>` parameter.
 */
const fs = require('fs')
const parser = require('@babel/parser')

const [file, lineArg, newName] = process.argv.slice(2)
if (!file || !lineArg || !newName) {
  console.error('usage: i18n-rename-shadowed-param.cjs <file> <line> <newName>')
  process.exit(2)
}
const targetLine = Number(lineArg)

const code = fs.readFileSync(file, 'utf8')
const ast = parser.parse(code, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true })

// Locate the function whose own parameter list binds `t` on the target line.
let target = null
;(function find(node) {
  if (!node || typeof node.type !== 'string' || target) return
  if (
    /Function(Declaration|Expression)|ArrowFunctionExpression/.test(node.type) &&
    node.loc.start.line === targetLine &&
    node.params.some((p) => p.type === 'Identifier' && p.name === 't')
  ) {
    target = node
    return
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue
    const c = node[k]
    if (Array.isArray(c)) c.forEach(find)
    else if (c && typeof c.type === 'string') find(c)
  }
})(ast.program)

if (!target) {
  console.error(`no function with a bare \`t\` parameter starting at line ${targetLine} of ${file}`)
  process.exit(1)
}

// Collect every `t` identifier belonging to this binding, skipping any that is
// the callee of a call (those are translator calls that should resolve outward)
// and any shadowed by a nested function that rebinds `t`.
const edits = []
const param = target.params.find((p) => p.type === 'Identifier' && p.name === 't')
edits.push({ start: param.start, end: param.end })

;(function walk(node, parent, depth) {
  if (!node || typeof node.type !== 'string') return
  if (
    node !== target &&
    /Function(Declaration|Expression)|ArrowFunctionExpression/.test(node.type) &&
    node.params.some((p) => p.type === 'Identifier' && p.name === 't')
  ) {
    return // inner function rebinds t; its body is not ours
  }
  if (node.type === 'Identifier' && node.name === 't' && node !== param) {
    const isCallee = parent && parent.type === 'CallExpression' && parent.callee === node
    const isMemberProp = parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed
    const isObjectKey = parent && parent.type === 'ObjectProperty' && parent.key === node && !parent.computed
    if (!isCallee && !isMemberProp && !isObjectKey) edits.push({ start: node.start, end: node.end })
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue
    const c = node[k]
    if (Array.isArray(c)) c.forEach((x) => walk(x, node, depth + 1))
    else if (c && typeof c.type === 'string') walk(c, node, depth + 1)
  }
})(target.body, target, 0)

edits.sort((a, b) => b.start - a.start)
let out = code
for (const e of edits) out = out.slice(0, e.start) + newName + out.slice(e.end)

fs.writeFileSync(file, out)
console.log(`${file}: renamed ${edits.length} reference(s) of \`t\` to \`${newName}\` at line ${targetLine}`)
