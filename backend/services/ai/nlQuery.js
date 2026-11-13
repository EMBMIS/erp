/**
 * Natural-language query interface for reporting.
 *
 * Lets a user ask "which customers owe us more than 10k and are over 60 days
 * late?" and get a real answer from the ledger, instead of an approximation
 * assembled from whatever fixed tools happen to exist.
 *
 * SECURITY POSTURE — this is the one feature in the AI surface that turns model
 * output into SQL, so the model is treated as an untrusted input source, not as
 * an authority. Generated SQL passes a deny-by-default gauntlet before it runs:
 *
 *   1. Single statement only (no stacked queries).
 *   2. Must be a SELECT/WITH — never DML or DDL.
 *   3. Forbidden-construct scan (writes, DDL, COPY, file/large-object access,
 *      dblink, set-returning system functions, privilege changes).
 *   4. Table ALLOWLIST — every relation referenced must be explicitly listed.
 *      Tables holding credentials and tokens are absent by construction, so a
 *      prompt-injected "read the users table" cannot succeed.
 *   5. Executed on a READ ONLY transaction with a statement timeout and a hard
 *      row cap, then rolled back.
 *
 * The allowlist is the load-bearing control: even a perfect jailbreak of the
 * model yields SQL that is rejected before it reaches the database. Layers 1-3
 * are defence in depth, not the primary barrier.
 */

const { pool } = require('../../config/database');

// ---------------------------------------------------------------------------
// Allowlist — business reporting surface only.
// Deliberately EXCLUDES: users, api_keys, webhooks, *_token* columns/tables,
// sessions, ai_audit_log, schema_migrations.
// ---------------------------------------------------------------------------
const ALLOWED_TABLES = new Set([
  'chart_of_accounts',
  'journal_entries',
  'journal_entry_items',
  'customers',
  'customer_invoices',
  'customer_payments',
  'suppliers',
  'supplier_invoices',
  'supplier_payments',
  'purchase_orders',
  'purchase_order_line_items',
  'purchase_requisitions',
  'goods_receipts',
  'sales_orders',
  'sales_quotations',
  'sales_contracts',
  'inventory_items',
  'items',
  'warehouse_transactions',
  'inventory_transfers',
  'storage_locations',
  'bins',
  'employees',
  'fixed_assets',
  'bank_accounts',
  'bank_transactions',
  'accounting_periods',
  'cost_centers',
  'budgets',
  'currencies',
  'delivery_schedules',
  'ai_findings',
]);

// Columns never worth exposing even on allowed tables.
// Matched as a SUBSTRING, not a whole word: the sensitive columns here are
// snake_case identifiers like `supplier_delivery_token` and `reset_password_hash`,
// and `\btoken\b` does not match inside them because `_` is a word character.
// Those portal tokens authenticate supplier access, so leaking one via a report
// query would be a genuine account-takeover path.
const SENSITIVE_COLUMN_PATTERN = /(password|token|secret|api_key|apikey|private_key|salt|credential)/i;

const FORBIDDEN_PATTERN = new RegExp(
  [
    '\\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|reindex|vacuum)\\b',
    '\\b(copy|lo_import|lo_export|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file)\\b',
    '\\b(dblink|postgres_fdw|pg_sleep)\\b',
    '\\bpg_(shadow|authid|user_mapping|settings|read)',
    '\\binto\\s+(outfile|dumpfile)\\b',
    '\\bsecurity\\s+definer\\b',
    '\\bdo\\s*\\$\\$',
  ].join('|'),
  'i'
);


const MAX_ROWS = 500;
const STATEMENT_TIMEOUT_MS = 10000;

/** Remove SQL comments so they cannot hide forbidden constructs from the scan. */
function stripComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/** Extract every relation name referenced after FROM / JOIN / UPDATE / INTO. */
function referencedTables(sql) {
  const found = new Set();
  const re = /\b(?:from|join|into|update)\s+([a-zA-Z_][a-zA-Z0-9_$]*(?:\s*\.\s*[a-zA-Z_][a-zA-Z0-9_$]*)?)/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    let ref = m[1].toLowerCase().replace(/\s+/g, '');
    // Strip an explicit schema qualifier, but only the public one; anything
    // else (pg_catalog, information_schema) must fail the allowlist.
    if (ref.startsWith('public.')) ref = ref.slice('public.'.length);
    found.add(ref);
  }
  return [...found];
}

/**
 * Validate model-generated SQL. Returns {ok:true, sql} or {ok:false, reason}.
 * Deny by default: anything not positively recognised is rejected.
 */
function validateSql(rawSql) {
  if (!rawSql || typeof rawSql !== 'string') {
    return { ok: false, reason: 'No SQL was produced.' };
  }

  let sql = rawSql.trim().replace(/;\s*$/, '');
  const scan = stripComments(sql);

  if (!scan.trim()) return { ok: false, reason: 'The query was empty after removing comments.' };

  // 1. Single statement.
  if (scan.includes(';')) {
    return { ok: false, reason: 'Multiple SQL statements are not allowed.' };
  }

  // 2. Read-only shape.
  if (!/^\s*(select|with)\b/i.test(scan)) {
    return { ok: false, reason: 'Only SELECT queries are allowed.' };
  }

  // 3. Forbidden constructs.
  const forbidden = scan.match(FORBIDDEN_PATTERN);
  if (forbidden) {
    return { ok: false, reason: `Query contains a forbidden construct: "${forbidden[0]}".` };
  }

  if (SENSITIVE_COLUMN_PATTERN.test(scan)) {
    return { ok: false, reason: 'Query references a credential-bearing column.' };
  }

  // 4. Table allowlist. CTE names are legitimate FROM targets, so collect and
  //    exempt them — but only names actually defined by a WITH clause.
  const cteNames = new Set();
  const cteRe = /\b(?:with|,)\s+([a-zA-Z_][a-zA-Z0-9_$]*)\s+as\s*\(/gi;
  let c;
  while ((c = cteRe.exec(scan)) !== null) cteNames.add(c[1].toLowerCase());

  const tables = referencedTables(scan);
  const disallowed = tables.filter((t) => !ALLOWED_TABLES.has(t) && !cteNames.has(t));
  if (disallowed.length) {
    return {
      ok: false,
      reason: `Query references table(s) outside the reporting allowlist: ${disallowed.join(', ')}.`,
    };
  }
  if (!tables.length) {
    return { ok: false, reason: 'Query does not reference any known reporting table.' };
  }

  // 5. Hard row cap.
  //
  // A parameterised limit (`LIMIT $1`) counts as a limit. Matching only a
  // numeric literal here meant appending a SECOND LIMIT clause to any query
  // that bound its row count, which is a guaranteed syntax error — it broke the
  // tool builder's own starter template and every saved report with a limit
  // parameter. Leaving the bind in place is safe because the cap does not rest
  // on this line: runReadOnly slices to MAX_ROWS regardless of what the query
  // asked for, under a statement timeout, in a READ ONLY transaction.
  if (!/\blimit\s+(\d+|\$\d+)/i.test(scan)) {
    sql = `${sql}\nLIMIT ${MAX_ROWS}`;
  }

  return { ok: true, sql };
}

/**
 * Strip credential-bearing columns from a result set.
 *
 * Rejecting the column NAME in validateSql is not sufficient on its own:
 * `SELECT * FROM purchase_orders` never mentions `supplier_delivery_token` yet
 * returns it. Redacting on the way out closes that, and covers any future table
 * that gains a sensitive column without the allowlist being revisited.
 */
function redactRows(rows) {
  if (!rows.length) return { rows, redacted: [] };
  const sensitive = Object.keys(rows[0]).filter((c) => SENSITIVE_COLUMN_PATTERN.test(c));
  if (!sensitive.length) return { rows, redacted: [] };
  const cleaned = rows.map((r) => {
    const copy = { ...r };
    sensitive.forEach((c) => { copy[c] = '[redacted]'; });
    return copy;
  });
  return { rows: cleaned, redacted: sensitive };
}

/**
 * Execute validated SQL under a read-only transaction with a timeout.
 * Even if validation were bypassed, READ ONLY makes a write impossible.
 *
 * `params` carries bind values for saved reports with declared parameters
 * (services/reportService.js). They are bound by the driver, never spliced into
 * the SQL text — a report whose date range was string-concatenated would hand
 * every user of that report an injection point, and saved reports are exactly
 * the queries that get shared and re-run.
 */
async function runReadOnly(sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const companyScope = require('../companyScope');
    const cid = companyScope.currentCompanyId();
    if (cid && /^[0-9a-fA-F-]{36}$/.test(cid)) {
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [cid]);
    }

    const result = await client.query(sql, params);
    const { rows, redacted } = redactRows(result.rows.slice(0, MAX_ROWS));
    return {
      rows,
      redacted_columns: redacted,
      row_count: result.rowCount,
      truncated: result.rowCount > MAX_ROWS,
      columns: result.fields?.map((f) => f.name) || [],
    };
  } finally {
    // ALWAYS end the transaction before handing the connection back. A failed
    // statement leaves the session in an aborted transaction; releasing it in
    // that state poisons the pooled connection and every later query on it dies
    // with "current transaction is aborted". Rejected queries are the expected
    // case here, not the exception, so this path is hot.
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Schema description handed to the model
// ---------------------------------------------------------------------------
async function reportingSchema() {
  const { rows } = await pool.query(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name, ordinal_position`,
    [[...ALLOWED_TABLES]]
  );
  const byTable = new Map();
  for (const r of rows) {
    if (SENSITIVE_COLUMN_PATTERN.test(r.column_name)) continue;
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
    byTable.get(r.table_name).push(`${r.column_name} ${r.data_type}`);
  }
  return [...byTable.entries()].map(([t, cols]) => `${t}(${cols.join(', ')})`).join('\n');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Answer a natural-language reporting question.
 *
 * @param {string} question
 * @param {object} opts {explain: boolean} — also produce a plain-English summary
 * @returns {{answered, sql, rows, explanation, error}}
 */
async function ask(question, { explain = true } = {}) {
  const q = String(question || '').trim();
  if (!q) return { answered: false, error: 'Please provide a question.' };

  const { getOpenAIClient, AI_MODEL, isAIEnabled } = require('../../config/aiConfig');
  const { safeJsonParse } = require('../aiJson');
  const { classifyAiError } = require('./errorClassifier');

  if (!isAIEnabled()) {
    return { answered: false, error: 'The AI service is not configured.', ai_unavailable: true };
  }

  let sqlCandidate;
  try {
    const schema = await reportingSchema();
    const client = getOpenAIClient();
    const completion = await client.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You translate business questions into a single read-only PostgreSQL SELECT query.\n' +
            'Rules:\n' +
            '- Output JSON: {"sql": "...", "assumptions": "..."}\n' +
            '- Exactly ONE SELECT statement. No semicolons, no DML, no DDL.\n' +
            '- Only use the tables and columns given below. Never guess a column.\n' +
            '- Soft-deleted rows: exclude with "deleted_at IS NULL" where that column exists.\n' +
            '- Only POSTED journal entries represent real financial fact.\n' +
            '- Always include a LIMIT (max ' + MAX_ROWS + ').\n' +
            '- If the question cannot be answered from this schema, return {"sql": null, "assumptions": "why not"}.\n\n' +
            `Schema:\n${schema}`,
        },
        { role: 'user', content: q },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 800,
    });

    const parsed = safeJsonParse(completion.choices?.[0]?.message?.content);
    if (!parsed || !parsed.sql) {
      return {
        answered: false,
        error: parsed?.assumptions || 'The question could not be turned into a query over the available data.',
      };
    }
    sqlCandidate = { sql: parsed.sql, assumptions: parsed.assumptions };
  } catch (err) {
    const classified = classifyAiError(err);
    return { answered: false, error: classified.userMessage, ai_unavailable: true, retryable: classified.retryable };
  }

  const validation = validateSql(sqlCandidate.sql);
  if (!validation.ok) {
    // Surface the rejected SQL: a blocked query is a security event worth seeing.
    return {
      answered: false,
      error: `Generated query was rejected by the safety check: ${validation.reason}`,
      rejected_sql: sqlCandidate.sql,
    };
  }

  let data;
  try {
    data = await runReadOnly(validation.sql);
  } catch (err) {
    return { answered: false, error: `Query failed: ${err.message}`, sql: validation.sql };
  }

  const result = {
    answered: true,
    question: q,
    sql: validation.sql,
    assumptions: sqlCandidate.assumptions || null,
    columns: data.columns,
    rows: data.rows,
    row_count: data.row_count,
    truncated: data.truncated,
  };

  if (explain && data.rows.length) {
    result.explanation = await explainResults(q, data).catch(() => null);
  }
  return result;
}

/** Plain-English summary of rows the model did not invent. */
async function explainResults(question, data) {
  const { getOpenAIClient, AI_MODEL } = require('../../config/aiConfig');
  const client = getOpenAIClient();
  const sample = data.rows.slice(0, 30);
  const completion = await client.chat.completions.create({
    model: AI_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'Summarise these query results for a finance user in 1-3 sentences. ' +
          'Use ONLY the numbers present in the data. Never estimate, extrapolate or add figures that are not shown. ' +
          'If the result set is empty or truncated, say so.',
      },
      {
        role: 'user',
        content: `Question: ${question}\nRows returned: ${data.row_count}\nData (first ${sample.length}):\n${JSON.stringify(sample)}`,
      },
    ],
    max_tokens: 300,
  });
  return completion.choices?.[0]?.message?.content?.trim() || null;
}

module.exports = {
  ask,
  validateSql,
  runReadOnly,
  reportingSchema,
  ALLOWED_TABLES,
  MAX_ROWS,
};
