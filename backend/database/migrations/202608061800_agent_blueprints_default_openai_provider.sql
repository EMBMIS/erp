-- Agents were created back when 'anthropic' was the blueprint default, but the
-- server only ever configures an OpenAI-compatible key (DeepSeek via
-- OPENAI_BASE_URL). Every such agent fails at run time with "ANTHROPIC_API_KEY
-- is not set" even though a perfectly good AI provider is configured — the
-- blueprint just points at the wrong one. Runtime now falls back gracefully
-- (services/agents/aiAgentRunner.js resolveClient), but existing blueprints
-- should simply be corrected so they run on the provider that is actually
-- configured, rather than depend on the fallback path.
UPDATE agent_blueprints
SET provider = 'openai'
WHERE provider = 'anthropic'
  AND credential_id IS NULL;
