-- Secrets that belong to the whole deployment, not to one company: today, the AI provider key the platform owner
-- can enter in Settings → AI instead of editing the server's environment. Encrypted with the same AES-256-GCM vault
-- as every other stored credential (AI_VAULT_KEY, services/ai/credentialVault.js); the value never leaves the
-- server through an API (only its last four characters do).
CREATE TABLE IF NOT EXISTS system_secrets (
  name        TEXT PRIMARY KEY,
  cipher      TEXT NOT NULL,
  iv          VARCHAR(32) NOT NULL,
  tag         VARCHAR(32) NOT NULL,
  key_id      VARCHAR(16) NOT NULL,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
