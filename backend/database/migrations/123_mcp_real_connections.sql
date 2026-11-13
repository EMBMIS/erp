-- 123 — Real MCP connections: a live endpoint, real auth, real fetched tools.
--
-- 121/122 only ever recorded that someone clicked "Connect" — no network call
-- was ever made. This migration adds what a REAL connection needs:
--
--   endpoint_url   the actual connect URL, confirmed by a person. Kept
--                  separate from url_or_package, which for a web-search
--                  discovery result is often a docs/marketing page, not
--                  something an MCP client can connect to.
--   auth_type      how the endpoint is authenticated. 'api_key' points at an
--                  ai_credentials row (same vault, same egress allowlist,
--                  same encryption everything else in this system already
--                  uses). 'oauth' points at mcp_oauth_grants below, kept
--                  separate from ai_credentials — see that table's comment.
--   tools_cache    the server's own tools/list response, fetched by an
--                  explicit sync step. Replaces the placeholder
--                  tools_preview once a connection is real.
--   last_error     so a broken connection (expired auth, unreachable
--                  endpoint) is visible on the Connected tab instead of just
--                  quietly returning zero tools.
--
-- Idempotent.

ALTER TABLE mcp_connections
  ADD COLUMN IF NOT EXISTS endpoint_url TEXT,
  ADD COLUMN IF NOT EXISTS auth_type VARCHAR(20) CHECK (auth_type IN ('none', 'api_key', 'oauth')),
  ADD COLUMN IF NOT EXISTS credential_id UUID REFERENCES ai_credentials(id),
  ADD COLUMN IF NOT EXISTS tools_cache JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS tools_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  -- Namespace for this server's tools in the flat tool catalogue, so two
  -- connected servers may both offer a "search" without colliding. UNIQUE and
  -- assigned once at connect time, because an agent blueprint stores the tool
  -- NAME it is allowed to call — a slug that shifted when some other
  -- connection was added or renamed would silently unbind those agents.
  ADD COLUMN IF NOT EXISTS slug VARCHAR(24);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_connections_slug ON mcp_connections (slug) WHERE slug IS NOT NULL;

ALTER TABLE mcp_connections DROP CONSTRAINT IF EXISTS mcp_connections_status_check;
ALTER TABLE mcp_connections ADD CONSTRAINT mcp_connections_status_check
  CHECK (status IN ('pending_auth', 'connected', 'disconnected', 'error'));

-- ---------------------------------------------------------------------------
-- OAuth token storage.
--
-- Deliberately its own table rather than another row in ai_credentials. The
-- vault's single secret slot is designed for a human-entered key that
-- changes only when a human rotates it; an OAuth access token is refreshed
-- by the system itself, silently, roughly hourly. Reusing the vault's rotate
-- path for that would churn `hint`/`updated_at` — fields that exist to tell
-- a person "this was changed" — on every automatic refresh, and would need a
-- cross-table transaction (ai_credentials + this table) that nothing here
-- currently wraps. One table, one UPDATE, on refresh.
--
-- Encrypted with the same AES-256-GCM helpers as ai_credentials
-- (services/ai/credentialVault.js encrypt/decrypt, exported for reuse) —
-- this is not a second crypto implementation, just a second place the first
-- one is called from.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  connection_id          UUID NOT NULL UNIQUE REFERENCES mcp_connections(id) ON DELETE CASCADE,

  access_token_cipher    TEXT,
  access_token_iv        VARCHAR(32),
  access_token_tag       VARCHAR(32),
  refresh_token_cipher   TEXT,
  refresh_token_iv       VARCHAR(32),
  refresh_token_tag      VARCHAR(32),
  access_token_expires_at TIMESTAMPTZ,

  authorization_endpoint TEXT,
  token_endpoint         TEXT NOT NULL,
  client_id              TEXT,
  client_secret_cipher   TEXT,
  client_secret_iv       VARCHAR(32),
  client_secret_tag      VARCHAR(32),
  scope                  TEXT,
  resource               TEXT,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Short-lived PKCE/state custody for an in-flight authorization redirect.
--
-- DB-backed rather than in-memory: the browser leaves this app entirely
-- during authorization and comes back on a separate HTTP request that must
-- not depend on hitting the same process. The PKCE code_verifier in
-- particular must never itself pass through the browser, or PKCE is
-- defeated — this table is where it waits instead. Single-use: deleted by
-- the callback route once consumed, and opportunistically swept of anything
-- past `expires_at` whenever a new authorize-url is requested.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mcp_oauth_pending (
  state          VARCHAR(64) PRIMARY KEY,
  connection_id  UUID NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  code_verifier  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at     TIMESTAMPTZ NOT NULL
);
