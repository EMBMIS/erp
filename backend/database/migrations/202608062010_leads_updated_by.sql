-- 202608062010 — leads is missing updated_by.
--
-- routes/leads.js PATCH /:id has always written `updated_by = $n` as part of
-- its UPDATE — a pattern copied from the other resource routes (customers,
-- sales_orders, purchase_orders, ...), all of which really do have that
-- column. leads (135_phase4_depth.sql) never got it, so every single
-- PATCH /leads/:id — every status change, assignment, note, or ai_score
-- update — has 500'd with "column \"updated_by\" of relation \"leads\" does
-- not exist" since the route was written. Add the column so the route's
-- existing query is simply correct, rather than special-casing leads to drop
-- the audit column every other resource has.
--
-- Idempotent.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);

COMMENT ON COLUMN leads.updated_by IS
  'User who last updated this lead (routes/leads.js PATCH /:id). Nullable: rows updated before this column existed, or by a system process, have no attribution.';
