const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class RequestForQuotation {
  static async create(rfqData, userId) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const {
        purchase_requisition_id: rawPurchaseRequisitionId,
        title,
        description,
        response_deadline,
        currency = 'USD',
        line_items = [],
        suppliers = [],
        status = 'DRAFT'
      } = rfqData;

      // The create form's "based on PR (optional)" select posts '' when left
      // unset, which Postgres rejects with "invalid input syntax for type
      // uuid" on this NULLable column — an uncaught error that surfaced to
      // the client as a bare 500 with no explanation.
      const purchase_requisition_id = rawPurchaseRequisitionId || null;

      const id = uuidv4();
      
      // Generate RFQ number
      const numberResult = await client.query('SELECT generate_rfq_number() as number');
      const rfq_number = numberResult.rows[0].number;

      // Create RFQ
      const rfqQuery = `
        INSERT INTO request_for_quotations (
          id, rfq_number, purchase_requisition_id, title, description,
          response_deadline, currency, status, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `;

      const rfqValues = [
        id, rfq_number, purchase_requisition_id, title, description,
        response_deadline, currency, status, userId
      ];

      const rfqResult = await client.query(rfqQuery, rfqValues);
      const rfq = rfqResult.rows[0];

      // Add line items if provided
      for (const item of line_items) {
        const itemId = uuidv4();
        const itemQuery = `
          INSERT INTO rfq_line_items (
            id, rfq_id, item_id, item_description, unit_of_measure,
            quantity, specifications
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;
        
        await client.query(itemQuery, [
          itemId, id, item.item_id, item.item_description, 
          item.unit_of_measure, item.quantity, item.specifications
        ]);
      }

      // Add suppliers if provided
      for (const supplierId of suppliers) {
        const supplierRfqId = uuidv4();
        const supplierQuery = `
          INSERT INTO rfq_suppliers (id, rfq_id, supplier_id)
          VALUES ($1, $2, $3)
        `;
        
        await client.query(supplierQuery, [supplierRfqId, id, supplierId]);
      }

      await client.query('COMMIT');
      return rfq;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async findAll(filters = {}, userId = null) {
    let query = `
      SELECT rfq.*,
             u1.first_name || ' ' || u1.last_name as created_by_name,
             pr.pr_number,
             pr.item_description as pr_item_description,
             ws.legal_name as winning_supplier_name,
             COUNT(DISTINCT rs.supplier_id) as supplier_count,
             COUNT(DISTINCT rli.id) as line_item_count,
             COUNT(DISTINCT rq.supplier_id) as response_count
      FROM request_for_quotations rfq
      LEFT JOIN users u1 ON rfq.created_by = u1.id
      LEFT JOIN purchase_requisitions pr ON rfq.purchase_requisition_id = pr.id
      LEFT JOIN suppliers ws ON rfq.winning_supplier_id = ws.id
      LEFT JOIN rfq_suppliers rs ON rfq.id = rs.rfq_id
      LEFT JOIN rfq_line_items rli ON rfq.id = rli.rfq_id
      LEFT JOIN rfq_quotations rq ON rfq.id = rq.rfq_id
    `;
    
    let conditions = [];
    let values = [];
    let paramIndex = 1;

    // Filter by user if provided
    if (userId) {
      conditions.push(`rfq.created_by = $${paramIndex}`);
      values.push(userId);
      paramIndex++;
    }

    if (filters.status) {
      conditions.push(`rfq.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex++;
    }

    if (filters.purchase_requisition_id) {
      conditions.push(`rfq.purchase_requisition_id = $${paramIndex}`);
      values.push(filters.purchase_requisition_id);
      paramIndex++;
    }

    if (filters.search) {
      conditions.push(`(rfq.rfq_number ILIKE $${paramIndex} OR rfq.title ILIKE $${paramIndex} OR rfq.description ILIKE $${paramIndex})`);
      values.push(`%${filters.search}%`);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' GROUP BY rfq.id, u1.first_name, u1.last_name, pr.pr_number, pr.item_description, ws.legal_name';
    query += ' ORDER BY rfq.created_at DESC';

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
      SELECT rfq.*,
             u1.first_name || ' ' || u1.last_name as created_by_name,
             pr.pr_number,
             pr.item_description as pr_item_description,
             pr.cost_center as pr_cost_center,
             ws.legal_name as winning_supplier_name,
             ws.supplier_code as winning_supplier_code
      FROM request_for_quotations rfq
      LEFT JOIN users u1 ON rfq.created_by = u1.id
      LEFT JOIN purchase_requisitions pr ON rfq.purchase_requisition_id = pr.id
      LEFT JOIN suppliers ws ON rfq.winning_supplier_id = ws.id
      WHERE rfq.id = $1
    `;
    
    let values = [id];
    
    if (userId) {
      query += ' AND rfq.created_by = $2';
      values.push(userId);
    }

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async update(id, rfqData, userId = null) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    const allowedFields = [
      'title', 'description', 'response_deadline', 'currency', 'status',
      'winning_supplier_id', 'selection_reason'
    ];

    allowedFields.forEach(field => {
      if (rfqData.hasOwnProperty(field)) {
        fields.push(`${field} = $${paramIndex}`);
        values.push(rfqData[field]);
        paramIndex++;
      }
    });

    if (fields.length === 0) {
      throw new Error('No valid fields to update');
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    values.push(id);
    let query = `
      UPDATE request_for_quotations 
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
    let query = 'DELETE FROM request_for_quotations WHERE id = $1';
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
  static async getLineItems(rfqId) {
    const query = `
      SELECT rli.*,
             i.name as item_name,
             i.approved_item_code,
             i.description as item_full_description
      FROM rfq_line_items rli
      LEFT JOIN items i ON rli.item_id = i.id
      WHERE rli.rfq_id = $1
      ORDER BY rli.created_at
    `;

    try {
      const result = await pool.query(query, [rfqId]);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async addLineItem(rfqId, itemData) {
    const {
      item_id,
      item_description,
      unit_of_measure,
      quantity,
      specifications
    } = itemData;

    const id = uuidv4();

    const query = `
      INSERT INTO rfq_line_items (
        id, rfq_id, item_id, item_description, unit_of_measure,
        quantity, specifications
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;

    const values = [id, rfqId, item_id, item_description, unit_of_measure, quantity, specifications];

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async removeLineItem(rfqId, lineItemId) {
    const query = `
      DELETE FROM rfq_line_items 
      WHERE rfq_id = $1 AND id = $2
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [rfqId, lineItemId]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Supplier management
  static async getSuppliers(rfqId) {
    const query = `
      SELECT rs.*,
             s.legal_name,
             s.supplier_code,
             s.email,
             s.phone,
             s.certification_status
      FROM rfq_suppliers rs
      JOIN suppliers s ON rs.supplier_id = s.id
      WHERE rs.rfq_id = $1
      ORDER BY s.legal_name
    `;

    try {
      const result = await pool.query(query, [rfqId]);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async addSupplier(rfqId, supplierId) {
    const id = uuidv4();

    const query = `
      INSERT INTO rfq_suppliers (id, rfq_id, supplier_id)
      VALUES ($1, $2, $3)
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, rfqId, supplierId]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async removeSupplier(rfqId, supplierId) {
    const query = `
      DELETE FROM rfq_suppliers 
      WHERE rfq_id = $1 AND supplier_id = $2
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [rfqId, supplierId]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Quotation management
  static async getQuotations(rfqId, supplierId = null) {
    let query = `
      SELECT rq.*,
             s.legal_name as supplier_name,
             s.supplier_code,
             rli.item_description,
             rli.unit_of_measure,
             rli.quantity,
             i.name as item_name
      FROM rfq_quotations rq
      JOIN suppliers s ON rq.supplier_id = s.id
      JOIN rfq_line_items rli ON rq.rfq_line_item_id = rli.id
      LEFT JOIN items i ON rli.item_id = i.id
      WHERE rq.rfq_id = $1
    `;
    
    let values = [rfqId];
    
    if (supplierId) {
      query += ' AND rq.supplier_id = $2';
      values.push(supplierId);
    }
    
    query += ' ORDER BY s.legal_name, rli.item_description';

    try {
      console.log(`🔍 Running getQuotations query for RFQ ${rfqId}, supplier: ${supplierId}`);
      console.log(`📝 Query: ${query}`);
      console.log(`📝 Values: ${JSON.stringify(values)}`);
      const result = await pool.query(query, values);
      console.log(`📋 getQuotations returned ${result.rows.length} rows`);
      return result.rows;
    } catch (error) {
      console.error('❌ Error in getQuotations:', error);
      throw error;
    }
  }

  static async addQuotation(quotationData) {
    const {
      rfq_id,
      supplier_id,
      rfq_line_item_id,
      unit_price,
      currency = 'USD',
      lead_time_days,
      delivery_terms,
      payment_terms,
      validity_days = 30,
      notes
    } = quotationData;

    const query = `
      INSERT INTO rfq_quotations (
        rfq_id, supplier_id, rfq_line_item_id, unit_price, currency,
        lead_time_days, delivery_terms, payment_terms, validity_days, notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;

    const values = [
      rfq_id, supplier_id, rfq_line_item_id, unit_price, currency,
      lead_time_days, delivery_terms, payment_terms, validity_days, notes
    ];

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // RFQ workflow methods
  static async submitForApproval(id, userId) {
    const query = `
      UPDATE request_for_quotations 
      SET status = 'PENDING_APPROVAL', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'DRAFT' AND created_by = $2
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, userId]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async send(id, userId) {
    const query = `
      UPDATE request_for_quotations 
      SET status = 'SENT', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'PENDING_APPROVAL' AND created_by = $2
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, userId]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async markResponsesReceived(id) {
    const query = `
      UPDATE request_for_quotations 
      SET status = 'RESPONSES_RECEIVED', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'SENT'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async markEvaluated(id) {
    const query = `
      UPDATE request_for_quotations 
      SET status = 'EVALUATED', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'RESPONSES_RECEIVED'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async selectSupplier(id, winningSupplierId, selectionReason) {
    const query = `
      UPDATE request_for_quotations 
      SET status = 'SUPPLIER_SELECTED',
          winning_supplier_id = $2,
          selection_reason = $3,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status IN ('RESPONSES_RECEIVED', 'EVALUATED')
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, winningSupplierId, selectionReason]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async getBestSupplierRecommendation(rfqId) {
    const query = `
      WITH supplier_stats AS (
        SELECT 
          rq.supplier_id,
          s.legal_name,
          s.supplier_code,
          s.certification_status,
          AVG(rq.unit_price) as avg_unit_price,
          COUNT(rq.id) as quotation_count,
          MIN(rq.lead_time_days) as min_lead_time
        FROM rfq_quotations rq
        JOIN suppliers s ON rq.supplier_id = s.id
        WHERE rq.rfq_id = $1
        GROUP BY rq.supplier_id, s.legal_name, s.supplier_code, s.certification_status
      ),
      min_price AS (
        SELECT MIN(avg_unit_price) as lowest_avg_price
        FROM supplier_stats
        WHERE avg_unit_price > 0
      )
      SELECT 
        ss.*,
        -- Scoring logic: prioritize certified suppliers, then by price and lead time
        CASE 
          WHEN ss.certification_status = 'CERTIFIED' THEN 100
          ELSE 0
        END +
        -- Price score (lower price = higher score, max 50 points)
        CASE 
          WHEN ss.avg_unit_price > 0 AND mp.lowest_avg_price > 0 THEN 
            GREATEST(0, 50 - ((ss.avg_unit_price / mp.lowest_avg_price - 1) * 50))
          ELSE 0
        END +
        -- Lead time score (shorter lead time = higher score, max 30 points)
        CASE 
          WHEN ss.min_lead_time > 0 THEN 
            GREATEST(0, 30 - (ss.min_lead_time / 30.0 * 30))
          ELSE 0
        END as score
      FROM supplier_stats ss
      CROSS JOIN min_price mp
      ORDER BY score DESC, ss.certification_status = 'CERTIFIED' DESC, ss.avg_unit_price ASC
      LIMIT 5
    `;

    try {
      console.log(`Running getBestSupplierRecommendation for RFQ ${rfqId}`);
      const result = await pool.query(query, [rfqId]);
      console.log(`Query returned ${result.rows.length} supplier recommendations`);
      return result.rows;
    } catch (error) {
      console.error('Error in getBestSupplierRecommendation:', error.message);
      throw error;
    }
  }

  static async autoSelectBestSupplier(id) {
    try {
      // First check if there are any quotations at all
      const allQuotations = await this.getQuotations(id);
      console.log(`Found ${allQuotations.length} quotations for RFQ ${id}`);
      
      if (allQuotations.length === 0) {
        throw new Error('No quotations have been submitted for this RFQ yet. Please wait for suppliers to respond before selecting a winner.');
      }

      // Get the best supplier recommendation
      const recommendations = await this.getBestSupplierRecommendation(id);
      console.log(`Found ${recommendations.length} supplier recommendations`);
      
      if (recommendations.length === 0) {
        throw new Error('Unable to calculate supplier recommendations. Please ensure quotations have valid prices and lead times.');
      }

      const bestSupplier = recommendations[0];
      const selectionReason = `Auto-selected based on scoring algorithm. Score: ${Math.round(bestSupplier.score)}/180. ` +
        `Certification: ${bestSupplier.certification_status}, ` +
        `Avg Price: ${bestSupplier.avg_unit_price}, ` +
        `Lead Time: ${bestSupplier.min_lead_time} days`;

      // Select the best supplier
      return await this.selectSupplier(id, bestSupplier.supplier_id, selectionReason);
    } catch (error) {
      throw error;
    }
  }

  static async close(id) {
    const query = `
      UPDATE request_for_quotations 
      SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status IN ('SUPPLIER_SELECTED', 'EVALUATED')
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  /**
   * Sourcing savings: what taking the best quote saved against the average of
   * the quotes received.
   *
   * This is deliberately measured INSIDE the RFQ rather than against the
   * purchase order that followed it. purchase_order_line_items carries no
   * rfq_line_item_id, so a line-to-line comparison would have to be guessed
   * from descriptions, and a savings figure built on a fuzzy match is worse
   * than one built on a narrower but exact question.
   *
   * The narrower question this answers exactly: for every line where at least
   * two suppliers quoted, (average quote - best quote) x quantity. Lines with a
   * single quote contribute nothing, because with one price there is no
   * alternative that was declined and so nothing was saved.
   */
  static async getSourcingSavings(userId = null, sinceDays = 365) {
    const conditions = ["rfq.status IN ('EVALUATED', 'SUPPLIER_SELECTED', 'CLOSED')"];
    const values = [];
    if (userId) { values.push(userId); conditions.push(`rfq.created_by = $${values.length}`); }
    values.push(sinceDays);
    conditions.push(`rfq.created_at >= CURRENT_DATE - ($${values.length}::int || ' days')::interval`);

    const { rows } = await pool.query(
      `WITH per_line AS (
         SELECT q.rfq_line_item_id,
                li.quantity,
                AVG(q.unit_price) AS avg_price,
                MIN(q.unit_price) AS best_price,
                COUNT(DISTINCT q.supplier_id) AS quote_count
           FROM rfq_quotations q
           JOIN rfq_line_items li ON li.id = q.rfq_line_item_id
           JOIN request_for_quotations rfq ON rfq.id = li.rfq_id
          WHERE ${conditions.join(' AND ')}
          GROUP BY q.rfq_line_item_id, li.quantity
         HAVING COUNT(DISTINCT q.supplier_id) >= 2
       )
       SELECT COALESCE(SUM((avg_price - best_price) * quantity), 0)::float8 AS savings,
              COALESCE(SUM(avg_price * quantity), 0)::float8 AS baseline,
              COUNT(*)::int AS lines_compared
         FROM per_line`,
      values
    );

    const row = rows[0] || {};
    const savings = Number(row.savings) || 0;
    const baseline = Number(row.baseline) || 0;
    return {
      savings,
      baseline,
      lines_compared: Number(row.lines_compared) || 0,
      // Null rather than zero when there is no baseline: "no comparable quotes"
      // and "saved nothing" are different answers.
      rate: baseline > 0 ? savings / baseline : null,
      window_days: sinceDays,
    };
  }

  static async getStats(userId = null) {
    let query = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'DRAFT' THEN 1 END) as draft,
        COUNT(CASE WHEN status = 'SENT' THEN 1 END) as sent,
        COUNT(CASE WHEN status = 'RESPONSES_RECEIVED' THEN 1 END) as responses_received,
        COUNT(CASE WHEN status = 'EVALUATED' THEN 1 END) as evaluated,
        COUNT(CASE WHEN status = 'SUPPLIER_SELECTED' THEN 1 END) as supplier_selected,
        COUNT(CASE WHEN status = 'CLOSED' THEN 1 END) as closed
      FROM request_for_quotations
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

  static async getCompletedRFQs() {
    const query = `
      SELECT rfq.*,
             u.first_name || ' ' || u.last_name as created_by_name,
             ws.legal_name as winning_supplier_name,
             ws.supplier_code as winning_supplier_code
      FROM request_for_quotations rfq
      LEFT JOIN users u ON rfq.created_by = u.id
      LEFT JOIN suppliers ws ON rfq.winning_supplier_id = ws.id
      WHERE rfq.status = 'SUPPLIER_SELECTED'
      ORDER BY rfq.updated_at DESC
    `;

    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = RequestForQuotation;