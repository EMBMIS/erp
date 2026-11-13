-- 109 — Give employees a cost rate and a link to their login.
--
-- Both exist to serve project P&L (migration 108):
--
--   user_id           — time is logged by a logged-in user, but cost belongs to
--                       an employee. Without this join every time entry has to
--                       name its employee by hand, which nobody will do, and
--                       labour cost silently reports as zero.
--
--   hourly_cost_rate  — what an hour of this person costs the company. Kept
--                       separate from the billing rate on purpose: billing an
--                       hour at 150 that costs 60 is the entire margin, and
--                       costing it at 150 would report every project as
--                       exactly breaking even.
--
-- Idempotent.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS hourly_cost_rate DECIMAL(15,2);

-- One employee record per login. Without this, a duplicated employee row makes
-- "whose time is this?" ambiguous and double-counts that person's cost.
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_user
  ON employees (user_id) WHERE user_id IS NOT NULL AND deleted_at IS NULL;

-- Best-effort backfill on exact email match. Deliberately conservative: only
-- links where exactly one user and one employee share an address, so a shared
-- inbox (info@, accounts@) cannot attach several people to one login.
UPDATE employees e
   SET user_id = u.id
  FROM users u
 WHERE e.user_id IS NULL
   AND e.email IS NOT NULL
   AND LOWER(e.email) = LOWER(u.email)
   AND e.deleted_at IS NULL
   AND (SELECT COUNT(*) FROM users u2 WHERE LOWER(u2.email) = LOWER(e.email)) = 1
   AND (SELECT COUNT(*) FROM employees e2
         WHERE LOWER(e2.email) = LOWER(e.email) AND e2.deleted_at IS NULL) = 1;

-- Seed the cost rate from annual salary over a 2080-hour year (40h × 52w).
--
-- This is an approximation and is meant to be overridden — it ignores employer
-- taxes, benefits and utilisation, so true cost is higher. It is still far
-- better than the alternative of leaving it NULL, which reports every project
-- as pure profit until somebody remembers to fill this in.
UPDATE employees
   SET hourly_cost_rate = ROUND(base_salary / 2080.0, 2)
 WHERE hourly_cost_rate IS NULL
   AND base_salary > 0
   AND deleted_at IS NULL;

COMMENT ON COLUMN employees.hourly_cost_rate IS
  'Internal cost of one hour of this employee''s time. Seeded from base_salary/2080; excludes employer taxes and benefits, so it understates true cost until set explicitly.';
COMMENT ON COLUMN employees.user_id IS
  'Login this employee record belongs to. Lets time logged by a user be costed against their salary.';
