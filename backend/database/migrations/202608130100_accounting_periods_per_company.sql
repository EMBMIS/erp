-- accounting_periods was unique on (period_year, period_month) ACROSS ALL
-- companies. Under multi-company that is not a wart, it is a hard cap: the
-- first tenant to be seeded takes January..December of a year and no other
-- tenant can ever own those months. ChartOfAccounts.seedFinanceMasterData
-- worked around it by walking forward a year at a time, which meant tenant N
-- kept its books in year 2026+N, and once the workaround's attempt budget ran
-- out a newly registered company was left with NO periods at all — the same
-- signup-has-no-finance-master-data blocker the COA seed exists to close.
--
-- A period belongs to a company, so the key is (company_id, period_year,
-- period_month). Rows with a NULL company_id (pre-multi-company data) stay
-- unique per (year, month) through a partial index, so nothing that relied on
-- the old shape regresses.

ALTER TABLE accounting_periods
  DROP CONSTRAINT IF EXISTS uq_accounting_period;

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_period_company
  ON accounting_periods (company_id, period_year, period_month)
  WHERE company_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_period_global
  ON accounting_periods (period_year, period_month)
  WHERE company_id IS NULL;
