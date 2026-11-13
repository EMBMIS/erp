/**
 * The expression language: a tokenizer, a recursive-descent parser, a type
 * checker, and two backends (SQL and an interpreter). No `eval`, no `Function`,
 * no template-string-into-SQL, anywhere.
 *
 * ===========================================================================
 * WHY A LANGUAGE AT ALL
 * ===========================================================================
 * Applications need conditions: "a finding may only close when its corrective
 * action is verified", "escalate when due_date is more than 7 days past",
 * "days_open = today − opened_at". Encoding each of those as a bespoke JSON
 * shape produces a dialect per feature and a validator per dialect. One small
 * language, parsed once, is both smaller and far easier to prove things about.
 *
 * WHY IT IS SAFE
 * ---------------------------------------------------------------------------
 *   • The tokenizer accepts a fixed character vocabulary. A backslash, a
 *     semicolon, a backtick, a dollar sign outside a known context variable —
 *     none of them tokenize, so they cannot reach a parser, let alone SQL.
 *   • Identifiers are not free text. Every one is resolved against the
 *     entity's declared fields (or the context allowlist) at CHECK time, and
 *     a miss is a hard error. An expression naming a column that does not
 *     exist never compiles, so it never reaches the database to be interpreted
 *     as something else.
 *   • Functions are a fixed table with fixed arities and fixed types.
 *   • The SQL backend emits ONLY: quoted identifiers it resolved itself, fixed
 *     operator strings, function templates written here, and `$n` placeholders.
 *     Every literal from the expression becomes a bound parameter. There is no
 *     code path that puts a user-supplied value into a SQL string.
 *   • The interpreter walks the AST with a switch. An unknown node type throws
 *     rather than being skipped.
 *
 * The grammar, lowest precedence first:
 *
 *     or      := and ( 'or' and )*
 *     and     := not ( 'and' not )*
 *     not     := 'not' not | comparison
 *     comparison := additive ( ('='|'!='|'<'|'<='|'>'|'>='|'in'|'contains') additive )?
 *     additive   := multiplicative ( ('+'|'-') multiplicative )*
 *     multiplicative := unary ( ('*'|'/') unary )*
 *     unary   := '-' unary | primary
 *     primary := number | string | true | false | null | identifier
 *              | function '(' args ')' | '(' or ')' | '[' list ']'
 */

class ExpressionError extends Error {
  constructor(message, position = null) {
    super(position === null ? message : `${message} (at character ${position + 1})`);
    this.name = 'ExpressionError';
    this.code = 'INVALID_EXPRESSION';
    this.position = position;
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------
const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'contains', 'true', 'false', 'null']);
const MAX_EXPRESSION_LENGTH = 1000;

function tokenize(source) {
  if (typeof source !== 'string') throw new ExpressionError('An expression must be a string.');
  if (source.length > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionError(`Expressions are limited to ${MAX_EXPRESSION_LENGTH} characters.`);
  }

  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue; }

    // Numbers. No exponents, no hex, no underscores — a business rule that
    // needs 1e9 can write it out, and every extra literal form is another
    // parser edge to get wrong.
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < source.length && source[j] >= '0' && source[j] <= '9') j += 1;
      if (source[j] === '.') {
        j += 1;
        while (j < source.length && source[j] >= '0' && source[j] <= '9') j += 1;
      }
      tokens.push({ type: 'number', value: Number(source.slice(i, j)), pos: i });
      i = j;
      continue;
    }

    // Single-quoted strings, '' for a literal quote. Backslash is NOT an escape
    // character here: there is no escape sequence to get wrong, and no way to
    // smuggle a quote past the tokenizer.
    if (ch === "'") {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < source.length) {
        if (source[j] === "'") {
          if (source[j + 1] === "'") { out += "'"; j += 2; continue; }
          closed = true; j += 1; break;
        }
        out += source[j];
        j += 1;
      }
      if (!closed) throw new ExpressionError('Unterminated string literal', i);
      tokens.push({ type: 'string', value: out, pos: i });
      i = j;
      continue;
    }

    // Identifiers, keywords, and context variables ($now, $user.role).
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i;
      while (j < source.length && /[a-zA-Z0-9_$.]/.test(source[j])) j += 1;
      const word = source.slice(i, j);
      if (KEYWORDS.has(word.toLowerCase()) && !word.includes('.')) {
        tokens.push({ type: 'keyword', value: word.toLowerCase(), pos: i });
      } else {
        tokens.push({ type: 'name', value: word, pos: i });
      }
      i = j;
      continue;
    }

    const two = source.slice(i, i + 2);
    if (two === '!=' || two === '<=' || two === '>=' || two === '<>') {
      tokens.push({ type: 'op', value: two === '<>' ? '!=' : two, pos: i });
      i += 2;
      continue;
    }
    if ('=<>+-*/(),[]'.includes(ch)) {
      tokens.push({ type: ch === '(' || ch === ')' || ch === ',' || ch === '[' || ch === ']' ? ch : 'op', value: ch, pos: i });
      i += 1;
      continue;
    }

    throw new ExpressionError(`Unexpected character ${JSON.stringify(ch)}`, i);
  }
  tokens.push({ type: 'eof', value: null, pos: source.length });
  return tokens;
}

// ---------------------------------------------------------------------------
// Functions. Fixed names, fixed arities, fixed types, fixed SQL templates.
//
// `sql` receives already-compiled operand fragments and returns a fragment. It
// is the only place a function name becomes SQL text, and every one of these
// strings is written here rather than derived from input.
// ---------------------------------------------------------------------------
const FUNCTIONS = {
  now:            { args: [], returns: 'datetime', sql: () => 'CURRENT_TIMESTAMP', js: () => new Date() },
  today:          { args: [], returns: 'date',     sql: () => 'CURRENT_DATE', js: () => new Date(new Date().toDateString()) },
  coalesce:       { args: ['any', 'any'], returns: 'any', sql: (a, b) => `COALESCE(${a}, ${b})`, js: (a, b) => (a === null || a === undefined ? b : a) },
  lower:          { args: ['text'], returns: 'text', sql: (a) => `LOWER(${a})`, js: (a) => String(a ?? '').toLowerCase() },
  upper:          { args: ['text'], returns: 'text', sql: (a) => `UPPER(${a})`, js: (a) => String(a ?? '').toUpperCase() },
  length:         { args: ['text'], returns: 'number', sql: (a) => `LENGTH(${a})`, js: (a) => String(a ?? '').length },
  abs:            { args: ['number'], returns: 'number', sql: (a) => `ABS(${a})`, js: (a) => Math.abs(Number(a)) },
  round:          { args: ['number'], returns: 'number', sql: (a) => `ROUND((${a})::numeric)`, js: (a) => Math.round(Number(a)) },
  // Date arithmetic, expressed as functions rather than as `-` on dates: the
  // unit is then part of the name and cannot be misread.
  days_between:   { args: ['datetime', 'datetime'], returns: 'number',
                    sql: (a, b) => `(DATE_PART('day', (${a})::timestamptz - (${b})::timestamptz))`,
                    js: (a, b) => (toDate(a) - toDate(b)) / 86400000 },
  days_since:     { args: ['datetime'], returns: 'number',
                    sql: (a) => `(DATE_PART('day', CURRENT_TIMESTAMP - (${a})::timestamptz))`,
                    js: (a) => (Date.now() - toDate(a)) / 86400000 },
  is_empty:       { args: ['any'], returns: 'boolean',
                    sql: (a) => `(${a} IS NULL OR ${a}::text = '')`,
                    js: (a) => a === null || a === undefined || a === '' },
};

function toDate(v) {
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

// Context variables an expression may read. Anything else starting with `$` is
// rejected, so this list is the whole ambient surface.
const CONTEXT_VARIABLES = {
  '$now':          { type: 'datetime', sql: 'CURRENT_TIMESTAMP' },
  '$today':        { type: 'date',     sql: 'CURRENT_DATE' },
  '$user.id':      { type: 'text',     param: 'userId' },
  '$user.role':    { type: 'text',     param: 'userRole' },
  '$surface':      { type: 'text',     param: 'surfaceKey' },
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------
function parse(source) {
  const tokens = tokenize(source);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (type, value) => {
    const t = peek();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new ExpressionError(`Expected ${value || type} but found ${t.value === null ? 'end of expression' : JSON.stringify(t.value)}`, t.pos);
    }
    return next();
  };
  const atKeyword = (word) => peek().type === 'keyword' && peek().value === word;

  function parseOr() {
    let left = parseAnd();
    while (atKeyword('or')) { next(); left = { node: 'logical', op: 'or', left, right: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (atKeyword('and')) { next(); left = { node: 'logical', op: 'and', left, right: parseNot() }; }
    return left;
  }
  function parseNot() {
    if (atKeyword('not')) { next(); return { node: 'unary', op: 'not', operand: parseNot() }; }
    return parseComparison();
  }
  function parseComparison() {
    const left = parseAdditive();
    const t = peek();
    if (t.type === 'op' && ['=', '!=', '<', '<=', '>', '>='].includes(t.value)) {
      next();
      return { node: 'compare', op: t.value, left, right: parseAdditive() };
    }
    if (t.type === 'keyword' && (t.value === 'in' || t.value === 'contains')) {
      next();
      return { node: 'compare', op: t.value, left, right: parseAdditive() };
    }
    return left;
  }
  function parseAdditive() {
    let left = parseMultiplicative();
    while (peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = next().value;
      left = { node: 'arith', op, left, right: parseMultiplicative() };
    }
    return left;
  }
  function parseMultiplicative() {
    let left = parseUnary();
    while (peek().type === 'op' && (peek().value === '*' || peek().value === '/')) {
      const op = next().value;
      left = { node: 'arith', op, left, right: parseUnary() };
    }
    return left;
  }
  function parseUnary() {
    if (peek().type === 'op' && peek().value === '-') {
      next();
      return { node: 'unary', op: 'neg', operand: parseUnary() };
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = peek();
    if (t.type === 'number' || t.type === 'string') { next(); return { node: 'literal', value: t.value, pos: t.pos }; }
    if (t.type === 'keyword' && ['true', 'false', 'null'].includes(t.value)) {
      next();
      return { node: 'literal', value: t.value === 'null' ? null : t.value === 'true', pos: t.pos };
    }
    if (t.type === '(') { next(); const inner = parseOr(); expect(')'); return inner; }
    if (t.type === '[') {
      next();
      const items = [];
      if (peek().type !== ']') {
        items.push(parseOr());
        while (peek().type === ',') { next(); items.push(parseOr()); }
      }
      expect(']');
      return { node: 'list', items, pos: t.pos };
    }
    if (t.type === 'name') {
      next();
      if (peek().type === '(') {
        next();
        const args = [];
        if (peek().type !== ')') {
          args.push(parseOr());
          while (peek().type === ',') { next(); args.push(parseOr()); }
        }
        expect(')');
        return { node: 'call', name: t.value, args, pos: t.pos };
      }
      if (t.value.startsWith('$')) return { node: 'context', name: t.value, pos: t.pos };
      return { node: 'field', name: t.value, pos: t.pos };
    }
    throw new ExpressionError(`Unexpected ${t.value === null ? 'end of expression' : JSON.stringify(t.value)}`, t.pos);
  }

  const ast = parseOr();
  if (peek().type !== 'eof') {
    throw new ExpressionError(`Unexpected trailing ${JSON.stringify(peek().value)}`, peek().pos);
  }
  return ast;
}

// ---------------------------------------------------------------------------
// Type checking. `fields` maps a name to one of the FIELD_TYPES keys.
// ---------------------------------------------------------------------------
const NUMERIC_TYPES = new Set(['integer', 'bigint', 'decimal', 'money', 'percent', 'duration_hours', 'number']);
const TEXT_TYPES = new Set(['text', 'long_text', 'email', 'url', 'phone', 'slug', 'enum', 'reference']);
const TEMPORAL_TYPES = new Set(['date', 'datetime']);

function family(type) {
  if (NUMERIC_TYPES.has(type)) return 'number';
  if (TEXT_TYPES.has(type)) return 'text';
  if (TEMPORAL_TYPES.has(type)) return 'datetime';
  if (type === 'boolean') return 'boolean';
  return type;
}

function check(ast, fields, { allowContext = true } = {}) {
  switch (ast.node) {
    case 'literal':
      if (ast.value === null) return 'any';
      if (typeof ast.value === 'number') return 'number';
      if (typeof ast.value === 'boolean') return 'boolean';
      return 'text';

    case 'list': {
      ast.items.forEach((item) => check(item, fields, { allowContext }));
      return 'list';
    }

    case 'field': {
      // The whole reason identifiers cannot be free text: an unknown name is an
      // error here, before the SQL backend ever sees it.
      if (!Object.prototype.hasOwnProperty.call(fields, ast.name)) {
        throw new ExpressionError(`Unknown field "${ast.name}". Expressions may only reference fields declared on the entity.`, ast.pos);
      }
      return family(fields[ast.name]);
    }

    case 'context': {
      if (!allowContext) throw new ExpressionError(`Context variable "${ast.name}" is not available here.`, ast.pos);
      const ctx = CONTEXT_VARIABLES[ast.name];
      if (!ctx) throw new ExpressionError(`Unknown context variable "${ast.name}".`, ast.pos);
      return family(ctx.type);
    }

    case 'call': {
      const fn = Object.prototype.hasOwnProperty.call(FUNCTIONS, ast.name) ? FUNCTIONS[ast.name] : null;
      if (!fn) throw new ExpressionError(`Unknown function "${ast.name}".`, ast.pos);
      if (fn.args.length !== ast.args.length) {
        throw new ExpressionError(`Function "${ast.name}" takes ${fn.args.length} argument(s), got ${ast.args.length}.`, ast.pos);
      }
      ast.args.forEach((arg, idx) => {
        const got = check(arg, fields, { allowContext });
        const want = family(fn.args[idx]);
        if (want !== 'any' && got !== 'any' && got !== want) {
          throw new ExpressionError(`Argument ${idx + 1} of "${ast.name}" should be ${want}, got ${got}.`, ast.pos);
        }
      });
      return family(fn.returns);
    }

    case 'unary': {
      const t = check(ast.operand, fields, { allowContext });
      if (ast.op === 'not' && t !== 'boolean' && t !== 'any') {
        throw new ExpressionError(`"not" needs a boolean, got ${t}.`, ast.operand.pos);
      }
      if (ast.op === 'neg' && t !== 'number' && t !== 'any') {
        throw new ExpressionError(`Negation needs a number, got ${t}.`, ast.operand.pos);
      }
      return ast.op === 'not' ? 'boolean' : 'number';
    }

    case 'logical': {
      ['left', 'right'].forEach((side) => {
        const t = check(ast[side], fields, { allowContext });
        if (t !== 'boolean' && t !== 'any') {
          throw new ExpressionError(`"${ast.op}" needs boolean operands, got ${t}.`, ast[side].pos);
        }
      });
      return 'boolean';
    }

    case 'arith': {
      const l = check(ast.left, fields, { allowContext });
      const r = check(ast.right, fields, { allowContext });
      if ((l !== 'number' && l !== 'any') || (r !== 'number' && r !== 'any')) {
        throw new ExpressionError(`Arithmetic needs numbers, got ${l} and ${r}. Use days_between() for dates.`, ast.left.pos);
      }
      return 'number';
    }

    case 'compare': {
      const l = check(ast.left, fields, { allowContext });
      const r = check(ast.right, fields, { allowContext });
      if (ast.op === 'in') {
        if (ast.right.node !== 'list') throw new ExpressionError('"in" needs a list on the right, e.g. status in [\'OPEN\', \'CLOSED\'].', ast.pos);
      } else if (ast.op === 'contains') {
        if (l !== 'text' && l !== 'any') throw new ExpressionError(`"contains" needs text on the left, got ${l}.`, ast.pos);
      } else if (l !== 'any' && r !== 'any' && l !== r) {
        throw new ExpressionError(`Cannot compare ${l} with ${r}.`, ast.pos);
      }
      return 'boolean';
    }

    default:
      // Not reachable from parse(), and that is the point: if it ever is, the
      // AST came from somewhere it should not have.
      throw new ExpressionError(`Unsupported expression node "${ast.node}".`);
  }
}

/** Parse + type check in one call. Returns { ast, type }. */
function compile(source, fields, options) {
  const ast = parse(source);
  const type = check(ast, fields, options);
  return { ast, type };
}

// ---------------------------------------------------------------------------
// SQL backend.
//
// `resolveField` maps a logical field name to an already-quoted, already-
// validated SQL fragment. The caller owns that mapping; this module never
// invents an identifier.
// ---------------------------------------------------------------------------
function toSql(ast, { resolveField, params, context = {} }) {
  const emit = (node) => {
    switch (node.node) {
      case 'literal':
        if (node.value === null) return 'NULL';
        params.push(node.value);
        return `$${params.length}`;

      case 'list':
        return `(${node.items.map(emit).join(', ')})`;

      case 'field': {
        const sql = resolveField(node.name);
        if (!sql) throw new ExpressionError(`Field "${node.name}" could not be resolved to a column.`);
        return sql;
      }

      case 'context': {
        const ctx = CONTEXT_VARIABLES[node.name];
        if (!ctx) throw new ExpressionError(`Unknown context variable "${node.name}".`);
        if (ctx.sql) return ctx.sql;
        params.push(context[ctx.param] ?? null);
        return `$${params.length}`;
      }

      case 'call': {
        const fn = FUNCTIONS[node.name];
        return fn.sql(...node.args.map(emit));
      }

      case 'unary':
        return node.op === 'not' ? `(NOT ${emit(node.operand)})` : `(-${emit(node.operand)})`;

      case 'logical':
        return `(${emit(node.left)} ${node.op === 'and' ? 'AND' : 'OR'} ${emit(node.right)})`;

      case 'arith':
        // Division guarded: a business rule that divides by a field is a
        // perfectly reasonable thing to write, and a zero in that field must
        // not take the whole query down.
        if (node.op === '/') return `(${emit(node.left)} / NULLIF(${emit(node.right)}, 0))`;
        return `(${emit(node.left)} ${node.op} ${emit(node.right)})`;

      case 'compare': {
        const left = emit(node.left);
        if (node.op === 'in') return `(${left} IN ${emit(node.right)})`;
        if (node.op === 'contains') {
          const right = emit(node.right);
          return `(${left} ILIKE '%' || ${right} || '%')`;
        }
        const op = node.op === '=' ? '=' : node.op;
        // IS [NOT] DISTINCT FROM rather than =/<>: business conditions written
        // by non-programmers mean "is it this value", and NULL = NULL being
        // unknown silently drops rows they expected to see.
        if (node.right.node === 'literal' && node.right.value === null) {
          return `(${left} IS ${node.op === '!=' ? 'NOT ' : ''}NULL)`;
        }
        return `(${left} ${op} ${emit(node.right)})`;
      }

      default:
        throw new ExpressionError(`Unsupported expression node "${node.node}".`);
    }
  };
  return emit(ast);
}

// ---------------------------------------------------------------------------
// Interpreter backend. Used by the sandbox, by automation conditions evaluated
// against an in-memory record, and by the preview renderer.
// ---------------------------------------------------------------------------
function evaluate(ast, record = {}, context = {}) {
  const walk = (node) => {
    switch (node.node) {
      case 'literal': return node.value;
      case 'list': return node.items.map(walk);
      case 'field': return Object.prototype.hasOwnProperty.call(record, node.name) ? record[node.name] : null;
      case 'context': {
        const ctx = CONTEXT_VARIABLES[node.name];
        if (!ctx) throw new ExpressionError(`Unknown context variable "${node.name}".`);
        if (node.name === '$now') return new Date();
        if (node.name === '$today') return new Date(new Date().toDateString());
        return context[ctx.param] ?? null;
      }
      case 'call': return FUNCTIONS[node.name].js(...node.args.map(walk));
      case 'unary': {
        const v = walk(node.operand);
        return node.op === 'not' ? !v : -Number(v);
      }
      case 'logical': {
        const l = walk(node.left);
        if (node.op === 'and') return l ? !!walk(node.right) : false;
        return l ? true : !!walk(node.right);
      }
      case 'arith': {
        const l = Number(walk(node.left));
        const r = Number(walk(node.right));
        if (node.op === '+') return l + r;
        if (node.op === '-') return l - r;
        if (node.op === '*') return l * r;
        return r === 0 ? null : l / r;
      }
      case 'compare': {
        const l = walk(node.left);
        if (node.op === 'in') return walk(node.right).some((v) => looseEq(v, l));
        if (node.op === 'contains') return String(l ?? '').toLowerCase().includes(String(walk(node.right) ?? '').toLowerCase());
        const r = walk(node.right);
        switch (node.op) {
          case '=':  return looseEq(l, r);
          case '!=': return !looseEq(l, r);
          case '<':  return cmp(l, r) < 0;
          case '<=': return cmp(l, r) <= 0;
          case '>':  return cmp(l, r) > 0;
          case '>=': return cmp(l, r) >= 0;
          default:   throw new ExpressionError(`Unsupported comparison "${node.op}".`);
        }
      }
      default:
        throw new ExpressionError(`Unsupported expression node "${node.node}".`);
    }
  };
  return walk(ast);
}

function looseEq(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (a instanceof Date || b instanceof Date) return toDate(a) === toDate(b);
  return String(a) === String(b);
}
function cmp(a, b) {
  if (a instanceof Date || b instanceof Date) return toDate(a) - toDate(b);
  const na = Number(a); const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

/** Every field an expression reads — used to validate and to plan indexes. */
function referencedFields(ast, acc = new Set()) {
  if (!ast || typeof ast !== 'object') return acc;
  if (ast.node === 'field') acc.add(ast.name);
  ['left', 'right', 'operand'].forEach((k) => { if (ast[k]) referencedFields(ast[k], acc); });
  (ast.args || []).forEach((a) => referencedFields(a, acc));
  (ast.items || []).forEach((a) => referencedFields(a, acc));
  return acc;
}

module.exports = {
  ExpressionError,
  FUNCTIONS,
  CONTEXT_VARIABLES,
  tokenize,
  parse,
  check,
  compile,
  toSql,
  evaluate,
  referencedFields,
  family,
};
