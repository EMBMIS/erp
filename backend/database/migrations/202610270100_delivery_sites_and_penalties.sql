-- Where an order ships from, and what it costs the company to ship it late.
--
-- "0 at the main site, 60 free at Site B — after a transfer, instead of a
-- €2,400 penalty." The delivery trace (services/deliveryRisk.js) pooled stock
-- across the whole company, so it could not see that the stock is in the wrong
-- place, and nothing on record said what a slip costs. Two facts close that:
--
--   sales_orders.ship_from_location_id   the storage location the order is
--                                         picked from. Set, the trace counts
--                                         only stock placed there (and
--                                         transfers on their way there);
--                                         stock at other sites becomes a
--                                         transfer the recovery planner can
--                                         measure and a manager can approve.
--                                         Unset, nothing changes.
--   customers.late_delivery_penalty      the customer's terms for a late
--   customers.late_delivery_penalty_per_day  delivery: a fixed amount per late
--                                         order and/or an amount per day late,
--                                         in the customer's currency. The
--                                         trace prices a slip with them; the
--                                         planner weighs each fix against it.

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS ship_from_location_id UUID REFERENCES storage_locations(id) ON DELETE SET NULL;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS late_delivery_penalty NUMERIC(15,2)
    CHECK (late_delivery_penalty IS NULL OR late_delivery_penalty >= 0),
  ADD COLUMN IF NOT EXISTS late_delivery_penalty_per_day NUMERIC(15,2)
    CHECK (late_delivery_penalty_per_day IS NULL OR late_delivery_penalty_per_day >= 0);

CREATE INDEX IF NOT EXISTS idx_sales_orders_ship_from ON sales_orders (ship_from_location_id)
  WHERE ship_from_location_id IS NOT NULL;
