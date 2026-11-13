-- Portal helper functions for PUBLIC, token-authenticated supplier flows.
--
-- Why SECURITY DEFINER: suppliers / request_for_quotations / rfq_quotations
-- are company-scoped under RLS (company_id = current_company_id()). Public
-- portal pages have no login and therefore no company context, so a plain
-- query from the app role sees zero rows — every public supplier endpoint
-- 404s. The token in the URL IS the credential; these functions look up and
-- update the specific row named by it, bypassing RLS with the definer's
-- (owner's) rights. No dynamic SQL, fixed search_path, so they cannot be
-- used to read anything other than the one named row.

CREATE OR REPLACE FUNCTION portal_supplier_lookup(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  row jsonb;
BEGIN
  SELECT jsonb_build_object(
    'id', s.id,
    'supplier_code', s.supplier_code,
    'legal_name', s.legal_name,
    'trade_name', s.trade_name,
    'email', s.email,
    'status', s.status,
    'partnership_status', s.partnership_status,
    'decline_reason', s.decline_reason,
    'created_at', s.created_at
  ) INTO row
    FROM suppliers s
   WHERE s.id = p_id;
  RETURN row;
END $$;

CREATE OR REPLACE FUNCTION portal_partnership_accept(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  row jsonb;
BEGIN
  UPDATE suppliers
     SET partnership_status = 'ACCEPTED',
         status = 'ACTIVE',
         updated_at = CURRENT_TIMESTAMP
   WHERE id = p_id
   RETURNING jsonb_build_object(
     'id', id, 'supplier_code', supplier_code, 'legal_name', legal_name,
     'partnership_status', partnership_status) INTO row;
  RETURN row;
END $$;

CREATE OR REPLACE FUNCTION portal_partnership_decline(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  row jsonb;
BEGIN
  UPDATE suppliers
     SET partnership_status = 'DECLINED',
         decline_reason = p_reason,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = p_id
   RETURNING jsonb_build_object(
     'id', id, 'supplier_code', supplier_code, 'legal_name', legal_name,
     'partnership_status', partnership_status) INTO row;
  RETURN row;
END $$;

-- Full RFQ response payload for the public response link: the RFQ header,
-- its line items, the quoting supplier, and quotations already submitted on
-- this token. Returns NULL when the RFQ is missing.
CREATE OR REPLACE FUNCTION portal_rfq_response_lookup(p_rfq_id uuid, p_supplier_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  row jsonb;
BEGIN
  SELECT jsonb_build_object(
    'rfq', jsonb_build_object(
      'id', r.id, 'rfq_number', r.rfq_number, 'title', r.title,
      'description', r.description, 'response_deadline', r.response_deadline,
      'currency', r.currency, 'status', r.status),
    'line_items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', li.id, 'item_description', li.item_description,
        'quantity', li.quantity, 'unit_of_measure', li.unit_of_measure))
      FROM rfq_line_items li
      WHERE li.rfq_id = r.id), '[]'::jsonb),
    'supplier', COALESCE((
      SELECT jsonb_build_object(
        'id', s.id, 'supplier_code', s.supplier_code, 'legal_name', s.legal_name,
        'email', s.email)
      FROM suppliers s WHERE s.id = p_supplier_id), 'null'::jsonb),
    'existing_quotations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'rfq_line_item_id', q.rfq_line_item_id, 'unit_price', q.unit_price,
        'lead_time_days', q.lead_time_days, 'notes', q.notes))
      FROM rfq_quotations q
      WHERE q.rfq_id = r.id AND q.supplier_id = p_supplier_id), '[]'::jsonb)
  ) INTO row
    FROM request_for_quotations r
   WHERE r.id = p_rfq_id;
  RETURN row;
END $$;

-- Upsert one quotation line for a public response link.
CREATE OR REPLACE FUNCTION portal_rfq_response_upsert(
  p_rfq_id uuid, p_supplier_id uuid, p_line_item_id uuid,
  p_unit_price numeric, p_currency text, p_lead_time_days int,
  p_delivery_terms text, p_payment_terms text, p_validity_days int, p_notes text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO rfq_quotations
    (rfq_id, supplier_id, rfq_line_item_id, unit_price, currency,
     lead_time_days, delivery_terms, payment_terms, validity_days, notes)
  VALUES
    (p_rfq_id, p_supplier_id, p_line_item_id, p_unit_price, p_currency,
     p_lead_time_days, p_delivery_terms, p_payment_terms, p_validity_days, p_notes)
  ON CONFLICT (rfq_id, supplier_id, rfq_line_item_id)
  DO UPDATE SET unit_price = EXCLUDED.unit_price,
                lead_time_days = EXCLUDED.lead_time_days,
                delivery_terms = EXCLUDED.delivery_terms,
                payment_terms = EXCLUDED.payment_terms,
                validity_days = EXCLUDED.validity_days,
                notes = EXCLUDED.notes;
  RETURN FOUND;
END $$;
