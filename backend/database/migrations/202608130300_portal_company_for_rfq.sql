-- The last session-less surface that could not see its own tenant.
--
-- Migration 202608130200 resolves a portal request's company from a token
-- stored in a table column. The supplier RFQ flow does not work that way: its
-- link carries a SIGNED JWT holding the RFQ id, so there is no token column to
-- look up and the previous resolver never applied. The three routes behind that
-- link — open the RFQ, submit a quotation, decline — read
-- request_for_quotations through the ordinary pool, which under row-level
-- isolation matches nothing. A supplier could receive an RFQ email and then be
-- unable to see or answer it.
--
-- The JWT is verified before this is called, so by the time we are here the
-- caller has already proven they hold a link the system issued for this RFQ.
-- All this adds is which tenant to look in.

CREATE OR REPLACE FUNCTION portal_company_for_rfq(p_rfq_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cid uuid;
BEGIN
  IF p_rfq_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT company_id INTO cid FROM request_for_quotations WHERE id = p_rfq_id;
  RETURN cid;
END $$;

COMMENT ON FUNCTION portal_company_for_rfq(uuid) IS
  'Resolves the owning company for an RFQ named by a verified supplier-portal JWT, so a session-less supplier can read and answer it under the right tenant. Returns NULL for an unknown RFQ.';
