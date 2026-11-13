-- 098 — API keys + webhook subscriptions for external integrations
-- (ERP-Roadmap P3 #20). This is the real, generalized version of the
-- server-held-secret pattern recommended when the client-controlled
-- X-AI-Service header bypass was removed (audit B1): a real integration now
-- authenticates with a hashed, revocable, scoped API key instead of a bare
-- header value the client controls.
-- Idempotent.

CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(100) NOT NULL,
  key_prefix   VARCHAR(12)  NOT NULL, -- first chars of the key, shown in UI so a key is recognizable without re-revealing it
  key_hash     VARCHAR(128) NOT NULL, -- sha256 hex of the full key; the plaintext key is shown ONCE at creation and never stored
  scopes       TEXT[] NOT NULL DEFAULT ARRAY['read']::TEXT[], -- 'read' | 'write' (write still goes through normal role checks)
  role         VARCHAR(20) NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','MANAGER','ADMIN')),
  status       VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_by   UUID REFERENCES users(id),
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url          TEXT NOT NULL,
  event_types  TEXT[] NOT NULL, -- e.g. '{journal_entry.posted, sales_order.completed}'
  secret       VARCHAR(64) NOT NULL, -- used to HMAC-sign delivered payloads so the receiver can verify authenticity
  status       VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_by   UUID REFERENCES users(id),
  last_delivery_at     TIMESTAMPTZ,
  last_delivery_status INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_status ON webhook_subscriptions(status);

CREATE TABLE IF NOT EXISTS webhook_delivery_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID REFERENCES webhook_subscriptions(id),
  event_type     VARCHAR(100) NOT NULL,
  payload        JSONB NOT NULL,
  response_status INTEGER,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_log_sub ON webhook_delivery_log(subscription_id);
