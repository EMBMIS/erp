-- Public, token-authenticated portal pages could not see their own row.
--
-- Every company-scoped table carries the RLS policy
-- `company_id = current_company_id()`, and current_company_id() reads a setting
-- the request middleware puts on the connection from the caller's session.
-- A portal page has no session by design — the token in the URL is the whole
-- credential — so the setting is NULL, the policy matches nothing, and every
-- one of these endpoints answers 404 for a token that is perfectly valid:
--
--   customer: delivery confirmation, order response, quotation response,
--             contract response
--   supplier: delivery/receipt portal, RFQ response, item confirmation
--
-- Migration 202608120700 solved this for three supplier lookups by writing a
-- SECURITY DEFINER function per operation. That does not scale to the fifteen
-- queries these seven flows actually run, and every new portal query would need
-- another function.
--
-- This resolves the one thing the request is missing — WHICH company the token
-- belongs to — and lets the endpoint run its normal queries inside that
-- company's context afterwards (services/portalScope.js). The function is the
-- narrowest possible bypass:
--
--   • It returns a company id and nothing else. Knowing a token maps to tenant
--     X reveals no business data; the caller still needs the token to read
--     anything, exactly as before.
--   • The scope is a fixed CASE over a closed list of table/column pairs. No
--     dynamic SQL, so it cannot be aimed at another table.
--   • Short strings are rejected outright, so it cannot be walked with
--     one-character guesses.
--   • search_path is pinned, the usual SECURITY DEFINER hardening.

CREATE OR REPLACE FUNCTION portal_company_for_token(p_scope text, p_token text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cid uuid;
BEGIN
  -- Real tokens are 32-byte hex (64 chars). Anything short is a probe.
  IF p_token IS NULL OR length(p_token) < 16 THEN
    RETURN NULL;
  END IF;

  CASE p_scope
    WHEN 'customer_delivery' THEN
      SELECT company_id INTO cid FROM sales_orders WHERE customer_delivery_token = p_token;
    WHEN 'customer_order' THEN
      SELECT company_id INTO cid FROM sales_orders WHERE customer_response_token = p_token;
    WHEN 'customer_quotation' THEN
      SELECT company_id INTO cid FROM sales_quotations WHERE customer_response_token = p_token;
    WHEN 'customer_contract' THEN
      SELECT company_id INTO cid FROM sales_contracts WHERE customer_response_token = p_token;
    WHEN 'supplier_delivery' THEN
      SELECT company_id INTO cid FROM purchase_orders WHERE supplier_delivery_token = p_token;
    WHEN 'supplier_rfq' THEN
      SELECT company_id INTO cid FROM sales_rfqs WHERE response_token = p_token;
    WHEN 'supplier_item' THEN
      SELECT company_id INTO cid FROM supplier_items WHERE confirmation_token = p_token;
    ELSE
      cid := NULL;
  END CASE;

  RETURN cid;
END $$;

COMMENT ON FUNCTION portal_company_for_token(text, text) IS
  'Resolves the owning company for a public portal token so a session-less request can run inside that tenant''s RLS context. Returns NULL for an unknown scope or token.';
