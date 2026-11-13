-- A bill that must not be paid until someone has looked at it.
--
-- "INV-7731 from Nordbay posted · matches PO-2240, already invoiced once ·
-- goods received once, not twice · INV-7719 paid 6 days ago · proposes
-- hold_payment · escalate, payment tools need a person." The check itself
-- (services/billedTwice.js) needs no new data; stopping the money does. A hold
-- is a fact on the bill, set by a person (a finance manager, manager or admin,
-- straight from the Supplier invoices screen or by approving Simeli's
-- proposal), with who, when and why. While it is on, a supplier payment cannot
-- be allocated to the bill and the payment run leaves it out.

ALTER TABLE supplier_invoices
  ADD COLUMN IF NOT EXISTS payment_hold BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS payment_hold_reason TEXT,
  ADD COLUMN IF NOT EXISTS payment_held_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_held_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_hold_released_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_hold_released_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_supplier_invoices_payment_hold ON supplier_invoices (company_id)
  WHERE payment_hold;

-- The check looks for the same supplier's other bills by their own reference
-- and by amount; both lookups start from the supplier.
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier_amount
  ON supplier_invoices (company_id, supplier_id, total_amount)
  WHERE deleted_at IS NULL;
