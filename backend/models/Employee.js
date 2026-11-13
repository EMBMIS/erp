const { pool } = require('../config/database');

/** Employee master for HR and payroll. */
class Employee {

  static async create(data, userId) {
    const numResult = await pool.query('SELECT generate_employee_number() as number');
    const employee_number = numResult.rows[0].number;
    const result = await pool.query(`
      INSERT INTO employees (
        employee_number, first_name, last_name, email, department, position,
        cost_center_id, hire_date, base_salary, currency, status,
        housing_allowance, transport_allowance, other_allowance, manager_id,
        created_by, updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
      RETURNING *
    `, [
      employee_number,
      data.first_name,
      data.last_name,
      data.email || null,
      data.department || null,
      data.position || null,
      data.cost_center_id || null,
      data.hire_date || null,
      data.base_salary || 0,
      data.currency || 'USD',
      data.status || 'ACTIVE',
      data.housing_allowance || 0,
      data.transport_allowance || 0,
      data.other_allowance || 0,
      data.manager_id || null,
      userId,
    ]);
    return result.rows[0];
  }

  static async findAll(filters = {}) {
    let query = `
      SELECT e.*, cc.name AS cost_center_name
      FROM employees e
      LEFT JOIN cost_centers cc ON e.cost_center_id = cc.id
      WHERE e.deleted_at IS NULL
    `;
    const conditions = [];
    const values = [];
    if (filters.status) { conditions.push(`e.status = $${values.length + 1}`); values.push(filters.status); }
    if (filters.search) {
      // Same $n placeholder reused three times: the caller supplies one value.
      conditions.push(`(e.first_name ILIKE $${values.length + 1} OR e.last_name ILIKE $${values.length + 1} OR e.employee_number ILIKE $${values.length + 1})`);
      values.push(`%${filters.search}%`);
    }
    if (conditions.length > 0) query += ' AND ' + conditions.join(' AND ');

    // Total BEFORE paging, so the UI can say "showing 1–50 of 412" instead of
    // guessing from the length of the page it happens to be holding. Runs before
    // limit/offset are appended to `values`, so the shared placeholder indexes
    // still line up.
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS n FROM employees e
        WHERE e.deleted_at IS NULL${conditions.length ? ' AND ' + conditions.join(' AND ') : ''}`,
      values
    );

    // Sorting is whitelisted, never interpolated from the request — the client's
    // value is used only to LOOK UP a fixed expression (see CustomerInvoice).
    const SORTABLE = {
      employee_number: 'e.employee_number',
      first_name: 'e.first_name',
      last_name: 'e.last_name',
      department: 'e.department',
      position: 'e.position',
      status: 'e.status',
      hire_date: 'e.hire_date',
      base_salary: 'e.base_salary',
      cost_center_name: 'cc.name',
      created_at: 'e.created_at',
    };
    const sortColumn = SORTABLE[filters.sort_by] || 'e.created_at';
    const sortDirection = String(filters.sort_dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    // Tie-break on id: without it, rows sharing a sort value can swap places
    // between pages, so the same employee appears on page 1 and page 2.
    query += ` ORDER BY ${sortColumn} ${sortDirection} NULLS LAST, e.id`;

    if (filters.limit) {
      query += ` LIMIT $${values.length + 1}`;
      values.push(filters.limit);
    }
    if (filters.offset) {
      query += ` OFFSET $${values.length + 1}`;
      values.push(filters.offset);
    }

    const result = await pool.query(query, values);
    return { rows: result.rows, total: countResult.rows[0].n };
  }

  static async findById(id) {
    const result = await pool.query('SELECT * FROM employees WHERE id = $1 AND deleted_at IS NULL', [id]);
    return result.rows[0] || null;
  }

  // Fields whose change is worth a row in the employee's job history — a real
  // audit trail for "who approved this raise" or "when did they change teams,"
  // not just the department/salary/manager the employee happens to have today.
  static TRACKED_FIELDS = ['department', 'position', 'base_salary', 'manager_id', 'cost_center_id', 'status'];

  static async update(id, data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const beforeRes = await client.query('SELECT * FROM employees WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
      if (beforeRes.rows.length === 0) throw new Error('Employee not found');
      const before = beforeRes.rows[0];

      const result = await client.query(`
        UPDATE employees SET
          first_name = COALESCE($2, first_name),
          last_name = COALESCE($3, last_name),
          email = COALESCE($4, email),
          department = COALESCE($5, department),
          position = COALESCE($6, position),
          cost_center_id = COALESCE($7, cost_center_id),
          base_salary = COALESCE($8, base_salary),
          status = COALESCE($9, status),
          manager_id = COALESCE($10, manager_id),
          updated_by = $11, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *
      `, [id, data.first_name || null, data.last_name || null, data.email || null, data.department || null,
          data.position || null, data.cost_center_id || null, data.base_salary ?? null, data.status || null,
          data.manager_id || null, userId]);
      const after = result.rows[0];

      for (const field of Employee.TRACKED_FIELDS) {
        const oldVal = before[field];
        const newVal = after[field];
        const changed = String(oldVal ?? '') !== String(newVal ?? '');
        if (changed) {
          await client.query(
            `INSERT INTO employee_job_history (employee_id, field_name, old_value, new_value, changed_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, field, oldVal == null ? null : String(oldVal), newVal == null ? null : String(newVal), userId]
          );
        }
      }

      await client.query('COMMIT');
      return after;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async jobHistory(employeeId) {
    const result = await pool.query(
      `SELECT jh.*, u.first_name || ' ' || u.last_name AS changed_by_name
         FROM employee_job_history jh
         LEFT JOIN users u ON jh.changed_by = u.id
        WHERE jh.employee_id = $1
        ORDER BY jh.created_at DESC`,
      [employeeId]
    );
    return result.rows;
  }

  // Flat list -> tree, rooted at whoever has no manager (or a manager outside
  // this result set, e.g. deleted). A person cannot be their own ancestor —
  // cycles are broken by tracking visited ids rather than trusted to never
  // occur in the data.
  static async orgChart() {
    const { rows } = await pool.query(`
      SELECT id, employee_number, first_name, last_name, department, position, manager_id, status
        FROM employees WHERE deleted_at IS NULL ORDER BY last_name, first_name
    `);
    const byId = new Map(rows.map((e) => [e.id, { ...e, reports: [] }]));
    const roots = [];
    for (const e of byId.values()) {
      if (e.manager_id && byId.has(e.manager_id) && e.manager_id !== e.id) {
        byId.get(e.manager_id).reports.push(e);
      } else {
        roots.push(e);
      }
    }
    return roots;
  }

  static async getStats() {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total_employees,
        COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_employees,
        COALESCE(SUM(base_salary) FILTER (WHERE status = 'ACTIVE'), 0) AS total_annual_payroll
      FROM employees WHERE deleted_at IS NULL
    `);
    return result.rows[0];
  }
}

module.exports = Employee;
