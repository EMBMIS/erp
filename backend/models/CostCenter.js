const { pool } = require('../config/database');

/** CostCenter — organizational units for expense allocation and budgeting. */
class CostCenter {

  static async create(data, userId) {
    const numResult = await pool.query('SELECT generate_cost_center_code() as code');
    const code = numResult.rows[0].code;
    const result = await pool.query(`
      INSERT INTO cost_centers (code, name, description, manager_id, status, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$6)
      RETURNING *
    `, [
      code,
      data.name,
      data.description || null,
      data.manager_id || null,
      data.status || 'ACTIVE',
      userId,
    ]);
    return result.rows[0];
  }

  static async findAll(filters = {}) {
    let query = `
      SELECT cc.*, u.first_name || ' ' || u.last_name AS manager_name
      FROM cost_centers cc
      LEFT JOIN users u ON cc.manager_id = u.id
      WHERE cc.deleted_at IS NULL
    `;
    const values = [];
    if (filters.status) { values.push(filters.status); query += ` AND cc.status = $${values.length}`; }
    query += ' ORDER BY cc.code ASC';
    const result = await pool.query(query, values);
    return result.rows;
  }

  static async findById(id) {
    const result = await pool.query('SELECT * FROM cost_centers WHERE id = $1 AND deleted_at IS NULL', [id]);
    return result.rows[0] || null;
  }

  static async update(id, data, userId) {
    const result = await pool.query(`
      UPDATE cost_centers
      SET name = COALESCE($2, name), description = COALESCE($3, description),
          manager_id = COALESCE($4, manager_id), status = COALESCE($5, status),
          updated_by = $6, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *
    `, [id, data.name || null, data.description || null, data.manager_id || null, data.status || null, userId]);
    if (result.rows.length === 0) throw new Error('Cost center not found');
    return result.rows[0];
  }
}

module.exports = CostCenter;
