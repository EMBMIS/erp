const { pool } = require('../config/database');

/**
 * Work centres and routing.
 *
 * Capacity here is reported from work_order_operations — the routing copied
 * onto each work order — and never from a fallback. If nobody has set up a
 * work centre, this returns an empty list, because an empty shop floor is a
 * true answer and three invented machines running at 80% is not.
 */

// Statuses whose operations still consume future capacity. A COMPLETED or
// SKIPPED operation is history; a PENDING one on a DRAFT order is not yet
// committed work and is excluded by the work-order status filter below.
const OPEN_OPERATION_STATUSES = ['PENDING', 'IN_PROGRESS'];
const COMMITTED_WO_STATUSES = ['RELEASED', 'IN_PROGRESS'];

class WorkCenter {
  static async findAll({ status, includeInactive = false } = {}) {
    const conditions = ['wc.deleted_at IS NULL'];
    const values = [];

    if (status) {
      values.push(status);
      conditions.push(`wc.status = $${values.length}`);
    } else if (!includeInactive) {
      conditions.push(`wc.status <> 'INACTIVE'`);
    }

    const { rows } = await pool.query(
      `SELECT wc.*, cc.name AS cost_center_name
         FROM work_centers wc
         LEFT JOIN cost_centers cc ON cc.id = wc.cost_center_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY wc.code ASC`,
      values
    );
    return rows;
  }

  static async findById(id) {
    const { rows } = await pool.query(
      `SELECT wc.*, cc.name AS cost_center_name
         FROM work_centers wc
         LEFT JOIN cost_centers cc ON cc.id = wc.cost_center_id
        WHERE wc.id = $1 AND wc.deleted_at IS NULL`,
      [id]
    );
    return rows[0] || null;
  }

  static async create(data, userId) {
    const { code, name } = data;
    if (!code || !String(code).trim()) throw new Error('Work centre code is required.');
    if (!name || !String(name).trim()) throw new Error('Work centre name is required.');

    const { rows } = await pool.query(
      `INSERT INTO work_centers
         (code, name, description, cost_center_id, daily_capacity_hours,
          efficiency_pct, hourly_rate, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        String(code).trim().toUpperCase(),
        String(name).trim(),
        data.description || null,
        data.cost_center_id || null,
        Number(data.daily_capacity_hours) || 8,
        Number(data.efficiency_pct) || 100,
        Number(data.hourly_rate) || 0,
        data.status || 'ACTIVE',
        userId,
      ]
    );
    return rows[0];
  }

  static async update(id, fields) {
    const allowed = [
      'name', 'description', 'cost_center_id', 'daily_capacity_hours',
      'efficiency_pct', 'hourly_rate', 'status',
    ];
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
      `UPDATE work_centers SET ${sets.join(', ')}
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      params
    );
    if (!rows.length) throw new Error('Work centre not found.');
    return rows[0];
  }

  static async remove(id) {
    // Refuse to retire a centre that committed work still depends on, rather
    // than leaving orphaned operations pointing at something nobody can see.
    const { rows: load } = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM work_order_operations op
         JOIN work_orders wo ON wo.id = op.work_order_id
        WHERE op.work_center_id = $1
          AND op.status = ANY($2)
          AND wo.status = ANY($3)
          AND wo.deleted_at IS NULL`,
      [id, OPEN_OPERATION_STATUSES, COMMITTED_WO_STATUSES]
    );
    if (load[0].n > 0) {
      throw new Error(
        `This work centre has ${load[0].n} open operation(s) on released work orders. `
        + 'Complete or reassign them first, or set the centre to INACTIVE instead.'
      );
    }

    const { rows } = await pool.query(
      `UPDATE work_centers SET deleted_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [id]
    );
    if (!rows.length) throw new Error('Work centre not found.');
    return { id };
  }

  /**
   * Load and utilisation per work centre, over a forward horizon.
   *
   * Load is the planned hours still outstanding (planned − actual, floored at
   * zero) on open operations belonging to committed work orders. Subtracting
   * actual hours is what makes this a picture of remaining work rather than of
   * work ever scheduled — an operation that is 90% done should not still be
   * consuming its full capacity.
   *
   * Capacity is effective daily hours × working days in the horizon. Weekend
   * handling is deliberately naive (5/7 of calendar days); a real shop
   * calendar with holidays and shift patterns is a bigger object than this
   * needs to be, and pretending otherwise would be the same mistake as the
   * hardcoded data this replaces.
   */
  static async capacity({ horizonDays = 7 } = {}) {
    const days = Math.max(1, Math.min(365, Number(horizonDays) || 7));

    const { rows } = await pool.query(
      `SELECT
          wc.id,
          wc.code,
          wc.name,
          wc.status,
          wc.daily_capacity_hours,
          wc.efficiency_pct,
          wc.hourly_rate,
          COALESCE(SUM(GREATEST(op.planned_hours - op.actual_hours, 0)), 0)::float AS remaining_hours,
          COALESCE(SUM(op.planned_hours), 0)::float                                AS planned_hours,
          COALESCE(SUM(op.actual_hours), 0)::float                                 AS actual_hours,
          COUNT(DISTINCT op.work_order_id)::int                                    AS active_work_orders,
          COUNT(op.id)::int                                                         AS open_operations
        FROM work_centers wc
        LEFT JOIN work_order_operations op
               ON op.work_center_id = wc.id
              AND op.status = ANY($1)
        LEFT JOIN work_orders wo
               ON wo.id = op.work_order_id
              AND wo.status = ANY($2)
              AND wo.deleted_at IS NULL
       WHERE wc.deleted_at IS NULL
         AND wc.status <> 'INACTIVE'
         -- Keep centres with no load (they show as idle), but drop operation
         -- rows whose work order failed the status filter above.
         AND (op.id IS NULL OR wo.id IS NOT NULL)
       GROUP BY wc.id
       ORDER BY wc.code ASC`,
      [OPEN_OPERATION_STATUSES, COMMITTED_WO_STATUSES]
    );

    const workingDays = Math.max(1, Math.round(days * (5 / 7)));

    return rows.map((wc) => {
      const effectiveDaily = Number(wc.daily_capacity_hours) * (Number(wc.efficiency_pct) / 100);
      const availableHours = effectiveDaily * workingDays;
      const load = Number(wc.remaining_hours);
      // Utilisation is uncapped on purpose: 140% is the number a planner needs
      // to see. Clamping it to 100 hides exactly the overload it exists to warn about.
      const utilisation = availableHours > 0 ? Math.round((load / availableHours) * 100) : 0;

      return {
        id: wc.id,
        code: wc.code,
        name: wc.name,
        status: wc.status,
        daily_capacity_hours: Number(wc.daily_capacity_hours),
        efficiency_pct: Number(wc.efficiency_pct),
        hourly_rate: Number(wc.hourly_rate),
        horizon_days: days,
        working_days: workingDays,
        available_hours: Number(availableHours.toFixed(2)),
        remaining_hours: Number(load.toFixed(2)),
        planned_hours: Number(Number(wc.planned_hours).toFixed(2)),
        actual_hours: Number(Number(wc.actual_hours).toFixed(2)),
        active_work_orders: wc.active_work_orders,
        open_operations: wc.open_operations,
        utilisation_pct: utilisation,
        // Kept under the old spelling too — WorkCenterDashboard.jsx reads this key.
        utilization_pct: utilisation,
        load_status:
          utilisation > 100 ? 'OVERLOADED'
            : utilisation > 85 ? 'HIGH_LOAD'
              : utilisation > 40 ? 'NORMAL'
                : 'LIGHT',
      };
    });
  }

  // -------------------------------------------------------------------------
  // Standard routing on a BOM
  // -------------------------------------------------------------------------

  static async listBomOperations(bomId) {
    const { rows } = await pool.query(
      `SELECT bo.*, wc.code AS work_center_code, wc.name AS work_center_name, wc.hourly_rate
         FROM bom_operations bo
         JOIN work_centers wc ON wc.id = bo.work_center_id
        WHERE bo.bom_id = $1
        ORDER BY bo.operation_number`,
      [bomId]
    );
    return rows;
  }

  static async addBomOperation(bomId, data) {
    const { work_center_id, description } = data;
    if (!work_center_id) throw new Error('A work centre is required for a routing operation.');
    if (!description || !String(description).trim()) {
      throw new Error('A routing operation needs a description of the work.');
    }

    // Default to the next step rather than making the caller track numbering.
    let operationNumber = Number(data.operation_number);
    if (!Number.isFinite(operationNumber) || operationNumber <= 0) {
      const { rows } = await pool.query(
        'SELECT COALESCE(MAX(operation_number), 0) + 10 AS n FROM bom_operations WHERE bom_id = $1',
        [bomId]
      );
      operationNumber = rows[0].n;
    }

    const { rows } = await pool.query(
      `INSERT INTO bom_operations
         (bom_id, operation_number, work_center_id, description, setup_hours, run_hours_per_unit)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        bomId,
        operationNumber,
        work_center_id,
        String(description).trim(),
        Number(data.setup_hours) || 0,
        Number(data.run_hours_per_unit) || 0,
      ]
    );
    return rows[0];
  }

  static async removeBomOperation(id) {
    const { rows } = await pool.query('DELETE FROM bom_operations WHERE id = $1 RETURNING id', [id]);
    if (!rows.length) throw new Error('Routing operation not found.');
    return { id };
  }

  /**
   * Copy a BOM's routing onto a new work order, scaled to its quantity.
   *
   * Takes an existing client because this runs inside WorkOrder.create's
   * transaction — the operations and the order they belong to must land
   * together or not at all.
   */
  static async copyRoutingToWorkOrder(client, { workOrderId, bomId, quantity }) {
    const { rows: operations } = await client.query(
      `SELECT bo.*, wc.hourly_rate
         FROM bom_operations bo
         JOIN work_centers wc ON wc.id = bo.work_center_id
        WHERE bo.bom_id = $1
        ORDER BY bo.operation_number`,
      [bomId]
    );

    // A BOM with no routing is normal — plenty of items are bought, kitted or
    // assembled without a timed operation. It is not an error.
    if (!operations.length) return 0;

    for (const op of operations) {
      const plannedHours =
        Number(op.setup_hours) + Number(op.run_hours_per_unit) * Number(quantity);

      await client.query(
        `INSERT INTO work_order_operations
           (work_order_id, operation_number, work_center_id, description,
            setup_hours, run_hours_per_unit, planned_hours, hourly_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          workOrderId,
          op.operation_number,
          op.work_center_id,
          op.description,
          op.setup_hours,
          op.run_hours_per_unit,
          plannedHours.toFixed(4),
          op.hourly_rate,
        ]
      );
    }
    return operations.length;
  }

  // -------------------------------------------------------------------------
  // Work-order operations
  // -------------------------------------------------------------------------

  static async listWorkOrderOperations(workOrderId) {
    const { rows } = await pool.query(
      `SELECT op.*, wc.code AS work_center_code, wc.name AS work_center_name,
              (op.planned_hours * op.hourly_rate)::numeric(15,2) AS planned_cost,
              (op.actual_hours  * op.hourly_rate)::numeric(15,2) AS actual_cost
         FROM work_order_operations op
         JOIN work_centers wc ON wc.id = op.work_center_id
        WHERE op.work_order_id = $1
        ORDER BY op.operation_number`,
      [workOrderId]
    );
    return rows;
  }

  /**
   * Book time against an operation.
   *
   * The time entry and the running total move together in one transaction, so
   * actual_hours can never drift from the entries that explain it.
   */
  static async bookTime(operationId, { hours, entry_date, employee_id, notes }, userId) {
    const booked = Number(hours);
    if (!Number.isFinite(booked) || booked <= 0) {
      throw new Error('Hours booked must be a positive number.');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: opRows } = await client.query(
        `SELECT op.*, wo.status AS wo_status
           FROM work_order_operations op
           JOIN work_orders wo ON wo.id = op.work_order_id
          WHERE op.id = $1
          FOR UPDATE OF op`,
        [operationId]
      );
      if (!opRows.length) throw new Error('Operation not found.');
      const op = opRows[0];

      if (op.status === 'COMPLETED') {
        throw new Error('This operation is already completed. Reopen it before booking more time.');
      }
      if (!COMMITTED_WO_STATUSES.includes(op.wo_status)) {
        throw new Error(
          `Time cannot be booked against a work order in status ${op.wo_status}. Release it first.`
        );
      }

      await client.query(
        `INSERT INTO work_order_time_entries
           (operation_id, work_order_id, hours, entry_date, employee_id, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [operationId, op.work_order_id, booked, entry_date || new Date(), employee_id || null,
         notes || null, userId]
      );

      const { rows } = await client.query(
        `UPDATE work_order_operations
            SET actual_hours = actual_hours + $2,
                status       = CASE WHEN status = 'PENDING' THEN 'IN_PROGRESS' ELSE status END,
                actual_start = COALESCE(actual_start, CURRENT_TIMESTAMP),
                updated_at   = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *`,
        [operationId, booked]
      );

      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  static async completeOperation(operationId) {
    const { rows } = await pool.query(
      `UPDATE work_order_operations
          SET status     = 'COMPLETED',
              actual_end = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *`,
      [operationId]
    );
    if (!rows.length) throw new Error('Operation not found.');
    return rows[0];
  }
}

module.exports = WorkCenter;
