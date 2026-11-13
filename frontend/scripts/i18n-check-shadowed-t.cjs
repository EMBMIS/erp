/**
 * Finds calls to the i18n `t()` translator that land in a scope where `t` is
 * actually something else — a `.map((t) => …)` element, a callback parameter,
 * a local binding.
 *
 * Why this needs its own tool: ESLint's no-undef cannot see these. `t` IS
 * defined at the call site, just bound to the wrong thing, so the file lints
 * clean and then throws "t is not a function" the moment the branch renders.
 * The string-extraction codemod produced them wherever it rewrote a literal
 * inside a callback whose parameter happened to be named `t`.
 *
 * A hit is reported when a CallExpression `t(...)` resolves to a binding that
 * is a function parameter or a variable declarator, rather than to the
 * `const { t } = useI18n()` destructure.
 *
 * Usage: node scripts/i18n-check-shadowed-t.cjs [--json]
 * Exits 1 if any shadowed call is found, so CI can gate on it.
 */
const fs = require('fs')
const path = require('path')
const parser = require('@babel/parser')

const SRC = path.join(__dirname, '..', 'src')

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.jsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Walks the AST maintaining a stack of scopes. Each scope records how `t` got
 * bound in it, so a `t()` call can be attributed to the nearest binding.
 */
function findShadowedCalls(ast, code) {
  const hits = []
  // Each frame: { kind: 'i18n' | 'param' | 'local', loc }
  const stack = []

  const currentBinding = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].t) return stack[i].t
    return null
  }

  // Destructures that yield the real translator:
  //   const { t } = useI18n()   — the hook
  //   const { t } = this.props  — a class component fed by a hook wrapper,
  //                               which is the only way a class can get one
  const destructureKind = (node) => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'ObjectPattern') return null
    const bindsT = node.id.properties.some((p) => {
      if (p.type === 'RestElement') return false
      const bound = p.value && p.value.type === 'AssignmentPattern' ? p.value.left : p.value
      return bound && bound.type === 'Identifier' && bound.name === 't'
    })
    if (!bindsT || !node.init) return null
    const init = node.init
    if (init.type === 'CallExpression' && init.callee.name === 'useI18n') return 'i18n'
    const isProps =
      (init.type === 'MemberExpression' &&
        init.object.type === 'ThisExpression' &&
        init.property.name === 'props') ||
      (init.type === 'Identifier' && init.name === 'props')
    return isProps ? 'prop' : null
  }

  // How a function parameter list binds `t`, if at all:
  //   'prop'  — destructured from a props object, `function Foo({ t, money })`.
  //             Legitimate: this is how t is threaded to child components.
  //   'param' — a bare positional parameter, `.map((t) => …)`. Broken: t is
  //             whatever the callback was handed, not the translator.
  const paramBindsT = (params) => {
    for (const p of params) {
      const node = p.type === 'AssignmentPattern' ? p.left : p
      if (node.type === 'Identifier' && node.name === 't') return 'param'
      if (node.type === 'ObjectPattern') {
        for (const prop of node.properties) {
          if (prop.type === 'RestElement') continue
          const bound = prop.value && prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value
          if (bound && bound.type === 'Identifier' && bound.name === 't') return 'prop'
        }
      }
    }
    return null
  }

  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return

    const isFunction = /Function(Declaration|Expression)|ArrowFunctionExpression/.test(node.type)
    let pushed = false

    if (isFunction) {
      const kind = paramBindsT(node.params)
      stack.push(kind ? { t: { kind, loc: node.loc } } : {})
      pushed = true
    } else if (node.type === 'BlockStatement' || node.type === 'Program') {
      stack.push({})
      pushed = true
    }

    // Register bindings introduced in this scope before visiting children.
    if (node.type === 'VariableDeclarator' && stack.length) {
      const frame = stack[stack.length - 1]
      const kind = destructureKind(node)
      if (kind) frame.t = { kind, loc: node.loc }
      else if (node.id.type === 'Identifier' && node.id.name === 't')
        frame.t = { kind: 'local', loc: node.loc }
    }

    // The check itself.
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 't') {
      const binding = currentBinding()
      // 'i18n' is the useI18n destructure; 'prop' is t threaded down from a
      // parent that has one. Both resolve to the real translator.
      if (!binding || (binding.kind !== 'i18n' && binding.kind !== 'prop')) {
        const arg = node.arguments[0]
        hits.push({
          line: node.loc.start.line,
          column: node.loc.start.column + 1,
          key: arg && arg.type === 'StringLiteral' ? arg.value : '<non-literal>',
          boundAs: binding ? binding.kind : 'unbound',
          shadowLine: binding ? binding.loc.start.line : null,
          source: code.split('\n')[node.loc.start.line - 1].trim().slice(0, 100),
        })
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'parent') continue
      const child = node[key]
      if (Array.isArray(child)) child.forEach((c) => visit(c, node))
      else if (child && typeof child.type === 'string') visit(child, node)
    }

    if (pushed) stack.pop()
  }

  visit(ast.program, null)
  return hits
}

const files = walkFiles(SRC)
const report = []

for (const file of files) {
  const code = fs.readFileSync(file, 'utf8')
  if (!/\bt\s*\(/.test(code)) continue
  let ast
  try {
    ast = parser.parse(code, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true })
  } catch {
    continue
  }
  const hits = findShadowedCalls(ast, code)
  if (hits.length) report.push({ file: path.relative(path.join(__dirname, '..'), file), hits })
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else if (!report.length) {
  console.log('PASS — every t() call resolves to the useI18n binding.')
} else {
  const total = report.reduce((n, r) => n + r.hits.length, 0)
  console.log(`FAIL — ${total} t() call(s) in ${report.length} file(s) resolve to something other than useI18n:\n`)
  for (const { file, hits } of report) {
    console.log(`  ${file}`)
    for (const h of hits) {
      const where = h.shadowLine ? `${h.boundAs} bound at line ${h.shadowLine}` : 'not bound at all'
      console.log(`    ${h.line}:${h.column}  t(${JSON.stringify(h.key)}) — ${where}`)
      console.log(`             ${h.source}`)
    }
    console.log('')
  }
}

process.exit(report.length ? 1 : 0)
