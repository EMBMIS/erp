const { pool } = require('../config/database');

class Shipment {
  /**
   * Create a new shipment and packing list for a sales order.
   */
  static async create({ salesOrderId, carrierName, trackingNumber, items = [] }, userId) {
    const shipmentNumber = `SHP-${Date.now().toString().slice(-6)}`;

    const { rows: shipments } = await pool.query(
      `INSERT INTO shipments (shipment_number, sales_order_id, carrier_name, tracking_number, shipping_status, ship_date)
       VALUES ($1, $2, $3, $4, 'PREPARING', CURRENT_DATE)
       RETURNING *`,
      [shipmentNumber, salesOrderId, carrierName, trackingNumber]
    );

    const shipment = shipments[0];

    for (const item of items) {
      await pool.query(
        `INSERT INTO packing_lists (shipment_id, item_id, quantity_packed, box_number)
         VALUES ($1, $2, $3, $4)`,
        [shipment.id, item.item_id, item.quantity_packed, item.box_number || 1]
      );
    }

    return shipment;
  }

  /**
   * Mark shipment as delivered with proof of delivery.
   */
  static async markDelivered(id, proofOfDelivery) {
    const { rows } = await pool.query(
      `UPDATE shipments
          SET shipping_status = 'DELIVERED',
              delivery_date = CURRENT_DATE,
              proof_of_delivery = $1,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *`,
      [proofOfDelivery, id]
    );

    return rows[0];
  }
}

module.exports = Shipment;
