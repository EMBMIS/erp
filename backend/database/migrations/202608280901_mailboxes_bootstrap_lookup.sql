-- Migration 202608280901: exempt `mailboxes` from row-level company isolation.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- Company isolation is genuinely active for the app's runtime role (checked
-- directly: `multi_company_enabled()` as qira_app returns true), and the
-- previous migration (202608280900) registered `mailboxes` as a scoped table,
-- so it inherited RLS forced-on with a `company_id = current_company_id()`
-- policy — same as every other scoped table.
--
-- That's wrong for this one table specifically, for the same reason
-- `user_companies` was deliberately excluded from company_scoped_tables back
-- in migration 110: the inbound-mail webhook (backend/routes/mailboxes.js,
-- POST /webhook/inbound) is called by an external Cloudflare Worker with no
-- logged-in user and therefore no ambient company context. Its very first
-- step is "look up mailboxes WHERE lower(address) = $1 to find out which
-- company this message belongs to" — under RLS with no company context yet
-- set, that lookup returns zero rows, and there is no way to establish the
-- context because establishing it requires the answer this query is supposed
-- to provide. It's the identical bootstrapping problem `user_companies`
-- solves the same way: an identity/routing table has to be queryable before
-- the company is known, so it can't itself be gated by that company.
--
-- `mailbox_messages` and `mailbox_attachments` — the actual mail content —
-- keep real RLS. By the time either is touched, the webhook has already
-- resolved company_id from this now-unprotected `mailboxes` lookup and wraps
-- the rest of the write in `companyScope.runWithCompany(company_id, ...)`,
-- same pattern as routes/companies.js uses for chart-of-accounts seeding.
-- Every application-facing query against `mailboxes` still filters
-- `WHERE company_id = $1` explicitly (mailboxService.js, routes/mailboxes.js)
-- — the same real boundary `user_companies` relies on today, just not
-- backed by the database engine for this one table.
--
-- Idempotent.

ALTER TABLE mailboxes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mailboxes DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON mailboxes;

DELETE FROM company_scoped_tables WHERE table_name = 'mailboxes';

COMMENT ON TABLE mailboxes IS
  'Company and per-user mailboxes on embmis.com. Deliberately NOT row-level-isolated (see 202608280901) — same bootstrapping reason as user_companies: the inbound webhook must look up an address before any company context exists. Security boundary is the explicit company_id filter in mailboxService.js/routes/mailboxes.js. mailbox_messages/mailbox_attachments (the actual content) keep real RLS.';
