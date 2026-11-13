-- Lead -> deal -> quotation chain (PHASE3_TEN_TENTHS CRM item: "pipeline").
--
-- leads and deals were two independent tables with no FK between them, and
-- leads.converted_to_quotation_id (added in 135_phase4_depth.sql) was dead —
-- nothing ever wrote to it. A lead converted straight to a customer with no
-- opportunity or quotation created. This adds the missing links so
-- POST /leads/:id/convert can create a real deal (linked to the lead) and,
-- optionally, a real sales quotation (linked to the deal).

ALTER TABLE deals ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS quotation_id UUID REFERENCES sales_quotations(id);

CREATE INDEX IF NOT EXISTS deals_lead_id_idx ON deals (lead_id);
