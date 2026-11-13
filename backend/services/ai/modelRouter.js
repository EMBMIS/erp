/**
 * Smart model routing for OpenRouter's free tier.
 *
 * A single free model is not reliable enough to hard-code as THE model: a
 * provider hits capacity, a model gets rate-limited or retired, and a single
 * pinned model just fails outright until someone notices and edits an env
 * var. This tries the best available model first (config/aiConfig.js's
 * FREE_TEXT_MODELS / FREE_VISION_MODELS, ranked by capability, not just
 * "whatever responds") and falls through the priority list on failure,
 * remembering — briefly — which model just failed so the NEXT request
 * doesn't retry it immediately too.
 *
 * Only used for AI_PROVIDER=openrouter. Every other provider has exactly one
 * model configured and no free-tier flakiness to route around, so
 * `withFallback` there is a single try, no different from calling the SDK
 * directly.
 */

const { IS_OPENROUTER, FREE_TEXT_MODELS, FREE_VISION_MODELS, AI_MODEL, AI_VISION_MODEL } = require('../../config/aiConfig');

// Last-resort provider: the legacy OpenAI-compatible endpoint this
// deployment ran on before OpenRouter (DeepSeek — OPENAI_API_KEY +
// OPENAI_BASE_URL are still in backend/.env). Only consulted after every
// free OpenRouter model failed to even start, so the free tier stays the
// primary path and DeepSeek is a paid-but-working safety net. Model names
// default to the ones this deployment used before the switch; override via
// AI_FALLBACK_MODEL / AI_VISION_FALLBACK_MODEL.
const FALLBACK_TEXT_MODEL = process.env.AI_FALLBACK_MODEL || 'deepseek-chat';
const FALLBACK_VISION_MODEL = process.env.AI_VISION_FALLBACK_MODEL || 'deepseek-v4-flash-vision-exp';

function fallbackCandidate(kind) {
  if (!IS_OPENROUTER) return null;
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_BASE_URL) return null;
  return kind === 'vision' ? FALLBACK_VISION_MODEL : FALLBACK_TEXT_MODEL;
}

let deepseekClient = null;
function getDeepSeekClient() {
  if (!deepseekClient) {
    const { OpenAI } = require('openai');
    deepseekClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      timeout: 120000,
    });
  }
  return deepseekClient;
}

// modelId -> timestamp (ms) until which this model is skipped. In-memory and
// per-process — deliberately not persisted: a cooldown surviving a restart
// buys nothing (OpenRouter capacity can recover in the meantime) and losing
// it on deploy is the safe direction to fail in.
const cooldowns = new Map();

const COOLDOWN_MS = {
  rate_limited: 2 * 60 * 1000,      // 429 — busy right now, likely fine soon
  quota_exhausted: 30 * 60 * 1000,  // 402 — this free tier is spent for a while
  not_found: 24 * 60 * 60 * 1000,   // 400/404 — wrong/retired slug, not worth retrying today
  server_error: 60 * 1000,          // 5xx — transient
  default: 5 * 60 * 1000,
};

function classifyFailure(err) {
  const status = err?.status || err?.response?.status;
  if (status === 429) return 'rate_limited';
  if (status === 402) return 'quota_exhausted';
  if (status === 400 || status === 404) return 'not_found';
  if (status >= 500) return 'server_error';
  return 'default';
}

function isOnCooldown(modelId) {
  const until = cooldowns.get(modelId);
  return !!until && until > Date.now();
}

function recordFailure(modelId, err) {
  const reason = classifyFailure(err);
  cooldowns.set(modelId, Date.now() + (COOLDOWN_MS[reason] || COOLDOWN_MS.default));
}

function recordSuccess(modelId) {
  cooldowns.delete(modelId);
}

/**
 * Ordered list of models to try for one request. `preferred` — a caller's
 * own resolved model (e.g. the admin UI's per-deployment override in
 * ai_settings, which the deployment-level AI_MODEL env var cannot see) —
 * always goes first when given; otherwise the env-level AI_MODEL /
 * AI_VISION_MODEL does. Either way the rest is the priority-ranked free
 * catalog, with currently-cooling-down entries pushed to the back rather
 * than dropped outright (if EVERY candidate is cooling down, something has
 * to be attempted, and the one that failed longest ago is the best
 * remaining bet).
 */
function candidateModels(kind, preferred) {
  const envDefault = kind === 'vision' ? AI_VISION_MODEL : AI_MODEL;
  if (!IS_OPENROUTER) return [preferred || envDefault];

  const first = preferred || envDefault;
  const pool = kind === 'vision' ? FREE_VISION_MODELS : FREE_TEXT_MODELS;
  const ordered = [first, ...pool.filter((m) => m !== first)];

  const available = ordered.filter((m) => !isOnCooldown(m));
  const cooling = ordered.filter((m) => isOnCooldown(m)).sort((a, b) => (cooldowns.get(a) || 0) - (cooldowns.get(b) || 0));
  return [...available, ...cooling];
}

/**
 * Run `attempt(modelId)` against each candidate for `kind` in priority
 * order, stopping at the first one that doesn't throw. `attempt` should
 * perform the actual API call (streaming or not) and let a failure reject
 * normally — this only reacts to a request that failed to even start
 * (wrong/unavailable model, rate limit, quota), not a stream that started
 * fine and broke mid-response.
 *
 * @param {'text'|'vision'} kind
 * @param {(modelId: string) => Promise<T>} attempt
 * @param {string} [preferred] — try this model before the priority catalog
 * @returns {Promise<{model: string, value: T}>}
 */
async function withFallback(kind, attempt, preferred) {
  const fallback = fallbackCandidate(kind);
  const candidates = [...candidateModels(kind, preferred), ...(fallback ? [fallback] : [])];
  let lastErr;
  for (const modelId of candidates) {
    const isFallback = modelId === fallback;
    try {
      const value = await attempt(modelId, isFallback ? getDeepSeekClient() : undefined);
      recordSuccess(modelId);
      if (isFallback) {
        console.warn(`[modelRouter] all free OpenRouter models failed — answered via ${modelId} (DeepSeek fallback).`);
      }
      return { model: modelId, value };
    } catch (err) {
      lastErr = err;
      recordFailure(modelId, err);
      console.warn(`[modelRouter] ${modelId} failed (${classifyFailure(err)}: ${err.message}) — trying next candidate.${isFallback ? ' (deepseek fallback)' : ''}`);
    }
  }
  throw lastErr || new Error(`No candidate model was available for "${kind}".`);
}

/** For the AI settings page: what's currently cooling down, and for how much longer. */
function cooldownStatus() {
  const now = Date.now();
  return [...cooldowns.entries()]
    .filter(([, until]) => until > now)
    .map(([model, until]) => ({ model, retry_in_seconds: Math.round((until - now) / 1000) }));
}

module.exports = { withFallback, candidateModels, cooldownStatus };
