const { pool } = require('../config/database');

class PriceList {
  /**
   * Find applicable unit price for a customer, item, and quantity.
   */
  static async getPrice(customerId, itemId, quantity = 1, fallbackUnitPrice = null) {
    const { rows } = await pool.query(
      `SELECT pli.unit_price
         FROM price_list_items pli
         JOIN price_lists pl ON pli.price_list_id = pl.id
        WHERE pl.is_active = TRUE
          AND (pl.customer_id = $1 OR pl.customer_id IS NULL)
          AND pli.item_id = $2
          AND pli.min_quantity <= $3
        ORDER BY pl.customer_id DESC NULLS LAST, pli.min_quantity DESC
        LIMIT 1`,
      [customerId, itemId, quantity]
    );

    if (rows.length > 0) {
      return Number(rows[0].unit_price);
    }
    return fallbackUnitPrice != null ? Number(fallbackUnitPrice) : 0;
  }
}

module.exports = PriceList;
