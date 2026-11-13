#!/usr/bin/env node
/**
 * One-time / periodic backfill for the record-level embedding columns
 * (purchase_orders, sales_orders, inventory_items) — pgvector(384) as of
 * migration 202608070200, populated locally via services/ai/embeddings.js
 * (no API key required).
 *
 * Finds rows where embedding IS NULL (never embedded) or embedding_generated_at
 * < updated_at (stale — the record changed since it was last embedded), embeds
 * them in batches, and writes the vectors back. Safe to re-run: an up-to-date
 * row costs nothing beyond the WHERE clause that excludes it.
 *
 * Usage:
 *   node backend/scripts/backfill-embeddings.js
 *   node backend/scripts/backfill-embeddings.js --table=purchase_orders
 *   node backend/scripts/backfill-embeddings.js --limit=500
 */

const { pool } = require('../config/database');
const { generateEmbeddingForDocument, toVectorLiteral } = require('../services/ai/embeddings');

const BATCH_SIZE = 20;

const TARGETS = [
  { type: 'purchase_order', table: 'purchase_orders' },
  { type: 'sales_order', table: 'sales_orders' },
  { type: 'inventory_item', table: 'inventory_items' },
];

function parseArgs(argv) {
  const args = { limit: 2000 };
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    if (key === 'table') args.table = value;
    if (key === 'limit') args.limit = Number(value) || args.limit;
  }
  return args;
}

async function fetchPending(table, limit) {
  const { rows } = await pool.query(
    `SELECT id FROM ${table}
      WHERE embedding IS NULL
         OR embedding_generated_at IS NULL
         OR embedding_generated_at < updated_at
      ORDER BY updated_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows.map((r) => r.id);
}

async function backfillTarget({ type, table }, limit) {
  const ids = await fetchPending(table, limit);
  console.log(`\n[${table}] ${ids.length} row(s) need an embedding.`);

  let embedded = 0;
  let empty = 0;
  let failed = 0;

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    console.log(`[${table}] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(ids.length / BATCH_SIZE)} (${batch.length} rows)`);

    for (const id of batch) {
      try {
        const vector = await generateEmbeddingForDocument({ type, id });
        if (!vector) { empty += 1; continue; }
        await pool.query(
          `UPDATE ${table} SET embedding = $1::vector, embedding_generated_at = NOW() WHERE id = $2`,
          [toVectorLiteral(vector), id]
        );
        embedded += 1;
      } catch (err) {
        failed += 1;
        console.error(`[${table}] failed to embed ${id}: ${err.message}`);
      }
    }

    console.log(`[${table}] progress: ${Math.min(i + BATCH_SIZE, ids.length)}/${ids.length} (embedded ${embedded}, empty ${empty}, failed ${failed})`);
  }

  return { table, total: ids.length, embedded, empty, failed };
}

async function main() {
  const args = parseArgs(process.argv);

  const targets = args.table ? TARGETS.filter((t) => t.table === args.table) : TARGETS;
  if (!targets.length) {
    console.error(`Unknown --table=${args.table}. Valid tables: ${TARGETS.map((t) => t.table).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const target of targets) {
    results.push(await backfillTarget(target, args.limit));
  }

  console.log('\n=== Backfill summary ===');
  for (const r of results) {
    console.log(`${r.table}: ${r.embedded}/${r.total} embedded, ${r.empty} empty, ${r.failed} failed`);
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Backfill failed:', err);
    pool.end();
    process.exitCode = 1;
  });
