const { pool } = require('../config/database');

class UOMService {
  /**
   * Convert a quantity from one UoM to another for a specific item.
   * If no specific conversion is found, returns quantity as-is if from_uom === to_uom.
   */
  static async convertQuantity(itemId, quantity, fromUom, toUom) {
    if (!fromUom || !toUom || fromUom.toLowerCase() === toUom.toLowerCase()) {
      return Number(quantity);
    }

    const { rows } = await pool.query(
      `SELECT conversion_factor
         FROM uom_conversions
        WHERE (item_id = $1 OR item_id IS NULL)
          AND LOWER(from_uom) = LOWER($2)
          AND LOWER(to_uom) = LOWER($3)
        ORDER BY item_id DESC NULLS LAST
        LIMIT 1`,
      [itemId, fromUom, toUom]
    );

    if (rows.length > 0) {
      return Number(quantity) * Number(rows[0].conversion_factor);
    }

    // Check inverse conversion
    const { rows: invRows } = await pool.query(
      `SELECT conversion_factor
         FROM uom_conversions
        WHERE (item_id = $1 OR item_id IS NULL)
          AND LOWER(from_uom) = LOWER($3)
          AND LOWER(to_uom) = LOWER($2)
        ORDER BY item_id DESC NULLS LAST
        LIMIT 1`,
      [itemId, fromUom, toUom]
    );

    if (invRows.length > 0) {
      return Number(quantity) / Number(invRows[0].conversion_factor);
    }

    // Default fallback if unmapped
    return Number(quantity);
  }
}

module.exports = UOMService;
