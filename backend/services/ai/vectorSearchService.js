/**
 * Semantic duplicate detection for master data (items, suppliers).
 *
 * ===========================================================================
 * WHAT THIS CLAIMED, AND WHAT IT ACTUALLY DID
 * ===========================================================================
 * The header said "semantic vector embedding & cosine similarity catalog
 * search". What it ran was:
 *
 *     SELECT id, item_name, description, category, unit_price, status
 *       FROM inventory_items
 *      WHERE deleted_at IS NULL
 *      ORDER BY created_at DESC LIMIT 200
 *     ... targetText.includes(term) ...
 *
 * Four problems, in ascending order of seriousness:
 *
 *   1. It never ran at all. `inventory_items` has no `item_name`, no
 *      `description`, no `category` and no `deleted_at` — those live on
 *      `items`, the item master, reached through `item_master_id`. Every call
 *      to GET /inventory-items/semantic-search threw a Postgres "column does
 *      not exist" and returned 500. The feature has never once worked.
 *   2. Not semantic. Substring containment. "M8 hex bolt" does not match
 *      "hexagonal screw M8" — which is exactly the duplicate this exists to
 *      catch. Anything a plain ILIKE would find, it found; nothing more.
 *   3. LIMIT 200 by creation date. Duplicate detection that only sees the 200
 *      newest rows misses the back catalogue, which is precisely where the
 *      ORIGINAL of a duplicate lives — the original is by definition older.
 *   4. It sat beside services/ai/documentSearch.js, which already does real
 *      embeddings and real cosine similarity over `document_embeddings`
 *      (migration 126), and ignored it.
 *
 * The name being wrong is what made 2 and 3 dangerous rather than merely
 * disappointing: anyone reading "vector search" concludes deduplication is
 * handled.
 *
 * ===========================================================================
 * WHAT IT DOES NOW
 * ===========================================================================
 * Real embeddings via documentSearch.embed(), stored under source_type
 * 'item' / 'supplier', compared by cosine similarity across the whole
 * catalogue — against the columns that exist.
 *
 * With one deliberate compromise: a lexical path is KEPT as a fallback.
 * Embeddings run locally and need no key, but a failing embedding path (model
 * load error, etc.) should not make the duplicate check silently find
 * nothing. So a failing embedding path degrades to trigram matching over the
 * full table — worse results, honestly labelled in `method`, rather than no
 * results dressed up as a clean bill of health.
 */

const { pool } = require('../../config/database');
const { embed, cosineSimilarity } = require('./documentSearch');

// Above this, two records almost certainly describe the same thing.
const DUPLICATE_THRESHOLD = 0.86;
// Below this, not worth a person's attention. Low enough to catch rephrasings,
// high enough that a fastener catalogue does not flag every bolt against every
// other bolt.
const SIMILARITY_FLOOR = 0.62;

const SOURCES = {
  item: {
    table: 'items',
    // The columns that actually exist on the item master, in the order a
    // person would read them. An embedding is only as good as the text given.
    select: `id, item_code, name, description, category, item_category,
             manufacturer, manufacturer_part_number, unit_of_measure, status`,
    textExpr:
      "COALESCE(name,'') || ' ' || COALESCE(description,'') || ' ' "
      + "|| COALESCE(category,'') || ' ' || COALESCE(manufacturer,'') || ' ' "
      + "|| COALESCE(manufacturer_part_number,'')",
    describe: (r) => [
      r.name, r.description, r.category || r.item_category,
      r.manufacturer, r.manufacturer_part_number,
    ].filter(Boolean).join(' — '),
    label: (r) => r.name || r.item_code,
  },
  supplier: {
    table: 'suppliers',
    select: 'id, supplier_code, legal_name, trade_name, city, country, status',
    textExpr: "COALESCE(legal_name,'') || ' ' || COALESCE(trade_name,'') || ' ' || COALESCE(city,'')",
    describe: (r) => [r.legal_name, r.trade_name, r.city, r.country].filter(Boolean).join(' — '),
    label: (r) => r.legal_name || r.supplier_code,
  },
};

/** Embed one short string and return the raw vector. */
async function embedQuery(text) {
  const chunks = await embed(text);
  return chunks[0]?.embedding || null;
}

/**
 * Lexical fallback, across the WHOLE table.
 *
 * pg_trgm gives real fuzzy matching (typos, reordered words) rather than
 * substring containment. If the extension is absent the query throws and this
 * falls back again to ILIKE — still unbounded by creation date, which is the
 * part that actually mattered.
 */
async function lexicalSearch(kind, query, limit) {
  const source = SOURCES[kind];

  try {
    const { rows } = await pool.query(
      `SELECT ${source.select}, similarity(${source.textExpr}, $1) AS score
         FROM ${source.table}
        WHERE similarity(${source.textExpr}, $1) > $2
        ORDER BY score DESC
        LIMIT $3`,
      [query, SIMILARITY_FLOOR / 2, limit]
    );
    return { rows, method: 'trigram' };
  } catch {
    const { rows } = await pool.query(
      `SELECT ${source.select}, 0.5::float AS score
         FROM ${source.table}
        WHERE ${source.textExpr} ILIKE $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [`%${query}%`, limit]
    );
    return { rows, method: 'substring' };
  }
}

/**
 * Semantic search over stored embeddings.
 *
 * Returns null when embeddings are unavailable or nothing is indexed, so the
 * caller falls back rather than reporting a confident "no duplicates found".
 */
async function semanticSearch(kind, query, limit) {
  const { rows: indexed } = await pool.query(
    'SELECT source_id, embedding FROM document_embeddings WHERE source_type = $1',
    [kind]
  );
  if (!indexed.length) return null;

  let queryVector;
  try {
    queryVector = await embedQuery(query);
  } catch (error) {
    console.error(`Semantic ${kind} search could not embed the query:`, error.message);
    return null;
  }
  if (!queryVector) return null;

  // Best chunk per record: a record split across chunks is ranked by its
  // closest one, not by an average a long description would dilute.
  const bestByRecord = new Map();
  for (const row of indexed) {
    const score = cosineSimilarity(queryVector, row.embedding);
    const current = bestByRecord.get(row.source_id);
    if (current === undefined || score > current) bestByRecord.set(row.source_id, score);
  }

  const ranked = [...bestByRecord.entries()]
    .filter(([, score]) => score >= SIMILARITY_FLOOR)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  if (!ranked.length) return { rows: [], method: 'embedding' };

  const source = SOURCES[kind];
  const { rows } = await pool.query(
    `SELECT ${source.select} FROM ${source.table} WHERE id = ANY($1::uuid[])`,
    [ranked.map(([id]) => id)]
  );

  const scoreById = new Map(ranked);
  return {
    rows: rows
      .map((r) => ({ ...r, score: scoreById.get(r.id) || 0 }))
      .sort((a, b) => b.score - a.score),
    method: 'embedding',
  };
}

class VectorSearchService {
  /**
   * Find records that may already describe the same thing.
   *
   * @returns {{method: string, degraded: boolean, matches: Array}}
   *   `method` and `degraded` are part of the answer deliberately. A screen
   *   showing "no similar items found" should be able to say whether that came
   *   from a semantic search or a fallback, because the two carry very
   *   different amounts of assurance.
   */
  static async findSimilar(kind, query, { limit = 5 } = {}) {
    const source = SOURCES[kind];
    if (!source) throw new Error(`Unknown record type "${kind}".`);
    if (!query || typeof query !== 'string' || !query.trim()) {
      return { method: 'none', degraded: false, matches: [] };
    }

    const text = query.trim();
    const result = (await semanticSearch(kind, text, limit))
      || (await lexicalSearch(kind, text, limit));

    return {
      method: result.method,
      degraded: result.method !== 'embedding',
      matches: result.rows.map(({ score, ...row }) => ({
        ...row,
        similarity_score: Math.round(Number(score) * 100) / 100,
        // The judgement, not just the number. A caller deciding whether to warn
        // needs "is this a duplicate", and a bare 0.83 makes every call site
        // re-invent the same threshold slightly differently.
        likely_duplicate: Number(score) >= DUPLICATE_THRESHOLD,
        label: source.label(row),
      })),
    };
  }

  /** Backwards-compatible wrapper for the original call shape. */
  static async searchSimilarItems(query, limit = 5) {
    const { matches } = await this.findSimilar('item', query, { limit });
    return matches;
  }

  static async searchSimilarSuppliers(query, limit = 5) {
    const { matches } = await this.findSimilar('supplier', query, { limit });
    return matches;
  }

  /**
   * Index (or re-index) master data so semantic search has something to search.
   *
   * Without this the semantic path finds nothing and quietly degrades to
   * lexical forever — an embeddings table nothing ever writes to.
   */
  static async reindex(kind, { limit = 2000 } = {}) {
    const source = SOURCES[kind];
    if (!source) throw new Error(`Unknown record type "${kind}".`);

    const { indexDocument } = require('./documentSearch');
    const { rows } = await pool.query(
      `SELECT ${source.select} FROM ${source.table} ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );

    let indexed = 0;
    let skipped = 0;
    for (const row of rows) {
      const text = source.describe(row);
      // A record with nothing but an id describes nothing; embedding it adds a
      // vector that matches everything weakly and nothing usefully.
      if (!text || text.length < 3) { skipped += 1; continue; }
      await indexDocument({ source_type: kind, source_id: row.id, text });
      indexed += 1;
    }

    return { kind, indexed, skipped, total: rows.length };
  }
}

module.exports = VectorSearchService;
module.exports.DUPLICATE_THRESHOLD = DUPLICATE_THRESHOLD;
module.exports.SIMILARITY_FLOOR = SIMILARITY_FLOOR;
