/**
 * Classify OpenAI SDK errors into an actionable shape.
 *
 * Before this, every AI failure path in this codebase collapsed into either a
 * generic "please try again" chat message or a hardcoded fallback object with
 * no indication anything went wrong — both actively mislead the user/operator
 * when the real cause is something only an admin can fix (an expired API key,
 * a billing/quota problem) rather than a transient glitch worth retrying.
 */

function classifyAiError(err) {
  const status = err?.status || err?.response?.status;
  const code = err?.code || err?.error?.code;
  const type = err?.type || err?.error?.type;

  if (status === 429 && (code === 'insufficient_quota' || type === 'insufficient_quota')) {
    return {
      code: 'QUOTA_EXCEEDED',
      retryable: false,
      userMessage: 'The AI service is unavailable: the configured API key has exceeded its usage quota/billing limit. An administrator needs to check the OpenAI account’s plan and billing.',
    };
  }
  if (status === 429) {
    return {
      code: 'RATE_LIMITED',
      retryable: true,
      userMessage: 'The AI service is temporarily rate-limited. Please wait a moment and try again.',
    };
  }
  if (status === 401 || code === 'invalid_api_key') {
    return {
      code: 'AUTH_ERROR',
      retryable: false,
      userMessage: 'The AI service is unavailable: the AI provider rejected the configured API key (expired, revoked or wrong). The platform owner can enter a new key in Settings → AI → Provider key.',
    };
  }
  if (status === 403 || code === 'permission_denied') {
    return {
      code: 'FORBIDDEN',
      retryable: false,
      userMessage: 'The AI service refused this request: the configured API key is not allowed to use this model or feature. An administrator needs to check the AI provider settings.',
    };
  }
  if (status === 404 || code === 'model_not_found') {
    return {
      code: 'MODEL_NOT_FOUND',
      retryable: false,
      userMessage: 'The AI service does not know the configured model. An administrator needs to choose an available model in the AI settings.',
    };
  }
  const net = code || err?.cause?.code;
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(net) || err?.name === 'APIConnectionError') {
    return {
      code: 'UNREACHABLE',
      retryable: true,
      userMessage: 'The AI service could not be reached from the server. If it runs as a separate service (for example a model proxy), it may be down.',
    };
  }
  if (typeof status === 'number' && status >= 500) {
    return {
      code: 'PROVIDER_ERROR',
      retryable: true,
      userMessage: 'The AI provider had a problem answering. Please try again in a moment.',
    };
  }
  if (err?.name === 'APIConnectionTimeoutError' || code === 'ETIMEDOUT' || err?.name === 'AbortError') {
    return {
      code: 'TIMEOUT',
      retryable: true,
      userMessage: 'The AI service took too long to respond. Please try again.',
    };
  }
  return {
    code: 'UNKNOWN',
    retryable: true,
    userMessage: 'I encountered an error processing your request. Please try again.',
  };
}

module.exports = { classifyAiError };
