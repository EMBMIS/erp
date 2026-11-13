/**
 * Automatic RAG context retrieval for the AI chat agent.
 *
 * search_documents (documentSearch.js, exposed via toolRegistry.js) already
 * does semantic search over document_embeddings, but only when the model
 * chooses to call it as a tool — a user asking "what's our PO approval
 * threshold?" gets an answer only if the model happens to reach for that
 * tool. This module runs the same search unconditionally, once per user
 * message, so company documents/policies are available as context whether or
 * not the model would have thought to look for them.
 *
 * Deliberately thin: documentSearch.js still owns chunking, embedding and
 * the actual (SQL, pgvector `<=>`) similarity ranking. This module adds a
 * threshold cutoff and resolves each chunk's parent document title, since
 * document_embeddings itself only knows (source_type, source_id).
 *
 * Every failure mode here — a query that embeds to nothing, a search error —
 * resolves to an empty array rather than a thrown error. A worse answer (no
 * retrieved context) is fine; a broken chat turn is not.
 */

const { pool } = require('../../config/database');
const documentSearch = require('./documentSearch');

const TITLE_RESOLVERS = {
  kb_document: async (ids) => {
    const { rows } = await pool.query('SELECT id, title FROM kb_documents WHERE id = ANY($1::uuid[])', [ids]);
    return new Map(rows.map((r) => [r.id, r.title]));
  },
  sales_contract: async (ids) => {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(contract_name, contract_number) AS title FROM sales_contracts WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    return new Map(rows.map((r) => [r.id, r.title]));
  },
  generated_document: async (ids) => {
    const { rows } = await pool.query('SELECT id, title FROM generated_documents WHERE id = ANY($1::uuid[])', [ids]);
    return new Map(rows.map((r) => [r.id, r.title]));
  },
  chat_message: async (ids) => {
    const { rows } = await pool.query(
      `SELECT cm.id, COALESCE(c.title, 'Untitled conversation') AS title
         FROM conversation_messages cm
         JOIN conversations c ON c.id = cm.conversation_id
        WHERE cm.id = ANY($1::uuid[])`,
      [ids]
    );
    return new Map(rows.map((r) => [r.id, r.title]));
  },
  supplier_invoice: async (ids) => {
    const { rows } = await pool.query(
      `SELECT si.id, COALESCE(s.legal_name, s.name, 'Supplier') AS supplier_name,
              si.bill_number, si.supplier_invoice_number
         FROM supplier_invoices si
         LEFT JOIN suppliers s ON s.id = si.supplier_id
        WHERE si.id = ANY($1::uuid[])`,
      [ids]
    );
    return new Map(rows.map((r) => [r.id, `${r.supplier_name} — ${r.supplier_invoice_number || r.bill_number}`]));
  },
};

/**
 * Given a user query, find the most relevant document chunks across every
 * indexed source type (knowledge base uploads, sales contracts, generated
 * documents).
 *
 * @param {string} query
 * @param {{limit?: number, threshold?: number}} [options]
 *   `threshold` is a cosine-similarity cutoff (0-1); results below it are
 *   dropped rather than padding the prompt with weak matches. Company
 *   scoping is not done here — document_embeddings is already company-scoped
 *   by the ambient RLS context every pool query runs under (see
 *   config/database.js), the same way documentSearch.search() itself is.
 * @returns {Promise<Array<{chunk_text: string, document_title: string, similarity_score: number}>>}
 */
async function retrieveContext(query, { limit = 5, threshold = 0.7 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  let result;
  try {
    result = await documentSearch.search(q, { limit });
  } catch (err) {
    console.error('ragRetrieval: search failed:', err.message);
    return [];
  }

  if (!result?.indexed || !result.results?.length) return [];

  // Results already arrive sorted by score, descending — filtering to the
  // threshold from that top slice cannot skip over a stronger match further
  // down, since none exists.
  const above = result.results.filter((r) => r.score >= threshold);
  if (!above.length) return [];

  const idsByType = {};
  for (const r of above) (idsByType[r.source_type] ||= new Set()).add(r.source_id);

  const titleMaps = {};
  await Promise.all(
    Object.entries(idsByType).map(async ([type, idSet]) => {
      const resolver = TITLE_RESOLVERS[type];
      if (!resolver) return;
      titleMaps[type] = await resolver([...idSet]).catch(() => new Map());
    })
  );

  return above.map((r) => ({
    chunk_text: r.chunk_text,
    document_title: titleMaps[r.source_type]?.get(r.source_id) || r.source_type,
    similarity_score: r.score,
  }));
}

module.exports = { retrieveContext };
