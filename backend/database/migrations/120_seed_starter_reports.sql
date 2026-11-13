-- 120 — Five starter report definitions.
--
-- 114 shipped the reporting engine with an empty report_definitions table, so
-- the Reports screen opens on nothing and gives no hint of what a report even
-- looks like here. These five are the ones every finance/ops user asks for in
-- the first week.
--
-- Four are BUILTIN rather than QUERY on purpose. Their SQL already exists,
-- reviewed, in services/reportService.js BUILTINS; storing a second copy in the
-- database would fork it — the stored copy is the one that gets edited, and the
-- two answer the same question differently. BUILTIN rows name the key and store
-- only the parameters.
--
-- Low Stock has no builtin, so it is a QUERY. Its SQL is re-validated against
-- the nlQuery allowlist on every run (inventory_items and items are both on
-- it), exactly like any user-written report — seeding through a migration does
-- not exempt it.
--
-- is_system = true: services/reportService.js update() and remove() both filter
-- on is_system = false, so these cannot be edited or deleted out from under the
-- users who come to rely on them. is_shared = true and owner_id NULL makes them
-- visible to everyone rather than to whoever happened to run the migration.
--
-- Idempotent: matched on name among system reports, so re-running adds nothing
-- and a hand-edited copy is left alone.

INSERT INTO report_definitions
  (name, description, category, report_type, builtin_key, sql_text, parameters, visualization, is_shared, is_system)
SELECT v.name, v.description, v.category, v.report_type, v.builtin_key, v.sql_text,
       v.parameters::jsonb, v.visualization::jsonb, true, true
FROM (VALUES
  (
    'Trial Balance',
    'Debits and credits by account from posted journal entries, as of a date. The report to open first when the balance sheet looks wrong.',
    'FINANCE',
    'BUILTIN',
    'trial_balance',
    NULL,
    '[{"name":"as_of","label":"As of date","type":"date","default":null,"required":false}]',
    '{"type":"table"}'
  ),
  (
    'AR Aging',
    'Outstanding customer invoices bucketed by how far past due they are. Drives collections.',
    'FINANCE',
    'BUILTIN',
    'aged_receivables',
    NULL,
    '[{"name":"as_of","label":"As of date","type":"date","default":null,"required":false}]',
    '{"type":"table"}'
  ),
  (
    'AP Aging',
    'Outstanding supplier invoices by days overdue. Drives the payment run and flags what is about to go late.',
    'FINANCE',
    'BUILTIN',
    'aged_payables',
    NULL,
    '[{"name":"as_of","label":"As of date","type":"date","default":null,"required":false}]',
    '{"type":"table"}'
  ),
  (
    'Sales by Customer',
    'Invoiced revenue per customer over a date range, net and gross of tax.',
    'SALES',
    'BUILTIN',
    'sales_by_customer',
    NULL,
    '[{"name":"from_date","label":"From date","type":"date","default":null,"required":false},
      {"name":"to_date","label":"To date","type":"date","default":null,"required":false}]',
    '{"type":"bar","x":"customer_name","y":"net_revenue"}'
  ),
  (
    'Low Stock',
    'Items at or below their reorder point, worst shortfall first. Items with no reorder point set are excluded — there is nothing to be below.',
    'INVENTORY',
    'QUERY',
    NULL,
    'SELECT i.item_code,
            i.name AS item_name,
            ii.current_stock_quantity::float AS on_hand,
            COALESCE(ii.reorder_point, ii.minimum_stock_level)::float AS reorder_point,
            (COALESCE(ii.reorder_point, ii.minimum_stock_level, 0) - ii.current_stock_quantity)::float AS shortfall
       FROM inventory_items ii
       JOIN items i ON i.id = ii.item_master_id
      WHERE ii.current_stock_quantity <= COALESCE(ii.reorder_point, ii.minimum_stock_level, 0)
        AND COALESCE(ii.reorder_point, ii.minimum_stock_level, 0) > 0
      ORDER BY shortfall DESC',
    '[]',
    '{"type":"table"}'
  )
) AS v(name, description, category, report_type, builtin_key, sql_text, parameters, visualization)
WHERE NOT EXISTS (
  SELECT 1 FROM report_definitions d
   WHERE d.name = v.name
     AND d.is_system = true
     AND d.deleted_at IS NULL
);
