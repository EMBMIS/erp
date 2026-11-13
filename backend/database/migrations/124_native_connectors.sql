-- 124 — Native OAuth connectors.
--
-- The MCP tables (121-123) connect to servers that speak the Model Context
-- Protocol. Most of the products people actually want — Google Drive, Gmail,
-- Outlook, Salesforce, Xero, QuickBooks — publish no MCP server at all. The AI
-- products that appear to "connect" to them are not using MCP either: they
-- registered an OAuth application with each vendor and call that vendor's REST
-- API directly.
--
-- This table is that second mechanism. A connector is one OAuth application
-- (client id + secret, supplied by whoever runs this ERP, because only the
-- account owner can create one) plus the tokens obtained by signing in with it.
-- The provider's endpoints, scopes and API base live in code
-- (services/ai/connectorProviders.js), not here — they are configuration, not
-- data, and putting them in the database would fork them from the tool
-- definitions that depend on them.
--
-- One row per provider per company. `status` follows the same vocabulary as
-- mcp_connections so both kinds of connection read the same way in the UI.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS connectors (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Matches a key in services/ai/connectorProviders.js.
  provider            VARCHAR(60) NOT NULL,

  -- What to call it in the UI; defaults to the provider's display name but can
  -- be overridden when two accounts of the same provider are connected.
  label               VARCHAR(160),

  -- The OAuth application. Only the account owner can create one, so these are
  -- supplied per installation rather than shipped with the code. The secret is
  -- encrypted with the same AES-256-GCM helpers as every other secret here.
  client_id           TEXT,
  client_secret_cipher TEXT,
  client_secret_iv    VARCHAR(32),
  client_secret_tag   VARCHAR(32),

  -- Tokens obtained by signing in.
  access_token_cipher TEXT,
  access_token_iv     VARCHAR(32),
  access_token_tag    VARCHAR(32),
  refresh_token_cipher TEXT,
  refresh_token_iv    VARCHAR(32),
  refresh_token_tag   VARCHAR(32),
  access_token_expires_at TIMESTAMPTZ,
  scope               TEXT,

  -- Whatever the provider hands back that later calls need: a Shopify shop
  -- domain, a Xero tenant id, an instance URL for Salesforce. Provider-specific
  -- by nature, so kept as JSON rather than as a column per vendor.
  account_info        JSONB NOT NULL DEFAULT '{}'::jsonb,

  status              VARCHAR(20) NOT NULL DEFAULT 'pending_auth'
                      CHECK (status IN ('pending_auth', 'connected', 'disconnected', 'error')),
  last_error          TEXT,

  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_connectors_provider ON connectors (provider);
CREATE INDEX IF NOT EXISTS idx_connectors_status ON connectors (status);

-- In-flight authorization redirects. Same reasoning as mcp_oauth_pending: the
-- browser leaves this app and comes back on a separate request, and the PKCE
-- verifier must never travel with it.
CREATE TABLE IF NOT EXISTS connector_oauth_pending (
  state          VARCHAR(64) PRIMARY KEY,
  connector_id   UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  code_verifier  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at     TIMESTAMPTZ NOT NULL
);
