/**
 * Every SQL identifier this platform ever emits is produced here.
 *
 * ===========================================================================
 * THE RULE
 * ===========================================================================
 * A generated application's schema is designed by a language model and named,
 * indirectly, by whoever typed the requirement. Neither is trusted. So no
 * string that arrived from outside this process is ever concatenated into SQL.
 * What happens instead:
 *
 *   1. A LOGICAL key (`warranty_claim`, `risk_score`) is validated against a
 *      narrow allowlist pattern and a reserved-word list. A key that does not
 *      match is rejected — never escaped, never sanitised, never truncated
 *      into something that does match. Silent repair is how an injection
 *      attempt becomes a valid identifier.
 *   2. The PHYSICAL name is DERIVED from the logical key plus a prefix that
 *      the server computes from two UUIDs it already holds. The caller has no
 *      influence over the prefix at all.
 *   3. The result is checked again — length, pattern, reserved words — and
 *      only then quoted.
 *
 * `quoteIdent` exists as the last line of defence, not the first. Anything
 * reaching it has already passed (1) and (3); if it ever receives something
 * that has not, it throws rather than quoting it.
 *
 * WHY DERIVATION AND NOT LOOKUP-FREE NAMING
 * ---------------------------------------------------------------------------
 * Physical names must be reproducible: given an application and a company, the
 * same prefix must come out on every machine, in every process, forever. A
 * counter or a random suffix would make a table's name depend on the order
 * installs happened in, which turns every recovery, restore or re-run into an
 * archaeology exercise. So the prefix is a hash of (application_id,
 * company_id) — deterministic — and collisions are handled by a deterministic
 * escalation, checked against the registry, with the database's UNIQUE index
 * on (table_schema, table_name) as the backstop that cannot be reasoned past.
 */

const crypto = require('crypto');

// Postgres truncates identifiers at NAMEDATALEN-1 = 63 bytes, silently. Two
// entities whose names differ only past character 63 would become the same
// table. So the limit is enforced here as a rejection, not a truncation.
const MAX_IDENTIFIER_BYTES = 63;

// Logical keys: lowercase snake_case, starting with a letter. Deliberately
// narrower than what Postgres accepts — no quotes needed, no case folding
// surprises, no unicode confusables, nothing that reads differently in a log
// than it does in the catalogue.
const LOGICAL_KEY_RE = /^[a-z][a-z0-9_]{1,63}$/;

// Physical table names get the prefix, so the logical part must leave room:
// `app_` + 8 + `_` + 8 + `_` = 22 characters of prefix.
const MAX_ENTITY_KEY_LENGTH = 40;
const MAX_FIELD_KEY_LENGTH = 48;

// Reserved words that would break or silently change meaning if used unquoted,
// plus the column names this platform owns on every generated table. A field
// called `id` or `company_id` in a specification is a design error worth
// reporting, not something to quietly rename.
const RESERVED_WORDS = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric',
  'authorization', 'between', 'binary', 'both', 'case', 'cast', 'check',
  'collate', 'collation', 'column', 'concurrently', 'constraint', 'create',
  'cross', 'current_catalog', 'current_date', 'current_role', 'current_schema',
  'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable',
  'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for',
  'foreign', 'freeze', 'from', 'full', 'grant', 'group', 'having', 'ilike',
  'in', 'initially', 'inner', 'intersect', 'into', 'is', 'isnull', 'join',
  'lateral', 'leading', 'left', 'like', 'limit', 'localtime', 'localtimestamp',
  'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order',
  'outer', 'overlaps', 'placing', 'primary', 'references', 'returning', 'right',
  'select', 'session_user', 'similar', 'some', 'symmetric', 'table', 'tablesample',
  'then', 'to', 'trailing', 'true', 'union', 'unique', 'user', 'using',
  'variadic', 'verbose', 'when', 'where', 'window', 'with',
]);

// Columns the compiler adds to every generated table. A specification may not
// declare them; they are the platform's, not the application's.
const RESERVED_COLUMNS = new Set([
  'id', 'company_id', 'app_instance_id', 'created_at', 'updated_at', 'deleted_at',
  'created_by', 'updated_by',
  'created_by_user_id', 'created_by_external_id',
  'updated_by_user_id', 'updated_by_external_id',
]);

class IdentifierError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'IdentifierError';
    this.code = 'INVALID_IDENTIFIER';
    this.detail = detail;
  }
}

/** Is this a logical key we are willing to derive an identifier from? */
function isLogicalKey(value, { maxLength = 63 } = {}) {
  if (typeof value !== 'string') return false;
  if (value.length > maxLength) return false;
  if (!LOGICAL_KEY_RE.test(value)) return false;
  if (RESERVED_WORDS.has(value)) return false;
  // Double underscores are reserved for platform-generated names (`__transitions`),
  // and a trailing underscore reads as a truncation artefact.
  if (value.includes('__') || value.endsWith('_')) return false;
  return true;
}

function assertLogicalKey(value, what, options) {
  if (!isLogicalKey(value, options)) {
    throw new IdentifierError(
      `${what} must be lowercase snake_case, start with a letter, avoid reserved words, and be at most ${options?.maxLength || 63} characters. Received: ${JSON.stringify(value)}`,
      { what, value }
    );
  }
  return value;
}

function assertEntityKey(value) {
  return assertLogicalKey(value, 'Entity key', { maxLength: MAX_ENTITY_KEY_LENGTH });
}

function assertFieldKey(value) {
  assertLogicalKey(value, 'Field name', { maxLength: MAX_FIELD_KEY_LENGTH });
  if (RESERVED_COLUMNS.has(value)) {
    throw new IdentifierError(
      `Field name "${value}" is reserved: every generated table already has it. Choose another name.`,
      { what: 'Field name', value }
    );
  }
  return value;
}

/**
 * Quote an identifier for interpolation into DDL.
 *
 * Refuses anything that has not already been validated. This is intentionally
 * hostile: a caller that reaches here with an unvalidated string has a bug, and
 * a bug in this direction is a SQL injection, so it must fail loudly rather
 * than produce a plausible-looking quoted string.
 */
function quoteIdent(name) {
  if (typeof name !== 'string' || !name.length) {
    throw new IdentifierError('Refusing to quote a non-string identifier.', { value: name });
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_IDENTIFIER_BYTES) {
    throw new IdentifierError(
      `Identifier "${name}" is ${Buffer.byteLength(name, 'utf8')} bytes; Postgres silently truncates past ${MAX_IDENTIFIER_BYTES}.`,
      { value: name }
    );
  }
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new IdentifierError(
      `Refusing to quote "${name}": identifiers reaching SQL must already be lowercase snake_case.`,
      { value: name }
    );
  }
  // Belt and braces. Nothing that passed the test above contains a quote, but
  // the doubling is what makes this function correct rather than merely
  // currently-sufficient.
  return `"${name.replace(/"/g, '""')}"`;
}

/** A literal string for DDL contexts (comments, defaults) that cannot take a parameter. */
function quoteLiteral(value) {
  if (typeof value !== 'string') {
    throw new IdentifierError('Refusing to quote a non-string literal.', { value });
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function shortHash(input, length) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, length);
}

/**
 * The physical table prefix for one company's instance of one application.
 *
 * Shape: `app_<8 hex of the application id>_<8 hex of the company id>`.
 * Hex digests rather than the raw UUID fragments so that a UUID whose first
 * characters happen to be non-hex-looking, or a future non-UUID id, still
 * produces a legal identifier — and so the two halves cannot be read as an
 * invitation to guess another company's tables from a known application id.
 * Guessing is not the threat model the prefix defends against in any case:
 * resolution goes through the registry, and RLS covers the table itself.
 *
 * `attempt` widens both halves deterministically. It exists only for the
 * astronomically unlikely 64-bit collision, and callers escalate through it in
 * order, so the same collision always resolves the same way.
 */
function instanceTablePrefix(applicationId, companyId, attempt = 0) {
  if (!applicationId || !companyId) {
    throw new IdentifierError('An instance prefix needs both an application id and a company id.');
  }
  const width = 8 + attempt * 2;
  const prefix = `app_${shortHash(`application:${applicationId}`, width)}_${shortHash(`company:${companyId}`, width)}`;
  if (!/^app_[a-f0-9]+_[a-f0-9]+$/.test(prefix)) {
    throw new IdentifierError(`Derived an illegal instance prefix: ${prefix}`);
  }
  return prefix;
}

/**
 * The physical table name for a logical entity inside an instance.
 *
 * The logical key is validated first and used verbatim — deriving the physical
 * name by hashing it too would make the catalogue unreadable for no security
 * gain, since the prefix already carries the isolation and the key has already
 * been proven safe.
 */
function physicalTableName(tablePrefix, entityKey) {
  assertEntityKey(entityKey);
  if (!/^app_[a-f0-9]+_[a-f0-9]+$/.test(String(tablePrefix))) {
    throw new IdentifierError(
      `Instance table prefix "${tablePrefix}" was not produced by instanceTablePrefix().`,
      { value: tablePrefix }
    );
  }
  const name = `${tablePrefix}_${entityKey}`;
  if (Buffer.byteLength(name, 'utf8') > MAX_IDENTIFIER_BYTES) {
    throw new IdentifierError(
      `Entity "${entityKey}" would produce the ${Buffer.byteLength(name, 'utf8')}-byte table name "${name}", past Postgres's ${MAX_IDENTIFIER_BYTES}-byte limit. Shorten the entity key.`,
      { entityKey, name }
    );
  }
  return name;
}

/**
 * Names for the objects that hang off a generated table.
 *
 * Constraint and index names share the 63-byte budget with the table name, and
 * a table at 60 bytes plus `_status_idx` would overflow it. So these hash the
 * suffix rather than appending it when the result would be too long — an index
 * name is never typed by a person, so legibility loses to correctness here.
 */
function derivedName(tableName, suffix) {
  const plain = `${tableName}_${suffix}`;
  if (Buffer.byteLength(plain, 'utf8') <= MAX_IDENTIFIER_BYTES) return plain;
  const room = MAX_IDENTIFIER_BYTES - 9; // '_' + 8 hex
  return `${tableName.slice(0, room)}_${shortHash(plain, 8)}`;
}

const indexName = (tableName, columns) =>
  derivedName(tableName, `${columns.join('_')}_idx`);
const constraintName = (tableName, kind, key) =>
  derivedName(tableName, `${kind}_${key}`);
const foreignKeyName = (tableName, column) =>
  derivedName(tableName, `${column}_fkey`);

/** `"public"."app_ab12cd34_ef56ab78_findings"` — the string that reaches SQL. */
function qualifiedIdentifier(schema, table) {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

module.exports = {
  IdentifierError,
  MAX_IDENTIFIER_BYTES,
  MAX_ENTITY_KEY_LENGTH,
  MAX_FIELD_KEY_LENGTH,
  RESERVED_WORDS,
  RESERVED_COLUMNS,
  isLogicalKey,
  assertLogicalKey,
  assertEntityKey,
  assertFieldKey,
  quoteIdent,
  quoteLiteral,
  instanceTablePrefix,
  physicalTableName,
  qualifiedIdentifier,
  indexName,
  constraintName,
  foreignKeyName,
  derivedName,
  shortHash,
};
