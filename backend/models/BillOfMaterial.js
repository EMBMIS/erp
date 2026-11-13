/**
 * Bills of material.
 *
 * A BOM says what an item is made of and in what proportion. The one structural
 * rule enforced here is that the component graph must be acyclic: an item cannot
 * be, directly or transitively, a component of itself. A cycle is not merely
 * invalid data — it makes BOM explosion non-terminating, so it has to be
 * rejected at write time rather than discovered during an MRP run.
 *
 * A table constraint can only catch the trivial self-reference, so the
 * transitive check lives in addComponent().
 */

const { pool } = require('../config/database');

class BillOfMaterial {
  static async create({ item_id, description, output_quantity = 1, unit_of_measure, components = [], effective_from, effective_to }, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const numResult = await client.query('SELECT generate_bom_number() AS n');
      const { rows } = await client.query(
        `INSERT INTO bills_of_material
           (bom_number, item_id, description, output_quantity, unit_of_measure, effective_from, effective_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [numResult.rows[0].n, item_id, description || null, output_quantity,
         unit_of_measure || null, effective_from || null, effective_to || null, userId]
      );
      const bom = rows[0];

      let line = 1;
      for (const c of components) {
        await this.assertNoCycle(client, item_id, c.component_item_id);
        await client.query(
          `INSERT INTO bom_components
             (bom_id, component_item_id, line_number, quantity_per, unit_of_measure, scrap_percent, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [bom.id, c.component_item_id, line++, c.quantity_per,
           c.unit_of_measure || null, c.scrap_percent || 0, c.notes || null]
        );
      }

      await client.query('COMMIT');
      return this.findById(bom.id);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Reject a component edge that would close a cycle.
   *
   * Walks down from the proposed component: if the parent item is reachable,
   * adding this edge would make the item a component of itself. Bounded by a
   * visited set so an existing cycle in legacy data cannot hang the check.
   */
  static async assertNoCycle(client, parentItemId, componentItemId) {
    if (parentItemId === componentItemId) {
      throw new Error('An item cannot be a component of itself.');
    }

    const visited = new Set([componentItemId]);
    const queue = [componentItemId];

    while (queue.length) {
      const current = queue.shift();
      const { rows } = await client.query(
        `SELECT bc.component_item_id
           FROM bills_of_material b
           JOIN bom_components bc ON bc.bom_id = b.id
          WHERE b.item_id = $1 AND b.deleted_at IS NULL AND b.status <> 'OBSOLETE'`,
        [current]
      );
      for (const r of rows) {
        if (r.component_item_id === parentItemId) {
          throw new Error(
            'This component would create a circular bill of material (the item would end up containing itself), which cannot be exploded.'
          );
        }
        if (!visited.has(r.component_item_id)) {
          visited.add(r.component_item_id);
          queue.push(r.component_item_id);
        }
      }
    }
  }

  static async addComponent(bomId, component) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const bom = await client.query('SELECT item_id FROM bills_of_material WHERE id = $1', [bomId]);
      if (!bom.rows.length) throw new Error('Bill of material not found.');

      await this.assertNoCycle(client, bom.rows[0].item_id, component.component_item_id);

      const next = await client.query(
        'SELECT COALESCE(MAX(line_number),0) + 1 AS n FROM bom_components WHERE bom_id = $1', [bomId]
      );
      const { rows } = await client.query(
        `INSERT INTO bom_components
           (bom_id, component_item_id, line_number, quantity_per, unit_of_measure, scrap_percent, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [bomId, component.component_item_id, next.rows[0].n, component.quantity_per,
         component.unit_of_measure || null, component.scrap_percent || 0, component.notes || null]
      );
      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async findById(id) {
    const { rows } = await pool.query(
      `SELECT b.*, i.name AS item_name, i.item_code
         FROM bills_of_material b
         LEFT JOIN items i ON i.id = b.item_id
        WHERE b.id = $1 AND b.deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return null;
    const components = await pool.query(
      `SELECT c.*, i.name AS component_name, i.item_code AS component_code
         FROM bom_components c
         LEFT JOIN items i ON i.id = c.component_item_id
        WHERE c.bom_id = $1 ORDER BY c.line_number`,
      [id]
    );
    return { ...rows[0], components: components.rows };
  }

  static async findAll({ status, item_id } = {}) {
    const params = [];
    let where = 'WHERE b.deleted_at IS NULL';
    if (status) { params.push(status); where += ` AND b.status = $${params.length}`; }
    if (item_id) { params.push(item_id); where += ` AND b.item_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT b.*, i.name AS item_name, i.item_code,
              (SELECT COUNT(*)::int FROM bom_components c WHERE c.bom_id = b.id) AS component_count
         FROM bills_of_material b
         LEFT JOIN items i ON i.id = b.item_id
         ${where}
         ORDER BY b.created_at DESC LIMIT 200`,
      params
    );
    return rows;
  }

  static async activate(id) {
    const { rows } = await pool.query(
      `UPDATE bills_of_material SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id]
    );
    if (!rows.length) throw new Error('Bill of material not found.');
    return rows[0];
  }

  /**
   * Multi-level explosion: total quantity of every raw component needed to build
   * `quantity` of `itemId`. Depth-bounded as a second guard alongside the cycle
   * check, so even corrupt legacy data cannot produce an infinite walk.
   */
  static async explode(itemId, quantity = 1, { maxDepth = 20 } = {}) {
    const totals = new Map();
    const levels = [];

    async function walk(currentItem, qty, depth, path) {
      if (depth > maxDepth) {
        throw new Error(`Bill of material nests deeper than ${maxDepth} levels — this usually means a circular reference.`);
      }
      const { rows } = await pool.query(
        `SELECT b.id, b.output_quantity, bc.component_item_id, bc.quantity_per, bc.scrap_percent,
                i.name AS component_name, i.item_code
           FROM bills_of_material b
           JOIN bom_components bc ON bc.bom_id = b.id
           LEFT JOIN items i ON i.id = bc.component_item_id
          WHERE b.item_id = $1 AND b.status = 'ACTIVE' AND b.deleted_at IS NULL`,
        [currentItem]
      );

      if (!rows.length) return; // a purchased part — nothing to explode

      const scale = qty / Number(rows[0].output_quantity);
      for (const r of rows) {
        if (path.includes(r.component_item_id)) {
          throw new Error('Circular bill of material detected during explosion.');
        }
        const required = Number(r.quantity_per) * scale * (1 + Number(r.scrap_percent) / 100);
        totals.set(r.component_item_id, (totals.get(r.component_item_id) || 0) + required);
        levels.push({
          level: depth,
          item_id: r.component_item_id,
          item_name: r.component_name,
          item_code: r.item_code,
          quantity: Number(required.toFixed(4)),
        });
        await walk(r.component_item_id, required, depth + 1, [...path, r.component_item_id]);
      }
    }

    await walk(itemId, Number(quantity), 1, [itemId]);

    return {
      item_id: itemId,
      quantity: Number(quantity),
      total_requirements: [...totals.entries()].map(([id, qty]) => ({ item_id: id, quantity: Number(qty.toFixed(4)) })),
      by_level: levels,
    };
  }
}

module.exports = BillOfMaterial;
