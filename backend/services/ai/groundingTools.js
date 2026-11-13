/**
 * Grounding — who the agent is talking about, and when.
 *
 * TWO PROBLEMS THIS SOLVES
 * ---------------------------------------------------------------------------
 * 1. THE AGENT DID NOT KNOW YOUR CURRENCY. Asked what was outstanding on
 *    receivables, it answered "$0" — because no tool result carries a currency,
 *    so the model supplied a symbol from nowhere. Harmless at zero; wrong the
 *    moment there is a balance and the ledger is in euros. The fix is not a
 *    formatting rule, it is telling the agent what the company's currency
 *    actually is, from the companies table.
 *
 * 2. THE AGENT COULD NOT NAME ANYTHING. Every write tool takes a UUID. A person
 *    says "Northern Ltd" and "the Riverside project", and the agent had no way
 *    to turn either into an id — so either the person had to paste UUIDs, or
 *    the model had to guess one, which is the worst available outcome.
 *    resolve_entity does the lookup, returns candidates when a name is
 *    ambiguous, and never picks for you when it is.
 *
 * Neither is a clever capability. Both are the difference between an agent that
 * can act on your business and one that can only talk about it.
 */

const { pool } = require('../../config/database');

/**
 * Company context, read once per turn and put in front of the model.
 *
 * Deliberately small: currency, today's date, and which accounting periods are
 * open. Everything else it can ask for. A system prompt that carries the whole
 * company record is one the model stops reading.
 */
async function companyContext(companyId) {
  const out = { today: new Date().toISOString().slice(0, 10) };

  if (!companyId) return out;

  try {
    const { rows } = await pool.query(
      `SELECT name, base_currency, country, fiscal_year_start
         FROM companies WHERE id = $1`,
      [companyId],
    );
    if (rows[0]) {
      out.company = rows[0].name;
      out.currency = rows[0].base_currency || null;
      out.country = rows[0].country || null;
      out.fiscal_year_start = rows[0].fiscal_year_start || null;
    }
  } catch {
    // A deployment without those columns still gets the date. Grounding is
    // best-effort: a missing currency means the agent says so, which is what it
    // should have been doing all along.
  }

  try {
    const { rows } = await pool.query(
      `SELECT period_name, start_date, end_date
         FROM accounting_periods
        WHERE status = 'OPEN'
        ORDER BY start_date DESC LIMIT 3`,
    );
    if (rows.length) out.open_periods = rows;
  } catch { /* module not installed */ }

  return out;
}

/**
 * The lines injected into the system prompt.
 *
 * The currency line is phrased as an instruction rather than a fact, because a
 * fact stated once at the top of a long conversation gets forgotten and a rule
 * does not. When the currency is unknown it says so explicitly and tells the
 * model to omit the symbol — silence is correct, a guessed "$" is not.
 */
function contextPrompt(ctx) {
  const lines = [`Today is ${ctx.today}.`];
  if (ctx.company) lines.push(`You are working inside ${ctx.company}${ctx.country ? ` (${ctx.country})` : ''}.`);

  if (ctx.currency) {
    lines.push(
      `The company's base currency is ${ctx.currency}. Amounts from ERP tools are in ${ctx.currency} unless the row `
      + `says otherwise — label them ${ctx.currency} and never with another currency's symbol.`,
    );
  } else {
    lines.push(
      'The base currency could not be determined. Write amounts as plain numbers with no currency symbol, and say '
      + 'the currency is not configured if it matters to the answer. Never guess one.',
    );
  }

  if (ctx.open_periods?.length) {
    const p = ctx.open_periods[0];
    lines.push(`The current open accounting period is ${p.period_name} (${p.start_date} to ${p.end_date}).`);
  }
  return lines.join(' ');
}

// ---------------------------------------------------------------------------
// Entity resolution.
//
// Each entry is a table the agent may need to name something in. `search`
// columns are matched case-insensitively; `label` is what comes back.
// ---------------------------------------------------------------------------
const ENTITIES = {
  customer: {
    table: 'customers',
    label: 'customer_name',
    extra: ['customer_code', 'email'],
    search: ['customer_name', 'customer_code', 'email'],
  },
  supplier: {
    table: 'suppliers',
    label: 'legal_name',
    extra: ['supplier_code', 'email'],
    search: ['legal_name', 'trade_name', 'supplier_code', 'email'],
  },
  employee: {
    table: 'employees',
    label: 'full_name',
    extra: ['employee_code', 'job_title'],
    search: ['full_name', 'first_name', 'last_name', 'employee_code', 'email'],
  },
  item: {
    table: 'inventory_items',
    label: 'item_name',
    extra: ['item_code', 'unit_of_measure'],
    search: ['item_name', 'item_code', 'description'],
  },
  project: {
    table: 'projects',
    label: 'name',
    extra: ['project_code', 'status'],
    search: ['name', 'project_code'],
  },
  deal: {
    table: 'crm_deals',
    label: 'title',
    extra: ['stage', 'value'],
    search: ['title'],
  },
  contact: {
    table: 'crm_contacts',
    label: 'first_name',
    extra: ['last_name', 'email', 'job_title'],
    search: ['first_name', 'last_name', 'email'],
  },
  gl_account: {
    table: 'chart_of_accounts',
    label: 'account_name',
    extra: ['account_code', 'account_type'],
    search: ['account_name', 'account_code'],
  },
};

/** Columns that actually exist on a table, so a missing one cannot break the query. */
async function realColumns(table) {
  const { rows } = await pool.query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

async function resolve(args = {}) {
  const spec = ENTITIES[args.type];
  if (!spec) {
    return { error: `"${args.type}" is not a resolvable type. Available: ${Object.keys(ENTITIES).join(', ')}.` };
  }

  const name = String(args.name || '').trim();
  if (!name) return { error: 'A name to look up is required.' };

  let columns;
  try {
    columns = await realColumns(spec.table);
  } catch (err) {
    return { error: `Could not inspect ${spec.table}: ${err.message}` };
  }
  if (!columns.size) {
    return { error: `The ${args.type} table is not present in this deployment.` };
  }

  const searchCols = spec.search.filter((c) => columns.has(c));
  if (!searchCols.length) return { error: `No searchable column on ${spec.table}.` };

  const selectCols = ['id', spec.label, ...spec.extra].filter((c) => columns.has(c));
  const where = searchCols.map((c, i) => `${c} ILIKE $1`).join(' OR ');
  const soft = columns.has('deleted_at') ? 'AND deleted_at IS NULL' : '';

  const { rows } = await pool.query(
    `SELECT ${selectCols.join(', ')} FROM ${spec.table}
      WHERE (${where}) ${soft}
      ORDER BY ${columns.has(spec.label) ? spec.label : 'id'}
      LIMIT 10`,
    [`%${name}%`],
  );

  if (!rows.length) {
    return { found: 0, matches: [], error: `Nothing in ${args.type}s matches "${name}".` };
  }

  // An exact, case-insensitive match on the label is unambiguous even when
  // several rows contain the string.
  const exact = rows.filter((r) => String(r[spec.label] || '').toLowerCase() === name.toLowerCase());
  const resolved = exact.length === 1 ? exact[0] : (rows.length === 1 ? rows[0] : null);

  return {
    found: rows.length,
    // Null when it is genuinely ambiguous. The model is told to ask rather than
    // pick — choosing a customer on the user's behalf is how you invoice the
    // wrong company.
    resolved,
    matches: rows,
    ...(resolved ? {} : {
      note: `"${name}" matches ${rows.length} ${args.type}s. Ask which one is meant rather than choosing.`,
    }),
  };
}

const groundingTools = [
  {
    name: 'describe_schema',
    description:
      'The tables and columns you are allowed to query, with their types. Call this BEFORE writing any SQL, and always '
      + 'when a query has just failed on an unknown column.\n\n'
      + 'You cannot introspect the database any other way: information_schema, pg_catalog and sqlite_master are all '
      + 'outside the reporting allowlist and will be rejected. (This is Postgres, not SQLite.) This tool is the '
      + 'supported way to find out what exists, and it returns only the reporting surface — a column that is not here '
      + 'is one you may not read.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'One table. Omit for every table you may query.' },
      },
    },
    handler: async (args) => {
      const { reportingSchema, ALLOWED_TABLES } = require('./nlQuery');
      let schema;
      try {
        schema = await reportingSchema();
      } catch (err) {
        return { error: `Could not read the schema: ${err.message}` };
      }

      const lines = String(schema || '').split('\n').filter(Boolean);
      if (!lines.length) return { error: 'No reporting tables are present in this deployment.' };

      if (args.table) {
        const wanted = String(args.table).toLowerCase();
        const hit = lines.find((l) => l.slice(0, l.indexOf('(')).toLowerCase() === wanted);
        if (!hit) {
          return {
            error: `"${args.table}" is not a queryable table.`,
            queryable_tables: [...ALLOWED_TABLES].sort(),
          };
        }
        return { table: args.table, definition: hit };
      }

      return {
        table_count: lines.length,
        // The whole surface in one call. It is a few KB and it is the thing
        // that stops the model guessing a column name, which is the failure
        // this tool exists to prevent.
        schema: lines,
      };
    },
  },

  {
    name: 'resolve_entity',
    description:
      'Turn a name into an id. People say "Northern Ltd" and "the Riverside project"; every other tool takes a UUID. '
      + 'Call this first whenever you have a name and need an id.\n\n'
      + 'Returns "resolved" when the match is unambiguous, and null with a list of candidates when it is not. When it '
      + 'is null, ASK which one is meant — do not pick. Choosing a customer on someone\'s behalf is how the wrong '
      + 'company gets invoiced.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: Object.keys(ENTITIES),
          description: 'What kind of thing to look for',
        },
        name: { type: 'string', description: 'The name, code or email to search for' },
      },
      required: ['type', 'name'],
    },
    handler: async (args) => resolve(args),
  },
  {
    name: 'get_record_history',
    description:
      'Everything that has happened to one record: every status change, who made it and when. This is how you answer '
      + '"what happened to this invoice?" or "who approved this?" with evidence instead of inference.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: 'e.g. customer_invoice, purchase_order, sales_order, work_order' },
        entity_id: { type: 'string' },
      },
      required: ['entity_type', 'entity_id'],
    },
    handler: async (args) => {
      const { rows } = await pool.query(
        `SELECT entity_type, entity_id, from_status, to_status, changed_by_name, occurred_at, notes
           FROM audit_trail
          WHERE entity_type = $1 AND entity_id = $2
          ORDER BY occurred_at ASC
          LIMIT 100`,
        [args.entity_type, String(args.entity_id)],
      ).catch(() => ({ rows: [] }));

      if (!rows.length) {
        return {
          count: 0,
          history: [],
          note: 'No audit entries for that record. Either nothing has changed since it was created, or this entity '
            + 'type is not audited. That is not the same as nothing having happened.',
        };
      }
      return { count: rows.length, history: rows };
    },
  },
];

module.exports = { groundingTools, companyContext, contextPrompt, resolve, ENTITIES };
