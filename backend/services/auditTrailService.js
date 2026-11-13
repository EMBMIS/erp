/**
 * Unified audit-trail viewer (ERP-Roadmap P3 #19).
 *
 * This codebase already writes a `*_status_history` row on nearly every status
 * transition (11 tables), plus `warehouse_transaction_audit_log` and
 * `ai_audit_log` — but there was no single place to browse "who did what,
 * when" across all of them. This service UNIONs them into one normalized shape
 * so the frontend/API can show one activity feed instead of eleven+ tables.
 *
 * Tamper-evidence (ROADMAP Task 18 — F5):
 *   Hash chaining (prev_hash → current_hash) over the union only existed at
 *   export time, so nothing could ever be verified. The chain is now PERSISTED
 *   in the `audit_chain` table: every record is appended with its own
 *   SHA-256 hash over (prev_hash | fields | reason). `verifyAuditChain()`
 *   walks the whole log, recomputes every hash and reports the FIRST row
 *   where the chain breaks — a direct UPDATE or DELETE via SQL is caught by
 *   hash or link mismatch at exactly that row. `exportSignedAuditTrail()`
 *   returns an Ed25519-signed snapshot whose signature a third party can
 *   check with `verifySignedExport()` using only the embedded (or pinned)
 *   public key — no database access required. DDL (schema changes) is
 *   recorded separately by an event trigger into `audit_ddl_log` (pgaudit is
 *   not available in this PostgreSQL build — see migration
 *   202608020901_audit_chain_and_ddl_audit.sql for the equivalent).
 */

const crypto = require('crypto');
const { pool } = require('../config/database');
const companyScope = require('./companyScope');
const companyContext = require('./companyContext');

const ZERO_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

// Fixed advisory-lock key that serializes chain appends: two concurrent
// appends must not read the same tail hash. The lock is transaction-scoped,
// so it is released automatically when the appending transaction commits.
const APPEND_LOCK_KEY = 723191;

// Each entry: { type, table, idCol, occurredCol, parentTable } describing how
// to project that table into the common shape:
//   entity_type, entity_id, from_status, to_status, changed_by, reason,
//   occurred_at, company_id
//
// `parentTable` is the entity table the history row's idCol points at (its PK
// is always `id`). It exists for exactly one reason: NONE of these
// *_status_history tables carry their own company_id — they were never given
// one — so the only way to know which company a status change belongs to is
// to join back to the record it happened to. Without that join this whole
// feed was company-blind: every admin/manager could browse every OTHER
// company's invoice, PO, journal-entry and payroll status history through
// this one screen. See getAuditTrail()'s mandatory company_id filter below.
const SOURCES = [
  { type: 'CHART_OF_ACCOUNTS', table: 'chart_of_accounts_status_history', idCol: 'account_id', occurredCol: 'status_date', parentTable: 'chart_of_accounts' },
  { type: 'CUSTOMER_INVOICE', table: 'customer_invoice_status_history', idCol: 'invoice_id', occurredCol: 'status_date', parentTable: 'customer_invoices' },
  { type: 'CUSTOMER_PAYMENT', table: 'customer_payment_status_history', idCol: 'payment_id', occurredCol: 'status_date', parentTable: 'customer_payments' },
  { type: 'DELIVERY_SCHEDULE', table: 'delivery_status_history', idCol: 'delivery_schedule_id', occurredCol: 'status_date', parentTable: 'delivery_schedules' },
  { type: 'JOURNAL_ENTRY', table: 'journal_entry_status_history', idCol: 'journal_entry_id', occurredCol: 'status_date', parentTable: 'journal_entries' },
  { type: 'SALES_CONTRACT', table: 'sales_contract_status_history', idCol: 'sales_contract_id', occurredCol: 'status_date', parentTable: 'sales_contracts' },
  { type: 'SALES_ORDER', table: 'sales_order_status_history', idCol: 'sales_order_id', occurredCol: 'status_date', parentTable: 'sales_orders' },
  { type: 'SALES_QUOTATION', table: 'sales_quotation_status_history', idCol: 'sales_quotation_id', occurredCol: 'status_date', parentTable: 'sales_quotations' },
  { type: 'SUPPLIER_INVOICE', table: 'supplier_invoice_status_history', idCol: 'bill_id', occurredCol: 'status_date', parentTable: 'supplier_invoices' },
  { type: 'SUPPLIER_PAYMENT', table: 'supplier_payment_status_history', idCol: 'payment_id', occurredCol: 'status_date', parentTable: 'supplier_payments' },
  { type: 'PURCHASE_ORDER', table: 'purchase_order_status_history', idCol: 'purchase_order_id', occurredCol: 'created_at', parentTable: 'purchase_orders' },
  { type: 'PURCHASE_REQUISITION', table: 'purchase_requisition_status_history', idCol: 'requisition_id', occurredCol: 'created_at', parentTable: 'purchase_requisitions' },
  { type: 'CONTRACT', table: 'contract_status_history', idCol: 'contract_id', occurredCol: 'created_at', parentTable: 'contracts' },
  { type: 'PAYROLL_RUN', table: 'payroll_run_status_history', idCol: 'payroll_run_id', occurredCol: 'created_at', parentTable: 'payroll_runs' },
  { type: 'FIXED_ASSET', table: 'fixed_asset_status_history', idCol: 'asset_id', occurredCol: 'created_at', parentTable: 'fixed_assets' },
  { type: 'WORK_ORDER', table: 'work_order_status_history', idCol: 'work_order_id', occurredCol: 'created_at', parentTable: 'work_orders' },
  { type: 'BUDGET', table: 'budget_status_history', idCol: 'budget_id', occurredCol: 'created_at', parentTable: 'budgets' },
];

function buildUnion(entityType) {
  const parts = [];

  // Accepts one type or several. A module overview wants the handful of
  // entities that belong to it — a stock screen showing sales-contract
  // transitions is a feed about somebody else's work — and asking for them one
  // request at a time would be several round trips for one panel.
  const wanted = Array.isArray(entityType)
    ? entityType
    : typeof entityType === 'string' && entityType
      ? entityType.split(',').map((v) => v.trim()).filter(Boolean)
      : null;
  const applicable = wanted && wanted.length
    ? SOURCES.filter((s) => wanted.includes(s.type))
    : SOURCES;
  for (const s of applicable) {
    parts.push(`
      SELECT '${s.type}'::text AS entity_type, h.${s.idCol}::text AS entity_id,
             h.from_status, h.to_status, h.changed_by, h.reason, h.${s.occurredCol} AS occurred_at,
             p.company_id AS company_id
      FROM ${s.table} h
      JOIN ${s.parentTable} p ON p.id = h.${s.idCol}
    `);
  }

  // sales_rfq_status_history has a different column shape (status/previous_status/changed_at/change_reason).
  if (!entityType || entityType === 'SALES_RFQ') {
    parts.push(`
      SELECT 'SALES_RFQ'::text AS entity_type, h.sales_rfq_id::text AS entity_id,
             h.previous_status AS from_status, h.status AS to_status, h.changed_by,
             h.change_reason AS reason, h.changed_at AS occurred_at,
             p.company_id AS company_id
      FROM sales_rfq_status_history h
      JOIN sales_rfqs p ON p.id = h.sales_rfq_id
    `);
  }

  // warehouse_transaction_audit_log: action-based, not a simple status transition.
  if (!entityType || entityType === 'WAREHOUSE_TRANSACTION') {
    parts.push(`
      SELECT 'WAREHOUSE_TRANSACTION'::text AS entity_type, h.warehouse_transaction_id::text AS entity_id,
             h.previous_status AS from_status, COALESCE(h.new_status, h.action) AS to_status, h.user_id AS changed_by,
             COALESCE(h.field_changed, h.action) AS reason, h.created_at AS occurred_at,
             p.company_id AS company_id
      FROM warehouse_transaction_audit_log h
      JOIN warehouse_transactions p ON p.id = h.warehouse_transaction_id
    `);
  }

  // ai_audit_log: every AI tool call, human-attributed (audit B15/AI-Roadmap
  // design rule). This is the one source that already carries its own
  // company_id — no join needed.
  if (!entityType || entityType === 'AI_ACTION') {
    parts.push(`
      SELECT 'AI_ACTION'::text AS entity_type, NULL::text AS entity_id,
             NULL::text AS from_status, tool_name AS to_status, user_id AS changed_by,
             COALESCE(error, result_summary) AS reason, created_at AS occurred_at,
             company_id AS company_id
      FROM ai_audit_log
    `);
  }

  return parts.join('\nUNION ALL\n');
}

/**
 * @param {{entity_type?, entity_id?, user_id?, date_from?, date_to?, limit?, offset?, company_id}} filters
 *
 * `company_id` is NOT optional in practice: every branch of the union above
 * now projects it (joined from the record the history row belongs to, since
 * the history tables carry no company_id of their own), and omitting the
 * filter here would mean every caller sees every company's history — which is
 * exactly the bug this shape exists to close. Callers that genuinely have no
 * company in scope (a platform-owner cross-tenant view, if one is ever built)
 * should say so explicitly rather than this silently defaulting to "all".
 */
async function getAuditTrail(filters = {}) {
  const union = buildUnion(filters.entity_type);

  // A filter naming only entity types this service has no source for leaves
  // nothing to union, and `FROM () t` is a syntax error rather than an empty
  // result. A caller asking for a feed that does not exist should get an empty
  // feed — the screen then says so — not a 500 that reads as the whole audit
  // trail being down.
  if (!union) return [];
  if (!filters.company_id) {
    throw new Error('getAuditTrail requires company_id — every source here is company-scoped data');
  }

  const conditions = [];
  const values = [];

  values.push(filters.company_id);
  conditions.push(`company_id = $${values.length}`);
  if (filters.entity_id) { values.push(String(filters.entity_id)); conditions.push(`entity_id = $${values.length}`); }
  if (filters.user_id) { values.push(filters.user_id); conditions.push(`changed_by = $${values.length}`); }
  if (filters.date_from) { values.push(filters.date_from); conditions.push(`occurred_at >= $${values.length}`); }
  if (filters.date_to) { values.push(filters.date_to); conditions.push(`occurred_at <= $${values.length}`); }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);
  values.push(limit, offset);

  const sql = `
    SELECT t.*, u.first_name || ' ' || u.last_name AS changed_by_name
    FROM (${union}) t
    LEFT JOIN users u ON t.changed_by = u.id
    ${where}
    ORDER BY occurred_at DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}
  `;

  const result = await pool.query(sql, values);
  return result.rows;
}

function listEntityTypes() {
  return [...SOURCES.map((s) => s.type), 'SALES_RFQ', 'WAREHOUSE_TRANSACTION', 'AI_ACTION'];
}

/**
 * Compute SHA-256 hash for an audit record linked to the previous entry's hash.
 *
 * Canonical payload: prev_hash | entity_type | entity_id | from_status |
 * to_status | changed_by | occurred_at | reason. `occurred_at` is normalized
 * to an ISO-8601 UTC string so the hash is byte-identical whether it is
 * computed at append time (JS object) or verification time (row read back
 * from the database).
 */
function computeRecordHash(record, prevHash = ZERO_HASH) {
  const occurredAt = record.occurred_at instanceof Date
    ? record.occurred_at.toISOString()
    : (record.occurred_at || '');
  const payload = [
    prevHash,
    record.entity_type || '',
    record.entity_id || '',
    record.from_status || '',
    record.to_status || '',
    record.changed_by || '',
    occurredAt,
    record.reason || ''
  ].join('|');

  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Append one record to the persisted hash chain.
 *
 * Serialized with a transaction-scoped advisory lock so concurrent appends
 * can never read the same tail hash. Pass `{ client }` to join the caller's
 * transaction (e.g. the period-close transaction) so the audit record commits
 * atomically with the business change it documents.
 *
 * @param {{entity_type: string, entity_id?, from_status?, to_status?, changed_by?, reason?, occurred_at?, company_id?}} record
 * @param {{client?: import('pg').PoolClient}} [opts]
 */
async function appendAuditRecord(record, { client: externalClient } = {}) {
  if (!record || !record.entity_type) {
    throw new Error('entity_type is required for audit chain records');
  }

  // Resolve the company BEFORE hashing, not in SQL. The record hash is computed
  // over company_id, so if the database substituted its own value via a column
  // DEFAULT the stored hash would not match the stored row and every later
  // verification would report the chain as tampered.
  //
  // The column is NOT NULL and this INSERT names it explicitly, so a DEFAULT
  // would never fire anyway. Falling back through session → default company
  // keeps system-originated events (schedulers, DDL audit) writable: an audit
  // record that cannot be written is an audited action with no trail, which is
  // strictly worse than one attributed to the default tenant.
  const resolvedCompanyId =
    record.company_id
    ?? companyScope.currentCompanyId()
    ?? (await companyContext.getDefaultCompanyId());

  const entry = {
    entity_type: record.entity_type,
    entity_id: record.entity_id ?? null,
    from_status: record.from_status ?? null,
    to_status: record.to_status ?? null,
    changed_by: record.changed_by ?? null,
    reason: record.reason ?? null,
    occurred_at: record.occurred_at instanceof Date ? record.occurred_at : new Date(),
    company_id: resolvedCompanyId ?? null
  };

  const insert = async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [APPEND_LOCK_KEY]);
    const { rows } = await client.query('SELECT hash FROM audit_chain ORDER BY id DESC LIMIT 1');
    const prevHash = rows[0]?.hash || ZERO_HASH;

    const res = await client.query(
      `INSERT INTO audit_chain
         (entity_type, entity_id, from_status, to_status, changed_by, reason, occurred_at, company_id, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        entry.entity_type,
        entry.entity_id,
        entry.from_status,
        entry.to_status,
        entry.changed_by,
        entry.reason,
        entry.occurred_at,
        entry.company_id,
        prevHash,
        computeRecordHash(entry, prevHash)
      ]
    );
    return res.rows[0];
  };

  if (externalClient) return insert(externalClient);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await insert(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Walk the whole persisted log, recompute every hash and report the FIRST row
 * where the chain breaks.
 *
 * Two failure modes are distinguished:
 *   - 'hash_mismatch'      the row's stored hash does not match a recomputation
 *                          over its own fields → the row was modified.
 *   - 'prev_hash_mismatch' the row's stored prev_hash does not match the
 *                          previous row's (recomputed) hash → the previous row
 *                          was modified or deleted.
 *
 * The chain always continues from the RECOMPUTED hash, so a single tampered
 * row breaks the chain exactly once, at that row.
 */
async function verifyAuditChain() {
  const { rows } = await pool.query('SELECT * FROM audit_chain ORDER BY id ASC');

  let prev = ZERO_HASH;
  let firstBroken = null;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const expected = computeRecordHash(r, prev);

    if (!firstBroken) {
      if (r.prev_hash !== prev) {
        firstBroken = {
          index: i,
          seq: r.id,
          entity_type: r.entity_type,
          entity_id: r.entity_id,
          broken: 'prev_hash_mismatch',
          expected_prev_hash: prev,
          stored_prev_hash: r.prev_hash
        };
      } else if (r.hash !== expected) {
        firstBroken = {
          index: i,
          seq: r.id,
          entity_type: r.entity_type,
          entity_id: r.entity_id,
          broken: 'hash_mismatch',
          expected_hash: expected,
          stored_hash: r.hash
        };
      }
    }

    prev = expected;
  }

  return {
    valid: firstBroken === null,
    total_rows: rows.length,
    first_broken: firstBroken
  };
}

let cachedKeyPair = null;

/**
 * Ed25519 signing keys. Production deployments pin a stable key via
 * AUDIT_SIGNING_PRIVATE_KEY_PEM (PKCS#8 PEM). For local/development use a
 * keypair is generated once per process; the public key is always embedded in
 * the export manifest so a third party can verify without database access.
 */
function getSigningKeys() {
  if (process.env.AUDIT_SIGNING_PRIVATE_KEY_PEM) {
    const privateKey = crypto.createPrivateKey(process.env.AUDIT_SIGNING_PRIVATE_KEY_PEM);
    return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
  }
  if (!cachedKeyPair) {
    cachedKeyPair = crypto.generateKeyPairSync('ed25519');
  }
  return cachedKeyPair;
}

/**
 * Export a signed, hash-chained audit log for SOC 2 / IFRS compliance.
 *
 * The signature covers (records_count | root_hash | exported_at) with the
 * exporter's Ed25519 private key; root_hash in turn commits to every record,
 * so verifying the signature + re-chaining the records proves the export is
 * byte-for-byte what the exporter signed.
 */
async function exportSignedAuditTrail() {
  const { rows } = await pool.query('SELECT * FROM audit_chain ORDER BY id ASC');
  const records = rows.map((r) => ({ ...r }));

  const exported_at = new Date().toISOString();
  const root_hash = records.length ? records[records.length - 1].hash : ZERO_HASH;
  const { privateKey, publicKey } = getSigningKeys();

  const canonical = `${records.length}|${root_hash}|${exported_at}`;
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');

  const manifest = {
    format_version: 1,
    algorithm: 'ed25519',
    records_count: records.length,
    root_hash,
    exported_at,
    public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    signature
  };

  return { manifest, records };
}

/**
 * Verify a signed export WITHOUT database access.
 *
 * A third party that holds the export (and optionally a pinned public key)
 * can confirm: (1) the signature over (records_count | root_hash |
 * exported_at) is valid, (2) the records re-chain to the manifest's
 * root_hash, (3) the first record whose hash does not recompute, if any.
 *
 * @param {{manifest?: object, records?: Array}} exportData
 * @param {{publicKeyPem?: string}} [opts] pinned public key; falls back to the
 *   key embedded in the manifest (for deployments that publish the key
 *   out-of-band, pass it here so a swapped embedded key is also detected).
 */
function verifySignedExport(exportData, { publicKeyPem } = {}) {
  const problems = [];
  const manifest = exportData && exportData.manifest;
  const records = (exportData && exportData.records) || [];

  if (!manifest) {
    return { valid: false, signature_valid: false, root_hash_valid: false, first_broken: null, problems: ['missing manifest'] };
  }

  // 1. Re-chain the records from the manifest-embedded order.
  let prev = ZERO_HASH;
  let firstBroken = null;
  for (let i = 0; i < records.length; i++) {
    const expected = computeRecordHash(records[i], prev);
    if (!firstBroken && records[i].hash !== expected) {
      firstBroken = {
        index: i,
        seq: records[i].seq ?? records[i].id ?? null,
        entity_type: records[i].entity_type || null,
        entity_id: records[i].entity_id || null,
        broken: 'hash_mismatch',
        expected_hash: expected,
        stored_hash: records[i].hash
      };
    }
    prev = expected;
  }

  // 2. Root hash must be the last record's hash (or the zero hash when empty).
  const rootOk = records.length === 0
    ? manifest.root_hash === ZERO_HASH
    : records[records.length - 1].hash === manifest.root_hash;
  if (!rootOk) {
    problems.push(`root_hash mismatch: manifest says ${manifest.root_hash}`);
  }

  // 3. Signature check with the pinned key or the key embedded in the manifest.
  const keyPem = publicKeyPem || manifest.public_key_pem;
  let signatureOk = false;
  if (!keyPem) {
    problems.push('no public key available (pass publicKeyPem or export a manifest with public_key_pem)');
  } else {
    try {
      const canonical = `${records.length}|${manifest.root_hash}|${manifest.exported_at}`;
      signatureOk = crypto.verify(
        null,
        Buffer.from(canonical, 'utf8'),
        crypto.createPublicKey(keyPem),
        Buffer.from(manifest.signature, 'base64')
      );
      if (!signatureOk) problems.push('signature is invalid for (records_count | root_hash | exported_at)');
    } catch (error) {
      problems.push(`signature verification failed: ${error.message}`);
    }
  }

  if (firstBroken) {
    problems.push(`record #${firstBroken.index} (seq ${firstBroken.seq}) does not re-chain: expected ${firstBroken.expected_hash}, stored ${firstBroken.stored_hash}`);
  }

  return {
    valid: problems.length === 0,
    signature_valid: signatureOk,
    root_hash_valid: rootOk,
    first_broken: firstBroken,
    problems
  };
}

module.exports = {
  getAuditTrail,
  listEntityTypes,
  computeRecordHash,
  appendAuditRecord,
  verifyAuditChain,
  exportSignedAuditTrail,
  verifySignedExport
};
