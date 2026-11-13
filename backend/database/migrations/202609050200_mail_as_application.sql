-- Mail becomes an application.
--
-- ===========================================================================
-- WHY IT NEEDS A MODULE ROW
-- ===========================================================================
-- Every application in the App Library is switchable, and for a core one the
-- switch is its `company_modules` row — the mechanism that has governed the
-- built-in modules since long before the platform existed. Mail never had one:
-- it was navigation and nothing else, always on, with no way for a company
-- that does not use it to put it away.
--
-- Enabled for every company that already exists, because turning a feature
-- off during a deployment is not a migration's decision to make. A company
-- that does not want it can switch it off in the App Library, which is the
-- entire point of this change.
--
-- Non-core deliberately. `is_core` means "cannot be switched off", and mail
-- is not load-bearing for anything else in the product: no ledger entry, no
-- approval and no application depends on a mailbox existing.

INSERT INTO modules (key, name, description, is_core, nav_section)
VALUES (
  'mail',
  'Mail',
  'Shared mailboxes, conversations and the messages the business sends and receives.',
  false,
  'Mail'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO company_modules (company_id, module_key, enabled)
  SELECT id, 'mail', true FROM companies
ON CONFLICT (company_id, module_key) DO NOTHING;
