/**
 * Centralized AI configuration for Simeli ERP.
 *
 * Every AI-powered feature in the backend resolves its model, tuning
 * parameters and client from this single module. Previously the model id was
 * hard-coded in dozens of places, which made it impossible to upgrade the ERP
 * to a new model without a large, error-prone find/replace. This module makes
 * the model a single, environment-overridable setting.
 *
 * As of 2026-09 the ERP supports three providers selected via AI_PROVIDER:
 *   - "openai" (default) — OpenAI or any OpenAI-compatible endpoint
 *   - "anthropic" — Anthropic Claude models via the Messages API
 *   - "openrouter" — OpenRouter (openrouter.ai), OpenAI-compatible. AI_MODEL
 *     and AI_VISION_MODEL default to $0 ":free" OpenRouter models when this
 *     is set and neither is overridden — every text/vision/PDF/code feature
 *     in the app (chat, OCR, AI mail branding, the agent's tool-calling
 *     loop) already resolves its client and model from here, so switching
 *     providers needs no other code change.
 *
 * To point the ERP at a different deployment set AI_MODEL + AI_PROVIDER in the
 * environment; no code changes are required.
 */
require('dotenv').config();

const OpenAI = require('openai');

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

/** Which provider to use for chat completions: "openai" (default), "anthropic", or "openrouter". */
const AI_PROVIDER = (process.env.AI_PROVIDER || 'openai').toLowerCase();
const IS_OPENROUTER = AI_PROVIDER === 'openrouter';

// OpenRouter's $0 ":free" catalog — best-first, curated by capability
// (coding/reasoning benchmarks, context length, active-lab track record) and
// checked to genuinely be $0/M input+output, not merely cheap. services/ai/
// modelRouter.js is what actually picks from these at request time: it tries
// the top entry, and on a rate limit, quota exhaustion, or removed/renamed
// model falls to the next one and remembers (briefly) not to retry the one
// that just failed — see that file for the fallback/cooldown logic. This
// array is only the priority order, not the routing itself.
//
// The free catalog turns over as providers rotate capacity in and out, and a
// model slug guessed from a display name can be off by a hyphen — the
// router degrades to the next candidate either way, so a stale or wrong
// entry costs one wasted attempt, not a broken feature. Re-check current
// $0 models at https://openrouter.ai/models?max_price=0 periodically.
const FREE_TEXT_MODELS = [
  'openrouter/free',                        // OpenRouter's own auto-router: picks any available :free model and fails over server-side
  'nvidia/nemotron-3-ultra-550b-a55b:free',              // 550B MoE frontier reasoning, 1M ctx
  'minimax/minimax-m3:free',                   // strong agentic + coding, 1M ctx
  'thinkingmachines/inkling:free',             // 975B MoE general reasoning/coding
  'nvidia/nemotron-3-super-120b-a12b:free',              // strong on AIME/SWE-Bench Verified
  'poolside/laguna-s-2.1:free',                // dedicated coding agent, 70% Terminal-Bench 2.1
  'minimax/minimax-m2.7:free',                 // agentic productivity, real-world workflows
  'inclusionai/ling-3.0-flash-fin:free',       // general reasoning/coding/math, finance-tuned
  'cohere/north-mini-code:free',               // dedicated coding, low-latency
  'nvidia/nemotron-3.5-lightning:free',        // smaller, high-throughput
  'poolside/laguna-xs-2.1:free',               // smaller coding agent
  'dots-studio/dots-3-note-preview:free',       // lightweight general MoE
  'thinkingmachines/inkling-small:free',       // smaller Inkling variant
  'liquid/lfm-2.5-2.6b:free',                   // compact — vendor advises against coding/knowledge-heavy use
];

// Vision-capable free models only — most of the text list above cannot
// accept an image at all, so a photo, scanned PDF page, or a logo (AI mail
// branding) needs one of these specifically.
const FREE_VISION_MODELS = [
  'openrouter/free',                       // auto-router first; falls through to the curated vision models if it picks a text-only model
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',   // purpose-built perception sub-agent: text/image/video/audio
  'minimax/minimax-m3:free',            // strong general model, also multimodal (image/video input)
  'thinkingmachines/inkling:free',      // native image + audio understanding
  'thinkingmachines/inkling-small:free', // smaller multimodal fallback
];

// Primary model used by every AI feature unless a call explicitly overrides
// it — chat, the agent's tool-calling loop, PDF/report generation, coding
// help asked through chat. There is one general-purpose model in this app,
// not a separate one per task; OpenRouter's free vision model above is the
// one exception, because plain-text models cannot read an image at all.
const AI_MODEL = process.env.AI_MODEL || (IS_OPENROUTER ? FREE_TEXT_MODELS[0] : 'gpt-4o');

// A lighter/cheaper tier for high-frequency utility work.
const AI_MODEL_FAST = process.env.AI_MODEL_FAST || AI_MODEL;

// Vision model used to transcribe scanned documents and photos (OCR), and to
// read a logo for AI mail branding — anything with an actual image in it.
// PDFs go through this too: pdfTools.js/visionOcr.js turn a text-less PDF
// page into an image first, so a PDF that's a scan (not real text) is,
// under the hood, the same vision call as a photo. Must be served by the
// same OpenAI-compatible endpoint as AI_MODEL.
const AI_VISION_MODEL = process.env.AI_VISION_MODEL || (IS_OPENROUTER ? FREE_VISION_MODELS[0] : 'deepseek-v4-flash-vision-exp');

// Anthropic-specific model default.
const AI_MODEL_ANTHROPIC = process.env.AI_MODEL_ANTHROPIC || 'claude-sonnet-5';

// The effective default model for the active provider.
const AI_MODEL_RESOLVED = AI_PROVIDER === 'anthropic' ? AI_MODEL_ANTHROPIC : AI_MODEL;


// Shared generation defaults. Individual callers may override any of these.
const AI_DEFAULTS = {
  temperature: process.env.AI_TEMPERATURE ? Number(process.env.AI_TEMPERATURE) : 0.7,
  maxTokens: process.env.AI_MAX_TOKENS ? Number(process.env.AI_MAX_TOKENS) : 800,
};

// Reasoning/verbosity hints for models that support them (GPT-5 family).
const AI_REASONING = {
  effort: process.env.AI_REASONING_EFFORT || 'minimal',
  verbosity: process.env.AI_VERBOSITY || 'low',
};

// Whether AI features are available at all (requires an API key for the active provider).
const isAIEnabled = () => !!currentKey();

// A provider key the platform owner entered in Settings → AI (services/ai/providerKey.js) wins over the server's
// environment, so a rejected or expired key can be replaced without touching the server. Setting it rebuilds the
// clients, so the very next AI call uses it.
let KEY_OVERRIDE = null;
function setKeyOverride(key) { KEY_OVERRIDE = key || null; _openaiClient = null; _anthropicClient = null; }
function currentKey() {
  if (KEY_OVERRIDE) return KEY_OVERRIDE;
  if (AI_PROVIDER === 'anthropic') return process.env.ANTHROPIC_API_KEY;
  if (IS_OPENROUTER) return process.env.OPENROUTER_API_KEY;
  return process.env.OPENAI_API_KEY;
}

// Embeddings (services/ai/embeddings.js, services/ai/documentSearch.js) run
// locally via services/ai/localEmbeddings.js (all-MiniLM-L6-v2 through
// @xenova/transformers) — no API key, always available. Kept as a function
// (rather than deleting it and updating every call site) since ragRetrieval.js
// and the backfill scripts gate on it.
const isEmbeddingEnabled = () => true;

// Per-request timeout (ms) and automatic retry count for every AI call. A hung
// upstream should fail a single request in bounded time, not tie up a worker
// indefinitely. Both are environment-overridable.
const AI_TIMEOUT_MS = process.env.AI_TIMEOUT_MS ? Number(process.env.AI_TIMEOUT_MS) : 60000;
const AI_MAX_RETRIES = process.env.AI_MAX_RETRIES ? Number(process.env.AI_MAX_RETRIES) : 2;

// ---------------------------------------------------------------------------
// OpenAI-compatible client — serves both the "openai" provider and
// "openrouter". OpenRouter's API is OpenAI-compatible (chat completions,
// vision content parts, tool calling all in the same shapes the `openai` npm
// package already speaks), so this is the same client with a different
// baseURL/key rather than a fourth SDK to depend on. Every call site in this
// codebase that reaches for getOpenAIClient() directly (not through the
// provider-agnostic getAIClient()) picks this up automatically — there is
// only one OpenAI-compatible client in the process, ever.
// ---------------------------------------------------------------------------

let _openaiClient = null;
const buildOpenAIClient = () => {
  if (!_openaiClient) {
    const isOpenRouter = AI_PROVIDER === 'openrouter';
    _openaiClient = new OpenAI({
      apiKey: currentKey(),
      baseURL: isOpenRouter
        ? (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1')
        : (process.env.OPENAI_BASE_URL || undefined),
      timeout: AI_TIMEOUT_MS,
      maxRetries: AI_MAX_RETRIES,
      // OpenRouter asks for these on every request — they attribute usage to
      // this app on their dashboard and are read for the (generous but real)
      // free-tier rate limit, not just cosmetic. Harmless when sent to a
      // plain OpenAI-compatible endpoint, which ignores unknown headers.
      defaultHeaders: isOpenRouter
        ? { 'HTTP-Referer': process.env.BASE_URL || process.env.FRONTEND_URL || 'https://embmis.com', 'X-Title': 'EMBMIS' }
        : undefined,
    });
  }
  return _openaiClient;
};

/**
 * Returns a handle to the OpenAI client that does not construct it yet.
 *
 * The memoisation above was already lazy, but four callers invoke this at
 * module scope or in a constructor (aiEnhancementService, aiModuleService,
 * intelligentChatRouter, nameValidationService), so "lazy" only ever deferred
 * as far as the first `require`. Since `new OpenAI()` throws outright when
 * OPENAI_API_KEY is unset, a deployment without an AI key could not boot the
 * ERP at all — the process died while loading routes, taking inventory,
 * finance and procurement down with it.
 *
 * The proxy pushes construction to the first real property access
 * (`client.chat`, `client.embeddings`, …), which happens inside the callers'
 * try/catch blocks where a missing key degrades that one AI feature instead of
 * killing the server. Returning a proxy rather than editing the four callers
 * also means a fifth eager caller cannot reintroduce the crash.
 */
const getOpenAIClient = () =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        const client = buildOpenAIClient();
        const value = client[prop];
        return typeof value === 'function' ? value.bind(client) : value;
      },
      has: (_target, prop) => prop in buildOpenAIClient(),
    }
  );

// ---------------------------------------------------------------------------
// Anthropic client
// ---------------------------------------------------------------------------

let _anthropicClient = null;
function getAnthropicClient() {
  if (!_anthropicClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropicClient = new Anthropic({
      apiKey: currentKey(),
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
      timeout: AI_TIMEOUT_MS,
      maxRetries: AI_MAX_RETRIES,
    });
  }
  return _anthropicClient;
}

// ---------------------------------------------------------------------------
// Unified client factory
// ---------------------------------------------------------------------------

/**
 * Returns the appropriate AI client for the configured provider.
 * Use this instead of getOpenAIClient() in code that should be provider-agnostic.
 */
function getAIClient() {
  if (AI_PROVIDER === 'anthropic') return getAnthropicClient();
  return getOpenAIClient();
}

/** Returns the active provider name. */
function getAIProvider() {
  return AI_PROVIDER;
}

/**
 * Returns the deployment-level default model for the active provider
 * (independent of any UI override stored in ai_settings).
 */
function resolveDefaultModel() {
  return process.env.AI_MODEL || AI_MODEL_RESOLVED;
}

/** Summary of what's configured, for the settings API. */
function getProviderInfo() {
  return {
    provider: AI_PROVIDER,
    available: {
      openai: !!process.env.OPENAI_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openrouter: !!process.env.OPENROUTER_API_KEY,
    },
    default_model: AI_MODEL_RESOLVED,
    vision_model: AI_VISION_MODEL,
  };
}

module.exports = {
  AI_MODEL,
  AI_MODEL_FAST,
  AI_VISION_MODEL,
  AI_MODEL_ANTHROPIC,
  AI_MODEL_RESOLVED,
  AI_DEFAULTS,
  AI_REASONING,
  AI_PROVIDER,
  IS_OPENROUTER,
  FREE_TEXT_MODELS,
  FREE_VISION_MODELS,
  AI_TIMEOUT_MS,
  AI_MAX_RETRIES,
  isAIEnabled,
  isEmbeddingEnabled,
  getOpenAIClient,
  getAnthropicClient,
  getAIClient,
  getAIProvider,
  resolveDefaultModel,
  getProviderInfo,
  setKeyOverride,
  currentKey,
};
