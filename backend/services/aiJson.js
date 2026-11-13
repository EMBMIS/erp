/**
 * Robust JSON extraction for LLM output.
 *
 * Models frequently wrap JSON in ```json ... ``` fences, add a prose preamble,
 * or emit trailing commentary — all of which break a bare JSON.parse and, in
 * this codebase, silently drop the real AI result in favor of a low-confidence
 * fallback. This helper strips fences and, if needed, extracts the first
 * balanced {...} / [...] block before parsing.
 *
 * @param {string} raw           The model's message content.
 * @param {*}      [fallback]    Returned if nothing parseable is found. If the
 *                               fallback is omitted, a parse failure throws.
 */
function safeJsonParse(raw, fallback) {
  const hasFallback = arguments.length > 1;
  try {
    if (raw == null) throw new Error('empty AI response');
    let text = String(raw).trim();

    // Strip Markdown code fences (```json ... ``` or ``` ... ```).
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fence) text = fence[1].trim();

    try {
      return JSON.parse(text);
    } catch (_) {
      // Fall back to extracting the first JSON object/array in the text.
      const start = text.search(/[[{]/);
      if (start !== -1) {
        const open = text[start];
        const close = open === '{' ? '}' : ']';
        const end = text.lastIndexOf(close);
        if (end > start) {
          return JSON.parse(text.slice(start, end + 1));
        }
      }
      throw new Error('no JSON found in AI response');
    }
  } catch (err) {
    if (hasFallback) return fallback;
    throw err;
  }
}

module.exports = { safeJsonParse };
