-- 095 — Expiring, single-use external (portal) tokens.
--
-- Every customer/supplier-facing "response link" token (sent by email, no login
-- required) currently lives forever with no expiry and no single-use marker —
-- a leaked or forwarded link works indefinitely. This adds an `_expires_at` and
-- `_used_at` sibling column next to each token column. Existing outstanding
-- tokens (already sent to a customer/supplier's inbox) are left with a NULL
-- expiry so they keep working — the app code (services/ai/../portalTokens.js)
-- only sets an expiry on NEWLY generated tokens going forward, and application
-- code now treats NULL expires_at as "pre-migration token, not yet expiring."
-- Idempotent.

ALTER TABLE sales_orders     ADD COLUMN IF NOT EXISTS customer_response_token_expires_at TIMESTAMPTZ;
ALTER TABLE sales_orders     ADD COLUMN IF NOT EXISTS customer_response_token_used_at    TIMESTAMPTZ;
ALTER TABLE sales_orders     ADD COLUMN IF NOT EXISTS customer_delivery_token_expires_at TIMESTAMPTZ;
ALTER TABLE sales_orders     ADD COLUMN IF NOT EXISTS customer_delivery_token_used_at    TIMESTAMPTZ;

ALTER TABLE sales_contracts  ADD COLUMN IF NOT EXISTS customer_response_token_expires_at TIMESTAMPTZ;
ALTER TABLE sales_contracts  ADD COLUMN IF NOT EXISTS customer_response_token_used_at    TIMESTAMPTZ;

ALTER TABLE sales_quotations ADD COLUMN IF NOT EXISTS customer_response_token_expires_at TIMESTAMPTZ;
ALTER TABLE sales_quotations ADD COLUMN IF NOT EXISTS customer_response_token_used_at    TIMESTAMPTZ;

ALTER TABLE contracts        ADD COLUMN IF NOT EXISTS supplier_response_token_expires_at TIMESTAMPTZ;
ALTER TABLE contracts        ADD COLUMN IF NOT EXISTS supplier_response_token_used_at    TIMESTAMPTZ;

ALTER TABLE purchase_orders  ADD COLUMN IF NOT EXISTS supplier_delivery_token_expires_at TIMESTAMPTZ;
ALTER TABLE purchase_orders  ADD COLUMN IF NOT EXISTS supplier_delivery_token_used_at    TIMESTAMPTZ;

ALTER TABLE sales_rfqs       ADD COLUMN IF NOT EXISTS response_token_expires_at TIMESTAMPTZ;
ALTER TABLE sales_rfqs       ADD COLUMN IF NOT EXISTS response_token_used_at    TIMESTAMPTZ;

ALTER TABLE rfqs             ADD COLUMN IF NOT EXISTS response_token_expires_at TIMESTAMPTZ;
ALTER TABLE rfqs             ADD COLUMN IF NOT EXISTS response_token_used_at    TIMESTAMPTZ;

ALTER TABLE supplier_items   ADD COLUMN IF NOT EXISTS confirmation_token_expires_at TIMESTAMPTZ;
ALTER TABLE supplier_items   ADD COLUMN IF NOT EXISTS confirmation_token_used_at    TIMESTAMPTZ;
