const db = require('../config/database');
const { indexDocument } = require('../services/ai/documentSearch');

/**
 * Fire-and-forget re-index after a create/update commits. Not awaited: an
 * embeddings call is ~seconds and AI may not even be configured, and neither
 * should ever turn a successful contract save into a failed request. Mirrors
 * the text shape documentSearch.indexSalesContracts already uses for the
 * batch/manual path, so live writes and a manual reindex produce the same text.
 */
function scheduleContractReindex(contract) {
  if (!contract) return;
  const body = [contract.terms_and_conditions, contract.special_conditions].filter(Boolean).join('\n\n').trim();
  if (!body) return;
  const text = `${contract.contract_number || ''} ${contract.contract_name || ''}\n\n${body}`.trim();
  indexDocument({ source_type: 'sales_contract', source_id: contract.id, text }).catch((err) => {
    console.error(`SalesContract: failed to auto-index contract ${contract.id}:`, err.message);
  });
}

class SalesContract {
  /**
   * There is no scheduler for sales contracts, so ACTIVE/SENT_TO_CUSTOMER
   * status is otherwise frozen forever once a contract's end_date passes —
   * "Expired" was a real, filterable status nothing ever set. Run this lazily
   * before any read so the status is never more than one request stale.
   */
  static async autoExpirePastEndDate() {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const due = await client.query(
        `SELECT id, status, COALESCE(approved_by, created_by) as attributed_to FROM sales_contracts
         WHERE status IN ('ACTIVE', 'SENT_TO_CUSTOMER')
           AND end_date < CURRENT_DATE
           AND deleted_at IS NULL
         FOR UPDATE`
      );
      for (const row of due.rows) {
        await client.query(
          `UPDATE sales_contracts SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1`,
          [row.id]
        );
        // changed_by is NOT NULL; there is no system-actor row, so attribute the
        // automatic transition to whoever approved (or failing that, created) the
        // contract rather than skip the audit trail entry.
        if (row.attributed_to) {
          await this.addStatusHistory(client, row.id, row.status, 'EXPIRED', row.attributed_to, 'Contract period ended; automatically marked Expired');
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesContract.autoExpirePastEndDate:', error);
    } finally {
      client.release();
    }
  }

  static async findAll(filters = {}) {
    try {
      await this.autoExpirePastEndDate();
      let query = `
        SELECT 
          sc.*,
          c.customer_name as customer_name_full,
          sc.supplier_name as supplier_name_full,
          u.first_name || ' ' || u.last_name as created_by_name,
          approver.first_name || ' ' || approver.last_name as approved_by_name,
          COUNT(sci.id) as item_count,
          SUM(sci.unit_price * COALESCE(sci.maximum_quantity, 1)) as estimated_total_value,
          CASE 
            WHEN sc.end_date < CURRENT_DATE AND sc.status = 'ACTIVE' 
            THEN TRUE 
            ELSE FALSE 
          END as is_expired,
          CASE 
            WHEN sc.end_date - CURRENT_DATE <= sc.days_before_expiry_notification AND sc.status = 'ACTIVE'
            THEN TRUE 
            ELSE FALSE 
          END as expiring_soon
        FROM sales_contracts sc
        LEFT JOIN customers c ON sc.customer_id = c.id
        LEFT JOIN suppliers s ON sc.supplier_id = s.id
        LEFT JOIN users u ON sc.created_by = u.id
        LEFT JOIN users approver ON sc.approved_by = approver.id
        LEFT JOIN sales_contract_items sci ON sc.id = sci.sales_contract_id
        WHERE sc.deleted_at IS NULL
      `;
      
      const conditions = [];
      const values = [];

      if (filters.search) {
        conditions.push(`(
          sc.contract_number ILIKE $${values.length + 1} OR
          sc.contract_name ILIKE $${values.length + 1} OR
          sc.customer_name ILIKE $${values.length + 1} OR
          sc.supplier_name ILIKE $${values.length + 1}
        )`);
        values.push(`%${filters.search}%`);
      }

      if (filters.status) {
        conditions.push(`sc.status = $${values.length + 1}`);
        values.push(filters.status);
      }

      if (filters.contract_type) {
        conditions.push(`sc.contract_type = $${values.length + 1}`);
        values.push(filters.contract_type);
      }

      if (filters.customer_id) {
        conditions.push(`sc.customer_id = $${values.length + 1}`);
        values.push(filters.customer_id);
      }

      if (filters.supplier_id) {
        conditions.push(`sc.supplier_id = $${values.length + 1}`);
        values.push(filters.supplier_id);
      }

      if (filters.approval_status) {
        conditions.push(`sc.approval_status = $${values.length + 1}`);
        values.push(filters.approval_status);
      }

      if (filters.start_date_from) {
        conditions.push(`sc.start_date >= $${values.length + 1}`);
        values.push(filters.start_date_from);
      }

      if (filters.end_date_to) {
        conditions.push(`sc.end_date <= $${values.length + 1}`);
        values.push(filters.end_date_to);
      }

      if (filters.expiring_soon === 'true') {
        conditions.push(`sc.end_date - CURRENT_DATE <= sc.days_before_expiry_notification AND sc.status = 'ACTIVE'`);
      }

      if (conditions.length > 0) {
        query += ' AND ' + conditions.join(' AND ');
      }

      query += `
        GROUP BY sc.id, c.customer_name, sc.supplier_name, u.first_name, u.last_name, approver.first_name, approver.last_name
        ORDER BY sc.created_at DESC
      `;

      if (filters.limit) {
        query += ` LIMIT $${values.length + 1}`;
        values.push(filters.limit);
      }

      if (filters.offset) {
        query += ` OFFSET $${values.length + 1}`;
        values.push(filters.offset);
      }

      const result = await db.query(query, values);
      return result.rows;
    } catch (error) {
      console.error('Error in SalesContract.findAll:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      await this.autoExpirePastEndDate();
      const query = `
        SELECT 
          sc.*,
          c.customer_name as customer_name_full,
          c.primary_email as customer_email,
          c.phone as customer_phone,
          sc.supplier_name as supplier_name_full,
          s.email as supplier_email,
          s.phone as supplier_phone,
          u.first_name || ' ' || u.last_name as created_by_name,
          approver.first_name || ' ' || approver.last_name as approved_by_name,
          CASE 
            WHEN sc.end_date < CURRENT_DATE AND sc.status = 'ACTIVE' 
            THEN TRUE 
            ELSE FALSE 
          END as is_expired,
          CASE 
            WHEN sc.end_date - CURRENT_DATE <= sc.days_before_expiry_notification AND sc.status = 'ACTIVE'
            THEN TRUE 
            ELSE FALSE 
          END as expiring_soon
        FROM sales_contracts sc
        LEFT JOIN customers c ON sc.customer_id = c.id
        LEFT JOIN suppliers s ON sc.supplier_id = s.id
        LEFT JOIN users u ON sc.created_by = u.id
        LEFT JOIN users approver ON sc.approved_by = approver.id
        WHERE sc.id = $1 AND sc.deleted_at IS NULL
      `;
      
      const result = await db.query(query, [id]);
      
      if (result.rows.length === 0) {
        return null;
      }

      const contract = result.rows[0];

      // Get contract items
      const itemsQuery = `
        SELECT 
          sci.*,
          i.name as inventory_item_name,
          i.item_code as inventory_item_code,
          i.approved_item_code
        FROM sales_contract_items sci
        LEFT JOIN inventory_items ii ON sci.inventory_item_id = ii.id
        LEFT JOIN items i ON ii.item_master_id = i.id
        WHERE sci.sales_contract_id = $1
        ORDER BY sci.line_number
      `;
      
      const itemsResult = await db.query(itemsQuery, [id]);
      contract.items = itemsResult.rows;

      return contract;
    } catch (error) {
      console.error('Error in SalesContract.findById:', error);
      throw error;
    }
  }

  static async create(contractData, userId) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Generate contract number
      const contractNumber = await this.generateContractNumber(client);

      // Insert sales contract
      const scQuery = `
        INSERT INTO sales_contracts (
          contract_number, contract_name, customer_id, customer_name, supplier_id, supplier_name,
          contract_type, contract_value, currency, payment_terms, incoterms,
          start_date, end_date, auto_renewal, renewal_period_months,
          default_lead_time_days, delivery_terms, delivery_location,
          signed_contract_url, contract_attachment_urls, terms_and_conditions, special_conditions,
          days_before_expiry_notification, linked_rfq_id, linked_quotation_id,
          notes, internal_notes, created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29
        ) RETURNING *
      `;

      const parseIntOrNull = (value, defaultValue = null) => {
        // Handle empty strings, null, undefined, or whitespace-only strings
        if (!value || value === '' || value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
          return defaultValue;
        }
        const parsed = parseInt(value, 10);
        return isNaN(parsed) ? defaultValue : parsed;
      };

      const scValues = [
        contractNumber,                                                                      // $1
        contractData.contract_name,                                                          // $2
        contractData.customer_id || null,                                                    // $3
        contractData.customer_name,                                                          // $4
        contractData.supplier_id || null,                                                    // $5
        contractData.supplier_name,                                                          // $6
        contractData.contract_type || 'SALES',                                               // $7
        contractData.contract_value,                                                         // $8
        contractData.currency || 'USD',                                                      // $9
        contractData.payment_terms,                                                          // $10
        contractData.incoterms,                                                              // $11
        contractData.start_date,                                                             // $12
        contractData.end_date,                                                               // $13
        contractData.auto_renewal || false,                                                  // $14
        parseIntOrNull(contractData.renewal_period_months, 12),                             // $15
        parseIntOrNull(contractData.default_lead_time_days, null),                          // $16
        contractData.delivery_terms,                                                         // $17
        contractData.delivery_location,                                                      // $18
        contractData.signed_contract_url,                                                    // $19
        contractData.contract_attachment_urls,                                               // $20
        contractData.terms_and_conditions,                                                   // $21
        contractData.special_conditions,                                                     // $22
        parseIntOrNull(contractData.days_before_expiry_notification, 30),                   // $23
        contractData.linked_rfq_id || null,                                                  // $24
        contractData.linked_quotation_id || null,                                           // $25
        contractData.notes,                                                                  // $26
        contractData.internal_notes,                                                         // $27
        userId,                                                                              // $28
        userId                                                                               // $29
      ];

      const scResult = await client.query(scQuery, scValues);
      const contract = scResult.rows[0];

      // Insert contract items
      if (contractData.items && contractData.items.length > 0) {
        for (let i = 0; i < contractData.items.length; i++) {
          const item = contractData.items[i];
          
          const itemQuery = `
            INSERT INTO sales_contract_items (
              sales_contract_id, line_number, inventory_item_id, item_code, item_name, item_description,
              unit_price, currency, unit_of_measure, minimum_quantity, maximum_quantity, annual_quantity_limit,
              volume_discount_tiers, price_escalation_clause, price_review_frequency_months,
              lead_time_days, delivery_terms, technical_specifications, quality_requirements,
              packaging_requirements, notes
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
              $16, $17, $18, $19, $20, $21
            )
          `;

          const itemValues = [
            contract.id,
            i + 1,
            item.inventory_item_id || null,
            item.item_code,
            item.item_name,
            item.item_description,
            item.unit_price,
            item.currency || contractData.currency || 'USD',
            item.unit_of_measure,
            parseIntOrNull(item.minimum_quantity, null),
            parseIntOrNull(item.maximum_quantity, null),
            parseIntOrNull(item.annual_quantity_limit, null),
            item.volume_discount_tiers ? JSON.stringify(item.volume_discount_tiers) : null,
            item.price_escalation_clause,
            parseIntOrNull(item.price_review_frequency_months, null),
            parseIntOrNull(item.lead_time_days, null),
            item.delivery_terms,
            item.technical_specifications,
            item.quality_requirements,
            item.packaging_requirements,
            item.item_notes || item.notes
          ];

          await client.query(itemQuery, itemValues);
        }
      }

      // Add status history
      await this.addStatusHistory(client, contract.id, null, 'DRAFT', userId, 'Contract created');

      await client.query('COMMIT');

      const fresh = await this.findById(contract.id);
      scheduleContractReindex(fresh);
      return fresh;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesContract.create:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async update(id, contractData, userId) {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Check if contract exists and can be updated
      const existingResult = await client.query(
        'SELECT status, approval_status FROM sales_contracts WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );

      if (existingResult.rows.length === 0) {
        throw new Error('Contract not found');
      }

      const { status, approval_status } = existingResult.rows[0];
      if (status === 'ACTIVE' && approval_status === 'APPROVED') {
        throw new Error('Cannot update approved and active contracts');
      }

      // Update contract
      const updateQuery = `
        UPDATE sales_contracts SET
          contract_name = COALESCE($2, contract_name),
          customer_id = COALESCE($3, customer_id),
          customer_name = COALESCE($4, customer_name),
          supplier_id = COALESCE($5, supplier_id),
          supplier_name = COALESCE($6, supplier_name),
          contract_type = COALESCE($7, contract_type),
          contract_value = COALESCE($8, contract_value),
          currency = COALESCE($9, currency),
          payment_terms = COALESCE($10, payment_terms),
          incoterms = COALESCE($11, incoterms),
          start_date = COALESCE($12, start_date),
          end_date = COALESCE($13, end_date),
          auto_renewal = COALESCE($14, auto_renewal),
          renewal_period_months = COALESCE($15, renewal_period_months),
          default_lead_time_days = COALESCE($16, default_lead_time_days),
          delivery_terms = COALESCE($17, delivery_terms),
          delivery_location = COALESCE($18, delivery_location),
          signed_contract_url = COALESCE($19, signed_contract_url),
          contract_attachment_urls = COALESCE($20, contract_attachment_urls),
          terms_and_conditions = COALESCE($21, terms_and_conditions),
          special_conditions = COALESCE($22, special_conditions),
          days_before_expiry_notification = COALESCE($23, days_before_expiry_notification),
          notes = COALESCE($24, notes),
          internal_notes = COALESCE($25, internal_notes),
          updated_by = $26
        WHERE id = $1 AND deleted_at IS NULL
      `;

      const parseIntOrNull = (value, defaultValue = null) => {
        if (value === '' || value === null || value === undefined) return defaultValue;
        const parsed = parseInt(value);
        return isNaN(parsed) ? defaultValue : parsed;
      };

      const updateValues = [
        id,
        contractData.contract_name,
        contractData.customer_id || null,
        contractData.customer_name,
        contractData.supplier_id || null,
        contractData.supplier_name,
        contractData.contract_type,
        contractData.contract_value,
        contractData.currency,
        contractData.payment_terms,
        contractData.incoterms,
        contractData.start_date,
        contractData.end_date,
        contractData.auto_renewal,
        parseIntOrNull(contractData.renewal_period_months, null),
        parseIntOrNull(contractData.default_lead_time_days, null),
        contractData.delivery_terms,
        contractData.delivery_location,
        contractData.signed_contract_url,
        contractData.contract_attachment_urls,
        contractData.terms_and_conditions,
        contractData.special_conditions,
        parseIntOrNull(contractData.days_before_expiry_notification, null),
        contractData.notes,
        contractData.internal_notes,
        userId
      ];

      await client.query(updateQuery, updateValues);

      // Update items if provided
      if (contractData.items) {
        // Delete existing items
        await client.query('DELETE FROM sales_contract_items WHERE sales_contract_id = $1', [id]);

        // Insert new items
        for (let i = 0; i < contractData.items.length; i++) {
          const item = contractData.items[i];
          
          const itemQuery = `
            INSERT INTO sales_contract_items (
              sales_contract_id, line_number, inventory_item_id, item_code, item_name, item_description,
              unit_price, currency, unit_of_measure, minimum_quantity, maximum_quantity, annual_quantity_limit,
              volume_discount_tiers, price_escalation_clause, price_review_frequency_months,
              lead_time_days, delivery_terms, technical_specifications, quality_requirements,
              packaging_requirements, notes
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
              $16, $17, $18, $19, $20, $21
            )
          `;

          const itemValues = [
            id,
            i + 1,
            item.inventory_item_id || null,
            item.item_code,
            item.item_name,
            item.item_description,
            item.unit_price,
            item.currency || contractData.currency || 'USD',
            item.unit_of_measure,
            parseIntOrNull(item.minimum_quantity, null),
            parseIntOrNull(item.maximum_quantity, null),
            parseIntOrNull(item.annual_quantity_limit, null),
            item.volume_discount_tiers ? JSON.stringify(item.volume_discount_tiers) : null,
            item.price_escalation_clause,
            parseIntOrNull(item.price_review_frequency_months, null),
            parseIntOrNull(item.lead_time_days, null),
            item.delivery_terms,
            item.technical_specifications,
            item.quality_requirements,
            item.packaging_requirements,
            item.item_notes || item.notes
          ];

          await client.query(itemQuery, itemValues);
        }
      }

      await client.query('COMMIT');

      const fresh = await this.findById(id);
      scheduleContractReindex(fresh);
      return fresh;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesContract.update:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateStatus(id, newStatus, userId, reason = '') {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get current status
      const currentResult = await client.query(
        'SELECT status FROM sales_contracts WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );

      if (currentResult.rows.length === 0) {
        throw new Error('Contract not found');
      }

      const currentStatus = currentResult.rows[0].status;

      // Update status
      await client.query(
        'UPDATE sales_contracts SET status = $2, updated_by = $3 WHERE id = $1',
        [id, newStatus, userId]
      );

      // Add status history
      await this.addStatusHistory(client, id, currentStatus, newStatus, userId, reason);

      await client.query('COMMIT');
      
      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesContract.updateStatus:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async approve(id, userId, reason = '') {
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Update approval status
      await client.query(
        `UPDATE sales_contracts 
         SET approval_status = 'APPROVED', approved_by = $2, approved_at = CURRENT_TIMESTAMP, updated_by = $2
         WHERE id = $1`,
        [id, userId]
      );

      // If contract is in draft, move to active
      await client.query(
        `UPDATE sales_contracts 
         SET status = 'ACTIVE' 
         WHERE id = $1 AND status = 'DRAFT'`,
        [id]
      );

      // Add status history
      await this.addStatusHistory(client, id, 'PENDING_APPROVAL', 'APPROVED', userId, reason);

      await client.query('COMMIT');
      
      return await this.findById(id);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesContract.approve:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async delete(id, userId) {
    try {
      const result = await db.query(
        `UPDATE sales_contracts 
         SET deleted_at = CURRENT_TIMESTAMP, updated_by = $2 
         WHERE id = $1 AND deleted_at IS NULL 
         RETURNING *`,
        [id, userId]
      );

      if (result.rows.length === 0) {
        throw new Error('Contract not found or already deleted');
      }

      return result.rows[0];
    } catch (error) {
      console.error('Error in SalesContract.delete:', error);
      throw error;
    }
  }

  static async getStats() {
    try {
      const query = `
        SELECT 
          COUNT(*) as total_contracts,
          COUNT(CASE WHEN status = 'DRAFT' THEN 1 END) as draft_contracts,
          COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END) as active_contracts,
          COUNT(CASE WHEN status = 'EXPIRED' THEN 1 END) as expired_contracts,
          COUNT(CASE WHEN approval_status = 'PENDING' THEN 1 END) as pending_approval,
          COUNT(CASE WHEN end_date - CURRENT_DATE <= days_before_expiry_notification AND status = 'ACTIVE' THEN 1 END) as expiring_soon,
          SUM(contract_value) as total_contract_value,
          AVG(contract_value) as average_contract_value
        FROM sales_contracts 
        WHERE deleted_at IS NULL
      `;
      
      const result = await db.query(query);
      return result.rows[0];
    } catch (error) {
      console.error('Error in SalesContract.getStats:', error);
      throw error;
    }
  }

  static async generateContractNumber(client = db.pool) {
    try {
      const year = new Date().getFullYear();
      const prefix = `SC${year}`;
      
      const result = await client.query(
        `SELECT contract_number FROM sales_contracts 
         WHERE contract_number LIKE $1 
         ORDER BY contract_number DESC LIMIT 1`,
        [`${prefix}%`]
      );

      let nextNumber = 1;
      if (result.rows.length > 0) {
        const lastNumber = result.rows[0].contract_number.replace(prefix, '');
        nextNumber = parseInt(lastNumber) + 1;
      }

      return `${prefix}${nextNumber.toString().padStart(6, '0')}`;
    } catch (error) {
      console.error('Error generating contract number:', error);
      throw error;
    }
  }

  static async addStatusHistory(client, contractId, fromStatus, toStatus, userId, reason) {
    const query = `
      INSERT INTO sales_contract_status_history 
      (sales_contract_id, from_status, to_status, changed_by, reason)
      VALUES ($1, $2, $3, $4, $5)
    `;
    
    await client.query(query, [contractId, fromStatus, toStatus, userId, reason]);
  }

  static async getStatusHistory(contractId) {
    try {
      const query = `
        SELECT 
          scsh.*,
          u.first_name || ' ' || u.last_name as changed_by_name
        FROM sales_contract_status_history scsh
        LEFT JOIN users u ON scsh.changed_by = u.id
        WHERE scsh.sales_contract_id = $1
        ORDER BY scsh.status_date ASC
      `;
      
      const result = await db.query(query, [contractId]);
      return result.rows;
    } catch (error) {
      console.error('Error in SalesContract.getStatusHistory:', error);
      throw error;
    }
  }

  static async getPendingApprovals(userId) {
    try {
      const DelegationOfAuthority = require('./DelegationOfAuthority');

      // The platform owner (the deployment's founder admin) is authorized for
      // every amount by identity — show them every contract awaiting approval
      // even though no delegation_of_authority row names them.
      const { isPlatformOwnerId } = require('../services/platformOwner');
      const isOwner = await isPlatformOwnerId(userId);

      let maxAuthority;
      let minAuthority;
      if (isOwner) {
        maxAuthority = Number.MAX_SAFE_INTEGER;
        minAuthority = 0;
      } else {
        // Get user's authority levels
        const authorities = await DelegationOfAuthority.getUserAuthority(userId, null, 'SALES_CONTRACT');

        if (!authorities.length) {
          return [];
        }

        maxAuthority = Math.max(...authorities.map(a => a.max_amount || Number.MAX_SAFE_INTEGER));
        minAuthority = Math.min(...authorities.map(a => a.min_amount || 0));
      }
      
      const query = `
        SELECT 
          sc.*,
          c.customer_name,
          u.first_name || ' ' || u.last_name as created_by_name,
          COUNT(sci.id) as item_count
        FROM sales_contracts sc
        LEFT JOIN customers c ON sc.customer_id = c.id
        LEFT JOIN users u ON sc.created_by = u.id
        LEFT JOIN sales_contract_items sci ON sc.id = sci.sales_contract_id
        WHERE sc.status = 'PENDING_APPROVAL'
          AND sc.contract_value >= $1
          AND sc.contract_value <= $2
          AND sc.deleted_at IS NULL
        GROUP BY sc.id, c.customer_name, u.first_name, u.last_name
        ORDER BY sc.created_at ASC
      `;
      
      const result = await db.query(query, [minAuthority, maxAuthority]);
      return result.rows;
    } catch (error) {
      console.error('Error in SalesContract.getPendingApprovals:', error);
      throw error;
    }
  }

  static async approveContract(contractId, userId, approvalNotes = '') {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get current contract with customer details
      const contractResult = await client.query(
        `SELECT sc.*, c.customer_name as customer_name_full, c.primary_email, c.customer_code
         FROM sales_contracts sc
         LEFT JOIN customers c ON sc.customer_id = c.id
         WHERE sc.id = $1 AND sc.deleted_at IS NULL`,
        [contractId]
      );
      
      if (contractResult.rows.length === 0) {
        throw new Error('Contract not found');
      }
      
      const contract = contractResult.rows[0];
      
      if (contract.status !== 'PENDING_APPROVAL') {
        throw new Error('Contract is not pending approval');
      }
      
      // Check DOA authority. The platform owner (the deployment's founder
      // admin — first account or PLATFORM_OWNER_EMAIL) is authorized for every
      // document type and amount by identity, with no DoA row required; every
      // other approver needs an actual grant.
      const { isPlatformOwnerId } = require('../services/platformOwner');
      if (!(await isPlatformOwnerId(userId, client))) {
        const doaQuery = `
          SELECT max_amount
          FROM delegation_of_authority
          WHERE user_id = $1
          AND applies_to = 'SALES_CONTRACT'
          AND max_amount >= $2
          AND effective_from <= CURRENT_DATE
          AND (effective_until IS NULL OR effective_until >= CURRENT_DATE)
          AND is_active = true
          LIMIT 1
        `;

        const doaResult = await client.query(doaQuery, [userId, contract.contract_value || 0]);

        if (doaResult.rows.length === 0) {
          throw new Error('You do not have authority to approve this contract');
        }
      }
      
      // Generate customer response token for contract signing (expiring, single-use)
      const { generateToken, expiryDate } = require('../services/portalTokens');
      const customerResponseToken = generateToken();
      const customerResponseTokenExpiresAt = expiryDate();

      // Update contract status to SENT_TO_CUSTOMER (approved and sent).
      // approval_status is a separate column from status (see the detail
      // page's "Approval Status" field) and defaults to PENDING — it was
      // never set here, so an approved contract's Status History correctly
      // showed "Contract approved..." while the Approval Status field stayed
      // stuck on PENDING forever.
      const updateQuery = `
        UPDATE sales_contracts
        SET
          status = 'SENT_TO_CUSTOMER',
          approval_status = 'APPROVED',
          approved_by = $1,
          approved_at = NOW(),
          approval_notes = $2,
          sent_to_customer_at = NOW(),
          sent_by = $1,
          customer_response_token = $3,
          customer_response_token_expires_at = $5,
          customer_response_token_used_at = NULL,
          updated_at = NOW()
        WHERE id = $4
        RETURNING *
      `;

      const updateResult = await client.query(updateQuery, [userId, approvalNotes, customerResponseToken, contractId, customerResponseTokenExpiresAt]);
      const approvedContract = updateResult.rows[0];
      
      // Add status history
      await this.addStatusHistory(client, contractId, 'PENDING_APPROVAL', 'SENT_TO_CUSTOMER', userId, `Contract approved and sent to customer: ${approvalNotes}`);
      
      // Create notifications
      const Notification = require('./Notification');
      
      // Notify the submitter
      if (contract.submitted_for_approval_by && contract.submitted_for_approval_by !== userId) {
        await Notification.create({
          user_id: contract.submitted_for_approval_by,
          type: 'SALES_CONTRACT_APPROVED',
          title: `Contract Approved: ${contract.contract_name}`,
          message: `Your contract ${contract.contract_number} has been approved and sent to customer ${contract.customer_name}`,
          related_type: 'CONTRACT',
          related_id: contractId
        });
      }
      
      await client.query('COMMIT');

      // Send email to customer (outside transaction to prevent rollback on email failure).
      // The customer-response token above is generated either way, so the portal
      // link exists and works even when this send is skipped or fails — the
      // approver just needs to be told that, instead of the contract silently
      // sitting at SENT_TO_CUSTOMER with no obvious next step.
      let emailSent = false;
      let emailWarning = null;
      try {
        const customerEmailService = require('../services/customerEmailService');

        if (contract.primary_email) {
          console.log('📧 Sending contract to customer:', contract.primary_email);

          const emailResult = await customerEmailService.sendContractEmail(
            approvedContract,
            {
              customer_name: contract.customer_name_full || contract.customer_name,
              primary_email: contract.primary_email,
              customer_code: contract.customer_code
            }
          );

          if (emailResult.success) {
            console.log('✅ Contract email sent to customer:', emailResult.recipient);
            emailSent = true;
          } else {
            emailWarning = 'Contract approved, but the customer email could not be sent. Use the customer portal link to share it manually.';
          }
        } else {
          console.log('⚠️ No customer email found, contract approved but not sent');
          emailWarning = 'Contract approved, but this customer has no email on file, so nothing was sent. Use the customer portal link to share it manually.';
        }
      } catch (emailError) {
        console.error('📧 Failed to send contract email to customer:', emailError.message);
        emailWarning = 'Contract approved, but the customer email failed to send. Use the customer portal link to share it manually.';
      }

      approvedContract.email_sent = emailSent;
      approvedContract.email_warning = emailWarning;
      return approvedContract;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesContract.approveContract:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Re-send (or send for the first time) the customer acceptance email for a
   * contract already sitting at SENT_TO_CUSTOMER — e.g. after the customer's
   * email address on file was fixed, or the first send failed/never fired.
   * Reuses the existing response token rather than minting a new one, so a
   * link already shared out-of-band keeps working.
   */
  static async resendCustomerEmail(contractId) {
    const result = await db.query(
      `SELECT sc.*, c.customer_name as customer_name_full, c.primary_email, c.customer_code
       FROM sales_contracts sc
       LEFT JOIN customers c ON sc.customer_id = c.id
       WHERE sc.id = $1 AND sc.deleted_at IS NULL`,
      [contractId]
    );
    if (result.rows.length === 0) {
      throw new Error('Contract not found');
    }
    const contract = result.rows[0];
    if (contract.status !== 'SENT_TO_CUSTOMER') {
      throw new Error('Contract is not awaiting customer response');
    }
    if (!contract.customer_response_token || contract.customer_response_token_used_at) {
      throw new Error('This contract has no active customer response link — it may already have been accepted or rejected');
    }
    if (!contract.primary_email) {
      throw new Error('This customer has no email on file — add one, or share the customer portal link manually');
    }

    const customerEmailService = require('../services/customerEmailService');
    const emailResult = await customerEmailService.sendContractEmail(contract, {
      customer_name: contract.customer_name_full || contract.customer_name,
      primary_email: contract.primary_email,
      customer_code: contract.customer_code
    });
    if (!emailResult.success) {
      throw new Error(emailResult.error || 'Failed to send contract email');
    }
    return { recipient: emailResult.recipient };
  }

  // Request approval for contract
  static async requestApproval(contractId, userId, notes = '') {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get current contract
      const contractResult = await client.query(
        'SELECT * FROM sales_contracts WHERE id = $1 AND deleted_at IS NULL',
        [contractId]
      );
      
      if (contractResult.rows.length === 0) {
        throw new Error('Contract not found');
      }
      
      const contract = contractResult.rows[0];
      
      if (contract.status !== 'DRAFT') {
        throw new Error('Only draft contracts can be submitted for approval');
      }
      
      // Update contract status
      const updateQuery = `
        UPDATE sales_contracts 
        SET 
          status = 'PENDING_APPROVAL',
          submitted_for_approval_by = $1,
          submitted_for_approval_at = NOW(),
          approval_notes = $2,
          updated_at = NOW()
        WHERE id = $3
        RETURNING *
      `;
      
      const updateResult = await client.query(updateQuery, [userId, notes, contractId]);
      const updatedContract = updateResult.rows[0];
      
      // Add status history
      await this.addStatusHistory(client, contractId, 'DRAFT', 'PENDING_APPROVAL', userId, `Contract submitted for approval: ${notes}`);
      
      // Create notification for approvers
      const Notification = require('./Notification');
      
      // Find users with approval authority for this contract value
      const doaQuery = `
        SELECT DISTINCT u.id, u.email, u.first_name, u.last_name
        FROM delegation_of_authority doa
        JOIN users u ON doa.user_id = u.id
        WHERE doa.applies_to = 'SALES_CONTRACT'
        AND doa.max_amount >= $1
        AND doa.effective_from <= CURRENT_DATE
        AND (doa.effective_until IS NULL OR doa.effective_until >= CURRENT_DATE)
        AND doa.is_active = true
      `;
      
      const approversResult = await client.query(doaQuery, [updatedContract.contract_value || 0]);
      
      for (const approver of approversResult.rows) {
        await Notification.create({
          user_id: approver.id,
          type: 'SALES_CONTRACT_SUBMITTED',
          title: `Contract Approval Required: ${updatedContract.contract_name}`,
          message: `Contract ${updatedContract.contract_number} (${updatedContract.customer_name}) submitted for approval. Value: ${updatedContract.contract_value} ${updatedContract.currency}`,
          related_type: 'CONTRACT',
          related_id: contractId
        });
      }
      
      await client.query('COMMIT');
      return updatedContract;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesContract.requestApproval:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async rejectContract(contractId, userId, rejectionReason = '') {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get current contract
      const contractResult = await client.query(
        'SELECT * FROM sales_contracts WHERE id = $1 AND deleted_at IS NULL',
        [contractId]
      );
      
      if (contractResult.rows.length === 0) {
        throw new Error('Contract not found');
      }
      
      const contract = contractResult.rows[0];
      
      if (contract.status !== 'PENDING_APPROVAL') {
        throw new Error('Contract is not pending approval');
      }
      
      // Update contract status — same approval_status column as approveContract()
      // above, kept in sync here for the same reason.
      const updateQuery = `
        UPDATE sales_contracts
        SET
          status = 'REJECTED',
          approval_status = 'REJECTED',
          rejected_by = $1,
          rejected_at = NOW(),
          rejection_reason = $2,
          updated_at = NOW()
        WHERE id = $3
        RETURNING *
      `;
      
      const updateResult = await client.query(updateQuery, [userId, rejectionReason, contractId]);
      
      // Add status history
      await this.addStatusHistory(client, contractId, 'PENDING_APPROVAL', 'REJECTED', userId, rejectionReason);
      
      await client.query('COMMIT');
      return updateResult.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in SalesContract.rejectContract:', error);
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = SalesContract;