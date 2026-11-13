-- 202611130300 — Companies that never had a module configured get every module.
--
-- A company that signed up without choosing a business type (the sign-up
-- form's default) had no company_modules rows at all, so every optional module
-- (Sales, Procurement, Inventory, Manufacturing, CRM, HR, Projects, Mail, ...)
-- was off and their screens refused every request with "... is not enabled for
-- this company". Sign-up now enables every module when no business type is
-- chosen (services/moduleService.js seedForCompany); this does the same for the
-- companies created before. Only companies with no module rows at all are
-- touched: a company that switched any module on or off has made a choice,
-- and it is left exactly as it is. Runs on the owner connection, so
-- company_id is explicit.

INSERT INTO company_modules (company_id, module_key, enabled)
SELECT c.id, m.key, true
  FROM companies c
 CROSS JOIN modules m
 WHERE c.deleted_at IS NULL
   AND NOT m.is_core
   AND NOT EXISTS (SELECT 1 FROM company_modules cm WHERE cm.company_id = c.id)
ON CONFLICT (company_id, module_key) DO NOTHING;
