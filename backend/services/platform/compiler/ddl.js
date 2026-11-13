/**
 * The only place in EMBMIS that writes DDL for a generated application.
 *
 * ===========================================================================
 * THE CONTRACT
 * ===========================================================================
 * Input:  a plan operation produced by planner.js from a VALIDATED
 *         specification, plus resolved physical names.
 * Output: an array of complete SQL statements.
 *
 * Every statement is assembled from three kinds of piece and nothing else:
 *
 *   • Fixed English written in this file ("CREATE TABLE", "ADD COLUMN").
 *   • Identifiers passed through quoteIdent(), which refuses anything that is
 *     not already lowercase snake_case within the length limit.
 *   • Literals passed through quoteLiteral(), which doubles quotes.
 *
 * No value from a specification is interpolated raw. No SQL fragment from a
 * specification is accepted at all — the specification has no field in which
 * to put one, because the vocabulary has no such field.
 *
 * DDL cannot take bind parameters, which is exactly why this file exists as a
 * single narrow choke point rather than as string building spread across the
 * deployer. If you are adding a statement type, add it here, and add it to
 * planner.js's operation vocabulary, or it cannot be reached.
 *
 * WHAT EVERY GENERATED TABLE GETS, WHETHER THE SPECIFICATION ASKS OR NOT
 * ---------------------------------------------------------------------------
 *   id                       UUID primary key.
 *   company_id               the tenant. NOT NULL, FK, and the column the RLS
 *                            policy tests.
 *   app_instance_id          pinned by a CHECK to the ONE instance that owns
 *                            this table. Defence in depth: even if the
 *                            registry were corrupted to point another
 *                            instance at this table, the database would refuse
 *                            its writes.
 *   created_at/updated_at    every business record needs them; making the
 *                            application ask would mean some do not have them.
 *   created_by_user_id /     who made it — one of these, never both. An
 *   created_by_external_id   external portal user is not a `users` row, so the
 *                            authorship column cannot be one either.
 *   deleted_at               soft delete, so a record removed from an
 *                            application is still there for an audit.
 */

const {
  quoteIdent, quoteLiteral, qualifiedIdentifier, indexName, constraintName, foreignKeyName,
} = require('../identifiers');
const { FIELD_TYPES } = require('../spec/types');
const canonical = require('../spec/canonical');

const ON_DELETE_SQL = {
  restrict: 'RESTRICT',
  set_null: 'SET NULL',
  cascade: 'CASCADE',
};

/** The platform's own columns, in the order they appear on every table. */
function systemColumns(instanceId, companyId) {
  return [
    `${quoteIdent('id')} UUID PRIMARY KEY DEFAULT gen_random_uuid()`,
    `${quoteIdent('company_id')} UUID NOT NULL DEFAULT ${quoteLiteral(companyId)}::uuid REFERENCES companies(id) ON DELETE CASCADE`,
    `${quoteIdent('app_instance_id')} UUID NOT NULL DEFAULT ${quoteLiteral(instanceId)}::uuid REFERENCES app_company_instances(id) ON DELETE CASCADE`,
  ];
}

function trailingSystemColumns() {
  return [
    `${quoteIdent('created_at')} TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    `${quoteIdent('updated_at')} TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    `${quoteIdent('created_by_user_id')} UUID REFERENCES users(id) ON DELETE SET NULL`,
    `${quoteIdent('created_by_external_id')} UUID REFERENCES app_external_identities(id) ON DELETE SET NULL`,
    `${quoteIdent('updated_by_user_id')} UUID REFERENCES users(id) ON DELETE SET NULL`,
    `${quoteIdent('deleted_at')} TIMESTAMPTZ`,
  ];
}

/**
 * The physical columns one logical field becomes.
 *
 * Almost always one. `geo_point` is the exception: it becomes a latitude and a
 * longitude, because storing a location as two numerics keeps the platform free
 * of a PostGIS dependency, and because a pair of plain numbers is something
 * every downstream consumer already knows how to read.
 */
function fieldColumns(field) {
  const type = FIELD_TYPES[field.type];
  if (!type) throw new Error(`Unknown field type "${field.type}" reached the DDL compiler.`);

  if (field.type === 'geo_point') {
    return [
      { name: `${field.name}_lat`, sqlType: 'NUMERIC(9,6)', nullable: true },
      { name: `${field.name}_lng`, sqlType: 'NUMERIC(9,6)', nullable: true },
    ];
  }
  return [{ name: field.name, sqlType: type.sql, nullable: !field.required }];
}

function defaultClause(field) {
  if (field.default === undefined || field.default === null) return '';
  if (['date', 'datetime'].includes(field.type)) {
    if (field.default === 'now') return ` DEFAULT ${field.type === 'date' ? 'CURRENT_DATE' : 'CURRENT_TIMESTAMP'}`;
    return ` DEFAULT ${quoteLiteral(String(field.default))}::${field.type === 'date' ? 'date' : 'timestamptz'}`;
  }
  if (typeof field.default === 'number') return ` DEFAULT ${Number(field.default)}`;
  if (typeof field.default === 'boolean') return ` DEFAULT ${field.default ? 'TRUE' : 'FALSE'}`;
  return ` DEFAULT ${quoteLiteral(String(field.default))}`;
}

function columnDefinition(field) {
  return fieldColumns(field).map((col) => {
    let sql = `${quoteIdent(col.name)} ${col.sqlType}`;
    // A geo_point's halves are always nullable — a required location means both
    // halves present, which is a CHECK, not two NOT NULLs that could disagree.
    if (!col.nullable && field.type !== 'geo_point') sql += ' NOT NULL';
    sql += defaultClause(field);
    return sql;
  });
}

/** Table-level CHECK constraints a field implies: enums, formats, geo pairs. */
function fieldChecks(tableName, field) {
  const checks = [];
  const col = quoteIdent(field.name);

  if (field.type === 'enum' && field.values?.length) {
    checks.push({
      name: constraintName(tableName, 'chk', field.name),
      // The enum's allowed values become a database constraint, which is what
      // makes "a workflow state the workflow does not know" impossible to write
      // rather than merely unlikely.
      expression: `${col} IS NULL OR ${col} IN (${field.values.map(quoteLiteral).join(', ')})`,
    });
  }
  const typeDef = FIELD_TYPES[field.type];
  if (typeDef?.check) {
    checks.push({ name: constraintName(tableName, 'chk', field.name), expression: typeDef.check(col) });
  }
  if (field.type === 'geo_point') {
    const lat = quoteIdent(`${field.name}_lat`);
    const lng = quoteIdent(`${field.name}_lng`);
    checks.push({
      name: constraintName(tableName, 'chk', `${field.name}_range`),
      expression: `(${lat} IS NULL AND ${lng} IS NULL) OR (${lat} BETWEEN -90 AND 90 AND ${lng} BETWEEN -180 AND 180)`,
    });
    if (field.required) {
      checks.push({
        name: constraintName(tableName, 'chk', `${field.name}_required`),
        expression: `${lat} IS NOT NULL AND ${lng} IS NOT NULL`,
      });
    }
  }
  return checks;
}

/**
 * The foreign key a reference field becomes.
 *
 * A reference to another application entity points at that entity's physical
 * table in THE SAME INSTANCE — resolved by the caller and passed in, never
 * derived from the specification's own idea of a table name.
 */
function foreignKeyFor(tableName, field, resolveEntityTable) {
  if (field.type !== 'reference' || !field.target) return null;
  const action = ON_DELETE_SQL[field.target.on_delete] || 'RESTRICT';

  if (field.target.kind === 'canonical') {
    const entity = canonical.entity(field.target.entity);
    if (!entity) throw new Error(`Canonical entity "${field.target.entity}" reached the DDL compiler.`);
    return {
      name: foreignKeyName(tableName, field.name),
      column: field.name,
      references: `${quoteIdent(entity.table)}(${quoteIdent('id')})`,
      onDelete: action,
    };
  }
  const target = resolveEntityTable(field.target.entity);
  if (!target) throw new Error(`Application entity "${field.target.entity}" has no physical table in this instance.`);
  return {
    name: foreignKeyName(tableName, field.name),
    column: field.name,
    references: `${qualifiedIdentifier(target.schema, target.table)}(${quoteIdent('id')})`,
    onDelete: action,
  };
}

/**
 * Every index this compiler creates for an entity, by name.
 *
 * Shared with the planner deliberately. createTable() emits implicit indexes
 * that no specification asks for — company, instance, the soft-delete partial
 * index, and one per reference/enum column — and a planner that only knew about
 * the DECLARED indexes would look at a freshly created table and propose
 * dropping most of them. The two have to agree, so there is one function.
 */
function expectedIndexNames(tableName, entity) {
  const names = new Set([
    indexName(tableName, ['company_id']),
    indexName(tableName, ['instance']),
    indexName(tableName, ['live']),
  ]);

  const covered = new Set();
  (entity.fields || []).forEach((field) => {
    const wants = field.indexed || field.type === 'reference' || field.type === 'enum';
    if (!wants || field.unique) return;
    fieldColumns(field).forEach((col) => {
      if (covered.has(col.name)) return;
      covered.add(col.name);
      names.add(indexName(tableName, [col.name]));
    });
  });

  (entity.indexes || []).forEach((index) => {
    names.add(indexName(tableName, index.fields));
  });

  return names;
}

// ---------------------------------------------------------------------------
// Statement emitters. One per plan operation kind.
// ---------------------------------------------------------------------------

function createTable(op) {
  const { schema, table, entity, instanceId, companyId, resolveEntityTable } = op;
  const qualified = qualifiedIdentifier(schema, table);

  const columns = [
    ...systemColumns(instanceId, companyId),
    ...entity.fields.flatMap((f) => columnDefinition(f)),
    ...trailingSystemColumns(),
  ];

  const constraints = [
    // The instance pin. Without it, a table is protected only by company RLS —
    // which is already strong, but says nothing about WHICH application inside
    // that company may write here. With it, a bug that pointed application B's
    // runtime at application A's table produces a constraint violation instead
    // of a silent cross-application write.
    `CONSTRAINT ${quoteIdent(constraintName(table, 'chk', 'instance'))} CHECK (${quoteIdent('app_instance_id')} = ${quoteLiteral(instanceId)}::uuid)`,
    // Authorship is one or the other, never both: a record was created by an
    // employee or by a portal user, and a row claiming both is a bug worth
    // catching at write time.
    `CONSTRAINT ${quoteIdent(constraintName(table, 'chk', 'author'))} CHECK (NOT (${quoteIdent('created_by_user_id')} IS NOT NULL AND ${quoteIdent('created_by_external_id')} IS NOT NULL))`,
  ];

  entity.fields.forEach((field) => {
    fieldChecks(table, field).forEach((c) => {
      constraints.push(`CONSTRAINT ${quoteIdent(c.name)} CHECK (${c.expression})`);
    });
    if (field.unique) {
      // Unique WITHIN the table, which is already within one company and one
      // instance — so a plain UNIQUE is the right scope here, unlike on the
      // shared ERP tables where it must include company_id.
      constraints.push(`CONSTRAINT ${quoteIdent(constraintName(table, 'uq', field.name))} UNIQUE (${quoteIdent(field.name)})`);
    }
    // Only canonical foreign keys are inlined. A reference to another entity
    // of the same application points at a table that may not exist yet — and
    // two entities that reference each other could not be ordered at all — so
    // those arrive afterwards as add_foreign_key operations, once every table
    // in the plan is in place.
    if (field.type === 'reference' && field.target?.kind === 'canonical') {
      const fk = foreignKeyFor(table, field, resolveEntityTable);
      constraints.push(
        `CONSTRAINT ${quoteIdent(fk.name)} FOREIGN KEY (${quoteIdent(fk.column)}) REFERENCES ${fk.references} ON DELETE ${fk.onDelete}`
      );
    }
  });

  (op.checkConstraints || []).forEach((c) => {
    constraints.push(`CONSTRAINT ${quoteIdent(c.name)} CHECK (${c.expression})`);
  });

  const statements = [
    `CREATE TABLE ${qualified} (\n  ${[...columns, ...constraints].join(',\n  ')}\n)`,
  ];

  // Indexes. Company and instance first — every query the runtime issues is
  // filtered on both, so they are not optional.
  statements.push(`CREATE INDEX ${quoteIdent(indexName(table, ['company_id']))} ON ${qualified} (${quoteIdent('company_id')})`);
  statements.push(`CREATE INDEX ${quoteIdent(indexName(table, ['instance']))} ON ${qualified} (${quoteIdent('app_instance_id')}, ${quoteIdent('created_at')} DESC)`);

  const indexed = new Set();
  entity.fields.forEach((field) => {
    // Every reference gets an index: a foreign key without one turns the parent
    // side's delete and every join into a sequential scan.
    const wants = field.indexed || field.type === 'reference' || field.type === 'enum';
    if (!wants || field.unique) return;
    fieldColumns(field).forEach((col) => {
      if (indexed.has(col.name)) return;
      indexed.add(col.name);
      statements.push(`CREATE INDEX ${quoteIdent(indexName(table, [col.name]))} ON ${qualified} (${quoteIdent(col.name)})`);
    });
  });
  (entity.indexes || []).forEach((index) => {
    const cols = index.fields.map((f) => quoteIdent(f)).join(', ');
    statements.push(
      `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(indexName(table, index.fields))} ON ${qualified} (${cols})`
    );
  });
  // Soft-deleted rows are excluded from every read; a partial index keeps that
  // filter from costing a scan.
  statements.push(`CREATE INDEX ${quoteIdent(indexName(table, ['live']))} ON ${qualified} (${quoteIdent('app_instance_id')}) WHERE ${quoteIdent('deleted_at')} IS NULL`);

  statements.push(`COMMENT ON TABLE ${qualified} IS ${quoteLiteral(
    `EMBMIS application entity "${entity.key}" (${entity.label}) for application instance ${instanceId}. Created by the platform schema compiler; do not edit by hand.`
  )}`);

  return statements;
}

function addColumn(op) {
  const qualified = qualifiedIdentifier(op.schema, op.table);
  const statements = [];
  columnDefinition(op.field).forEach((definition) => {
    statements.push(`ALTER TABLE ${qualified} ADD COLUMN ${definition}`);
  });
  fieldChecks(op.table, op.field).forEach((c) => {
    statements.push(`ALTER TABLE ${qualified} ADD CONSTRAINT ${quoteIdent(c.name)} CHECK (${c.expression})`);
  });
  if (op.field.unique) {
    statements.push(`ALTER TABLE ${qualified} ADD CONSTRAINT ${quoteIdent(constraintName(op.table, 'uq', op.field.name))} UNIQUE (${quoteIdent(op.field.name)})`);
  }
  const fk = foreignKeyFor(op.table, op.field, op.resolveEntityTable);
  if (fk) {
    statements.push(
      `ALTER TABLE ${qualified} ADD CONSTRAINT ${quoteIdent(fk.name)} FOREIGN KEY (${quoteIdent(fk.column)}) REFERENCES ${fk.references} ON DELETE ${fk.onDelete}`
    );
  }
  if (op.field.indexed || op.field.type === 'reference' || op.field.type === 'enum') {
    fieldColumns(op.field).forEach((col) => {
      statements.push(`CREATE INDEX ${quoteIdent(indexName(op.table, [col.name]))} ON ${qualified} (${quoteIdent(col.name)})`);
    });
  }
  return statements;
}

function addForeignKey(op) {
  const qualified = qualifiedIdentifier(op.schema, op.table);
  const fk = foreignKeyFor(op.table, op.field, op.resolveEntityTable);
  if (!fk) return [];
  return [
    `ALTER TABLE ${qualified} ADD CONSTRAINT ${quoteIdent(fk.name)} FOREIGN KEY (${quoteIdent(fk.column)}) REFERENCES ${fk.references} ON DELETE ${fk.onDelete}`,
  ];
}

function dropConstraint(op) {
  return [`ALTER TABLE ${qualifiedIdentifier(op.schema, op.table)} DROP CONSTRAINT IF EXISTS ${quoteIdent(op.constraint)}`];
}

function dropColumn(op) {
  const qualified = qualifiedIdentifier(op.schema, op.table);
  return op.columns.map((c) => `ALTER TABLE ${qualified} DROP COLUMN ${quoteIdent(c)}`);
}

function alterColumnType(op) {
  const qualified = qualifiedIdentifier(op.schema, op.table);
  const type = FIELD_TYPES[op.field.type];
  // USING with an explicit cast rather than relying on an implicit one: TEXT to
  // NUMERIC has no implicit cast at all, and the failure mode of guessing is a
  // migration that aborts halfway through a deployment.
  return [
    `ALTER TABLE ${qualified} ALTER COLUMN ${quoteIdent(op.field.name)} TYPE ${type.sql} USING ${quoteIdent(op.field.name)}::${type.sql}`,
  ];
}

function setColumnNullability(op) {
  const qualified = qualifiedIdentifier(op.schema, op.table);
  return [
    `ALTER TABLE ${qualified} ALTER COLUMN ${quoteIdent(op.column)} ${op.required ? 'SET' : 'DROP'} NOT NULL`,
  ];
}

function replaceCheck(op) {
  const qualified = qualifiedIdentifier(op.schema, op.table);
  const statements = [`ALTER TABLE ${qualified} DROP CONSTRAINT IF EXISTS ${quoteIdent(op.constraint)}`];
  if (op.expression) {
    statements.push(`ALTER TABLE ${qualified} ADD CONSTRAINT ${quoteIdent(op.constraint)} CHECK (${op.expression})`);
  }
  return statements;
}

function createIndex(op) {
  const qualified = qualifiedIdentifier(op.schema, op.table);
  const cols = op.columns.map((c) => quoteIdent(c)).join(', ');
  return [`CREATE ${op.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quoteIdent(op.name)} ON ${qualified} (${cols})`];
}

function dropIndex(op) {
  return [`DROP INDEX IF EXISTS ${quoteIdent(op.schema)}.${quoteIdent(op.name)}`];
}

function dropTable(op) {
  // No CASCADE. A table that something still references is a table whose drop
  // needs a person to look at it, not one the compiler should force through.
  return [`DROP TABLE ${qualifiedIdentifier(op.schema, op.table)}`];
}

/**
 * Row-level security for a freshly created table.
 *
 * Applied in the same transaction as the CREATE, so there is no window in which
 * the table exists without its policy. The policy is byte-for-byte the one
 * enable_multi_company() applies to every other company-scoped table — the
 * platform does not invent a second tenant boundary, it joins the existing one.
 */
function enableRowLevelSecurity(op) {
  const qualified = qualifiedIdentifier(op.schema, op.table);
  return [
    `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS ${quoteIdent('company_isolation')} ON ${qualified}`,
    `CREATE POLICY ${quoteIdent('company_isolation')} ON ${qualified}
       USING (${quoteIdent('company_id')} = public.current_company_id())
       WITH CHECK (${quoteIdent('company_id')} = public.current_company_id())`,
  ];
}

/**
 * Grants for the restricted application role.
 *
 * ALTER DEFAULT PRIVILEGES covers tables created by the migration owner, but a
 * table created at runtime by the deployer needs the grant explicitly, and a
 * missing grant fails as "permission denied" the first time a user opens the
 * application — long after the deployment reported success.
 */
function grantToAppRole(op) {
  if (!op.role) return [];
  const qualified = qualifiedIdentifier(op.schema, op.table);
  return [`GRANT SELECT, INSERT, UPDATE, DELETE ON ${qualified} TO ${quoteIdent(op.role)}`];
}

const EMITTERS = {
  create_table: createTable,
  add_column: addColumn,
  add_foreign_key: addForeignKey,
  drop_constraint: dropConstraint,
  drop_column: dropColumn,
  alter_column_type: alterColumnType,
  set_column_nullability: setColumnNullability,
  replace_check: replaceCheck,
  create_index: createIndex,
  drop_index: dropIndex,
  drop_table: dropTable,
  enable_rls: enableRowLevelSecurity,
  grant_app_role: grantToAppRole,
};

/**
 * Turn one plan operation into SQL.
 *
 * Fails closed on an unknown kind. There is no default branch, because a
 * default branch is how an operation nobody reviewed would still execute.
 */
function emit(op) {
  const emitter = Object.prototype.hasOwnProperty.call(EMITTERS, op.kind) ? EMITTERS[op.kind] : null;
  if (!emitter) {
    throw new Error(`No DDL emitter for plan operation "${op.kind}". The compiler refuses operations it does not implement.`);
  }
  return emitter(op);
}

module.exports = {
  emit,
  EMITTERS,
  expectedIndexNames,
  fieldColumns,
  columnDefinition,
  fieldChecks,
  foreignKeyFor,
  systemColumns,
  trailingSystemColumns,
  ON_DELETE_SQL,
};
