-- 106 — Add the unit of measure to work-order component lines.
--
-- Omitted from 105. The work order copies each component's UoM from the BOM at
-- explosion time rather than joining to the item at read time: a BOM can specify
-- a different UoM from the item master (metres of a cable sold by the reel), and
-- the quantity on the work order is only meaningful alongside the unit it was
-- calculated in.
--
-- Added as a separate migration rather than by editing 105, which has already
-- been applied — db:verify checksums applied migrations and would report the
-- edit as drift.

ALTER TABLE work_order_components ADD COLUMN IF NOT EXISTS unit_of_measure VARCHAR(20);
