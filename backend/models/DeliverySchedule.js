const { pool } = require('../config/database');

// Statuses from which scheduling a delivery is a meaningful forward step.
// Mirrors stateMachine.js's SALES_ORDER transition map: each of these is a
// legal predecessor of READY_FOR_DELIVERY. Anything past that point (SHIPPED,
// DELIVERED, WAITING_CUSTOMER_DELIVERY_CONFIRMATION, COMPLETED, CANCELLED) is
// left alone so this never tries an illegal backward transition.
const SO_STATUSES_ADVANCED_BY_SCHEDULING = ['CONFIRMED', 'CUSTOMER_ACCEPTED', 'IN_PRODUCTION', 'IN_PROGRESS', 'GOODS_ISSUED'];

class DeliverySchedule {
  // Creating a delivery schedule (SCHEDULED) is itself an operation on the sales
  // order — fulfillment work has started — so the SO status should reflect that
  // instead of sitting at CONFIRMED until someone later marks the schedule
  // READY_TO_SHIP/IN_TRANSIT (see the sibling advance in routes/delivery-schedules.js
  // and DeliverySchedule.updateStatus). Runs after commit, on a fresh connection,
  // and is deliberately non-fatal: a sales order in some other state (e.g. a
  // second delivery schedule created after the first already advanced it, or
  // an order that moved on its own) is not an error, just nothing to do here.
  static async advanceSalesOrderOnScheduling(salesOrderId, userId) {
    if (!salesOrderId) return;
    try {
      const { rows } = await pool.query(
        'SELECT status FROM sales_orders WHERE id = $1 AND deleted_at IS NULL',
        [salesOrderId]
      );
      const currentStatus = rows[0]?.status;
      if (currentStatus && SO_STATUSES_ADVANCED_BY_SCHEDULING.includes(currentStatus)) {
        const SalesOrder = require('./SalesOrder');
        await SalesOrder.updateStatus(
          salesOrderId,
          'READY_FOR_DELIVERY',
          userId,
          'Delivery scheduled: fulfillment in progress'
        );
      }
    } catch (error) {
      console.error(`DeliverySchedule: could not advance sales order ${salesOrderId} status after scheduling:`, error.message);
    }
  }

  static async findAll(filters = {}) {
    try {
      let query = `
        SELECT 
          ds.*,
          so.so_number,
          c.customer_name,
          c.primary_email as customer_email,
          c.phone as customer_phone,
          u.first_name || ' ' || u.last_name as created_by_name,
          COUNT(di.id) as item_count,
          SUM(di.ordered_quantity) as total_ordered_quantity,
          SUM(di.delivered_quantity) as total_delivered_quantity,
          SUM(di.remaining_quantity) as total_remaining_quantity
        FROM delivery_schedules ds
        LEFT JOIN sales_orders so ON ds.sales_order_id = so.id
        LEFT JOIN customers c ON ds.customer_id = c.id
        LEFT JOIN users u ON ds.created_by = u.id
        LEFT JOIN delivery_items di ON ds.id = di.delivery_schedule_id
        WHERE ds.deleted_at IS NULL
      `;
      
      const conditions = [];
      const values = [];

      if (filters.search) {
        conditions.push(`(
          ds.schedule_number ILIKE $${values.length + 1} OR
          ds.customer_name ILIKE $${values.length + 1} OR
          ds.tracking_number ILIKE $${values.length + 1} OR
          so.so_number ILIKE $${values.length + 1}
        )`);
        values.push(`%${filters.search}%`);
      }

      if (filters.status) {
        conditions.push(`ds.status = $${values.length + 1}`);
        values.push(filters.status);
      }

      if (filters.customer_id) {
        conditions.push(`ds.customer_id = $${values.length + 1}`);
        values.push(filters.customer_id);
      }

      if (filters.sales_order_id) {
        conditions.push(`ds.sales_order_id = $${values.length + 1}`);
        values.push(filters.sales_order_id);
      }

      if (filters.priority) {
        conditions.push(`ds.priority = $${values.length + 1}`);
        values.push(filters.priority);
      }

      if (filters.delivery_date_from) {
        conditions.push(`ds.delivery_date >= $${values.length + 1}`);
        values.push(filters.delivery_date_from);
      }

      if (filters.delivery_date_to) {
        conditions.push(`ds.delivery_date <= $${values.length + 1}`);
        values.push(filters.delivery_date_to);
      }

      if (filters.driver_name) {
        conditions.push(`ds.driver_name ILIKE $${values.length + 1}`);
        values.push(`%${filters.driver_name}%`);
      }

      if (conditions.length > 0) {
        query += ' AND ' + conditions.join(' AND ');
      }

      query += `
        GROUP BY ds.id, so.so_number, c.customer_name, c.primary_email, c.phone, u.first_name, u.last_name
        ORDER BY ds.delivery_date DESC, ds.created_at DESC
      `;

      if (filters.limit) {
        query += ` LIMIT $${values.length + 1}`;
        values.push(filters.limit);
      }

      if (filters.offset) {
        query += ` OFFSET $${values.length + 1}`;
        values.push(filters.offset);
      }

      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      console.error('Error in DeliverySchedule.findAll:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      const query = `
        SELECT 
          ds.*,
          so.so_number,
          so.total_amount as order_total,
          c.customer_name,
          c.primary_email as customer_email,
          c.phone as customer_phone,
          c.billing_address_line1,
          c.billing_city,
          c.billing_country,
          u.first_name || ' ' || u.last_name as created_by_name
        FROM delivery_schedules ds
        LEFT JOIN sales_orders so ON ds.sales_order_id = so.id
        LEFT JOIN customers c ON ds.customer_id = c.id
        LEFT JOIN users u ON ds.created_by = u.id
        WHERE ds.id = $1 AND ds.deleted_at IS NULL
      `;
      
      const result = await pool.query(query, [id]);
      
      if (result.rows.length === 0) {
        return null;
      }

      const schedule = result.rows[0];

      // Get delivery items
      const itemsQuery = `
        SELECT 
          di.*,
          soi.unit_price,
          soi.line_total
        FROM delivery_items di
        LEFT JOIN sales_order_items soi ON di.sales_order_item_id = soi.id
        WHERE di.delivery_schedule_id = $1
        ORDER BY di.id
      `;
      
      const itemsResult = await pool.query(itemsQuery, [id]);
      schedule.items = itemsResult.rows;

      return schedule;
    } catch (error) {
      console.error('Error in DeliverySchedule.findById:', error);
      throw error;
    }
  }

  static async create(scheduleData, userId) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Generate schedule number
      const scheduleNumber = await this.generateScheduleNumber(client);

      // Derive the sales order number from the linked sales order when the
      // caller did not supply one. delivery_schedules.sales_order_number is
      // NOT NULL and downstream O2C delivery steps read it to reference the
      // order, so a missing value breaks the flow
      // (ERP_PRODUCT_EVALUATION: "sales_order_number never set → no O2C delivery").
      let salesOrderNumber = scheduleData.sales_order_number;
      if (!salesOrderNumber && scheduleData.sales_order_id) {
        const soNumberResult = await client.query(
          'SELECT so_number FROM sales_orders WHERE id = $1',
          [scheduleData.sales_order_id]
        );
        if (soNumberResult.rows.length > 0) {
          salesOrderNumber = soNumberResult.rows[0].so_number;
        }
      }

      // Insert delivery schedule
      const dsQuery = `
        INSERT INTO delivery_schedules (
          schedule_number, sales_order_id, sales_order_number, customer_id, customer_name,
          delivery_date, delivery_time_from, delivery_time_to, delivery_address, delivery_instructions,
          shipping_method, contact_person, contact_phone, contact_email, priority,
          driver_name, vehicle_number, tracking_number, estimated_delivery_time,
          notes, internal_notes, special_instructions, created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, $23, $23
        ) RETURNING *
      `;

      const dsValues = [
        scheduleNumber,
        scheduleData.sales_order_id,
        salesOrderNumber,
        scheduleData.customer_id,
        scheduleData.customer_name,
        scheduleData.delivery_date,
        scheduleData.delivery_time_from,
        scheduleData.delivery_time_to,
        scheduleData.delivery_address,
        scheduleData.delivery_instructions,
        scheduleData.shipping_method,
        scheduleData.contact_person,
        scheduleData.contact_phone,
        scheduleData.contact_email,
        scheduleData.priority || 'NORMAL',
        scheduleData.driver_name,
        scheduleData.vehicle_number,
        scheduleData.tracking_number,
        scheduleData.estimated_delivery_time,
        scheduleData.notes,
        scheduleData.internal_notes,
        scheduleData.special_instructions,
        userId
      ];

      const dsResult = await client.query(dsQuery, dsValues);
      const schedule = dsResult.rows[0];

      // Insert delivery items
      if (scheduleData.items && scheduleData.items.length > 0) {
        for (const item of scheduleData.items) {
          const itemQuery = `
            INSERT INTO delivery_items (
              delivery_schedule_id, sales_order_item_id, item_code, item_name, item_description,
              ordered_quantity, delivered_quantity, remaining_quantity, unit_of_measure,
              package_type, package_count, weight_kg, dimensions_cm, notes
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
            )
          `;

          const itemValues = [
            schedule.id,
            item.sales_order_item_id,
            item.item_code,
            item.item_name,
            item.item_description,
            item.ordered_quantity,
            item.delivered_quantity || 0,
            item.remaining_quantity || item.ordered_quantity,
            item.unit_of_measure,
            item.package_type,
            item.package_count || 1,
            item.weight_kg,
            item.dimensions_cm,
            item.notes
          ];

          await client.query(itemQuery, itemValues);
        }
      }

      // Add status history
      await this.addStatusHistory(client, schedule.id, null, 'SCHEDULED', userId, 'Delivery scheduled');

      await client.query('COMMIT');

      await this.advanceSalesOrderOnScheduling(scheduleData.sales_order_id, userId);

      return await this.findById(schedule.id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in DeliverySchedule.create:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async update(id, scheduleData, userId) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Check if schedule exists and can be updated
      const existingResult = await client.query(
        'SELECT status FROM delivery_schedules WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );

      if (existingResult.rows.length === 0) {
        throw new Error('Delivery schedule not found');
      }

      const currentStatus = existingResult.rows[0].status;
      if (['DELIVERED', 'CANCELLED'].includes(currentStatus)) {
        throw new Error('Cannot update delivery schedule that is already delivered or cancelled');
      }

      // Update schedule
      const updateQuery = `
        UPDATE delivery_schedules SET
          sales_order_id = COALESCE($2, sales_order_id),
          sales_order_number = COALESCE($3, sales_order_number),
          customer_id = COALESCE($4, customer_id),
          customer_name = COALESCE($5, customer_name),
          delivery_date = COALESCE($6, delivery_date),
          delivery_time_from = COALESCE($7, delivery_time_from),
          delivery_time_to = COALESCE($8, delivery_time_to),
          delivery_address = COALESCE($9, delivery_address),
          delivery_instructions = COALESCE($10, delivery_instructions),
          shipping_method = COALESCE($11, shipping_method),
          contact_person = COALESCE($12, contact_person),
          contact_phone = COALESCE($13, contact_phone),
          contact_email = COALESCE($14, contact_email),
          priority = COALESCE($15, priority),
          driver_name = COALESCE($16, driver_name),
          vehicle_number = COALESCE($17, vehicle_number),
          tracking_number = COALESCE($18, tracking_number),
          estimated_delivery_time = COALESCE($19, estimated_delivery_time),
          notes = COALESCE($20, notes),
          internal_notes = COALESCE($21, internal_notes),
          special_instructions = COALESCE($22, special_instructions),
          updated_by = $23
        WHERE id = $1 AND deleted_at IS NULL
      `;

      const updateValues = [
        id,
        scheduleData.sales_order_id,
        scheduleData.sales_order_number,
        scheduleData.customer_id,
        scheduleData.customer_name,
        scheduleData.delivery_date,
        scheduleData.delivery_time_from,
        scheduleData.delivery_time_to,
        scheduleData.delivery_address,
        scheduleData.delivery_instructions,
        scheduleData.shipping_method,
        scheduleData.contact_person,
        scheduleData.contact_phone,
        scheduleData.contact_email,
        scheduleData.priority,
        scheduleData.driver_name,
        scheduleData.vehicle_number,
        scheduleData.tracking_number,
        scheduleData.estimated_delivery_time,
        scheduleData.notes,
        scheduleData.internal_notes,
        scheduleData.special_instructions,
        userId
      ];

      await client.query(updateQuery, updateValues);

      // Update items if provided
      if (scheduleData.items) {
        // Delete existing items
        await client.query('DELETE FROM delivery_items WHERE delivery_schedule_id = $1', [id]);

        // Insert new items
        for (const item of scheduleData.items) {
          const itemQuery = `
            INSERT INTO delivery_items (
              delivery_schedule_id, sales_order_item_id, item_code, item_name, item_description,
              ordered_quantity, delivered_quantity, remaining_quantity, unit_of_measure,
              package_type, package_count, weight_kg, dimensions_cm, notes
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
            )
          `;

          const itemValues = [
            id,
            item.sales_order_item_id,
            item.item_code,
            item.item_name,
            item.item_description,
            item.ordered_quantity,
            item.delivered_quantity || 0,
            item.remaining_quantity || item.ordered_quantity,
            item.unit_of_measure,
            item.package_type,
            item.package_count || 1,
            item.weight_kg,
            item.dimensions_cm,
            item.notes
          ];

          await client.query(itemQuery, itemValues);
        }
      }

      await client.query('COMMIT');
      
      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in DeliverySchedule.update:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Has every sales_order_item's ordered quantity actually been shipped?
  //
  // "No delivery schedule left outstanding" (the pre-existing auto-advance
  // check) is NOT the same thing: a short-shipped or partially-quantitied
  // delivery schedule (the UI lets a user schedule fewer units than were
  // ordered — routes/sales.../DeliveryScheduling.jsx's "deliver quantity"
  // field) can be marked DELIVERED on its own, with no second schedule ever
  // created for the remainder. Without this check, that reads as "nothing
  // outstanding" and the sales order auto-advances toward COMPLETED, which
  // raises a customer invoice for the FULL order total even though only part
  // of it was ever shipped — an invoice that no longer ties out to what was
  // actually delivered.
  static async isFullyShipped(salesOrderId, client = pool) {
    const { rows } = await client.query(
      `SELECT soi.id, soi.quantity AS ordered,
              COALESCE(SUM(di.ordered_quantity) FILTER (
                WHERE ds.status = 'DELIVERED' AND ds.deleted_at IS NULL
              ), 0) AS shipped
         FROM sales_order_items soi
         LEFT JOIN delivery_items di ON di.sales_order_item_id = soi.id
         LEFT JOIN delivery_schedules ds ON ds.id = di.delivery_schedule_id
        WHERE soi.sales_order_id = $1
        GROUP BY soi.id, soi.quantity`,
      [salesOrderId]
    );
    // An order with no items at all has nothing to ship; don't block it.
    return rows.every((r) => Number(r.shipped) + 1e-6 >= Number(r.ordered));
  }

  static async updateStatus(id, newStatus, userId, reason = '', location = null) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get current status
      const currentResult = await client.query(
        'SELECT status FROM delivery_schedules WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );

      if (currentResult.rows.length === 0) {
        throw new Error('Delivery schedule not found');
      }

      const currentStatus = currentResult.rows[0].status;

      // Update status and timestamps
      let updateQuery = 'UPDATE delivery_schedules SET status = $2, updated_by = $3, updated_at = CURRENT_TIMESTAMP';
      let updateValues = [id, newStatus, userId];

      if (newStatus === 'DELIVERED') {
        updateQuery += ', actual_delivery_time = CURRENT_TIMESTAMP';
      }

      updateQuery += ' WHERE id = $1';

      await client.query(updateQuery, updateValues);

      // Add status history
      await this.addStatusHistory(client, id, currentStatus, newStatus, userId, reason, location);

      // Look up the linked sales order (if any) while still in the transaction,
      // so we know whether to auto-complete it once committed.
      let salesOrderId = null;
      if (newStatus === 'DELIVERED') {
        const soRow = await client.query('SELECT sales_order_id FROM delivery_schedules WHERE id = $1', [id]);
        salesOrderId = soRow.rows[0]?.sales_order_id || null;
      }

      await client.query('COMMIT');

      // Auto-invoice on delivery confirmation (ERP-Roadmap P1 #4): once EVERY
      // delivery schedule for this sales order has been confirmed DELIVERED
      // (handles partial/multi-shipment orders correctly — an order isn't done
      // until all its shipments have arrived), advance the sales order. Runs
      // after commit, on a fresh connection, matching the pattern used elsewhere
      // for cross-model auto-completion.
      //
      // It advances by ONE step, never straight to COMPLETED: the warehouse
      // saying "delivered" is not the customer saying "received". The route
      // (routes/delivery-schedules.js) and the customer portal
      // (routes/customers.js delivery-confirmation) both model that as
      // ... -> WAITING_CUSTOMER_DELIVERY_CONFIRMATION -> COMPLETED, and COMPLETED
      // is what raises the customer invoice and posts revenue. Jumping the queue
      // here both invoiced a customer who had not confirmed receipt and tried an
      // illegal CONFIRMED -> COMPLETED transition, which 500'd the whole request.
      if (salesOrderId) {
        const outstanding = await pool.query(
          `SELECT COUNT(*)::int AS n FROM delivery_schedules
           WHERE sales_order_id = $1 AND deleted_at IS NULL AND status NOT IN ('DELIVERED', 'CANCELLED')`,
          [salesOrderId]
        );
        if (outstanding.rows[0].n === 0 && (await this.isFullyShipped(salesOrderId))) {
          const SalesOrder = require('./SalesOrder');
          const so = await pool.query('SELECT status FROM sales_orders WHERE id = $1 AND deleted_at IS NULL', [salesOrderId]);
          const soStatus = so.rows[0]?.status;
          if (soStatus === 'WAITING_CUSTOMER_DELIVERY_CONFIRMATION') {
            await SalesOrder.updateStatus(salesOrderId, 'COMPLETED', userId, 'Auto-completed: all deliveries confirmed');
          } else if (soStatus && soStatus !== 'COMPLETED' && soStatus !== 'CANCELLED') {
            await SalesOrder.updateStatus(
              salesOrderId,
              'WAITING_CUSTOMER_DELIVERY_CONFIRMATION',
              userId,
              'All deliveries dispatched: awaiting customer delivery confirmation'
            );
          }
        }
      }

      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in DeliverySchedule.updateStatus:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async delete(id, userId) {
    try {
      const result = await pool.query(
        `UPDATE delivery_schedules 
         SET deleted_at = CURRENT_TIMESTAMP, updated_by = $2 
         WHERE id = $1 AND deleted_at IS NULL 
         RETURNING *`,
        [id, userId]
      );

      if (result.rows.length === 0) {
        throw new Error('Delivery schedule not found or already deleted');
      }

      return result.rows[0];
    } catch (error) {
      console.error('Error in DeliverySchedule.delete:', error);
      throw error;
    }
  }

  static async getStats() {
    try {
      const query = `
        SELECT 
          COUNT(*) as total_deliveries,
          COUNT(CASE WHEN status = 'SCHEDULED' THEN 1 END) as scheduled_deliveries,
          COUNT(CASE WHEN status = 'IN_TRANSIT' THEN 1 END) as in_transit_deliveries,
          COUNT(CASE WHEN status = 'DELIVERED' THEN 1 END) as delivered_deliveries,
          COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled_deliveries,
          COUNT(CASE WHEN status = 'FAILED' THEN 1 END) as failed_deliveries,
          COUNT(CASE WHEN delivery_date = CURRENT_DATE THEN 1 END) as today_deliveries,
          COUNT(CASE WHEN delivery_date < CURRENT_DATE AND status NOT IN ('DELIVERED', 'CANCELLED', 'FAILED') THEN 1 END) as overdue_deliveries,
          ROUND(
            COUNT(CASE WHEN status = 'DELIVERED' THEN 1 END) * 100.0 / 
            NULLIF(COUNT(CASE WHEN status IN ('DELIVERED', 'CANCELLED', 'FAILED') THEN 1 END), 0), 2
          ) as delivery_success_rate
        FROM delivery_schedules 
        WHERE deleted_at IS NULL
      `;
      
      const result = await pool.query(query);
      return result.rows[0];
    } catch (error) {
      console.error('Error in DeliverySchedule.getStats:', error);
      throw error;
    }
  }

  static async generateScheduleNumber(client = pool) {
    try {
      const year = new Date().getFullYear();
      const prefix = `DL${year}`;
      
      const result = await client.query(
        `SELECT schedule_number FROM delivery_schedules 
         WHERE schedule_number LIKE $1 
         ORDER BY schedule_number DESC LIMIT 1`,
        [`${prefix}%`]
      );

      let nextNumber = 1;
      if (result.rows.length > 0) {
        const lastNumber = result.rows[0].schedule_number.replace(prefix, '');
        nextNumber = parseInt(lastNumber) + 1;
      }

      return `${prefix}${nextNumber.toString().padStart(6, '0')}`;
    } catch (error) {
      console.error('Error generating schedule number:', error);
      throw error;
    }
  }

  static async addStatusHistory(client, scheduleId, fromStatus, toStatus, userId, reason, location = null) {
    const query = `
      INSERT INTO delivery_status_history 
      (delivery_schedule_id, from_status, to_status, changed_by, reason, location)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    
    await client.query(query, [scheduleId, fromStatus, toStatus, userId, reason, location]);
  }

  static async getStatusHistory(scheduleId) {
    try {
      const query = `
        SELECT 
          dsh.*,
          u.first_name || ' ' || u.last_name as changed_by_name
        FROM delivery_status_history dsh
        LEFT JOIN users u ON dsh.changed_by = u.id
        WHERE dsh.delivery_schedule_id = $1
        ORDER BY dsh.status_date ASC
      `;
      
      const result = await pool.query(query, [scheduleId]);
      return result.rows;
    } catch (error) {
      console.error('Error in DeliverySchedule.getStatusHistory:', error);
      throw error;
    }
  }

  static async createFromSalesOrder(salesOrderId, userId) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get sales order details
      const soQuery = `
        SELECT 
          so.*,
          c.customer_name,
          c.primary_email as customer_email,
          c.phone as customer_phone
        FROM sales_orders so
        LEFT JOIN customers c ON so.customer_id = c.id
        WHERE so.id = $1
      `;
      
      const soResult = await client.query(soQuery, [salesOrderId]);
      
      if (soResult.rows.length === 0) {
        throw new Error('Sales order not found');
      }

      const salesOrder = soResult.rows[0];

      // delivery_schedules.delivery_address is NOT NULL, but a quotation-created
      // sales order carries no delivery_address of its own. Derive one from the
      // customer's shipping address (billing when the customer uses that), so a
      // schedule can always be created from an order (O2C blocker #2: the flow
      // previously died with "null value in column delivery_address").
      let deliveryAddress = salesOrder.delivery_address;
      if (!deliveryAddress) {
        const custAddr = await client.query(
          `SELECT shipping_address_line1, shipping_address_line2, shipping_city,
                  shipping_state, shipping_country, shipping_postal_code,
                  billing_address_line1, billing_address_line2, billing_city,
                  billing_state, billing_country, billing_postal_code,
                  use_billing_as_shipping
             FROM customers WHERE id = $1`,
          [salesOrder.customer_id]
        );
        const a = custAddr.rows[0] || {};
        const useBilling = a.use_billing_as_shipping || !a.shipping_address_line1;
        const line1 = useBilling ? a.billing_address_line1 : a.shipping_address_line1;
        const line2 = useBilling ? a.billing_address_line2 : a.shipping_address_line2;
        const city = useBilling ? a.billing_city : a.shipping_city;
        const state = useBilling ? a.billing_state : a.shipping_state;
        const country = useBilling ? a.billing_country : a.shipping_country;
        const zip = useBilling ? a.billing_postal_code : a.shipping_postal_code;
        deliveryAddress = [line1, line2, city, state, zip, country]
          .filter(Boolean)
          .join(', ') || 'Address on file';
      }
      const itemsQuery = `
        SELECT * FROM sales_order_items 
        WHERE sales_order_id = $1 
        ORDER BY id
      `;
      
      const itemsResult = await client.query(itemsQuery, [salesOrderId]);

      // Create delivery schedule
      const scheduleData = {
        sales_order_id: salesOrder.id,
        sales_order_number: salesOrder.so_number,
        customer_id: salesOrder.customer_id,
        customer_name: salesOrder.customer_name,
        delivery_date: salesOrder.delivery_date || new Date(),
        delivery_address: deliveryAddress,
        delivery_instructions: salesOrder.delivery_instructions,
        shipping_method: salesOrder.shipping_method,
        contact_person: salesOrder.customer_name,
        contact_email: salesOrder.customer_email,
        contact_phone: salesOrder.customer_phone,
        priority: salesOrder.priority,
        notes: salesOrder.notes,
        items: itemsResult.rows.map(item => ({
          sales_order_item_id: item.id,
          item_code: item.item_code,
          item_name: item.item_name,
          item_description: item.item_description,
          ordered_quantity: item.quantity,
          remaining_quantity: item.quantity,
          unit_of_measure: item.unit_of_measure
        }))
      };

      const delivery = await this.create(scheduleData, userId);

      await client.query('COMMIT');
      
      return delivery;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in DeliverySchedule.createFromSalesOrder:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Create hybrid delivery schedule with automatic PO creation
  static async createHybridDeliveryWithAutoPO(salesOrderId, deliveryPlan, userId) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get sales order details
      const soQuery = `
        SELECT
          so.*,
          c.customer_name,
          c.primary_email as customer_email,
          c.phone as customer_phone,
          c.shipping_address_line1, c.shipping_address_line2,
          c.shipping_city, c.shipping_state, c.shipping_postal_code, c.shipping_country
        FROM sales_orders so
        LEFT JOIN customers c ON so.customer_id = c.id
        WHERE so.id = $1
      `;

      const soResult = await client.query(soQuery, [salesOrderId]);

      if (soResult.rows.length === 0) {
        throw new Error('Sales order not found');
      }

      const salesOrder = soResult.rows[0];
      const customerAddress = [
        salesOrder.shipping_address_line1, salesOrder.shipping_address_line2,
        salesOrder.shipping_city, salesOrder.shipping_state,
        salesOrder.shipping_postal_code, salesOrder.shipping_country
      ].filter(Boolean).join(', ') || null;

      const resolvedDeliveryAddress = deliveryPlan.delivery_address || salesOrder.delivery_address || customerAddress;
      if (!resolvedDeliveryAddress) {
        const err = new Error('Delivery address is required — add one to the sales order or the customer record before scheduling a delivery');
        err.statusCode = 400;
        throw err;
      }

      // Determine fulfillment type based on delivery plan
      const fulfillmentType = this.determineFulfillmentType(deliveryPlan.items);
      
      // Generate schedule number
      const scheduleNumber = await this.generateScheduleNumber(client);

      // Create delivery schedule
      const dsQuery = `
        INSERT INTO delivery_schedules (
          schedule_number, sales_order_id, sales_order_number, customer_id, customer_name,
          delivery_date, delivery_time_from, delivery_time_to, delivery_address, delivery_instructions,
          shipping_method, contact_person, contact_phone, contact_email, priority,
          notes, internal_notes, fulfillment_type, workflow_status, created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $20
        ) RETURNING *
      `;

      const dsValues = [
        scheduleNumber,
        salesOrder.id,
        salesOrder.so_number,
        salesOrder.customer_id,
        salesOrder.customer_name || deliveryPlan.customer_name,
        deliveryPlan.delivery_date || salesOrder.delivery_date,
        deliveryPlan.delivery_time_from,
        deliveryPlan.delivery_time_to,
        resolvedDeliveryAddress,
        deliveryPlan.delivery_instructions || salesOrder.delivery_instructions,
        deliveryPlan.shipping_method || salesOrder.shipping_method,
        deliveryPlan.contact_person || salesOrder.customer_name,
        deliveryPlan.contact_phone,
        deliveryPlan.contact_email,
        deliveryPlan.priority || salesOrder.priority || 'NORMAL',
        deliveryPlan.notes || salesOrder.notes,
        deliveryPlan.internal_notes,
        fulfillmentType,
        'PLANNING',
        userId
      ];

      const dsResult = await client.query(dsQuery, dsValues);
      const schedule = dsResult.rows[0];

      // Create delivery items with fulfillment methods
      const autoPosBySupplier = new Map();
      
      for (const item of deliveryPlan.items) {
        const itemQuery = `
          INSERT INTO delivery_items (
            delivery_schedule_id, sales_order_item_id, item_code, item_name, item_description,
            ordered_quantity, delivered_quantity, remaining_quantity, unit_of_measure,
            fulfillment_method, supplier_id, inventory_reserved_quantity, dropship_quantity, notes
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
          ) RETURNING *
        `;

        const itemValues = [
          schedule.id,
          item.sales_order_item_id,
          item.item_code,
          item.item_name,
          item.item_description,
          item.ordered_quantity,
          0, // delivered_quantity
          item.ordered_quantity, // remaining_quantity
          item.unit_of_measure,
          item.fulfillment_method || 'INVENTORY',
          item.supplier_id || null,
          item.inventory_reserved_quantity || 0,
          item.dropship_quantity || 0,
          item.notes || null
        ];

        const itemResult = await client.query(itemQuery, itemValues);
        const deliveryItem = itemResult.rows[0];

        // If this item needs dropshipping, track supplier for auto PO creation
        if (item.fulfillment_method === 'DROPSHIP' && item.supplier_id) {
          if (!autoPosBySupplier.has(item.supplier_id)) {
            autoPosBySupplier.set(item.supplier_id, []);
          }
          autoPosBySupplier.get(item.supplier_id).push({
            ...deliveryItem,
            ...item
          });
        }
      }

      // Create automatic purchase orders for dropship items
      const createdPOs = [];
      for (const [supplierId, items] of autoPosBySupplier) {
        try {
          const po = await this.createAutomaticPurchaseOrder(
            client, 
            salesOrder, 
            schedule, 
            supplierId, 
            items, 
            userId
          );
          createdPOs.push(po);
        } catch (error) {
          console.error(`Error creating auto PO for supplier ${supplierId}:`, error);
          // Continue with other suppliers, log but don't fail the entire process
        }
      }

      // Update workflow status based on what was created
      let newWorkflowStatus = 'PLANNING';
      if (createdPOs.length > 0 && fulfillmentType !== 'INVENTORY') {
        newWorkflowStatus = 'PO_CREATED';
      } else if (fulfillmentType === 'INVENTORY') {
        newWorkflowStatus = 'INVENTORY_RESERVED';
      }

      await client.query(
        'UPDATE delivery_schedules SET workflow_status = $2 WHERE id = $1',
        [schedule.id, newWorkflowStatus]
      );

      // Add status history
      await this.addStatusHistory(client, schedule.id, null, 'SCHEDULED', userId, 'Hybrid delivery scheduled with auto PO creation');

      await client.query('COMMIT');

      await this.advanceSalesOrderOnScheduling(salesOrder.id, userId);

      const result = await this.findById(schedule.id);
      result.created_purchase_orders = createdPOs;

      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in DeliverySchedule.createHybridDeliveryWithAutoPO:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Determine fulfillment type based on items
  static determineFulfillmentType(items) {
    const hasInventory = items.some(item => item.fulfillment_method === 'INVENTORY');
    const hasDropship = items.some(item => item.fulfillment_method === 'DROPSHIP');
    
    if (hasInventory && hasDropship) return 'HYBRID';
    if (hasDropship) return 'DROPSHIP';
    return 'INVENTORY';
  }

  // Create automatic purchase order for dropship items
  static async createAutomaticPurchaseOrder(client, salesOrder, deliverySchedule, supplierId, items, userId) {
    // Get supplier details
    const supplierQuery = `
      SELECT * FROM suppliers WHERE id = $1 AND status = 'ACTIVE'
    `;
    const supplierResult = await client.query(supplierQuery, [supplierId]);
    
    if (supplierResult.rows.length === 0) {
      throw new Error(`Active supplier not found: ${supplierId}`);
    }
    
    const supplier = supplierResult.rows[0];

    // Create PO
    const PurchaseOrder = require('./PurchaseOrder');
    
    // Calculate PO totals
    let subtotal = 0;
    const poItems = items.map(item => {
      const lineTotal = (item.dropship_quantity || item.ordered_quantity) * (item.unit_price || 0);
      subtotal += lineTotal;
      
      return {
        item_id: item.item_id,
        item_description: item.item_description || item.item_name || 'Dropship item',
        quantity: item.dropship_quantity || item.ordered_quantity,
        unit_of_measure: item.unit_of_measure,
        unit_price: item.unit_price || 0,
        line_total: lineTotal,
        requested_delivery_date: deliverySchedule.delivery_date,
      };
    });

    // purchase_orders has no supplier_name/email/contact/phone,
    // shipping_method, priority, discount_amount, or notes columns — a
    // supplier snapshot isn't stored anywhere in this schema, every other PO
    // creation path (PurchaseOrder.create) just joins to `suppliers` for that
    // data, so this follows the same pattern instead of inventing new
    // columns. The dropship instructions, which have no column to live in,
    // are folded into delivery_address (the one free-text field that
    // survives) so the information isn't silently lost.
    const poData = {
      supplier_id: supplierId,
      delivery_date: deliverySchedule.delivery_date,
      delivery_address: `DROPSHIP DIRECTLY TO CUSTOMER: ${deliverySchedule.customer_name}\n${deliverySchedule.delivery_instructions || ''}\n\n${deliverySchedule.delivery_address || ''}`.trim(),
      payment_terms: supplier.payment_terms || 'Net 30',
      currency: salesOrder.currency || 'USD',
      subtotal: subtotal,
      tax_amount: 0, // Will be calculated by supplier
      total_amount: subtotal,
      source_type: 'DROPSHIP',
      sales_order_id: salesOrder.id,
      items: poItems
    };

    // Use a transaction-aware version of PO creation
    const po = await this.createPurchaseOrderInTransaction(client, poData, userId);

    // Record the auto PO creation
    const autoPoQuery = `
      INSERT INTO auto_purchase_orders (
        sales_order_id, delivery_schedule_id, purchase_order_id, supplier_id,
        created_reason, total_amount, currency, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;

    await client.query(autoPoQuery, [
      salesOrder.id,
      deliverySchedule.id,
      po.id,
      supplierId,
      'DROPSHIP',
      subtotal,
      salesOrder.currency || 'USD',
      userId
    ]);

    return po;
  }

  // Create PO within existing transaction. Was previously built against a
  // `purchase_orders`/`purchase_order_items` schema that never matched
  // reality — 12 of the header columns it inserted don't exist on
  // `purchase_orders` (no supplier snapshot, shipping/priority/notes fields
  // in this schema), and the item table it targeted, `purchase_order_items`,
  // doesn't exist at all (the real table is `purchase_order_line_items`,
  // with a different column set). Every dropship delivery schedule has
  // therefore been unable to auto-create its supplier PO — silently, since
  // the only caller (createSalesOrderDeliverySchedule) catches and logs this
  // per-supplier without failing the request. Rewritten to match the real
  // schema and the same generate_po_number() sequence PurchaseOrder.create()
  // uses, instead of a hand-rolled MAX+1 scan that races under concurrency.
  static async createPurchaseOrderInTransaction(client, poData, userId) {
    const numberResult = await client.query('SELECT generate_po_number() as number');
    const poNumber = numberResult.rows[0].number;

    const poQuery = `
      INSERT INTO purchase_orders (
        po_number, supplier_id, delivery_date, delivery_address,
        payment_terms, currency, subtotal, tax_amount, total_amount,
        source_type, sales_order_id, status, created_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
      ) RETURNING *
    `;

    const poValues = [
      poNumber,
      poData.supplier_id,
      poData.delivery_date,
      poData.delivery_address,
      poData.payment_terms,
      poData.currency,
      poData.subtotal,
      poData.tax_amount,
      poData.total_amount,
      poData.source_type || 'DROPSHIP',
      poData.sales_order_id,
      'DRAFT',
      userId
    ];

    const poResult = await client.query(poQuery, poValues);
    const po = poResult.rows[0];

    // Insert PO line items
    if (poData.items && poData.items.length > 0) {
      for (const item of poData.items) {
        const itemQuery = `
          INSERT INTO purchase_order_line_items (
            po_id, item_id, item_description, unit_of_measure,
            quantity, unit_price, requested_delivery_date
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;

        await client.query(itemQuery, [
          po.id,
          item.item_id || null,
          item.item_description,
          item.unit_of_measure,
          item.quantity,
          item.unit_price,
          item.requested_delivery_date
        ]);
      }
    }

    return po;
  }

  // Postpone delivery schedule
  static async postponeDelivery(id, newDeliveryDate, reason, postponedBy) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get current schedule
      const currentResult = await client.query(
        'SELECT * FROM delivery_schedules WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );

      if (currentResult.rows.length === 0) {
        throw new Error('Delivery schedule not found');
      }

      const currentSchedule = currentResult.rows[0];

      // Update schedule with postponement
      const updateQuery = `
        UPDATE delivery_schedules 
        SET 
          original_delivery_date = COALESCE(original_delivery_date, delivery_date),
          delivery_date = $2,
          postponement_count = postponement_count + 1,
          postponement_reason = $3,
          postponed_by = $4,
          postponed_at = CURRENT_TIMESTAMP,
          updated_by = $4,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `;

      const result = await client.query(updateQuery, [id, newDeliveryDate, reason, postponedBy]);
      const updatedSchedule = result.rows[0];

      // Add status history
      await this.addStatusHistory(
        client, 
        id, 
        currentSchedule.status, 
        currentSchedule.status, // Status remains the same
        postponedBy, 
        `Delivery postponed: ${reason}`, 
        `From ${currentSchedule.delivery_date} to ${newDeliveryDate}`
      );

      // Create notification for relevant parties
      const Notification = require('./Notification');
      
      // Notify schedule creator
      if (currentSchedule.created_by) {
        await Notification.create({
          user_id: currentSchedule.created_by,
          type: 'DELIVERY_POSTPONED',
          title: `Delivery Postponed: ${currentSchedule.schedule_number}`,
          message: `Delivery schedule ${currentSchedule.schedule_number} has been postponed from ${currentSchedule.delivery_date} to ${newDeliveryDate}. Reason: ${reason}`,
          data: { 
            delivery_schedule_id: id, 
            schedule_number: currentSchedule.schedule_number,
            old_date: currentSchedule.delivery_date,
            new_date: newDeliveryDate
          }
        });
      }

      await client.query('COMMIT');
      
      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in DeliverySchedule.postponeDelivery:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Mark purchase order as created for delivery schedule
  static async markPurchaseOrderCreated(deliveryScheduleId, purchaseOrderId) {
    const query = `
      UPDATE delivery_schedules 
      SET 
        purchase_order_created = true,
        purchase_order_id = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [deliveryScheduleId, purchaseOrderId]);
      return result.rows[0];
    } catch (error) {
      console.error('Error marking purchase order as created:', error);
      throw error;
    }
  }
}

module.exports = DeliverySchedule;