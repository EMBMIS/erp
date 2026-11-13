/**
 * Dashboards: arrangements of saved reports.
 *
 * A dashboard holds no data of its own — every widget points at a report
 * definition, and rendering one runs those reports through the same validated
 * path as running them individually. That is deliberate: a widget that cached
 * its own numbers would quietly show a different figure from the report it
 * claims to display, and nobody would know which to believe.
 */

const { pool } = require('../config/database');
const { Reports } = require('../services/reportService');

const Dashboards = {
  async create({ name, description, is_shared }, userId) {
    if (!name || !String(name).trim()) throw new Error('A dashboard needs a name.');
    const { rows } = await pool.query(
      `INSERT INTO dashboards (name, description, owner_id, is_shared, created_by)
       VALUES ($1,$2,$3,$4,$3) RETURNING *`,
      [String(name).trim(), description || null, userId, is_shared === true]
    );
    return rows[0];
  },

  async findAll(userId) {
    const { rows } = await pool.query(
      `SELECT d.*, (SELECT COUNT(*)::int FROM dashboard_widgets w WHERE w.dashboard_id = d.id) AS widget_count
         FROM dashboards d
        WHERE d.deleted_at IS NULL AND (d.is_shared = true OR d.owner_id = $1)
        ORDER BY d.is_default DESC, d.name`,
      [userId]
    );
    return rows;
  },

  async findById(id, userId) {
    const { rows } = await pool.query(
      `SELECT * FROM dashboards
        WHERE id = $1 AND deleted_at IS NULL AND (is_shared = true OR owner_id = $2)`,
      [id, userId]
    );
    if (!rows.length) return null;

    const widgets = await pool.query(
      `SELECT w.*, r.name AS report_name, r.report_type, r.parameters AS report_parameters
         FROM dashboard_widgets w
         LEFT JOIN report_definitions r ON r.id = w.report_id
        WHERE w.dashboard_id = $1
        ORDER BY w.position_y, w.position_x`,
      [id]
    );
    return { ...rows[0], widgets: widgets.rows };
  },

  async update(id, fields, userId) {
    const allowed = ['name', 'description', 'is_shared', 'is_default'];
    const sets = [];
    const params = [id, userId];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        params.push(fields[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) throw new Error('Nothing to update.');
    sets.push('updated_at = CURRENT_TIMESTAMP');

    const { rows } = await pool.query(
      `UPDATE dashboards SET ${sets.join(', ')}
        WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL RETURNING *`,
      params
    );
    if (!rows.length) throw new Error('Dashboard not found, or you do not own it.');
    return rows[0];
  },

  async remove(id, userId) {
    const { rows } = await pool.query(
      `UPDATE dashboards SET deleted_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL RETURNING id`,
      [id, userId]
    );
    if (!rows.length) throw new Error('Dashboard not found, or you do not own it.');
    return { deleted: true };
  },

  async addWidget(dashboardId, data, userId) {
    const owned = await pool.query(
      'SELECT 1 FROM dashboards WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL',
      [dashboardId, userId]
    );
    if (!owned.rows.length) throw new Error('Dashboard not found, or you do not own it.');

    const { report_id, title, widget_type, position_x, position_y, width, height, config } = data;

    // Checked through Reports.findById so a widget cannot be used to surface a
    // report the user has no access to — a dashboard is shareable, and without
    // this a private report could be read by adding it to a shared board.
    if (widget_type !== 'TEXT') {
      if (!report_id) throw new Error('A widget needs a report.');
      const report = await Reports.findById(report_id, userId);
      if (!report) throw new Error('Report not found, or you do not have access to it.');
    }

    const { rows } = await pool.query(
      `INSERT INTO dashboard_widgets
         (dashboard_id, report_id, title, widget_type, position_x, position_y, width, height, config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [dashboardId, widget_type === 'TEXT' ? null : report_id, title || null,
       widget_type || 'TABLE', position_x || 0, position_y || 0,
       width || 6, height || 4, JSON.stringify(config || {})]
    );
    return rows[0];
  },

  async updateWidget(widgetId, fields, userId) {
    const owned = await pool.query(
      `SELECT 1 FROM dashboard_widgets w
         JOIN dashboards d ON d.id = w.dashboard_id
        WHERE w.id = $1 AND d.owner_id = $2 AND d.deleted_at IS NULL`,
      [widgetId, userId]
    );
    if (!owned.rows.length) throw new Error('Widget not found, or you do not own its dashboard.');

    const allowed = ['title', 'widget_type', 'position_x', 'position_y', 'width', 'height', 'config'];
    const sets = [];
    const params = [widgetId];
    for (const key of allowed) {
      if (fields[key] === undefined) continue;
      params.push(key === 'config' ? JSON.stringify(fields[key]) : fields[key]);
      sets.push(`${key} = $${params.length}`);
    }
    if (!sets.length) throw new Error('Nothing to update.');
    sets.push('updated_at = CURRENT_TIMESTAMP');

    const { rows } = await pool.query(
      `UPDATE dashboard_widgets SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params
    );
    return rows[0];
  },

  async removeWidget(widgetId, userId) {
    const { rows } = await pool.query(
      `DELETE FROM dashboard_widgets w
        USING dashboards d
        WHERE w.dashboard_id = d.id AND w.id = $1 AND d.owner_id = $2
        RETURNING w.id`,
      [widgetId, userId]
    );
    if (!rows.length) throw new Error('Widget not found, or you do not own its dashboard.');
    return { deleted: true };
  },

  /**
   * Render every widget on a dashboard.
   *
   * Widgets are run concurrently but failures are per widget: one report that
   * errors returns its message in place of its rows rather than blanking the
   * whole board. A dashboard where nine panels work is worth showing.
   *
   * Runs are not recorded in report_runs — a dashboard left open on a wall
   * display would otherwise bury every genuine execution in the history.
   */
  async render(id, userId, parameterValues = {}) {
    const dashboard = await this.findById(id, userId);
    if (!dashboard) throw new Error('Dashboard not found.');

    const widgets = await Promise.all(dashboard.widgets.map(async (w) => {
      if (w.widget_type === 'TEXT' || !w.report_id) return { ...w, data: null };
      try {
        const result = await Reports.run(
          w.report_id,
          { parameter_values: { ...(w.config?.parameters || {}), ...parameterValues }, record: false },
          userId
        );
        return { ...w, data: { columns: result.columns, rows: result.rows, row_count: result.row_count } };
      } catch (error) {
        return { ...w, data: null, error: error.message };
      }
    }));

    return { ...dashboard, widgets };
  },
};

module.exports = Dashboards;
