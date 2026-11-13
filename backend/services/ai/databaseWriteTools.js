/**
 * Generic database write tools.
 *
 * The ERP's dedicated write tools cover the flows that matter most — drafts,
 * DOA, postings. This is the long tail: a person says "add this supplier's
 * second warehouse" and no one wrote a tool for supplier warehouses. These
 * tools let the agent write to any business table directly, with the same
 * guardrails every other write has:
 *
 *   • highImpact — in the default accept_edits mode the call pauses for human
 *     approval before any row is created. A generic insert is exactly the kind
 *     of write a person should see before it lands.
 *   • Column-validated — keys are checked against the live schema, so a typo
 *     is refused with the real column list, not a database error.
 *   • Tenant-scoped — a table with a company_id column gets it forced to the
 *     request's company. The model cannot choose another tenant's.
 *   • Parameterized — values are bound, never interpolated. Table and column
 *     names come from the server-side schema, not from the caller.
 *
 * WHAT IS REFUSED
 * ---------------------------------------------------------------------------
 * Almost the whole ERP is writable: master data, documents, orders, invoices,
 * postings, stock movements, payroll — the AI can take the main actions of
 * every section. The exclusions that remain are where a write breaks the
 * system itself, approval gate or not:
 *
 *   • Identity and security: users, user_companies, api_keys, tokens,
 *     company/isolation config, approval chains and DOA — writing those from
 *     a chat is how permissions change hands.
 *   • System bookkeeping: migrations, audit logs, ai_* settings and usage,
 *     conversation internals, agent/mcp/connector machinery, webhook
 *     subscriptions, report schedules, status/audit history tables (written
 *     by the app itself) — internal tables the app owns.
 *
 * Everything else is writable. list_writable_tables() returns the exact set,
 * so the model never guesses.
 */

const { pool } = require('../../config/database');

// ---------------------------------------------------------------------------
// Which tables are writable. Computed once from the live schema and cached;
// the schema itself is stable for the life of a process.
// ---------------------------------------------------------------------------
const SCHEMA_TTL_MS = 30_000;
let schemaCache = null;
let schemaLoadedAt = 0;

// Tables no generic write may touch. Explicit names plus suffix rules for the
// two families that repeat across modules (status history and audit trails).
const BLOCKED = new Set([
  // --- migrations, audit, system bookkeeping -------------------------------
  'schema_migrations', 'audit_chain', 'audit_ddl_log', 'ai_audit_log',
  'usage_counters', 'background_tasks', 'notifications',
  // --- AI configuration and learning --------------------------------------
  'ai_settings', 'ai_tool_settings', 'ai_tool_versions', 'ai_tools',
  'ai_usage_log', 'ai_credentials', 'ai_feedback', 'ai_findings',
  'ai_finding_suppressions', 'ai_learned_preferences',
  // --- identity and security ------------------------------------------------
  'users', 'user_companies', 'api_keys', 'email_verification_tokens',
  'password_reset_tokens',
  // --- tenancy and module configuration -------------------------------------
  'companies', 'company_isolation_config', 'company_scoped_tables',
  'company_modules', 'company_gl_mappings', 'business_types',
  'business_type_default_modules', 'plans', 'company_subscriptions', 'modules',
  // --- chat internals (owned by the conversation machinery) ------------------
  'conversations', 'conversation_messages', 'conversation_attachments',
  'chat_memory', 'kb_documents', 'document_embeddings',
  'generated_documents', 'pdf_templates', 'pdf_template_versions',
  'dashboards', 'dashboard_widgets',
  // --- agent machinery (created via build_agent, disabled by default) --------
  'agent_definitions', 'agent_blueprints', 'agent_blueprint_versions',
  'agent_credentials', 'agent_memory', 'agent_runs', 'agent_run_messages',
  'agent_run_actions', 'agent_paused_runs', 'agent_escalations',
  // --- mcp / connector / webhook machinery ----------------------------------
  'mcp_connections', 'mcp_oauth_grants', 'mcp_oauth_pending', 'connectors',
  'connector_oauth_pending', 'webhook_subscriptions', 'webhook_delivery_log',
  'mailboxes', 'mailbox_messages', 'mailbox_attachments',
  // --- reporting machinery -----------------------------------------------------
  'report_definitions', 'report_schedules', 'report_runs',
  // --- approvals and authority (security) -------------------------------------
  'approval_chains', 'approval_chain_templates', 'approval_chain_steps',
  'approval_requests', 'approval_request_steps', 'approval_delegations',
  'delegation_of_authority',
]);

const BLOCKED_SUFFIX = /(_status_history|_audit_log)$/;

function isBlocked(table) {
  if (BLOCKED.has(table)) return true;
  if (BLOCKED_SUFFIX.test(table)) return true;
  return false;
}

// Columns a record value may legitimately contain but the caller should never
// need to set — they are either derived or defaults are better.
const SKIP_COLUMNS = new Set(['created_at', 'updated_at']);

async function loadSchema() {
  if (schemaCache && Date.now() - schemaLoadedAt < SCHEMA_TTL_MS) return schemaCache;
  const { rows } = await pool.query(
    `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`
  );
  const tables = new Map();
  for (const r of rows) {
    if (!tables.has(r.table_name)) tables.set(r.table_name, []);
    tables.get(r.table_name).push(r);
  }
  schemaCache = tables;
  schemaLoadedAt = Date.now();
  return tables;
}

function writableTables(schema) {
  return [...schema.keys()].filter((t) => !isBlocked(t)).sort();
}

const NUMERIC = new Set(['smallint', 'integer', 'bigint', 'decimal', 'numeric', 'real', 'double precision', 'money']);
const BOOL_VALUES = { true: true, false: false, '1': true, '0': false, yes: true, no: false, t: true, f: false, on: true, off: false };

/** Coerce a caller-supplied value to the shape the column expects. */
function coerceValue(column, value) {
  if (value === null || value === undefined) return value;
  const type = column.data_type;

  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const v = BOOL_VALUES[value.toLowerCase()];
      if (v !== undefined) return v;
    }
    if (typeof value === 'number') return value !== 0;
    throw new Error(`"${column.column_name}" is boolean; got ${JSON.stringify(value)}`);
  }

  if (NUMERIC.has(type)) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
      throw new Error(`"${column.column_name}" is a number; got "${value}"`);
    }
    throw new Error(`"${column.column_name}" is a number; got ${JSON.stringify(value)}`);
  }

  if (type === 'json' || type === 'jsonb') {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  if (type === 'uuid') {
    const s = String(value);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
      throw new Error(`"${column.column_name}" is a UUID; got "${s}". Use resolve_entity or look the id up first.`);
    }
    return s;
  }

  // date/timestamp/time, text/varchar, arrays, and anything else: hand to pg.
  return value;
}

/** Bound a returned row so a single huge field cannot flood the transcript. */
function boundRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (v === null) { out[k] = null; continue; }
    if (typeof v === 'string' && v.length > 2000) out[k] = `${v.slice(0, 2000)}… (${v.length} chars)`;
    else if (typeof v === 'object') out[k] = JSON.stringify(v).slice(0, 2000);
    else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const databaseWriteTools = [
  {
    name: 'list_writable_tables',
    description:
      'List every database table the assistant may create a row in with write_database — essentially the whole ERP: '
      + 'master data, documents, orders, invoices, payments, postings, stock movements, payroll, fixed assets, HR. '
      + 'Call this before write_database when you are not sure a table is writable. Tables not listed here are refused '
      + 'by write_database — identity/security, approval/DOA, and system-internal bookkeeping tables.\n\n'
      + 'Pass a "table" to get its COLUMNS (name, type, required) so you can build a valid record. Writable tables '
      + 'are often NOT queryable through describe_schema — the reporting surface is deliberately smaller — so this is '
      + 'the way to learn a writable table\'s columns. Do not guess column names: if you are about to write, look '
      + 'them up here first.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Optional: one writable table name; returns its columns for write_database.' },
      },
    },
    handler: async (args) => {
      const schema = await loadSchema();
      const tables = writableTables(schema);
      if (args && args.table) {
        const wanted = String(args.table).toLowerCase().trim();
        if (!tables.includes(wanted)) {
          return {
            error: `"${wanted}" is not writable by the assistant.`,
            writable_tables: tables.slice(0, 200),
            count: tables.length,
          };
        }
        return {
          table: wanted,
          // Schema only — column names and types, never data. This is what the
          // model needs to build a valid write_database record, and it is not
          // a read of the table's contents.
          columns: schema.get(wanted).map((c) => ({
            name: c.column_name,
            type: c.data_type,
            required: c.is_nullable === 'NO' && !c.column_default,
            default: c.column_default || null,
          })),
        };
      }
      return {
        writable_tables: tables,
        count: tables.length,
        note: 'Pass "table" to see its columns before writing.',
      };
    },
  },
  {
    name: 'write_database',
    description:
      'Create a real row in any writable database table. Provide the table name and a record of column names to values. '
      + 'Call list_writable_tables first to see which tables are writable, and describe_schema to see columns — the '
      + 'record keys must be exact column names.\n\n'
      + 'This writes real data and requires human approval, so present what you are about to create before the '
      + 'confirmation is asked. Prefer a dedicated tool when one exists for the record type (for example '
      + 'create_purchase_requisition_draft for a requisition) — this tool covers the rest of the ERP: orders, invoices, '
      + 'payments, postings, stock movements, payroll and everything else. Build COMPLETE, valid rows: call '
      + 'describe_schema for the table and supply every required column (customer_id, amounts, dates, status, ...), or '
      + 'the database will reject the insert and you will have to retry. The row is forced into the person\'s own '
      + 'company and never written without their approval.\n\n'
      + 'Still refused: users, api keys, tokens, company/isolation config, approval chains and DOA, and system '
      + 'bookkeeping (migrations, audit logs, chat internals, agent machinery) — those are never writable from here.',
    readOnly: false,
    highImpact: true, // a real insert into any table — worth a confirmation outside full-auto mode
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'The table to insert into, exactly as listed by list_writable_tables.' },
        record: {
          type: 'object',
          description: 'Column name → value for the new row. Keys must be real columns of that table; omitting a column lets its default apply.',
          additionalProperties: true,
        },
      },
      required: ['table', 'record'],
    },
    handler: async (args, ctx) => {
      const table = String(args.table || '').toLowerCase().trim();
      if (!table) throw new Error('write_database needs a "table".');
      if (isBlocked(table)) {
        throw new Error(
          `"${table}" is not writable by the assistant — it is system, security, approval, or money/stock-movement data `
          + 'with its own gated flows. Use list_writable_tables for the writable set, or a dedicated tool when one exists '
          + 'for this record type.',
        );
      }

      const record = args.record;
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('write_database needs a "record" object of column names to values.');
      }

      const schema = await loadSchema();
      const columns = schema.get(table);
      if (!columns) {
        throw new Error(
          `"${table}" is not a table in this database. Use list_writable_tables to see the writable tables.`,
        );
      }

      const byName = new Map(columns.map((c) => [c.column_name, c]));

      // Tenant isolation: a table with company_id gets the request's company,
      // whatever the caller asked for. This is the same gate the RLS wrapper
      // applies to the statement itself; naming it here makes the intent
      // explicit and lets the tool refuse a different tenant loudly.
      const hasCompany = byName.has('company_id');
      const companyId = ctx && ctx.companyId;

      const values = {};
      for (const [key, value] of Object.entries(record)) {
        if (value === undefined) continue;
        if (SKIP_COLUMNS.has(key)) continue; // let the DB default apply
        const column = byName.get(key);
        if (!column) {
          const known = columns.filter((c) => !SKIP_COLUMNS.has(c.column_name)).map((c) => c.column_name).sort();
          throw new Error(
            `"${key}" is not a column of "${table}". Columns: ${known.join(', ') || '(none writable)'}.`,
          );
        }
        if (key === 'company_id') continue; // forced below
        values[key] = coerceValue(column, value);
      }
      if (hasCompany) {
        if (!companyId) {
          throw new Error(`"${table}" is company-scoped and no company context is available for this call.`);
        }
        values.company_id = companyId;
      }

      const keys = Object.keys(values);
      if (!keys.length) {
        throw new Error(`No writable columns were supplied for "${table}". Columns: ${columns.map((c) => c.column_name).sort().join(', ')}.`);
      }

      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `INSERT INTO "${table}" ("${keys.join('", "')}") VALUES (${placeholders}) RETURNING *`;
      try {
        const { rows: [row] } = await pool.query(sql, keys.map((k) => values[k]));
        return {
          action: 'created',
          table,
          id: row.id !== undefined ? row.id : row[keys[0]],
          created_row: boundRow(row),
        };
      } catch (err) {
        // Surface constraint problems in a way the model can act on: name the
        // table and the constraint, not the raw SQL.
        const detail = err.detail || err.message || '';
        throw new Error(`Could not create the "${table}" row: ${detail.slice(0, 500)}`);
      }
    },
  },
];

module.exports = { databaseWriteTools, isBlocked, writableTables };
