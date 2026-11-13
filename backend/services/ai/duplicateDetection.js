/**
 * Smart duplicate detection for master data and invoices.
 *
 * Duplicate suppliers/customers are how the same vendor gets paid twice and how
 * credit limits get silently doubled. Exact-match constraints never catch this,
 * because the second record is always *slightly* different — "Acme Ltd." vs
 * "ACME Limited".
 *
 * Two-stage matching, for cost and for precision:
 *   1. Postgres pg_trgm generates a shortlist of plausible pairs using a GIN
 *      index (migration 103). Comparing every row to every other row is O(n²)
 *      and does not survive a realistic customer count.
 *   2. services/ai/stats.js scores the shortlist precisely, normalising legal
 *      suffixes and accents and combining edit distance with token overlap.
 *
 * No LLM is involved: string similarity is a solved problem and a model would
 * be slower, non-deterministic, and no more accurate. Results are ranked
 * suggestions for a human — nothing is merged automatically.
 */

const { pool } = require('../../config/database');
const stats = require('./stats');

// Trigram floor for the SQL shortlist. Deliberately loose — stage 2 does the
// real judging, and a missed candidate here can never be recovered later.
const TRIGRAM_FLOOR = 0.3;
// Score at or above which a pair is worth showing a human.
const REPORT_THRESHOLD = 0.75;
// Score at or above which the pair is almost certainly the same entity.
const HIGH_CONFIDENCE = 0.9;

// Score at or above which two PO/SO records are treated as likely duplicates.
// Matches anomalyAgent's duplicate_score_threshold default — one knob covers
// both the supplier/customer (trigram) and PO/SO (embedding) dedup paths.
const RECORD_DUP_THRESHOLD = 0.9;

function confidenceOf(score) {
  if (score >= HIGH_CONFIDENCE) return 'high';
  if (score >= 0.82) return 'medium';
  return 'low';
}

/**
 * Generic near-duplicate scan over one table's name column.
 * `id < id` in the join keeps each pair once and stops a row matching itself.
 */
async function scanNameDuplicates({ table, idCol = 'id', nameCol, extraCols = [], where = 'TRUE', threshold = REPORT_THRESHOLD, limit = 50 }) {
  const extras = extraCols.length ? `, ${extraCols.map((c) => `a.${c} AS a_${c}, b.${c} AS b_${c}`).join(', ')}` : '';
  const { rows } = await pool.query(
    `
    SELECT a.${idCol} AS a_id, a.${nameCol} AS a_name,
           b.${idCol} AS b_id, b.${nameCol} AS b_name,
           similarity(a.${nameCol}, b.${nameCol}) AS trigram_score
           ${extras}
      FROM ${table} a
      JOIN ${table} b
        ON a.${idCol} < b.${idCol}
       AND a.${nameCol} % b.${nameCol}
     WHERE ${where}
       AND a.${nameCol} IS NOT NULL AND b.${nameCol} IS NOT NULL
       AND similarity(a.${nameCol}, b.${nameCol}) >= $1
     ORDER BY trigram_score DESC
     LIMIT 500
    `,
    [TRIGRAM_FLOOR]
  );

  const scored = rows
    .map((r) => {
      const score = stats.nameSimilarity(r.a_name, r.b_name);
      return {
        score: stats.round2(score),
        confidence: confidenceOf(score),
        trigram_score: stats.round2(Number(r.trigram_score)),
        records: [
          { id: r.a_id, name: r.a_name, ...pick(r, extraCols, 'a_') },
          { id: r.b_id, name: r.b_name, ...pick(r, extraCols, 'b_') },
        ],
        normalized: stats.normalizeName(r.a_name),
      };
    })
    .filter((p) => p.score >= threshold)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
}

function pick(row, cols, prefix) {
  const out = {};
  cols.forEach((c) => { out[c] = row[`${prefix}${c}`]; });
  return out;
}

/**
 * Suppliers entered more than once. The highest-value case: duplicate suppliers
 * lead directly to duplicate payments.
 */
async function findDuplicateSuppliers({ threshold = REPORT_THRESHOLD, limit = 50 } = {}) {
  const pairs = await scanNameDuplicates({
    table: 'suppliers',
    nameCol: 'legal_name',
    extraCols: ['supplier_code', 'email', 'status'],
    threshold,
    limit,
  });

  // An exact email match is much stronger evidence than any name score.
  const emailPairs = await pool.query(`
    SELECT a.id AS a_id, a.legal_name AS a_name, a.supplier_code AS a_code,
           b.id AS b_id, b.legal_name AS b_name, b.supplier_code AS b_code,
           lower(a.email) AS shared_email
      FROM suppliers a JOIN suppliers b ON a.id < b.id
     WHERE a.email IS NOT NULL AND a.email <> ''
       AND lower(a.email) = lower(b.email)
     LIMIT 100
  `);

  return {
    entity: 'suppliers',
    by_name: pairs,
    by_shared_email: emailPairs.rows.map((r) => ({
      score: 1,
      confidence: 'high',
      reason: `Both records use the same email address (${r.shared_email}).`,
      records: [
        { id: r.a_id, name: r.a_name, supplier_code: r.a_code },
        { id: r.b_id, name: r.b_name, supplier_code: r.b_code },
      ],
    })),
    total: pairs.length + emailPairs.rows.length,
  };
}

async function findDuplicateCustomers({ threshold = REPORT_THRESHOLD, limit = 50 } = {}) {
  const pairs = await scanNameDuplicates({
    table: 'customers',
    nameCol: 'customer_name',
    extraCols: ['customer_code', 'primary_email', 'status'],
    where: 'a.deleted_at IS NULL AND b.deleted_at IS NULL',
    threshold,
    limit,
  });

  const emailPairs = await pool.query(`
    SELECT a.id AS a_id, a.customer_name AS a_name, a.customer_code AS a_code,
           b.id AS b_id, b.customer_name AS b_name, b.customer_code AS b_code,
           lower(a.primary_email) AS shared_email
      FROM customers a JOIN customers b ON a.id < b.id
     WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
       AND a.primary_email IS NOT NULL AND a.primary_email <> ''
       AND lower(a.primary_email) = lower(b.primary_email)
     LIMIT 100
  `);

  return {
    entity: 'customers',
    by_name: pairs,
    by_shared_email: emailPairs.rows.map((r) => ({
      score: 1,
      confidence: 'high',
      reason: `Both records use the same primary email (${r.shared_email}).`,
      records: [
        { id: r.a_id, name: r.a_name, customer_code: r.a_code },
        { id: r.b_id, name: r.b_name, customer_code: r.b_code },
      ],
    })),
    total: pairs.length + emailPairs.rows.length,
  };
}

/**
 * Duplicate supplier bills — the direct route to paying the same invoice twice.
 *
 * Three independent signals, strongest first:
 *   • identical supplier reference on the same supplier (near-certain)
 *   • same supplier + same amount within a short date window
 *   • same amount + same date across the whole ledger (catches the case where
 *     the duplicate was booked against a *duplicated supplier record*)
 */
async function findDuplicateSupplierInvoices({ dayWindow = 45, limit = 50 } = {}) {
  const sameReference = await pool.query(`
    SELECT a.id AS a_id, a.bill_number AS a_bill, b.id AS b_id, b.bill_number AS b_bill,
           a.supplier_invoice_number AS reference, a.total_amount, s.legal_name AS supplier_name
      FROM supplier_invoices a
      JOIN supplier_invoices b
        ON a.id < b.id
       AND a.supplier_id = b.supplier_id
       AND lower(trim(a.supplier_invoice_number)) = lower(trim(b.supplier_invoice_number))
      LEFT JOIN suppliers s ON s.id = a.supplier_id
     WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
       AND a.supplier_invoice_number IS NOT NULL AND trim(a.supplier_invoice_number) <> ''
     LIMIT $1
  `, [limit]).catch(() => ({ rows: [] }));

  const sameAmountAndSupplier = await pool.query(`
    SELECT a.id AS a_id, a.bill_number AS a_bill, a.invoice_date AS a_date,
           b.id AS b_id, b.bill_number AS b_bill, b.invoice_date AS b_date,
           a.total_amount, s.legal_name AS supplier_name,
           ABS(a.invoice_date - b.invoice_date) AS days_apart
      FROM supplier_invoices a
      JOIN supplier_invoices b
        ON a.id < b.id
       AND a.supplier_id = b.supplier_id
       AND a.total_amount = b.total_amount
       AND ABS(a.invoice_date - b.invoice_date) <= $1
      LEFT JOIN suppliers s ON s.id = a.supplier_id
     WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
       AND a.total_amount > 0
     LIMIT $2
  `, [dayWindow, limit]).catch(() => ({ rows: [] }));

  return {
    entity: 'supplier_invoices',
    day_window: dayWindow,
    same_supplier_reference: sameReference.rows.map((r) => ({
      confidence: 'high',
      reason: `Both bills carry the supplier's own invoice number "${r.reference}" for ${r.supplier_name || 'the same supplier'} — almost certainly the same document entered twice.`,
      amount: Number(r.total_amount),
      records: [{ id: r.a_id, bill_number: r.a_bill }, { id: r.b_id, bill_number: r.b_bill }],
    })),
    same_supplier_and_amount: sameAmountAndSupplier.rows.map((r) => ({
      confidence: Number(r.days_apart) === 0 ? 'high' : 'medium',
      reason: `Same supplier and identical amount ${Number(r.total_amount)}, ${r.days_apart} day(s) apart.`,
      amount: Number(r.total_amount),
      records: [
        { id: r.a_id, bill_number: r.a_bill, invoice_date: r.a_date },
        { id: r.b_id, bill_number: r.b_bill, invoice_date: r.b_date },
      ],
    })),
    total: sameReference.rows.length + sameAmountAndSupplier.rows.length,
  };
}

/**
 * Near-duplicate purchase orders / sales orders, by embedding similarity
 * rather than trigram name matching — these records don't have one obvious
 * "name" column, but they do have a pgvector embedding of their supplier/
 * customer, line items and terms (migration 202608070200,
 * services/ai/embeddings.js).
 *
 * `JOIN LATERAL ... ORDER BY b.embedding <=> a.embedding LIMIT 1` gets each
 * row's single nearest neighbour using the HNSW index — O(n) index lookups
 * rather than an O(n²) self-join, which is what makes this practical at
 * catalogue scale where scanNameDuplicates' pg_trgm shortlist approach would
 * not apply (there's no trigram-indexable text column to shortlist on).
 *
 * Each pair can surface twice (once from each row's own nearest-neighbour
 * lookup) — deduped below by the unordered (id, id) key.
 */
async function scanEmbeddingDuplicates({ table, numberCol, excludeDeleted = false, threshold = RECORD_DUP_THRESHOLD, limit = 50 }) {
  const deletedFilterA = excludeDeleted ? 'AND a.deleted_at IS NULL' : '';
  const deletedFilterB = excludeDeleted ? 'AND b2.deleted_at IS NULL' : '';
  const { rows } = await pool.query(
    `
    SELECT a.id AS a_id, a.${numberCol} AS a_number,
           b.id AS b_id, b.${numberCol} AS b_number,
           1 - (a.embedding <=> b.embedding) AS score
      FROM ${table} a
      JOIN LATERAL (
        SELECT id, ${numberCol}, embedding
          FROM ${table} b2
         WHERE b2.id <> a.id AND b2.embedding IS NOT NULL ${deletedFilterB}
         ORDER BY b2.embedding <=> a.embedding ASC
         LIMIT 1
      ) b ON TRUE
     WHERE a.embedding IS NOT NULL ${deletedFilterA}
       AND (1 - (a.embedding <=> b.embedding)) >= $1
     LIMIT $2
    `,
    [threshold, limit * 2]
  );

  const seen = new Set();
  const pairs = [];
  for (const r of rows) {
    const key = [r.a_id, r.b_id].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const score = stats.round2(Number(r.score));
    pairs.push({
      score,
      confidence: confidenceOf(score),
      records: [
        { id: r.a_id, number: r.a_number },
        { id: r.b_id, number: r.b_number },
      ],
    });
  }
  return pairs.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function findDuplicatePurchaseOrders({ threshold = RECORD_DUP_THRESHOLD, limit = 50 } = {}) {
  const pairs = await scanEmbeddingDuplicates({ table: 'purchase_orders', numberCol: 'po_number', threshold, limit });
  return { entity: 'purchase_orders', pairs, total: pairs.length };
}

async function findDuplicateSalesOrders({ threshold = RECORD_DUP_THRESHOLD, limit = 50 } = {}) {
  const pairs = await scanEmbeddingDuplicates({
    table: 'sales_orders', numberCol: 'so_number', excludeDeleted: true, threshold, limit,
  });
  return { entity: 'sales_orders', pairs, total: pairs.length };
}

/**
 * Single-record duplicate check: does `id` (a PO or SO that was just created)
 * have a near-duplicate among the other records of its type? Used at create
 * time (checkNewRecordForDuplicate below) — a full scanEmbeddingDuplicates
 * self-join would work but is wasteful for checking one row.
 */
async function checkRecordForDuplicate(type, id, { threshold = RECORD_DUP_THRESHOLD } = {}) {
  const table = type === 'purchase_order' ? 'purchase_orders' : 'sales_orders';
  const numberCol = type === 'purchase_order' ? 'po_number' : 'so_number';
  const deletedFilter = type === 'sales_order' ? 'AND b.deleted_at IS NULL' : '';

  const { rows } = await pool.query(
    `
    SELECT b.id, b.${numberCol} AS number, 1 - (a.embedding <=> b.embedding) AS score
      FROM ${table} a
      JOIN ${table} b ON b.id <> a.id AND b.embedding IS NOT NULL ${deletedFilter}
     WHERE a.id = $1 AND a.embedding IS NOT NULL
     ORDER BY a.embedding <=> b.embedding ASC
     LIMIT 1
    `,
    [id]
  );

  const match = rows[0];
  if (!match) return null;
  const score = stats.round2(Number(match.score));
  if (score < threshold) return null;
  return { id: match.id, number: match.number, score };
}

/**
 * Orchestrates the create-time duplicate check: embed the new record (it has
 * none yet — ensureEmbedding generates and stores it), look for a near
 * neighbour, and if one is found above threshold, raise it the same way the
 * scheduled sweep does (services/agents/definitions/anomalyAgent.js#act) —
 * one INSERT INTO ai_findings ... ON CONFLICT DO NOTHING, so if the scheduled
 * sweep later finds the same pair it's a no-op rather than a second finding.
 *
 * Fire-and-forget from models/PurchaseOrder.js / models/SalesOrder.js — never
 * awaited, and every failure here is caught and logged rather than thrown,
 * because a slow or failing duplicate check must never fail the record's own
 * save (same reasoning as models/SalesContract.js's indexing hook).
 */
async function checkNewRecordForDuplicate(type, id) {
  const { ensureEmbedding } = require('./embeddings');
  await ensureEmbedding(type, id);

  const match = await checkRecordForDuplicate(type, id);
  if (!match) return null;

  const label = type === 'purchase_order' ? 'purchase order' : 'sales order';
  const severity = match.score >= 0.95 ? 'HIGH' : 'MEDIUM';

  const { rows } = await pool.query(
    `INSERT INTO ai_findings (finding_type, severity, entity_type, entity_id, title, description, data, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      type === 'purchase_order' ? 'DUPLICATE_PURCHASE_ORDER' : 'DUPLICATE_SALES_ORDER',
      severity,
      type,
      id,
      `Possible duplicate ${label}`,
      `This ${label} is ${Math.round(match.score * 100)}% similar to existing ${match.number} (${match.id}).`,
      JSON.stringify({ matched_id: match.id, matched_number: match.number, score: match.score }),
    ]
  );

  const findingId = rows[0]?.id;
  if (findingId && severity === 'HIGH') {
    const Notification = require('../../models/Notification');
    await Notification.createForManagers({
      type: 'AI_FINDING',
      title: `Possible duplicate ${label} created`,
      message: `A new ${label} looks ${Math.round(match.score * 100)}% similar to existing ${match.number} — worth a quick check.`,
      data: { finding_id: findingId, entity_type: type, entity_id: id, matched_id: match.id },
    }).catch(() => {});
  }

  return findingId ? { finding_id: findingId, match } : null;
}

/**
 * One call for the whole duplicate surface — what a "clean up my master data"
 * request actually wants.
 */
async function scanAll(options = {}) {
  const [suppliers, customers, invoices, purchaseOrders, salesOrders] = await Promise.all([
    findDuplicateSuppliers(options),
    findDuplicateCustomers(options),
    findDuplicateSupplierInvoices(options),
    findDuplicatePurchaseOrders(options),
    findDuplicateSalesOrders(options),
  ]);
  return {
    scanned_at: new Date().toISOString(),
    suppliers,
    customers,
    supplier_invoices: invoices,
    purchase_orders: purchaseOrders,
    sales_orders: salesOrders,
    total_suspected: suppliers.total + customers.total + invoices.total + purchaseOrders.total + salesOrders.total,
  };
}

module.exports = {
  findDuplicateSuppliers,
  findDuplicateCustomers,
  findDuplicateSupplierInvoices,
  findDuplicatePurchaseOrders,
  findDuplicateSalesOrders,
  checkRecordForDuplicate,
  checkNewRecordForDuplicate,
  scanAll,
  scanNameDuplicates,
  REPORT_THRESHOLD,
  RECORD_DUP_THRESHOLD,
};
