const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const NotificationService = require('../services/notificationService');
const duplicateDetection = require('../services/ai/duplicateDetection');
const { isPlatformOwnerId } = require('../services/platformOwner');

/**
 * Fire-and-forget duplicate check after a create commits. Not awaited: it
 * embeds the new PO and runs a similarity search, which is real work that
 * must never delay or fail the PO's own save (same reasoning as
 * models/SalesContract.js's indexDocument hook). Any finding lands in
 * ai_findings — the same table/shape the scheduled anomaly sweep
 * (services/agents/definitions/anomalyAgent.js) uses, so this is a faster,
 * earlier catch of exactly what that sweep would find hours later anyway.
 */
function scheduleDuplicateCheck(po) {
  if (!po) return;
  duplicateDetection.checkNewRecordForDuplicate('purchase_order', po.id).catch((err) => {
    console.error(`PurchaseOrder: duplicate check failed for ${po.id}:`, err.message);
  });
}

// The tax traits taxService.resolveSupplierRate looks for, read off whatever the
// suppliers table on this deployment actually has.
//
// `suppliers` here carries only `country` and `tax_id` — no tax_exempt, no
// tax_rate, no tax_jurisdiction_code — so selecting those columns by name is a
// 42703 that fails the whole purchase order. Reading the row and picking what
// exists keeps this working on a schema that has since grown the richer columns
// (the resolver already prefers them), and falls back to the country as the
// jurisdiction, which is the only tax signal a supplier record has today.
function supplierTaxTraits(row = {}) {
  return {
    ...row,
    jurisdiction_code: row?.tax_jurisdiction_code || row?.jurisdiction_code || row?.country || null,
  };
}

class PurchaseOrder {
  static async create(poData, userId) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const {
        purchase_requisition_id,
        rfq_id,
        contract_id,
        supplier_id,
        po_date = new Date().toISOString().split('T')[0],
        delivery_date,
        payment_terms,
        incoterms,
        currency = 'USD',
        delivery_address,
        storage_location_id,
        line_items = [],
        status = 'DRAFT',
        source_type,
        sales_order_id,
        sales_rfq_id
      } = poData;

      const id = uuidv4();
      
      // Generate PO number
      const numberResult = await client.query('SELECT generate_po_number() as number');
      const po_number = numberResult.rows[0].number;

      // Create PO
      const poQuery = `
        INSERT INTO purchase_orders (
          id, po_number, purchase_requisition_id, rfq_id, contract_id,
          supplier_id, po_date, delivery_date, payment_terms, incoterms,
          currency, delivery_address, storage_location_id, status, created_by,
          source_type, sales_order_id, sales_rfq_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING *
      `;

      const poValues = [
        id, po_number, 
        purchase_requisition_id || null, 
        rfq_id || null, 
        contract_id || null,
        supplier_id, po_date, delivery_date, payment_terms, incoterms,
        currency, delivery_address, storage_location_id || null, status, userId,
        source_type || null, sales_order_id || null, sales_rfq_id || null
      ];

      const poResult = await client.query(poQuery, poValues);
      const po = poResult.rows[0];

      let subtotal = 0;

      // Add line items if provided
      for (const item of line_items) {
        const itemId = uuidv4();
        const lineTotal = parseFloat(item.quantity) * parseFloat(item.unit_price);
        subtotal += lineTotal;
        
        const itemQuery = `
          INSERT INTO purchase_order_line_items (
            id, po_id, item_id, item_description, unit_of_measure,
            quantity, unit_price, requested_delivery_date
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `;
        
        await client.query(itemQuery, [
          itemId, id, item.item_id || null, item.item_description, 
          item.unit_of_measure, item.quantity, item.unit_price, 
          item.requested_delivery_date || delivery_date
        ]);
      }

      // Update PO totals, including purchase VAT.
      //
      // This line used to read `subtotal * 0.0 // No tax calculation for now`,
      // and that one placeholder is the whole of the audit's tax-asymmetry
      // finding. Sales resolves VAT from the customer's tax profile, so revenue
      // carries Output VAT; purchases resolved nothing, so every PO was taxed at
      // zero. The bill inherits po.tax_amount, which meant SupplierInvoice's
      // Input VAT branch (`tax > 0 && 1160`) could never fire — the account
      // exists in the seeded chart and never received a posting. A VAT return
      // built from that pays output tax and reclaims no input tax.
      //
      // taxService.resolveSupplierRate already existed for this and had no
      // callers. It honours the supplier's exemption, an explicit rate, then
      // their jurisdiction, then the company default — the mirror image of
      // resolveCustomerRate.
      const taxService = require('../services/taxService');
      const supplierTaxRes = await client.query('SELECT * FROM suppliers WHERE id = $1', [supplier_id]);
      const vatRate = taxService.resolveSupplierRate(supplierTaxTraits(supplierTaxRes.rows[0]));
      const taxAmount = taxService.computeTax(subtotal, vatRate);
      const totalAmount = taxService.round2(subtotal + taxAmount);

      await client.query(`
        UPDATE purchase_orders 
        SET subtotal = $1, tax_amount = $2, total_amount = $3 
        WHERE id = $4
      `, [subtotal, taxAmount, totalAmount, id]);

      // Read the finished row back INSIDE the transaction.
      //
      // config/database.js scopes a hand-rolled transaction by issuing
      // `SET LOCAL app.current_company_id` right after it sees the BEGIN.
      // SET LOCAL is transaction-scoped, so COMMIT discards it — and a
      // statement issued on this same client afterwards runs with no company
      // context at all. Under RLS that SELECT then matches nothing, and
      // create() returned `undefined` to its caller instead of the purchase
      // order it had just successfully written.
      const finalResult = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [id]);
      const created = finalResult.rows[0];

      await client.query('COMMIT');

      // Fire-and-forget, and deliberately after COMMIT: the duplicate check
      // reads the PO back over its own connection, so the row has to be
      // visible to other sessions before it runs.
      scheduleDuplicateCheck(created);
      return created;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async findAll(filters = {}, userId = null) {
    let query = `
      SELECT po.*,
             u1.first_name || ' ' || u1.last_name as created_by_name,
             u2.first_name || ' ' || u2.last_name as approved_by_name,
             s.legal_name as supplier_name,
             s.supplier_code,
             pr.pr_number,
             rfq.rfq_number,
             c.contract_number,
             COUNT(poli.id) as line_item_count
      FROM purchase_orders po
      LEFT JOIN users u1 ON po.created_by = u1.id
      LEFT JOIN users u2 ON po.approved_by = u2.id
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      LEFT JOIN purchase_requisitions pr ON po.purchase_requisition_id = pr.id
      LEFT JOIN request_for_quotations rfq ON po.rfq_id = rfq.id
      LEFT JOIN contracts c ON po.contract_id = c.id
      LEFT JOIN purchase_order_line_items poli ON po.id = poli.po_id
    `;
    
    let conditions = [];
    let values = [];
    let paramIndex = 1;

    if (filters.status) {
      conditions.push(`po.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex++;
    }

    if (filters.supplier_id) {
      conditions.push(`po.supplier_id = $${paramIndex}`);
      values.push(filters.supplier_id);
      paramIndex++;
    }

    if (filters.purchase_requisition_id) {
      conditions.push(`po.purchase_requisition_id = $${paramIndex}`);
      values.push(filters.purchase_requisition_id);
      paramIndex++;
    }

    if (filters.rfq_id) {
      conditions.push(`po.rfq_id = $${paramIndex}`);
      values.push(filters.rfq_id);
      paramIndex++;
    }

    if (filters.contract_id) {
      conditions.push(`po.contract_id = $${paramIndex}`);
      values.push(filters.contract_id);
      paramIndex++;
    }

    if (filters.search) {
      conditions.push(`(po.po_number ILIKE $${paramIndex} OR s.legal_name ILIKE $${paramIndex} OR pr.pr_number ILIKE $${paramIndex})`);
      values.push(`%${filters.search}%`);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' GROUP BY po.id, u1.first_name, u1.last_name, u2.first_name, u2.last_name, s.legal_name, s.supplier_code, pr.pr_number, rfq.rfq_number, c.contract_number';
    query += ' ORDER BY po.created_at DESC';

    if (filters.limit) {
      query += ` LIMIT $${paramIndex}`;
      values.push(filters.limit);
      paramIndex++;
    }

    if (filters.offset) {
      query += ` OFFSET $${paramIndex}`;
      values.push(filters.offset);
    }

    try {
      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async findById(id, userId = null) {
    let query = `
      SELECT po.*,
             u1.first_name || ' ' || u1.last_name as created_by_name,
             u2.first_name || ' ' || u2.last_name as approved_by_name,
             s.legal_name as supplier_name,
             s.supplier_code,
             s.email as supplier_email,
             s.phone as supplier_phone,
             s.address as supplier_address,
             pr.pr_number,
             pr.cost_center,
             rfq.rfq_number,
             c.contract_number,
             c.contract_name
      FROM purchase_orders po
      LEFT JOIN users u1 ON po.created_by = u1.id
      LEFT JOIN users u2 ON po.approved_by = u2.id
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      LEFT JOIN purchase_requisitions pr ON po.purchase_requisition_id = pr.id
      LEFT JOIN request_for_quotations rfq ON po.rfq_id = rfq.id
      LEFT JOIN contracts c ON po.contract_id = c.id
      WHERE po.id = $1
    `;
    
    let values = [id];
    
    if (userId) {
      query += ' AND po.created_by = $2';
      values.push(userId);
    }

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async update(id, poData, userId = null) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    const allowedFields = [
      'delivery_date', 'payment_terms', 'incoterms', 'currency', 'status'
    ];

    allowedFields.forEach(field => {
      if (poData.hasOwnProperty(field)) {
        fields.push(`${field} = $${paramIndex}`);
        values.push(poData[field]);
        paramIndex++;
      }
    });

    if (fields.length === 0) {
      throw new Error('No valid fields to update');
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    values.push(id);
    let query = `
      UPDATE purchase_orders 
      SET ${fields.join(', ')} 
      WHERE id = $${paramIndex}
    `;
    
    if (userId) {
      paramIndex++;
      values.push(userId);
      query += ` AND created_by = $${paramIndex}`;
    }
    
    query += ' RETURNING *';

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async delete(id, userId = null) {
    let query = 'DELETE FROM purchase_orders WHERE id = $1';
    let values = [id];
    
    if (userId) {
      query += ' AND created_by = $2';
      values.push(userId);
    }
    
    query += ' RETURNING *';
    
    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Line items management
  static async getLineItems(poId) {
    const query = `
      SELECT poli.*,
             i.name as item_name,
             i.approved_item_code,
             i.description as item_full_description
      FROM purchase_order_line_items poli
      LEFT JOIN items i ON poli.item_id = i.id
      WHERE poli.po_id = $1
      ORDER BY poli.created_at
    `;

    try {
      const result = await pool.query(query, [poId]);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async addLineItem(poId, itemData) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const {
        item_id,
        item_description,
        unit_of_measure,
        quantity,
        unit_price,
        requested_delivery_date
      } = itemData;

      const id = uuidv4();

      const query = `
        INSERT INTO purchase_order_line_items (
          id, po_id, item_id, item_description, unit_of_measure,
          quantity, unit_price, requested_delivery_date
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `;

      const values = [id, poId, item_id || null, item_description, unit_of_measure, quantity, unit_price, requested_delivery_date];
      const result = await client.query(query, values);
      
      // Recalculate PO totals
      await this._recalculateTotals(client, poId);
      
      await client.query('COMMIT');
      return result.rows[0];
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateLineItem(poId, lineItemId, itemData) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const fields = [];
      const values = [];
      let paramIndex = 1;

      const allowedFields = ['item_description', 'unit_of_measure', 'quantity', 'unit_price', 'requested_delivery_date'];

      allowedFields.forEach(field => {
        if (itemData.hasOwnProperty(field)) {
          fields.push(`${field} = $${paramIndex}`);
          values.push(itemData[field]);
          paramIndex++;
        }
      });

      if (fields.length === 0) {
        throw new Error('No valid fields to update');
      }

      values.push(poId);
      values.push(lineItemId);

      const query = `
        UPDATE purchase_order_line_items 
        SET ${fields.join(', ')} 
        WHERE po_id = $${paramIndex - 1} AND id = $${paramIndex}
        RETURNING *
      `;

      const result = await client.query(query, values);
      
      // Recalculate PO totals
      await this._recalculateTotals(client, poId);
      
      await client.query('COMMIT');
      return result.rows[0];
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async removeLineItem(poId, lineItemId) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const query = `
        DELETE FROM purchase_order_line_items 
        WHERE po_id = $1 AND id = $2
        RETURNING *
      `;

      const result = await client.query(query, [poId, lineItemId]);
      
      // Recalculate PO totals
      await this._recalculateTotals(client, poId);
      
      await client.query('COMMIT');
      return result.rows[0];
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Helper method to recalculate totals
  static async _recalculateTotals(client, poId) {
    const totalsQuery = `
      SELECT COALESCE(SUM(line_total), 0) as subtotal
      FROM purchase_order_line_items
      WHERE po_id = $1
    `;
    
    const totalsResult = await client.query(totalsQuery, [poId]);
    const subtotal = parseFloat(totalsResult.rows[0].subtotal || 0);

    // Same supplier VAT resolution as create — see the note there. Recalculating
    // totals at zero tax after a line change would silently strip the VAT off an
    // already-correct PO, which is the worse of the two bugs.
    const taxService = require('../services/taxService');
    const supplierTaxRes = await client.query(
      `SELECT s.* FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`,
      [poId]
    );
    const vatRate = taxService.resolveSupplierRate(supplierTaxTraits(supplierTaxRes.rows[0]));
    const taxAmount = taxService.computeTax(subtotal, vatRate);
    const totalAmount = taxService.round2(subtotal + taxAmount);

    await client.query(`
      UPDATE purchase_orders 
      SET subtotal = $1, tax_amount = $2, total_amount = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
    `, [subtotal, taxAmount, totalAmount, poId]);
  }

  // PO workflow methods
  static async findPendingApproval() {
    const query = `
      SELECT po.*,
             u.first_name || ' ' || u.last_name as created_by_name,
             s.legal_name as supplier_name,
             s.supplier_code
      FROM purchase_orders po
      LEFT JOIN users u ON po.created_by = u.id
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      WHERE po.status = 'PENDING_APPROVAL'
      ORDER BY po.created_at DESC
    `;

    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async submitForApproval(id, userId = null) {
    let query = `
      UPDATE purchase_orders 
      SET status = 'PENDING_APPROVAL', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'DRAFT'
    `;
    
    let values = [id];
    
    if (userId) {
      query += ' AND created_by = $2';
      values.push(userId);
    }
    
    query += ' RETURNING *';
    
    try {
      const result = await pool.query(query, values);
      const submittedPO = result.rows[0];
      
      if (submittedPO) {
        // Create notification for managers about new PO submission
        await NotificationService.createPOSubmittedNotification(submittedPO, userId);
      }
      
      return submittedPO;
    } catch (error) {
      throw error;
    }
  }

  static async approve(id, approvedBy) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const poRes = await client.query('SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
      if (poRes.rows.length === 0) throw new Error('Purchase order not found');
      const po = poRes.rows[0];

      // Segregation of Duties: Creator cannot approve their own PO — except
      // the platform owner (the deployment's creator admin), who may approve
      // their own submitted operations. Identity check on the same
      // transaction client; no role grants this exemption.
      if (po.created_by && String(po.created_by) === String(approvedBy)
          && !(await isPlatformOwnerId(approvedBy, client))) {
        throw new Error('Segregation of duties violation: you raised this purchase order, so you cannot approve it.');
      }

      // Validate legal state transition
      const { assertTransition } = require('../services/stateMachine');
      assertTransition('PURCHASE_ORDER', po.status, 'APPROVED');

      const result = await client.query(
        `UPDATE purchase_orders 
         SET status = 'APPROVED', approved_by = $2, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING *`,
        [id, approvedBy]
      );
      const approvedPO = result.rows[0];

      // Append transaction-atomic audit log
      const { auditStatusTransition } = require('../services/auditHook');
      await auditStatusTransition({
        client,
        entityType: 'PURCHASE_ORDER',
        entityId: id,
        fromStatus: po.status,
        toStatus: 'APPROVED',
        actorId: approvedBy,
        reason: 'Purchase order approved'
      });

      await client.query('COMMIT');

      if (approvedPO) {
        await NotificationService.createPOApprovedNotification(approvedPO, approvedBy, approvedPO.created_by);
      }

      return approvedPO;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Reject a purchase order during approval (preserves the record and records the reason)
  static async reject(id, rejectedBy, reason = '') {
    const query = `
      UPDATE purchase_orders 
      SET status = 'REJECTED', 
          rejection_reason = $2, 
          rejected_by = $3, 
          rejected_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, reason, rejectedBy]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async sendToSupplier(id, userId) {
    const query = `
      UPDATE purchase_orders 
      SET status = 'SENT_TO_SUPPLIER', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'APPROVED'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async confirm(id) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const query = `
        UPDATE purchase_orders 
        SET status = 'CONFIRMED', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'SENT_TO_SUPPLIER'
        RETURNING *
      `;

      const result = await client.query(query, [id]);
      const confirmedPO = result.rows[0];
      
      // Note: Journal entry creation moved to COMPLETED status for better business logic
      
      await client.query('COMMIT');
      return confirmedPO;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async cancel(id, userId) {
    const query = `
      UPDATE purchase_orders 
      SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED') AND created_by = $2
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, userId]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Receiving methods
  static async receiveItems(id, lineItemId, quantityReceived) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Update the line item received quantity
      const updateQuery = `
        UPDATE purchase_order_line_items 
        SET quantity_received = quantity_received + $1
        WHERE po_id = $2 AND id = $3
        RETURNING *
      `;
      
      const result = await client.query(updateQuery, [quantityReceived, id, lineItemId]);
      
      // Check if PO is fully or partially received
      const statusQuery = `
        SELECT 
          COUNT(*) as total_items,
          COUNT(CASE WHEN quantity_received >= quantity THEN 1 END) as fully_received_items
        FROM purchase_order_line_items 
        WHERE po_id = $1
      `;
      
      const statusResult = await client.query(statusQuery, [id]);
      const { total_items, fully_received_items } = statusResult.rows[0];
      
      let newStatus = 'CONFIRMED';
      if (parseInt(fully_received_items) === parseInt(total_items)) {
        newStatus = 'FULLY_RECEIVED';
      } else if (parseInt(fully_received_items) > 0) {
        newStatus = 'PARTIALLY_RECEIVED';
      }
      
      // Update PO status
      await client.query(`
        UPDATE purchase_orders 
        SET status = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [newStatus, id]);
      
      // Note: Journal entry creation happens when PO status changes to COMPLETED
      
      await client.query('COMMIT');
      return result.rows[0];
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async getStats(userId = null) {
    let query = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'DRAFT' THEN 1 END) as draft,
        COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END) as pending_approval,
        COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) as approved,
        COUNT(CASE WHEN status = 'SENT_TO_SUPPLIER' THEN 1 END) as sent_to_supplier,
        COUNT(CASE WHEN status = 'CONFIRMED' THEN 1 END) as confirmed,
        COUNT(CASE WHEN status = 'PARTIALLY_RECEIVED' THEN 1 END) as partially_received,
        COUNT(CASE WHEN status = 'FULLY_RECEIVED' THEN 1 END) as fully_received,
        SUM(total_amount) as total_value
      FROM purchase_orders
    `;
    
    let values = [];
    
    if (userId) {
      query += ' WHERE created_by = $1';
      values.push(userId);
    }

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  /**
   * The aggregates a procurement overview needs, in one round trip.
   *
   * Scope note: every query here carries the same `created_by` filter getStats
   * and findAll apply, so the analytics agree with the list and the counters
   * beside them. Handing back company-wide totals next to a user-scoped PO
   * count would produce a spend figure nobody could reconcile.
   *
   * DRAFT and CANCELLED orders are excluded from spend everywhere: a draft is
   * not money committed, and a cancelled order is money un-committed.
   */
  static async getAnalytics(userId = null, months = 24) {
    const scope = userId ? 'AND po.created_by = $1' : '';
    const values = userId ? [userId] : [];
    const mv = `$${values.length + 1}`;
    const COMMITTED = `po.status NOT IN ('DRAFT', 'CANCELLED')`;

    const [bySupplier, byCategory, onTime, monthly] = await Promise.all([
      pool.query(
        `SELECT COALESCE(NULLIF(s.trade_name, ''), s.legal_name, 'Unassigned') AS supplier,
                SUM(po.total_amount)::float8 AS spend,
                COUNT(*)::int AS orders
           FROM purchase_orders po
           LEFT JOIN suppliers s ON s.id = po.supplier_id
          WHERE ${COMMITTED} ${scope}
          GROUP BY 1
          HAVING SUM(po.total_amount) > 0
          ORDER BY 2 DESC
          LIMIT 6`,
        values
      ),
      // Category lives on the item, not on the order line, so an ad-hoc line
      // with no catalogue item genuinely has no category — it is reported as
      // Uncategorised rather than dropped, or the totals would not add up to
      // the spend figure shown above them.
      pool.query(
        `SELECT COALESCE(NULLIF(i.category, ''), NULLIF(i.item_category, ''), 'Uncategorised') AS category,
                SUM(li.line_total)::float8 AS spend
           FROM purchase_order_line_items li
           JOIN purchase_orders po ON po.id = li.po_id
           LEFT JOIN items i ON i.id = li.item_id
          WHERE ${COMMITTED} ${scope}
          GROUP BY 1
          HAVING SUM(li.line_total) > 0
          ORDER BY 2 DESC
          LIMIT 6`,
        values
      ),
      // A real on-time rate, which the sales side cannot offer: purchase_orders
      // carries both the promised delivery_date and delivery_confirmed_at, so
      // "arrived when it said it would" is a comparison of two recorded facts
      // rather than an inference from a status.
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE po.delivery_confirmed_at IS NOT NULL
                              AND po.delivery_date IS NOT NULL
                              AND po.delivery_confirmed_at::date <= po.delivery_date)::int AS on_time,
           COUNT(*) FILTER (WHERE po.delivery_confirmed_at IS NOT NULL
                              AND po.delivery_date IS NOT NULL
                              AND po.delivery_confirmed_at::date > po.delivery_date)::int AS late,
           COUNT(*) FILTER (WHERE po.delivery_confirmed_at IS NULL
                              AND po.delivery_date IS NOT NULL
                              AND po.delivery_date < CURRENT_DATE
                              AND po.status NOT IN ('DRAFT','CANCELLED','FULLY_RECEIVED'))::int AS overdue,
           COALESCE(SUM(po.total_amount) FILTER (WHERE po.delivery_confirmed_at IS NOT NULL
                              AND po.delivery_date IS NOT NULL
                              AND po.delivery_confirmed_at::date <= po.delivery_date), 0)::float8 AS on_time_value,
           COALESCE(SUM(po.total_amount) FILTER (WHERE po.delivery_confirmed_at IS NOT NULL
                              AND po.delivery_date IS NOT NULL
                              AND po.delivery_confirmed_at::date > po.delivery_date), 0)::float8 AS late_value
         FROM purchase_orders po
         WHERE 1=1 ${scope}`,
        values
      ),
      // Committed spend by month. Months with no orders come back as zero
      // rather than missing, because a gap in a series is a drawing artefact
      // and not a fact about the business.
      pool.query(
        `WITH span AS (
           SELECT generate_series(
             date_trunc('month', CURRENT_DATE) - make_interval(months => ${mv}::int - 1),
             date_trunc('month', CURRENT_DATE),
             interval '1 month')::date AS m
         ),
         spend AS (
           SELECT date_trunc('month', po.po_date)::date AS m,
                  SUM(po.total_amount)::float8 AS total
             FROM purchase_orders po
            WHERE ${COMMITTED} ${scope}
              AND po.po_date >= date_trunc('month', CURRENT_DATE) - make_interval(months => ${mv}::int - 1)
            GROUP BY 1
         )
         SELECT to_char(span.m, 'YYYY-MM') AS month,
                COALESCE(spend.total, 0)::float8 AS spend
           FROM span LEFT JOIN spend ON spend.m = span.m
          ORDER BY span.m`,
        [...values, months]
      ),
    ]);

    return {
      spend_by_supplier: bySupplier.rows,
      spend_by_category: byCategory.rows,
      delivery: onTime.rows[0],
      monthly_spend: monthly.rows,
    };
  }

  static async getBySupplier(supplierId) {
    const query = `
      SELECT po.*,
             u.first_name || ' ' || u.last_name as created_by_name
      FROM purchase_orders po
      LEFT JOIN users u ON po.created_by = u.id
      WHERE po.supplier_id = $1
      ORDER BY po.created_at DESC
    `;

    try {
      const result = await pool.query(query, [supplierId]);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get POs for delivery tracking
  static async findDeliveryTracking(filters = {}) {
    let query = `
      SELECT po.*, 
             s.legal_name as supplier_name,
             sl.name as storage_location_name,
             sl.address as storage_location_address,
             u1.first_name || ' ' || u1.last_name as created_by_name,
             u2.first_name || ' ' || u2.last_name as verified_by_name
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      LEFT JOIN storage_locations sl ON po.storage_location_id = sl.id
      LEFT JOIN users u1 ON po.created_by = u1.id
      LEFT JOIN users u2 ON po.verified_by = u2.id
      WHERE po.status IN (
        'SENT_TO_SUPPLIER', 'CONFIRMED', 'PREPARING_DELIVERY', 
        'IN_TRANSIT', 'DELIVERED', 'GOODS_READY_FOR_RECEIPT', 'COMPLETED'
      )
    `;

    let conditions = [];
    let values = [];
    let paramIndex = 1;

    if (filters.status) {
      conditions.push(`po.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex++;
    }

    if (filters.supplier_id) {
      conditions.push(`po.supplier_id = $${paramIndex}`);
      values.push(filters.supplier_id);
      paramIndex++;
    }

    if (filters.storage_location_id) {
      conditions.push(`po.storage_location_id = $${paramIndex}`);
      values.push(filters.storage_location_id);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' AND ' + conditions.join(' AND ');
    }

    query += ' ORDER BY po.delivery_date ASC, po.created_at DESC';

    if (filters.limit) {
      query += ` LIMIT $${paramIndex}`;
      values.push(filters.limit);
      paramIndex++;
    }

    try {
      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Verify delivery
  static async verifyDelivery(poId, verifiedBy, verified = true, verificationNotes = null, status = null) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Check if PO exists and is in DELIVERED status
      const checkQuery = `
        SELECT po.*, s.legal_name as supplier_name
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        WHERE po.id = $1 AND po.status = 'DELIVERED'
      `;
      
      const checkResult = await client.query(checkQuery, [poId]);
      if (checkResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const po = checkResult.rows[0];
      
      // Determine status based on PO source type
      let newStatus;
      if (status) {
        newStatus = status;
      } else if (verified) {
        // Check if this is a sales-related PO (has sales_order_id or source_type indicates sales)
        const isSalesRelated = po.sales_order_id || 
                              po.source_type?.includes('sales_order') || 
                              po.source_type?.includes('contract_sales');
        
        newStatus = isSalesRelated ? 'READY_FOR_CUSTOMER_DELIVERY' : 'GOODS_READY_FOR_RECEIPT';
      } else {
        newStatus = 'DELIVERED';
      }

      // Update PO status and verification info
      const updateQuery = `
        UPDATE purchase_orders 
        SET status = $1,
            verified_at = $2,
            verified_by = $3,
            verification_notes = $4,
            updated_at = NOW()
        WHERE id = $5
        RETURNING *
      `;

      const updateValues = [
        newStatus,
        verified ? new Date() : null,
        verified ? verifiedBy : null,
        verificationNotes,
        poId
      ];

      const updateResult = await client.query(updateQuery, updateValues);
      const updatedPO = updateResult.rows[0];

      // Create notification
      if (verified) {
        await NotificationService.createDeliveryVerifiedNotification(updatedPO, verifiedBy);
      } else {
        await NotificationService.createDeliveryIssueNotification(updatedPO, verifiedBy, verificationNotes);
      }

      await client.query('COMMIT');
      return updatedPO;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Customer handover for sales-related POs
  static async updateCustomerHandover(poId, status, notes, handoverBy) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Check if PO exists and is ready for customer handover
      const checkQuery = `
        SELECT po.*, s.legal_name as supplier_name
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        WHERE po.id = $1 AND po.status IN ('READY_FOR_CUSTOMER_DELIVERY', 'DELIVERED_TO_CUSTOMER')
      `;
      
      const checkResult = await client.query(checkQuery, [poId]);
      if (checkResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const po = checkResult.rows[0];

      // Update PO status and handover info
      const updateQuery = `
        UPDATE purchase_orders 
        SET status = $1,
            handover_notes = $2,
            handover_at = $3,
            handover_by = $4,
            updated_at = NOW()
        WHERE id = $5
        RETURNING *
      `;

      const updateValues = [
        status,
        notes,
        new Date(),
        handoverBy,
        poId
      ];

      const updateResult = await client.query(updateQuery, updateValues);
      const updatedPO = updateResult.rows[0];

      // Update related sales order status if applicable
      if (updatedPO.sales_order_id) {
        let salesOrderStatus;
        if (status === 'DELIVERED_TO_CUSTOMER') {
          salesOrderStatus = 'WAITING_CUSTOMER_DELIVERY_CONFIRMATION';
        } else if (status === 'CUSTOMER_CONFIRMED') {
          salesOrderStatus = 'COMPLETED';
        }
        
        if (salesOrderStatus) {
          await client.query(`
            UPDATE sales_orders 
            SET status = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
          `, [salesOrderStatus, updatedPO.sales_order_id]);
        }
      }

      // Create appropriate notification
      if (status === 'DELIVERED_TO_CUSTOMER') {
        await NotificationService.createCustomerDeliveryNotification(updatedPO, handoverBy);
      } else if (status === 'CUSTOMER_CONFIRMED') {
        await NotificationService.createCustomerConfirmationNotification(updatedPO, handoverBy);
      }

      await client.query('COMMIT');
      
      // Send email after transaction is committed (non-blocking)
      if (status === 'DELIVERED_TO_CUSTOMER' && updatedPO.sales_order_id) {
        setImmediate(async () => {
          try {
            const customerEmailService = require('../services/customerEmailService');
            await customerEmailService.sendDeliveryConfirmationRequest(updatedPO.sales_order_id);
          } catch (emailError) {
            console.error('Error sending customer delivery confirmation email:', emailError);
          }
        });
      }
      
      return updatedPO;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Update purchase order status with finance integration
  static async updateStatus(id, newStatus, userId, reason = '') {
    const client = await pool.connect();
    let currentStatus;
    let poNumber;

    try {
      await client.query('BEGIN');

      // Get current status (purchase_orders is not a soft-delete table — no
      // deleted_at column, unlike sales_orders/customer_invoices).
      const currentResult = await client.query(
        'SELECT status, po_number FROM purchase_orders WHERE id = $1',
        [id]
      );

      if (currentResult.rows.length === 0) {
        throw new Error('Purchase order not found');
      }

      currentStatus = currentResult.rows[0].status;
      poNumber = currentResult.rows[0].po_number;

      // Update status (purchase_orders has no updated_by column — only updated_at)
      await client.query(
        'UPDATE purchase_orders SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [id, newStatus]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in PurchaseOrder.updateStatus:', error);
      throw error;
    } finally {
      client.release();
    }

    // NOTE: PO completion no longer posts the AP liability. Under the GR/IR model,
    // inventory + the received-not-invoiced accrual are recognized at goods receipt
    // (Dr Inventory / Cr GR/IR), and the payable is recognized when the supplier
    // invoice arrives (Dr GR/IR + Input VAT / Cr AP). Completing a PO is a status
    // change only. (See goodsReceiptService + SupplierInvoice.createFromPurchaseOrder.)

    return await this.findById(id);
  }
}

module.exports = PurchaseOrder;