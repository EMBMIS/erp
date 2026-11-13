-- Customer credit hold — dunning escalation trigger (PHASE3_TEN_TENTHS CRM
-- item: "dunning depth ... credit-hold trigger").
--
-- dunningService.js escalated overdue invoices by email only; nothing ever
-- connected a severely delinquent customer (FINAL_NOTICE level) to a block
-- on taking new orders from them. This adds the flag and the reason/date it
-- was set, so runDunning can set/clear it and SalesOrder.approveOrder can
-- refuse to approve a new order for a customer on hold.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_hold BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_hold_reason TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_hold_set_at TIMESTAMPTZ;
