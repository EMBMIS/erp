/**
 * The migration planner: what has to happen to the database for this company's
 * instance to be running this version of this application.
 *
 * ===========================================================================
 * WHY PLANNING IS SEPARATE FROM APPLYING
 * ===========================================================================
 * Three things need the plan before anything executes:
 *
 *   • The person approving the change, who needs to be told "this drops the
 *     `root_cause` column and the 412 values in it" in those words.
 *   • The safety classifier, which decides whether an ordinary approval is
 *     enough or whether someone has to name the destructive steps.
 *   • The deployer, which re-plans immediately before applying and refuses to
 *     proceed if the plan changed since approval. An approval is an approval of
 *     a specific plan, not of an intention.
 *
 * So planning is a pure function of (specification, current physical state).
 * It touches nothing, and running it twice on an unchanged database produces a
 * byte-identical result — which is what makes the hash comparison meaningful.
 *
 * SAFETY CLASSES
 * ---------------------------------------------------------------------------
 *   safe        Additive. New table, new nullable column, new index. Nothing
 *               existing changes meaning and no data can be lost.
 *   review      Existing data keeps its bytes but changes meaning or gains a
 *               rule it might violate: a widened type, a new NOT NULL, a
 *               narrowed enum, a dropped index.
 *   destructive Data goes away: a dropped column, a dropped table, a narrowed
 *               type that cannot round-trip.
 *
 * The class of a plan is the worst class in it.
 */

const { physicalTableName, indexName, constraintName } = require('../identifiers');
const ddl = require('./ddl');

const SAFETY_ORDER = { safe: 0, review: 1, destructive: 2 };
const worst = (a, b) => (SAFETY_ORDER[b] > SAFETY_ORDER[a] ? b : a);

/**
 * Which type changes are lossless.
 *
 * Deliberately conservative: a change absent from this table is destructive,
 * not "probably fine". Postgres will happily cast NUMERIC(18,4) to INTEGER and
 * silently round every value; that is data loss with a success message.
 */
const WIDENING = {
  integer: new Set(['bigint', 'decimal', 'money', 'text', 'long_text']),
  bigint: new Set(['decimal', 'text', 'long_text']),
  decimal: new Set(['text', 'long_text']),
  money: new Set(['decimal', 'text', 'long_text']),
  percent: new Set(['decimal', 'text', 'long_text']),
  duration_hours: new Set(['decimal', 'text', 'long_text']),
  date: new Set(['datetime', 'text', 'long_text']),
  text: new Set(['long_text']),
  slug: new Set(['text', 'long_text']),
  email: new Set(['text', 'long_text']),
  url: new Set(['text', 'long_text']),
  phone: new Set(['text', 'long_text']),
  enum: new Set(['text', 'long_text']),
  boolean: new Set(['text', 'long_text']),
};

function classifyTypeChange(from, to) {
  if (from === to) return null;
  if (WIDENING[from]?.has(to)) {
    return { safety: 'review', reason: `${from} widens to ${to} without loss, but anything reading the column now sees a different type.` };
  }
  return {
    safety: 'destructive',
    reason: `${from} does not convert to ${to} without loss. Values that do not fit will be truncated, rounded or rejected.`,
  };
}

/**
 * @param {object} args
 * @param {object} args.spec       Validated, normalized specification.
 * @param {object} args.instance   { id, companyId, tablePrefix }
 * @param {Map}    args.current    entityKey -> { schema, table, columns: Map, indexes: Set, constraints: Set }
 * @param {string} [args.appRole]  The restricted role that needs grants.
 */
function plan({ spec, instance, current = new Map(), appRole = null, schema = 'public' }) {
  const operations = [];
  const notes = [];
  let safety = 'safe';

  const add = (op, opSafety = 'safe', description = '') => {
    operations.push({ ...op, safety: opSafety, description });
    safety = worst(safety, opSafety);
  };

  // Physical names for every entity in the target specification, plus the ones
  // that already exist. Resolution goes through this map and nowhere else.
  const targetTables = new Map();
  spec.data.entities.forEach((entity) => {
    const existing = current.get(entity.key);
    targetTables.set(entity.key, {
      schema: existing?.schema || schema,
      table: existing?.table || physicalTableName(instance.tablePrefix, entity.key),
    });
  });
  current.forEach((value, key) => {
    if (!targetTables.has(key)) targetTables.set(key, { schema: value.schema, table: value.table });
  });

  const resolveEntityTable = (entityKey) => targetTables.get(entityKey) || null;

  // -- new tables ----------------------------------------------------------
  const created = [];
  spec.data.entities.forEach((entity) => {
    if (current.has(entity.key)) return;
    const target = targetTables.get(entity.key);
    created.push(entity);
    add({
      kind: 'create_table',
      entity,
      entityKey: entity.key,
      schema: target.schema,
      table: target.table,
      instanceId: instance.id,
      companyId: instance.companyId,
      resolveEntityTable,
      checkConstraints: entityCheckConstraints(entity, target.table),
      register: true,
    }, 'safe', `Create table for entity "${entity.key}" (${entity.fields.length} field(s)).`);

    add({ kind: 'enable_rls', schema: target.schema, table: target.table }, 'safe',
      `Enable company row-level security on "${target.table}".`);

    if (appRole) {
      add({ kind: 'grant_app_role', schema: target.schema, table: target.table, role: appRole }, 'safe',
        `Grant the application role access to "${target.table}".`);
    }
  });

  // App-to-app foreign keys, once every table exists. Doing these last is what
  // makes mutually-referencing entities expressible at all.
  created.forEach((entity) => {
    const target = targetTables.get(entity.key);
    entity.fields
      .filter((f) => f.type === 'reference' && f.target?.kind === 'app')
      .forEach((field) => {
        add({
          kind: 'add_foreign_key',
          schema: target.schema,
          table: target.table,
          entityKey: entity.key,
          field,
          resolveEntityTable,
        }, 'safe', `Link ${entity.key}.${field.name} to ${field.target.entity}.`);
      });
  });

  // -- existing tables -----------------------------------------------------
  spec.data.entities.forEach((entity) => {
    const existing = current.get(entity.key);
    if (!existing) return;
    const target = targetTables.get(entity.key);
    const known = existing.columns;

    entity.fields.forEach((field) => {
      const physical = ddl.fieldColumns(field);
      const presentAll = physical.every((c) => known.has(c.name));
      const presentAny = physical.some((c) => known.has(c.name));

      if (!presentAny) {
        // A required column added to a table that already has rows would fail
        // on the NOT NULL unless a default fills the existing rows in.
        const needsBackfill = field.required && (field.default === undefined || field.default === null);
        add({
          kind: 'add_column',
          schema: target.schema,
          table: target.table,
          entityKey: entity.key,
          field: needsBackfill ? { ...field, required: false } : field,
          resolveEntityTable,
        }, 'safe', `Add ${entity.key}.${field.name} (${field.type}).`);

        if (needsBackfill) {
          notes.push({
            level: 'warning',
            code: 'REQUIRED_WITHOUT_DEFAULT',
            message: `"${entity.key}.${field.name}" is required but has no default, so it is added as nullable. Existing rows have no value for it; give it a default or fill it in before making it required.`,
          });
        }
        return;
      }
      if (!presentAll) {
        // Half a geo_point exists. Nothing sane to do automatically.
        notes.push({
          level: 'error',
          code: 'PARTIAL_COLUMN',
          message: `Field "${entity.key}.${field.name}" expands to ${physical.map((c) => c.name).join(' and ')}, and only some of them exist. This needs a person.`,
        });
        safety = worst(safety, 'review');
        return;
      }

      // The column exists. Has anything about it changed?
      physical.forEach((col) => {
        const currentCol = known.get(col.name);
        const currentType = currentCol.specType;
        if (currentType && currentType !== field.type) {
          const change = classifyTypeChange(currentType, field.type);
          if (change) {
            add({
              kind: 'alter_column_type',
              schema: target.schema,
              table: target.table,
              entityKey: entity.key,
              field,
              from: currentType,
            }, change.safety, `Change ${entity.key}.${field.name} from ${currentType} to ${field.type}. ${change.reason}`);
          }
        }
        const wantNotNull = field.required && field.type !== 'geo_point';
        if (wantNotNull && currentCol.nullable) {
          add({
            kind: 'set_column_nullability',
            schema: target.schema,
            table: target.table,
            column: col.name,
            required: true,
          }, 'review', `Make ${entity.key}.${field.name} required. Existing rows with no value will block this.`);
        } else if (!wantNotNull && currentCol.nullable === false) {
          add({
            kind: 'set_column_nullability',
            schema: target.schema,
            table: target.table,
            column: col.name,
            required: false,
          }, 'safe', `Make ${entity.key}.${field.name} optional.`);
        }
      });

      // Enum membership. Adding a value is safe; removing one may orphan rows.
      if (field.type === 'enum') {
        const previous = known.get(field.name)?.enumValues || null;
        const next = field.values || [];
        const changed = !previous || previous.length !== next.length || previous.some((v, i) => v !== next[i]);
        if (changed) {
          const removed = (previous || []).filter((v) => !next.includes(v));
          add({
            kind: 'replace_check',
            schema: target.schema,
            table: target.table,
            constraint: constraintName(target.table, 'chk', field.name),
            expression: next.length
              ? `${quoteColumn(field.name)} IS NULL OR ${quoteColumn(field.name)} IN (${next.map(literal).join(', ')})`
              : null,
          }, removed.length ? 'review' : 'safe',
          removed.length
            ? `Narrow the allowed values of ${entity.key}.${field.name}; rows still holding ${removed.join(', ')} would violate the new constraint.`
            : `Widen the allowed values of ${entity.key}.${field.name}.`);
        }
      }
    });

    // Fields that were in the previous version and are not in this one.
    const wanted = new Set(entity.fields.flatMap((f) => ddl.fieldColumns(f).map((c) => c.name)));
    const orphaned = [...known.keys()].filter((name) => !wanted.has(name) && !known.get(name).system);
    if (orphaned.length) {
      add({
        kind: 'drop_column',
        schema: target.schema,
        table: target.table,
        entityKey: entity.key,
        columns: orphaned,
      }, 'destructive', `Drop column(s) ${orphaned.join(', ')} from "${entity.key}". Everything stored in them is destroyed.`);
    }

    // Indexes. `declared` is what the specification asks for; `expected` is
    // every index the compiler would create for this entity, INCLUDING the
    // implicit ones createTable() emits (company, instance, soft-delete, and
    // one per reference/enum column). The distinction matters: only the
    // declared ones can be missing and need adding, but all of them must be
    // spared from the drop pass below, or a freshly created table would be
    // proposed for stripping the moment anything else changed.
    const declaredIndexes = new Map();
    (entity.indexes || []).forEach((index) => {
      declaredIndexes.set(indexName(target.table, index.fields), { columns: index.fields, unique: index.unique });
    });
    const expectedIndexes = ddl.expectedIndexNames(target.table, entity);

    declaredIndexes.forEach((index, name) => {
      if (!existing.indexes.has(name)) {
        add({
          kind: 'create_index',
          schema: target.schema,
          table: target.table,
          name,
          columns: index.columns,
          unique: index.unique,
        }, 'safe', `Add index on ${entity.key}(${index.columns.join(', ')}).`);
      }
    });
    existing.indexes.forEach((name) => {
      // Only indexes this planner created are candidates for removal, and
      // `managedIndexes` is the authority on which those are — it has already
      // excluded constraint-backing indexes (a primary key's index belongs to
      // the constraint, and dropping it independently is an error that aborts
      // the whole deployment) and anything an operator added by hand, which is
      // somebody's deliberate performance fix and not the specification's to
      // undo. A missing set means "nothing is known to be ours", which is a
      // reason to drop nothing rather than a licence to drop everything.
      if (expectedIndexes.has(name)) return;
      if (!existing.managedIndexes || !existing.managedIndexes.has(name)) return;
      add({
        kind: 'drop_index',
        schema: target.schema,
        name,
      }, 'review', `Drop index ${name}, which this version no longer declares.`);
    });
  });

  // Entities that existed and are gone from the specification.
  current.forEach((existing, entityKey) => {
    if (spec.data.entities.some((e) => e.key === entityKey)) return;
    add({
      kind: 'drop_table',
      schema: existing.schema,
      table: existing.table,
      entityKey,
      unregister: true,
    }, 'destructive', `Drop the table for entity "${entityKey}". Every record it holds is destroyed.`);
  });

  return {
    operations,
    safety,
    notes,
    summary: summarize(operations),
    tables: targetTables,
  };
}

function entityCheckConstraints(entity, tableName) {
  // Entity-level constraints are declared as expressions. They were type
  // checked by the validator; here they are compiled to SQL against the
  // entity's own columns, with no parameters (a CHECK cannot have any), which
  // is safe precisely because the expression compiler emits only quoted
  // identifiers, fixed operators and literals it quoted itself.
  const expressions = require('../spec/expressions');
  const fieldTypes = Object.fromEntries(entity.fields.map((f) => [f.name, f.type]));
  return (entity.constraints || []).map((c) => {
    const { ast } = expressions.compile(c.expression, fieldTypes, { allowContext: false });
    const params = [];
    const sql = expressions.toSql(ast, { resolveField: (name) => quoteColumn(name), params });
    // A CHECK constraint cannot bind parameters, so any literal the expression
    // contained has to be inlined — quoted here, by us, from a value that has
    // already been through the tokenizer.
    const inlined = params.reduce((acc, value, idx) => {
      const placeholder = new RegExp(`\\$${idx + 1}(?![0-9])`, 'g');
      return acc.replace(placeholder, literal(value));
    }, sql);
    return { name: constraintName(tableName, 'chk', c.key), expression: inlined };
  });
}

const { quoteIdent, quoteLiteral } = require('../identifiers');
const quoteColumn = (name) => quoteIdent(name);
const literal = (value) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(Number(value));
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return quoteLiteral(String(value));
};

function summarize(operations) {
  const counts = {};
  operations.forEach((op) => { counts[op.kind] = (counts[op.kind] || 0) + 1; });
  return {
    total: operations.length,
    byKind: counts,
    destructive: operations.filter((o) => o.safety === 'destructive').map((o) => o.description),
    review: operations.filter((o) => o.safety === 'review').map((o) => o.description),
  };
}

/**
 * A stable digest of a plan.
 *
 * Compared before applying against the hash the approver saw. Built from the
 * operation kinds, targets and descriptions rather than from the emitted SQL,
 * so a compiler improvement that changes whitespace does not silently void
 * every outstanding approval — while any change to what would actually happen
 * does.
 */
function hashPlan(planResult) {
  const crypto = require('crypto');
  const canonicalForm = planResult.operations.map((op) => ({
    kind: op.kind,
    safety: op.safety,
    table: op.table || null,
    entityKey: op.entityKey || null,
    column: op.column || op.field?.name || null,
    columns: op.columns || null,
    description: op.description,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(canonicalForm)).digest('hex');
}

/** Turn a plan into the statements that would run. Pure; executes nothing. */
function toStatements(planResult) {
  return planResult.operations.flatMap((op) => ddl.emit(op).map((sql) => ({ sql, op })));
}

module.exports = { plan, hashPlan, toStatements, classifyTypeChange, WIDENING };
