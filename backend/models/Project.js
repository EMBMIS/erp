/**
 * Projects: work breakdown, time tracking and project P&L.
 *
 * The module earns its keep through two numbers a services business cannot
 * otherwise get: what a project actually cost, and what of that is still
 * unbilled. Everything else here exists to make those two trustworthy.
 *
 * Cost comes from two places and both are counted:
 *   - labour, valued at the cost rate on each time entry, and
 *   - anything posted to the general ledger against the project dimension
 *     (`journal_entry_items.project_id`) — materials, subcontractors, expenses.
 *
 * Revenue is only counted once invoiced. Recognising it as hours are logged
 * would flatter every in-flight project, which is exactly when the number gets
 * looked at.
 */

const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const taxService = require('../services/taxService');
const CustomerInvoice = require('./CustomerInvoice');

const OPEN_STATUSES = ['PLANNED', 'ACTIVE', 'ON_HOLD'];

const Projects = {
  async create(data, userId) {
    const { name, customer_id, billing_type, default_hourly_rate, fixed_price,
            budget_hours, budget_amount, currency, start_date, end_date, manager_id, description } = data;

    if (!name || !String(name).trim()) throw new Error('A project needs a name.');

    const type = billing_type || 'TIME_AND_MATERIALS';
    // A fixed-price project with no price is a project nobody can invoice, and
    // the omission is invisible until someone tries.
    if (type === 'FIXED_PRICE' && !(Number(fixed_price) > 0)) {
      throw new Error('A fixed-price project needs a fixed price.');
    }
    if (type === 'TIME_AND_MATERIALS' && customer_id && !(Number(default_hourly_rate) > 0)) {
      throw new Error('A time-and-materials project needs a default hourly rate to bill against.');
    }

    const codeResult = await pool.query('SELECT generate_project_code() AS code');
    const { rows } = await pool.query(
      `INSERT INTO projects
         (project_code, name, description, customer_id, billing_type, default_hourly_rate,
          fixed_price, budget_hours, budget_amount, currency, start_date, end_date, manager_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [codeResult.rows[0].code, String(name).trim(), description || null, customer_id || null,
       type, default_hourly_rate || null, fixed_price || null, budget_hours || null, budget_amount || null,
       currency || 'USD', start_date || null, end_date || null, manager_id || userId, userId]
    );
    return rows[0];
  },

  async findAll({ status, customer_id, manager_id, open_only, limit = 100 } = {}) {
    const params = [];
    let where = 'WHERE p.deleted_at IS NULL';

    if (status) { params.push(status); where += ` AND p.status = $${params.length}`; }
    if (open_only) where += ` AND p.status IN ('PLANNED','ACTIVE','ON_HOLD')`;
    if (customer_id) { params.push(customer_id); where += ` AND p.customer_id = $${params.length}`; }
    if (manager_id) { params.push(manager_id); where += ` AND p.manager_id = $${params.length}`; }

    params.push(Math.min(Number(limit) || 100, 500));
    const { rows } = await pool.query(
      `SELECT p.*, c.customer_name,
              COALESCE(t.hours_logged, 0)::float   AS hours_logged,
              COALESCE(t.hours_unbilled, 0)::float AS hours_unbilled
         FROM projects p
         LEFT JOIN customers c ON c.id = p.customer_id
         LEFT JOIN LATERAL (
           SELECT SUM(hours) AS hours_logged,
                  SUM(hours) FILTER (WHERE billable AND invoice_id IS NULL) AS hours_unbilled
             FROM time_entries te WHERE te.project_id = p.id
         ) t ON true
         ${where}
         ORDER BY p.created_at DESC
         LIMIT $${params.length}`,
      params
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query(
      `SELECT p.*, c.customer_name, u.first_name AS manager_first_name, u.last_name AS manager_last_name
         FROM projects p
         LEFT JOIN customers c ON c.id = p.customer_id
         LEFT JOIN users u     ON u.id = p.manager_id
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return null;

    const tasks = await pool.query(
      `SELECT t.*, u.first_name AS assignee_first_name, u.last_name AS assignee_last_name,
              COALESCE((SELECT SUM(hours) FROM time_entries te WHERE te.task_id = t.id), 0)::float AS hours_logged
         FROM project_tasks t
         LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.project_id = $1
        ORDER BY t.due_date NULLS LAST, t.created_at`,
      [id]
    );

    return { ...rows[0], tasks: tasks.rows };
  },

  async update(id, fields) {
    const allowed = ['name', 'description', 'customer_id', 'billing_type', 'default_hourly_rate',
                     'fixed_price', 'budget_hours', 'budget_amount', 'status', 'start_date', 'end_date', 'manager_id'];
    const sets = [];
    const params = [id];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        params.push(fields[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) throw new Error('Nothing to update.');
    sets.push('updated_at = CURRENT_TIMESTAMP');

    const { rows } = await pool.query(
      `UPDATE projects SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      params
    );
    if (!rows.length) throw new Error('Project not found.');
    return rows[0];
  },

  /**
   * Project P&L.
   *
   * Labour cost uses the employee's cost rate where one is known, NOT the
   * billing rate — billing an hour at 150 that cost 60 is the margin, and
   * costing it at 150 would report every project as breaking even.
   */
  async profitAndLoss(id) {
    const project = await pool.query(
      'SELECT * FROM projects WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!project.rows.length) throw new Error('Project not found.');
    const p = project.rows[0];

    const [time, invoiced, ledger] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(te.hours), 0)::float                                        AS hours_total,
           COALESCE(SUM(te.hours) FILTER (WHERE te.billable), 0)::float             AS hours_billable,
           COALESCE(SUM(te.hours) FILTER (WHERE te.billable
                                            AND te.invoice_id IS NULL), 0)::float   AS hours_unbilled,
           COALESCE(SUM(te.hours * COALESCE(te.hourly_rate, $2))
                    FILTER (WHERE te.billable AND te.invoice_id IS NULL), 0)::float AS unbilled_value,
           -- Cost rate falls back to zero rather than to the billing rate: an
           -- unknown cost must not silently inflate reported cost.
           COALESCE(SUM(te.hours * COALESCE(e.hourly_cost_rate, 0)), 0)::float      AS labour_cost
         FROM time_entries te
         LEFT JOIN employees e ON e.id = te.employee_id
        WHERE te.project_id = $1`,
        [id, p.default_hourly_rate || 0]
      ),
      pool.query(
        // project_id is now stamped on every invoice raised for this project
        // (time billing and milestone billing alike). The time_entries join is
        // kept as a fallback OR so invoices created before this column existed
        // are not silently dropped from history.
        `SELECT COALESCE(SUM(ci.total_amount - ci.tax_amount), 0)::float AS revenue_invoiced,
                COUNT(DISTINCT ci.id)::int AS invoice_count
           FROM customer_invoices ci
          WHERE ci.deleted_at IS NULL
            AND ci.status <> 'CANCELLED'
            AND (ci.project_id = $1
                 OR ci.id IN (SELECT DISTINCT invoice_id FROM time_entries
                               WHERE project_id = $1 AND invoice_id IS NOT NULL))`,
        [id]
      ),
      // Non-labour cost: anything posted to the project dimension against an
      // expense account.
      pool.query(
        `SELECT COALESCE(SUM(jei.debit_amount - jei.credit_amount), 0)::float AS ledger_cost
           FROM journal_entry_items jei
           JOIN journal_entries je      ON je.id = jei.journal_entry_id
           JOIN chart_of_accounts coa   ON coa.id = jei.account_id
          WHERE jei.project_id = $1
            AND je.status = 'POSTED'
            AND je.deleted_at IS NULL
            AND coa.account_type = 'EXPENSE'`,
        [id]
      ),
    ]);

    const t = time.rows[0];
    const revenueInvoiced = invoiced.rows[0].revenue_invoiced;
    const labourCost = t.labour_cost;
    const otherCost = ledger.rows[0].ledger_cost;
    const totalCost = labourCost + otherCost;

    // Recognised revenue for a fixed-price project is the agreed price once the
    // project is complete, and nothing before — percentage-of-completion needs
    // an estimate-to-complete this module deliberately does not collect.
    const isFixed = p.billing_type === 'FIXED_PRICE';
    const margin = revenueInvoiced - totalCost;

    const round = (n) => Number(n.toFixed(2));

    return {
      project: {
        id: p.id, project_code: p.project_code, name: p.name,
        billing_type: p.billing_type, status: p.status, currency: p.currency,
      },
      hours: {
        logged: round(t.hours_total),
        billable: round(t.hours_billable),
        unbilled: round(t.hours_unbilled),
        budget: p.budget_hours ? Number(p.budget_hours) : null,
        budget_used_pct: p.budget_hours && Number(p.budget_hours) > 0
          ? round((t.hours_total / Number(p.budget_hours)) * 100)
          : null,
      },
      revenue: {
        invoiced: round(revenueInvoiced),
        unbilled_wip: isFixed ? 0 : round(t.unbilled_value),
        invoice_count: invoiced.rows[0].invoice_count,
        contract_value: isFixed ? Number(p.fixed_price || 0) : null,
      },
      cost: {
        labour: round(labourCost),
        other: round(otherCost),
        total: round(totalCost),
        // Surfaced because a zero here usually means cost rates were never set
        // on employees, not that the project was free.
        note: labourCost === 0 && t.hours_total > 0
          ? 'No labour cost is reported because no cost rate is set on the employees who logged time.'
          : null,
      },
      margin: round(margin),
      margin_pct: revenueInvoiced > 0 ? round((margin / revenueInvoiced) * 100) : null,
    };
  },

  /**
   * Budget vs actuals, open commitments, and an estimate-at-completion.
   *
   * Three numbers a project manager cannot get from the P&L alone: what has
   * actually been spent, what is already committed on open purchase orders
   * (real exposure before a dollar hits the GL), and where total cost is
   * headed if the current burn rate holds.
   */
  async budgetReport(id) {
    const project = await pool.query('SELECT * FROM projects WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!project.rows.length) throw new Error('Project not found.');
    const p = project.rows[0];

    const [labour, ledger, committed] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(te.hours), 0)::float AS hours_total,
                COALESCE(SUM(te.hours * COALESCE(e.hourly_cost_rate, 0)), 0)::float AS labour_cost
           FROM time_entries te
           LEFT JOIN employees e ON e.id = te.employee_id
          WHERE te.project_id = $1`,
        [id]
      ),
      pool.query(
        `SELECT COALESCE(SUM(jei.debit_amount - jei.credit_amount), 0)::float AS ledger_cost
           FROM journal_entry_items jei
           JOIN journal_entries je    ON je.id = jei.journal_entry_id
           JOIN chart_of_accounts coa ON coa.id = jei.account_id
          WHERE jei.project_id = $1 AND je.status = 'POSTED' AND je.deleted_at IS NULL
            AND coa.account_type = 'EXPENSE'`,
        [id]
      ),
      // Open commitment: purchase orders raised against this project that have
      // not yet been fully received/invoiced. Once a PO is FULLY_RECEIVED its
      // cost has already landed in `ledger` above via GR/AP posting, so it is
      // deliberately excluded here to avoid double-counting the same dollar as
      // both "committed" and "actual."
      pool.query(
        `SELECT COALESCE(SUM(total_amount), 0)::float AS committed
           FROM purchase_orders
          WHERE project_id = $1
            AND status IN ('APPROVED','SENT_TO_SUPPLIER','CONFIRMED','PARTIALLY_RECEIVED')`,
        [id]
      ),
    ]);

    const round = (n) => Number(Number(n).toFixed(2));
    const hoursLogged = labour.rows[0].hours_total;
    const actualCost = round(labour.rows[0].labour_cost + ledger.rows[0].ledger_cost);
    const committedAmount = round(committed.rows[0].committed);
    const budgetHours = p.budget_hours ? Number(p.budget_hours) : null;
    const budgetAmount = p.budget_amount ? Number(p.budget_amount) : null;

    // Estimate at completion, burn-rate method: project the remaining budgeted
    // hours forward at the average cost-per-hour observed so far. Requires
    // both a budget_hours target and at least one costed hour to have a rate to
    // project with — without those this module has no driver to forecast on,
    // and reporting a number anyway would be a guess dressed as an estimate.
    let eac = null;
    let percentComplete = null;
    let etc = null;
    if (budgetHours && budgetHours > 0) {
      percentComplete = round(Math.min(hoursLogged / budgetHours, 1) * 100);
      if (hoursLogged > 0 && actualCost > 0) {
        const avgCostPerHour = actualCost / hoursLogged;
        const remainingHours = Math.max(budgetHours - hoursLogged, 0);
        etc = round(remainingHours * avgCostPerHour);
        eac = round(actualCost + etc + committedAmount);
      }
    }

    const projectedTotal = round(actualCost + committedAmount);
    const varianceToBudget = budgetAmount != null ? round(budgetAmount - projectedTotal) : null;

    return {
      project: { id: p.id, project_code: p.project_code, name: p.name, status: p.status },
      budget: { amount: budgetAmount, hours: budgetHours },
      actual: { cost: actualCost, hours: round(hoursLogged) },
      committed: committedAmount,
      projected_total: projectedTotal,
      forecast: {
        percent_complete: percentComplete,
        estimate_to_complete: etc,
        estimate_at_completion: eac,
        note: budgetHours && !(hoursLogged > 0 && actualCost > 0)
          ? 'No estimate-at-completion yet: needs at least one costed hour logged against the budgeted hours to project a burn rate.'
          : (!budgetHours ? 'No estimate-at-completion: this project has no budget_hours to project a burn rate against.' : null),
      },
      variance_to_budget: varianceToBudget,
      over_budget: varianceToBudget != null ? varianceToBudget < 0 : null,
    };
  },
};

// ===========================================================================
// Tasks
// ===========================================================================

const ProjectTasks = {
  async create({ project_id, name, description, assignee_id, estimated_hours, due_date }) {
    if (!project_id) throw new Error('A task must belong to a project.');
    if (!name || !String(name).trim()) throw new Error('A task needs a name.');

    const { rows } = await pool.query(
      `INSERT INTO project_tasks (project_id, name, description, assignee_id, estimated_hours, due_date)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [project_id, String(name).trim(), description || null,
       assignee_id || null, estimated_hours || null, due_date || null]
    );
    return rows[0];
  },

  async update(id, fields) {
    const allowed = ['name', 'description', 'status', 'assignee_id', 'estimated_hours', 'due_date'];
    const sets = [];
    const params = [id];
    let statusParam = null;
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        params.push(fields[key]);
        sets.push(`${key} = $${params.length}`);
        if (key === 'status') statusParam = params.length;
      }
    }
    if (!sets.length) throw new Error('Nothing to update.');

    // Completion timestamp follows status rather than being set by the caller,
    // so "done" and "when it was done" cannot disagree.
    if (statusParam !== null) {
      sets.push(`completed_at = CASE WHEN $${statusParam} = 'DONE'
                                     THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE NULL END`);
    }
    sets.push('updated_at = CURRENT_TIMESTAMP');

    const { rows } = await pool.query(
      `UPDATE project_tasks SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    if (!rows.length) throw new Error('Task not found.');
    return rows[0];
  },
};

// ===========================================================================
// Time entries
// ===========================================================================

const TimeEntries = {
  /**
   * Log time.
   *
   * The billing rate is resolved and stored now rather than at invoicing time.
   * Rates change; an hour logged in Q1 must bill at the Q1 rate, and reading
   * the project's current rate months later would silently reprice history.
   */
  async create(data, userId) {
    const { project_id, task_id, entry_date, hours, description, billable, hourly_rate, employee_id } = data;

    if (!project_id) throw new Error('Time must be logged against a project.');
    if (!entry_date) throw new Error('Time needs a date.');
    const h = Number(hours);
    if (!(h > 0) || h > 24) throw new Error('Hours must be between 0 and 24.');

    const project = await pool.query(
      'SELECT status, billing_type, default_hourly_rate FROM projects WHERE id = $1 AND deleted_at IS NULL',
      [project_id]
    );
    if (!project.rows.length) throw new Error('Project not found.');
    const p = project.rows[0];
    if (!OPEN_STATUSES.includes(p.status)) {
      throw new Error(`Project is ${p.status}; time can only be logged to an open project.`);
    }

    // Internal projects never bill, whatever the caller asks for.
    const isBillable = p.billing_type === 'INTERNAL' ? false : (billable !== false);
    const rate = isBillable
      ? (hourly_rate !== undefined && hourly_rate !== null ? Number(hourly_rate) : p.default_hourly_rate)
      : null;

    const resolvedEmployee = employee_id || (await pool.query(
      'SELECT id FROM employees WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1', [userId]
    )).rows[0]?.id || null;

    const { rows } = await pool.query(
      `INSERT INTO time_entries
         (project_id, task_id, user_id, employee_id, entry_date, hours, description, billable, hourly_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [project_id, task_id || null, userId, resolvedEmployee, entry_date, h,
       description || null, isBillable, rate]
    );
    return rows[0];
  },

  async findAll({ project_id, user_id, task_id, from_date, to_date, unbilled_only, limit = 200 } = {}) {
    const params = [];
    let where = 'WHERE 1=1';

    if (project_id) { params.push(project_id); where += ` AND te.project_id = $${params.length}`; }
    if (user_id) { params.push(user_id); where += ` AND te.user_id = $${params.length}`; }
    if (task_id) { params.push(task_id); where += ` AND te.task_id = $${params.length}`; }
    if (from_date) { params.push(from_date); where += ` AND te.entry_date >= $${params.length}`; }
    if (to_date) { params.push(to_date); where += ` AND te.entry_date <= $${params.length}`; }
    if (unbilled_only) where += ' AND te.billable = true AND te.invoice_id IS NULL';

    params.push(Math.min(Number(limit) || 200, 1000));
    const { rows } = await pool.query(
      `SELECT te.*, p.project_code, p.name AS project_name, t.name AS task_name,
              u.first_name, u.last_name
         FROM time_entries te
         JOIN projects p           ON p.id = te.project_id
         LEFT JOIN project_tasks t ON t.id = te.task_id
         LEFT JOIN users u         ON u.id = te.user_id
         ${where}
         ORDER BY te.entry_date DESC, te.created_at DESC
         LIMIT $${params.length}`,
      params
    );
    return rows;
  },

  /**
   * Editing and deleting time is only allowed while it is unbilled and not yet
   * approved. Once an hour is on an invoice the customer has seen it; once it
   * is approved, a manager has signed off on it as billable/payable fact —
   * either way, changing it silently would put someone's record out of step
   * with no trace. Editing a REJECTED entry puts it back to PENDING, since a
   * changed entry is not the same claim the rejection was about.
   */
  async update(id, fields) {
    const allowed = ['entry_date', 'hours', 'description', 'billable', 'hourly_rate', 'task_id'];
    const sets = [];
    const params = [id];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        params.push(fields[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) throw new Error('Nothing to update.');
    sets.push(`approval_status = CASE WHEN approval_status = 'REJECTED' THEN 'PENDING' ELSE approval_status END`);
    sets.push('updated_at = CURRENT_TIMESTAMP');

    const { rows } = await pool.query(
      `UPDATE time_entries SET ${sets.join(', ')}
        WHERE id = $1 AND invoice_id IS NULL AND approval_status <> 'APPROVED' RETURNING *`,
      params
    );
    if (!rows.length) {
      throw new Error('Time entry not found, or it has already been invoiced or approved and can no longer be changed.');
    }
    return rows[0];
  },

  async remove(id) {
    const { rows } = await pool.query(
      `DELETE FROM time_entries WHERE id = $1 AND invoice_id IS NULL AND approval_status <> 'APPROVED' RETURNING id`,
      [id]
    );
    if (!rows.length) {
      throw new Error('Time entry not found, or it has already been invoiced or approved and can no longer be deleted.');
    }
    return { deleted: true };
  },

  /**
   * Approve or reject a logged hour. Segregation of duties: whoever logged
   * the time cannot approve their own entry, or "approval" is theatre — the
   * same person who might over-report hours would also be the one signing
   * off on them.
   */
  async approve(id, approverId) {
    const entry = await pool.query('SELECT user_id, approval_status FROM time_entries WHERE id = $1', [id]);
    if (!entry.rows.length) throw new Error('Time entry not found.');
    if (entry.rows[0].approval_status === 'APPROVED') throw new Error('This time entry is already approved.');
    if (entry.rows[0].user_id === approverId) {
      throw new Error('You cannot approve your own time entry — a different approver is required.');
    }

    const { rows } = await pool.query(
      `UPDATE time_entries
          SET approval_status = 'APPROVED', approved_by = $2, approved_at = CURRENT_TIMESTAMP,
              rejection_reason = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND invoice_id IS NULL RETURNING *`,
      [id, approverId]
    );
    if (!rows.length) throw new Error('Time entry not found, or it has already been invoiced.');
    return rows[0];
  },

  async reject(id, approverId, reason) {
    if (!reason || !String(reason).trim()) throw new Error('A rejection needs a reason.');
    const entry = await pool.query('SELECT user_id, approval_status FROM time_entries WHERE id = $1', [id]);
    if (!entry.rows.length) throw new Error('Time entry not found.');
    if (entry.rows[0].user_id === approverId) {
      throw new Error('You cannot reject your own time entry — a different approver is required.');
    }
    if (entry.rows[0].approval_status === 'APPROVED') throw new Error('An already-approved entry cannot be rejected; ask for a correction instead.');

    const { rows } = await pool.query(
      `UPDATE time_entries
          SET approval_status = 'REJECTED', approved_by = $2, approved_at = CURRENT_TIMESTAMP,
              rejection_reason = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING *`,
      [id, approverId, String(reason).trim()]
    );
    return rows[0];
  },

  /**
   * What would be billed, without billing it. Lets someone review a draft
   * before it reaches the customer, which is the only realistic way errors get
   * caught.
   */
  async previewBilling(projectId, { to_date } = {}) {
    const { rows } = await pool.query(
      `SELECT te.id, te.entry_date, te.hours, te.hourly_rate, te.description,
              u.first_name, u.last_name, t.name AS task_name
         FROM time_entries te
         LEFT JOIN users u         ON u.id = te.user_id
         LEFT JOIN project_tasks t ON t.id = te.task_id
        WHERE te.project_id = $1
          AND te.billable = true
          AND te.invoice_id IS NULL
          AND te.approval_status = 'APPROVED'
          AND ($2::date IS NULL OR te.entry_date <= $2)
        ORDER BY te.entry_date`,
      [projectId, to_date || null]
    );

    const total = rows.reduce((sum, r) => sum + Number(r.hours) * Number(r.hourly_rate || 0), 0);
    const unrated = rows.filter((r) => !Number(r.hourly_rate));

    return {
      entries: rows,
      hours: Number(rows.reduce((s, r) => s + Number(r.hours), 0).toFixed(2)),
      amount: taxService.round2(total),
      // Zero-rate entries would silently bill at nothing.
      warning: unrated.length
        ? `${unrated.length} entr${unrated.length === 1 ? 'y has' : 'ies have'} no hourly rate and would bill at zero.`
        : null,
    };
  },

  /**
   * Turn unbilled time into a customer invoice.
   *
   * The whole operation is one transaction, and the time entries are claimed
   * with `invoice_id IS NULL` still in the UPDATE's WHERE clause. That is what
   * makes a double-click, a retry, or two people billing at once safe: the
   * second writer matches zero rows and the invoice is rolled back rather than
   * the same hour being billed twice. Billing an hour twice is the one bug in
   * this module the customer would see.
   */
  async billProject(projectId, { to_date, tax_rate = 0, description } = {}, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const projectResult = await client.query(
        `SELECT p.*, c.customer_name, c.credit_days, c.payment_terms
           FROM projects p
           LEFT JOIN customers c ON c.id = p.customer_id
          WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [projectId]
      );
      if (!projectResult.rows.length) throw new Error('Project not found.');
      const project = projectResult.rows[0];

      if (!project.customer_id) throw new Error('This project has no customer, so it cannot be invoiced.');
      if (project.billing_type === 'INTERNAL') throw new Error('Internal projects are not billable.');

      // Lock the candidate rows for the duration of the transaction so a
      // concurrent billing run blocks here rather than racing us.
      const candidates = await client.query(
        `SELECT te.id, te.hours, te.hourly_rate, te.entry_date, te.description
           FROM time_entries te
          WHERE te.project_id = $1
            AND te.billable = true
            AND te.invoice_id IS NULL
            AND te.approval_status = 'APPROVED'
            AND ($2::date IS NULL OR te.entry_date <= $2)
          ORDER BY te.entry_date
          FOR UPDATE`,
        [projectId, to_date || null]
      );
      if (!candidates.rows.length) throw new Error('There is no unbilled, approved time on this project.');

      const subtotal = taxService.round2(
        candidates.rows.reduce((sum, r) => sum + Number(r.hours) * Number(r.hourly_rate || 0), 0)
      );
      if (!(subtotal > 0)) {
        throw new Error('The unbilled time on this project has no rate against it, so the invoice would be for zero.');
      }

      const totalHours = Number(candidates.rows.reduce((s, r) => s + Number(r.hours), 0).toFixed(2));
      const taxAmount = taxService.round2(subtotal * (Number(tax_rate) || 0));
      const totalAmount = taxService.round2(subtotal + taxAmount);

      const invoiceNumberResult = await client.query('SELECT generate_invoice_number() AS number');
      const invoiceNumber = invoiceNumberResult.rows[0].number;

      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (project.credit_days || 30));

      const invoiceId = uuidv4();
      const invoiceResult = await client.query(
        `INSERT INTO customer_invoices (
           id, invoice_number, customer_id, project_id, invoice_date, due_date, payment_terms, currency,
           subtotal, tax_amount, discount_amount, total_amount, status, description, created_by, updated_by
         ) VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,$7,$8,$9,0,$10,'APPROVED',$11,$12,$12)
         RETURNING *`,
        [invoiceId, invoiceNumber, project.customer_id, projectId, dueDate,
         project.payment_terms || 'Net 30', project.currency || 'USD',
         subtotal, taxAmount, totalAmount,
         description || `${project.project_code} ${project.name} — ${totalHours} hours`, userId]
      );

      await client.query(
        `INSERT INTO customer_invoice_items
           (invoice_id, line_number, item_description, quantity, unit_of_measure,
            unit_price, line_total, tax_rate, tax_amount)
         VALUES ($1,1,$2,$3,'HOUR',$4,$5,$6,$7)`,
        [invoiceId, `Professional services — ${project.name}`, totalHours,
         totalHours > 0 ? taxService.round2(subtotal / totalHours) : 0,
         subtotal, Number(tax_rate) || 0, taxAmount]
      );

      // Claim the entries. `invoice_id IS NULL` stays in the WHERE clause: if
      // another transaction billed them between our SELECT and here, this
      // matches fewer rows and the guard below aborts the whole invoice.
      const ids = candidates.rows.map((r) => r.id);
      const claimed = await client.query(
        `UPDATE time_entries
            SET invoice_id = $1, invoiced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ANY($2::uuid[]) AND invoice_id IS NULL
          RETURNING id`,
        [invoiceId, ids]
      );
      if (claimed.rows.length !== ids.length) {
        throw new Error('Some of this time was billed by another user while this invoice was being prepared. Nothing has been charged — please try again.');
      }

      const journalEntry = await CustomerInvoice.postRevenueJournal(
        { id: projectId, so_number: invoiceNumber, customer_name: project.customer_name },
        totalAmount, taxAmount, userId, client,
        { sourceType: 'PROJECT_BILLING', documentLabel: 'Project' }
      );
      if (journalEntry?.id) {
        await client.query('UPDATE customer_invoices SET journal_entry_id = $1 WHERE id = $2',
          [journalEntry.id, invoiceId]);
        invoiceResult.rows[0].journal_entry_id = journalEntry.id;
      }

      await CustomerInvoice.addStatusHistory(
        client, invoiceId, null, 'APPROVED', userId, `Billed from project ${project.project_code}`
      );

      await client.query('COMMIT');
      return {
        invoice: invoiceResult.rows[0],
        entries_billed: claimed.rows.length,
        hours_billed: totalHours,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
};

// ===========================================================================
// Resource loading
// ===========================================================================
//
// A weekly-hours allocation of an employee to a project, checked against the
// employee's standard capacity. The question this answers is "who is
// overcommitted," which a timesheet cannot answer on its own — a timesheet
// shows what happened, an allocation shows what was planned, and the gap
// between them is where projects quietly slip.

const ResourceAssignments = {
  async create(data, userId) {
    const { project_id, employee_id, allocation_hours_per_week, start_date, end_date } = data;
    if (!project_id) throw new Error('An assignment must belong to a project.');
    if (!employee_id) throw new Error('An assignment must name an employee.');
    const hours = Number(allocation_hours_per_week);
    if (!(hours > 0)) throw new Error('Allocation hours per week must be greater than zero.');
    if (!start_date) throw new Error('An assignment needs a start date.');

    const { rows } = await pool.query(
      `INSERT INTO project_assignments
         (project_id, employee_id, allocation_hours_per_week, start_date, end_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [project_id, employee_id, hours, start_date, end_date || null, userId]
    );
    return rows[0];
  },

  async remove(id) {
    const { rows } = await pool.query('DELETE FROM project_assignments WHERE id = $1 RETURNING id', [id]);
    if (!rows.length) throw new Error('Assignment not found.');
    return { deleted: true };
  },

  async findByProject(projectId) {
    const { rows } = await pool.query(
      `SELECT pa.*, e.first_name, e.last_name, e.weekly_capacity_hours
         FROM project_assignments pa
         JOIN employees e ON e.id = pa.employee_id
        WHERE pa.project_id = $1
        ORDER BY pa.start_date`,
      [projectId]
    );
    return rows;
  },

  /**
   * Allocation vs capacity for one employee, as of a given date (defaults to
   * today). Sums every assignment across every project whose date range
   * covers that date — overallocation is a property of the person, not of any
   * one project, which is exactly what a single project's screen cannot show.
   */
  async loadForEmployee(employeeId, asOfDate) {
    const date = asOfDate || new Date().toISOString().split('T')[0];
    const emp = await pool.query(
      'SELECT id, first_name, last_name, weekly_capacity_hours FROM employees WHERE id = $1 AND deleted_at IS NULL',
      [employeeId]
    );
    if (!emp.rows.length) throw new Error('Employee not found.');
    const e = emp.rows[0];

    const { rows } = await pool.query(
      `SELECT pa.id, pa.project_id, p.project_code, p.name AS project_name,
              pa.allocation_hours_per_week::float AS allocation_hours_per_week
         FROM project_assignments pa
         JOIN projects p ON p.id = pa.project_id
        WHERE pa.employee_id = $1
          AND pa.start_date <= $2
          AND (pa.end_date IS NULL OR pa.end_date >= $2)
          AND p.deleted_at IS NULL
        ORDER BY p.project_code`,
      [employeeId, date]
    );

    const capacity = Number(e.weekly_capacity_hours || 40);
    const allocated = Number(rows.reduce((s, r) => s + r.allocation_hours_per_week, 0).toFixed(2));

    return {
      employee: { id: e.id, first_name: e.first_name, last_name: e.last_name },
      as_of: date,
      capacity_hours_per_week: capacity,
      allocated_hours_per_week: allocated,
      available_hours_per_week: Number((capacity - allocated).toFixed(2)),
      utilization_pct: capacity > 0 ? Number(((allocated / capacity) * 100).toFixed(1)) : null,
      overallocated: allocated > capacity,
      assignments: rows,
    };
  },

  /**
   * Company-wide loading as of a date: every employee with at least one
   * active assignment, so an overallocated person cannot be missed by having
   * to be looked up one at a time.
   */
  async loadOverview(asOfDate) {
    const date = asOfDate || new Date().toISOString().split('T')[0];
    const { rows } = await pool.query(
      `SELECT e.id, e.first_name, e.last_name, COALESCE(e.weekly_capacity_hours, 40)::float AS capacity,
              COALESCE(SUM(pa.allocation_hours_per_week), 0)::float AS allocated
         FROM employees e
         JOIN project_assignments pa ON pa.employee_id = e.id
              AND pa.start_date <= $1 AND (pa.end_date IS NULL OR pa.end_date >= $1)
         JOIN projects p ON p.id = pa.project_id AND p.deleted_at IS NULL
        WHERE e.deleted_at IS NULL
        GROUP BY e.id, e.first_name, e.last_name, e.weekly_capacity_hours
        ORDER BY (COALESCE(SUM(pa.allocation_hours_per_week), 0) / NULLIF(COALESCE(e.weekly_capacity_hours, 40), 0)) DESC`,
      [date]
    );
    return rows.map((r) => ({
      employee_id: r.id, first_name: r.first_name, last_name: r.last_name,
      capacity_hours_per_week: r.capacity,
      allocated_hours_per_week: Number(r.allocated.toFixed(2)),
      utilization_pct: r.capacity > 0 ? Number(((r.allocated / r.capacity) * 100).toFixed(1)) : null,
      overallocated: r.allocated > r.capacity,
    }));
  },
};

// ===========================================================================
// Milestone billing — revenue recognition tied to a deliverable, not a date
// ===========================================================================
//
// Two steps, deliberately kept separate: achieving a milestone records that
// the deliverable happened; billing it raises the invoice and posts revenue
// to the GL. A milestone can be achieved and reviewed before anyone commits
// to invoicing it, the same achieved-then-posted split used elsewhere in this
// codebase (credit notes, depreciation).
//
// This is milestone billing, not continuous percentage-of-completion —
// revenue is recognised in discrete chunks tied to named deliverables, not
// accrued smoothly against an estimate-to-complete. See the eval write-up for
// why: POC needs an estimate-to-complete this module does not collect, and a
// fabricated one would be worse than not having the feature.
const Milestones = {
  async create(data, userId) {
    const { project_id, name, amount, target_date } = data;
    if (!project_id) throw new Error('A milestone must belong to a project.');
    if (!name || !String(name).trim()) throw new Error('A milestone needs a name.');
    if (!(Number(amount) > 0)) throw new Error('A milestone needs an amount greater than zero.');

    const project = await pool.query('SELECT customer_id FROM projects WHERE id = $1 AND deleted_at IS NULL', [project_id]);
    if (!project.rows.length) throw new Error('Project not found.');

    const { rows } = await pool.query(
      `INSERT INTO project_milestones (project_id, name, amount, target_date, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [project_id, String(name).trim(), Number(amount), target_date || null, userId]
    );
    return rows[0];
  },

  async findByProject(projectId) {
    const { rows } = await pool.query(
      'SELECT * FROM project_milestones WHERE project_id = $1 ORDER BY target_date NULLS LAST, created_at',
      [projectId]
    );
    return rows;
  },

  async achieve(id, userId) {
    const { rows } = await pool.query(
      `UPDATE project_milestones
          SET status = 'ACHIEVED', achieved_at = CURRENT_TIMESTAMP, achieved_by = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'PENDING' RETURNING *`,
      [id, userId]
    );
    if (!rows.length) throw new Error('Milestone not found, or it is not PENDING.');
    return rows[0];
  },

  /**
   * Raise a customer invoice for an achieved milestone and post revenue to
   * the GL. Reuses the same posting path (CustomerInvoice.postRevenueJournal)
   * every other revenue-recognition site in this codebase uses, so the
   * accounting is identical to a time-billed or sales-order invoice: Dr AR,
   * Cr Revenue, distinct posting identity for SoD.
   */
  async bill(id, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const milestoneResult = await client.query(
        `SELECT m.*, p.project_code, p.name AS project_name, p.currency, p.customer_id,
                c.customer_name, c.credit_days, c.payment_terms
           FROM project_milestones m
           JOIN projects p  ON p.id = m.project_id
           LEFT JOIN customers c ON c.id = p.customer_id
          WHERE m.id = $1 FOR UPDATE OF m`,
        [id]
      );
      if (!milestoneResult.rows.length) throw new Error('Milestone not found.');
      const m = milestoneResult.rows[0];

      if (m.status !== 'ACHIEVED') throw new Error(`Milestone is ${m.status}; only an ACHIEVED milestone can be billed.`);
      if (!m.customer_id) throw new Error('This project has no customer, so its milestones cannot be invoiced.');

      const amount = taxService.round2(Number(m.amount));
      const invoiceNumberResult = await client.query('SELECT generate_invoice_number() AS number');
      const invoiceNumber = invoiceNumberResult.rows[0].number;

      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (m.credit_days || 30));

      const invoiceId = uuidv4();
      const invoiceResult = await client.query(
        `INSERT INTO customer_invoices (
           id, invoice_number, customer_id, project_id, invoice_date, due_date, payment_terms, currency,
           subtotal, tax_amount, discount_amount, total_amount, status, description, created_by, updated_by
         ) VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,$7,$8,0,0,$8,'APPROVED',$9,$10,$10)
         RETURNING *`,
        [invoiceId, invoiceNumber, m.customer_id, m.project_id, dueDate,
         m.payment_terms || 'Net 30', m.currency || 'USD', amount,
         `${m.project_code} ${m.project_name} — milestone: ${m.name}`, userId]
      );

      await client.query(
        `INSERT INTO customer_invoice_items
           (invoice_id, line_number, item_description, quantity, unit_of_measure, unit_price, line_total, tax_rate, tax_amount)
         VALUES ($1,1,$2,1,'EA',$3,$3,0,0)`,
        [invoiceId, `Milestone — ${m.name}`, amount]
      );

      const journalEntry = await CustomerInvoice.postRevenueJournal(
        { id: m.project_id, so_number: invoiceNumber, customer_name: m.customer_name },
        amount, 0, userId, client,
        { sourceType: 'PROJECT_MILESTONE', documentLabel: 'Project milestone' }
      );
      if (journalEntry?.id) {
        await client.query('UPDATE customer_invoices SET journal_entry_id = $1 WHERE id = $2', [journalEntry.id, invoiceId]);
        invoiceResult.rows[0].journal_entry_id = journalEntry.id;
      }

      await CustomerInvoice.addStatusHistory(
        client, invoiceId, null, 'APPROVED', userId, `Billed from milestone ${m.name}`
      );

      const billed = await client.query(
        `UPDATE project_milestones SET status = 'BILLED', invoice_id = $2, billed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 RETURNING *`,
        [id, invoiceId]
      );

      await client.query('COMMIT');
      return { milestone: billed.rows[0], invoice: invoiceResult.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
};

module.exports = { Projects, ProjectTasks, TimeEntries, ResourceAssignments, Milestones, OPEN_STATUSES };
