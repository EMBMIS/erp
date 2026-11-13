/**
 * MCP server discovery.
 *
 * Searches two sources in parallel and merges the results into one ranked
 * list:
 *
 *   1. The curated registry (mcpRegistry.js) — hand-picked, so it is scored
 *      by simple keyword overlap rather than anything fancier.
 *   2. Live web search via WebSearchAgent (Tavily), so a server not on the
 *      curated list can still turn up. If TAVILY_API_KEY is not configured,
 *      WebSearchAgent already reports that gracefully — this module just
 *      drops that source rather than erroring the whole request.
 *
 * Phase 1 only: this discovers candidates. Actually connecting to one and
 * running its tools is a later phase — see routes/ai-mcp.js.
 */

const { REGISTRY } = require('./mcpRegistry');
const WebSearchAgent = require('../webSearchAgent');
const mcpEndpoint = require('./mcpEndpoint');

const webSearchAgent = new WebSearchAgent();

// How many results get the full "how do I actually connect to this" treatment.
const ENRICH_LIMIT = 5;

// Common enough to collide with unrelated registry entries by accident — "a
// tool that..." matches the word "tool" in "Developer tools", "...and..."
// matches nothing in particular but shows up in half the descriptions. None
// of these identify what the person is actually looking for.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'with', 'for', 'that', 'this', 'these', 'those',
  'from', 'into', 'onto', 'to', 'of', 'in', 'on', 'at', 'by', 'is', 'are', 'be',
  'it', 'its', 'my', 'our', 'your', 'their', 'me', 'i', 'we', 'you', 'want',
  'need', 'like', 'tool', 'tools', 'server', 'servers', 'mcp',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** Keyword overlap against a curated entry, weighted by which field matched. */
function scoreRegistryEntry(entry, queryTokens) {
  const name = entry.name.toLowerCase();
  const description = entry.description.toLowerCase();
  const category = entry.category.toLowerCase();
  const tools = entry.tools_preview.join(' ').toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    if (name.includes(token)) score += 3;
    if (category.includes(token)) score += 2;
    if (tools.includes(token)) score += 2;
    if (description.includes(token)) score += 1;
  }
  return score;
}

function searchRegistry(query) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  return REGISTRY
    .map((entry) => ({ entry, score: scoreRegistryEntry(entry, queryTokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ entry, score }) => ({
      name: entry.name,
      description: entry.description,
      url_or_package: entry.url_or_package,
      category: entry.category,
      tools_preview: entry.tools_preview,
      source: 'registry',
      score,
    }));
}

/** Best-effort parse of a web search hit into a candidate MCP server. */
function toWebCandidate(result, queryTokens) {
  const title = String(result.title || result.url || 'MCP server').trim();
  const content = String(result.content || '').trim();

  let score = (Number(result.score) || 0) * 5;
  const haystack = `${title} ${content}`.toLowerCase();
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 1;
  }
  // A result that never mentions MCP at all is almost never a real server —
  // web search for "X MCP server" still returns plenty of unrelated hits.
  if (!haystack.includes('mcp') && !haystack.includes('model context protocol')) {
    return null;
  }

  return {
    name: title.slice(0, 160),
    description: (content || title).slice(0, 500),
    url_or_package: result.url,
    category: 'Web result',
    tools_preview: [],
    source: 'web',
    score,
    // Kept for the enrichment pass, which reads the page rather than ranking
    // it. Stripped before the candidate is returned to the caller.
    _rawContent: result.rawContent || null,
    _content: content,
  };
}

async function searchWeb(query) {
  try {
    const result = await webSearchAgent.search(`MCP server ${query} Model Context Protocol tools`, {
      maxResults: 5,
      searchDepth: 'basic',
    });
    if (!result.success || !Array.isArray(result.results)) return [];

    const queryTokens = tokenize(query);
    return result.results
      .map((r) => toWebCandidate(r, queryTokens))
      .filter(Boolean);
  } catch (error) {
    // Web search is a bonus source, never a hard dependency of discovery.
    console.error('MCP web search failed:', error.message);
    return [];
  }
}

/** De-dupe by url_or_package (case-insensitive), preferring the higher score. */
function merge(candidates) {
  const byKey = new Map();
  for (const c of candidates) {
    const key = String(c.url_or_package || c.name).toLowerCase();
    const existing = byKey.get(key);
    if (!existing || c.score > existing.score) byKey.set(key, c);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

/**
 * @param {string} query
 * @returns {Promise<Array<{name, description, url_or_package, category, tools_preview}>>}
 */
/**
 * Work out how each web result is actually connected to.
 *
 * Only the top few are enriched: each one may cost a page read, a model call
 * and a handshake, and nobody scrolls to the tenth result of a search they are
 * about to act on. The rest are returned as found.
 */
async function enrich(candidates) {
  const top = candidates.slice(0, ENRICH_LIMIT);
  const rest = candidates.slice(ENRICH_LIMIT);

  const enriched = await Promise.all(
    top.map(async (candidate) => {
      if (candidate.source === 'registry') return candidate;
      try {
        const resolved = await mcpEndpoint.resolve({
          name: candidate.name,
          url: candidate.url_or_package,
          content: candidate._content,
          rawContent: candidate._rawContent,
        });
        return {
          ...candidate,
          ...resolved,
          // Real tool names beat an empty list; keep whatever was already there
          // if the probe could not list any (an endpoint behind auth, say).
          tools_preview: resolved.tools_preview.length ? resolved.tools_preview : candidate.tools_preview,
          // Something we have actually connected to belongs above a page that
          // merely mentions one — this is the whole point of probing. An
          // endpoint that only answered with "authenticate first" gets a
          // smaller lift: promising, but not proof it is a server.
          score: candidate.score
            + (resolved.verified ? 100 : 0)
            + (resolved.needs_auth ? 35 : 0)
            + (!resolved.verified && !resolved.needs_auth && resolved.endpoint_url ? 15 : 0)
            + (resolved.install_command || resolved.instructions ? 10 : 0),
        };
      } catch (error) {
        console.error(`Could not work out how to connect to "${candidate.name}":`, error.message);
        return candidate;
      }
    })
  );

  return [...enriched, ...rest];
}

async function discover(query) {
  const q = String(query || '').trim();
  if (q.length < 2) {
    throw new Error('Describe what you need in a few words.');
  }

  const [registryResults, webResults] = await Promise.all([
    Promise.resolve(searchRegistry(q)),
    searchWeb(q),
  ]);

  const merged = merge([...registryResults, ...webResults]);
  const enriched = await enrich(merged);

  return enriched
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ score, _rawContent, _content, ...candidate }) => candidate);
}

module.exports = { discover, searchRegistry };
