-- 121 — MCP connection records.
--
-- Phase 1 of MCP tool discovery: a person can search for an external MCP
-- (Model Context Protocol) server and "connect" it. Nothing actually spins up
-- an MCP client yet — services/ai/mcpDiscovery.js says so — this table only
-- records that the connection was requested, so the Tool Library has
-- something real to list and disconnect. Phase 2 turns a row here into a
-- running client and real tool entries in the catalogue.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS mcp_connections (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  name           VARCHAR(160) NOT NULL,
  description    TEXT,
  url_or_package VARCHAR(500) NOT NULL,

  status         VARCHAR(20) NOT NULL DEFAULT 'connected'
                 CHECK (status IN ('connected', 'disconnected')),

  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mcp_connections_status ON mcp_connections (status);
