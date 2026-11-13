/**
 * Local, in-process embedding generation — no external API, no API key.
 *
 * Runs all-MiniLM-L6-v2 (a small, well-regarded sentence-embedding model)
 * directly in Node via @xenova/transformers (ONNX runtime under the hood,
 * CPU-only, no GPU required). Model weights (~90MB) download once on first
 * use and are cached under node_modules/@xenova/transformers/.cache — no
 * network access needed after that first run.
 *
 * Replaces the OpenAI embeddings API that documentSearch.js/knowledgeBase.js
 * previously depended on: this ERP's chat model is DeepSeek (which has no
 * embeddings endpoint of its own), and requiring a *separate* real OpenAI key
 * just to embed documents was an unnecessary external dependency for
 * something that runs perfectly well locally at this document volume.
 *
 * EMBEDDING_DIM (384) is what migration 202608070100 sized the
 * document_embeddings.embedding vector(384) column to — the two must agree,
 * since pgvector enforces the column's dimension on every insert.
 */

const EMBEDDING_DIM = 384;
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

// The transformers cache defaults to node_modules/@xenova/transformers/.cache,
// which is root-owned and read-only after the image drops to USER node — the
// first embed would fail with EACCES on a fresh container and silently disable
// every RAG retrieval. Redirect it to /app/cache (created and chowned in the
// Dockerfile) where the runtime user can write.
(async () => {
  try {
    const { env } = await import('@xenova/transformers');
    env.cacheDir = '/app/cache';
  } catch (_) { /* non-fatal: embed will surface its own error if unavailable */ }
})();

// Loaded once and reused — instantiating the pipeline (reading + compiling
// the ONNX model) costs real time, so every call after the first reuses this
// promise rather than re-loading the model.
let extractorPromise = null;

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import('@xenova/transformers').then(({ pipeline }) =>
      pipeline('feature-extraction', MODEL_NAME)
    );
  }
  return extractorPromise;
}

/**
 * Embed one or more strings. Always returns an array of vectors (length ===
 * texts.length), mirroring the batch shape callers already expect from the
 * OpenAI embeddings endpoint this replaces.
 *
 * NOT metered. This used to call usageLimits.checkAndIncrementUsage() for
 * 'embedding_calls' and THROW when a company was over its monthly plan limit,
 * which made a quota decision indistinguishable from a failure: the throw
 * propagated out of RAG retrieval and duplicate detection into whatever
 * request triggered it, so exceeding a free-tier ceiling surfaced as a broken
 * feature rather than a limit being reached. Removed on request.
 *
 * Consequences worth knowing:
 *   - Local inference is CPU work with no dollar cost, so nothing else bounds
 *     it. The AI spend cap (services/ai/usageTracking.js) tracks $ and cannot
 *     see this. Embedding generation is now effectively unlimited per company.
 *   - usage_counters no longer receives embedding_calls rows, so the
 *     embedding_calls usage counter (ai_usage,
 *     via usageLimits.getUsageSummary) will read 0 permanently.
 *
 * To re-meter without the failure mode, the check belongs at the request edge
 * where a limit can be reported as a limit, not deep inside a helper whose
 * callers all treat a throw as an error.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedBatch(texts) {
  const clean = texts.map((t) => String(t || '').trim()).filter(Boolean);
  if (!clean.length) return [];

  const extractor = await getExtractor();
  const vectors = [];
  // One text at a time rather than a single batched call: transformers.js
  // pads a batch to its longest member, which wastes compute unevenly across
  // very different chunk lengths. At the chunk counts a single document
  // produces (tens, not thousands) sequential calls are fast enough and keep
  // memory bounded.
  for (const text of clean) {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    vectors.push(Array.from(output.data));
  }
  return vectors;
}

async function embed(text) {
  const [vector] = await embedBatch([text]);
  return vector || [];
}

module.exports = { embed, embedBatch, EMBEDDING_DIM, MODEL_NAME };
