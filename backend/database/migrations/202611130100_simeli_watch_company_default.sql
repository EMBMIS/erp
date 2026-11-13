-- 202611130100 — simeli_watch_items / simeli_watch_sweeps: company_id defaults
-- from the session, like every other company-scoped table.
--
-- 202611070100 created both tables with company_id NOT NULL and no default.
-- services/simeliWatch.js always passes company_id explicitly, so nothing is
-- broken today, but the tenancy guard (tests/tenancy.test.js, "company_id
-- resolves from the session, never from a fixed literal") requires the
-- session default so an insert that forgets the column lands in the caller's
-- company instead of failing — and so the invariant stays checkable.
-- Without a session company the default is NULL and NOT NULL refuses the row:
-- no fallback to some other company.

ALTER TABLE simeli_watch_items  ALTER COLUMN company_id SET DEFAULT public.current_company_id();
ALTER TABLE simeli_watch_sweeps ALTER COLUMN company_id SET DEFAULT public.current_company_id();
