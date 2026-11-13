const express = require('express');
const router = express.Router();
const emailService = require('../services/emailService');
const RequestForQuotation = require('../models/RequestForQuotation');
const SalesRfq = require('../models/SalesRfq');
const { query } = require('../config/database');
const { portalCompany, portalCompanyForRfq } = require('../services/portalScope');

// GET /supplier-portal/rfq/verify/:token - Verify RFQ response token
router.get('/rfq/verify/:token', portalCompanyForRfq(), async (req, res) => {
  try {
    const tokenData = emailService.verifySupplierToken(req.params.token);
    
    // Get RFQ details for display
    const rfq = await RequestForQuotation.findById(tokenData.rfqId);
    if (!rfq) {
      return res.status(404).json({
        success: false,
        error: 'RFQ not found'
      });
    }

    // Get line items
    const lineItems = await RequestForQuotation.getLineItems(tokenData.rfqId);
    
    // Get supplier info (optional, for display)
    const suppliers = await RequestForQuotation.getSuppliers(tokenData.rfqId);
    const supplier = suppliers.find(s => s.supplier_id === tokenData.supplierId);

    res.json({
      success: true,
      data: {
        rfq,
        lineItems,
        supplier,
        tokenData
      }
    });
  } catch (error) {
    console.error('Error verifying RFQ token:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Invalid or expired token'
    });
  }
});

// POST /supplier-portal/rfq/submit-quotation - Submit quotation response
router.post('/rfq/submit-quotation', portalCompanyForRfq((req) => req.body?.token), async (req, res) => {
  try {
    const { token, quotations, notes } = req.body;
    
    if (!token || !quotations || !Array.isArray(quotations)) {
      return res.status(400).json({
        success: false,
        error: 'Token and quotations array are required'
      });
    }

    // Verify token
    const tokenData = emailService.verifySupplierToken(token);
    console.log('🔍 Token data:', tokenData);
    
    // Verify supplier exists
    const Supplier = require('../models/Supplier');
    const supplier = await Supplier.findById(tokenData.supplierId);
    if (!supplier) {
      return res.status(404).json({
        success: false,
        error: `Supplier with ID ${tokenData.supplierId} not found. This quotation link may be outdated.`
      });
    }
    console.log('✅ Supplier found:', supplier.legal_name);
    
    // Verify RFQ exists and is in correct status
    const rfq = await RequestForQuotation.findById(tokenData.rfqId);
    if (!rfq) {
      return res.status(404).json({
        success: false,
        error: 'RFQ not found'
      });
    }

    if (rfq.status !== 'SENT') {
      return res.status(400).json({
        success: false,
        error: 'This RFQ is no longer accepting responses'
      });
    }

    // Submit quotations for each line item
    const submittedQuotations = [];
    for (const quotation of quotations) {
      try {
        const quotationData = {
          rfq_id: tokenData.rfqId,
          supplier_id: tokenData.supplierId,
          rfq_line_item_id: quotation.line_item_id,
          unit_price: quotation.unit_price,
          currency: quotation.currency || rfq.currency,
          lead_time_days: quotation.lead_time_days,
          delivery_terms: quotation.delivery_terms,
          payment_terms: quotation.payment_terms,
          validity_days: quotation.validity_days || 30,
          notes: quotation.notes || notes
        };

        const submitted = await RequestForQuotation.addQuotation(quotationData);
        submittedQuotations.push(submitted);
      } catch (error) {
        console.error(`Error submitting quotation for line item ${quotation.line_item_id}:`, error);
        // Continue with other quotations
      }
    }

    // Update RFQ status if this is the first response
    if (rfq.status === 'SENT') {
      try {
        await RequestForQuotation.markResponsesReceived(tokenData.rfqId);
      } catch (error) {
        console.error('Error updating RFQ status to RESPONSES_RECEIVED:', error);
        // Don't fail the submission if this fails
      }
    }

    res.json({
      success: true,
      data: {
        submittedQuotations,
        count: submittedQuotations.length
      },
      message: 'Quotation submitted successfully'
    });

  } catch (error) {
    console.error('Error submitting quotation:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to submit quotation'
    });
  }
});

// POST /supplier-portal/rfq/decline - Decline RFQ invitation
router.post('/rfq/decline', portalCompanyForRfq((req) => req.body?.token), async (req, res) => {
  try {
    const { token, reason } = req.body;
    
    if (!token || !reason) {
      return res.status(400).json({
        success: false,
        error: 'Token and reason are required'
      });
    }

    // Verify token
    const tokenData = emailService.verifySupplierToken(token);
    
    res.json({
      success: true,
      message: 'RFQ invitation declined successfully'
    });

  } catch (error) {
    console.error('Error declining RFQ:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to decline RFQ'
    });
  }
});

// GET /supplier-portal/delivery/verify/:token - Verify delivery token and get PO details
router.get('/delivery/verify/:token', portalCompany('supplier_delivery'), async (req, res) => {
  try {
    const { token } = req.params;
    
    // Get PO by delivery token
    const query = `
      SELECT po.*,
             s.legal_name as supplier_name,
             s.supplier_code,
             s.email as supplier_email
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      WHERE po.supplier_delivery_token = $1
    `;
    
    const result = await require('../config/database').query(query, [token]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found or invalid delivery token'
      });
    }
    
    const po = result.rows[0];
    
    // Check if delivery token is still valid
    if (po.supplier_delivery_due && new Date() > new Date(po.supplier_delivery_due)) {
      return res.status(400).json({
        success: false,
        error: 'Delivery confirmation period has expired'
      });
    }
    
    // Get line items
    const PurchaseOrder = require('../models/PurchaseOrder');
    const lineItems = await PurchaseOrder.getLineItems(po.id);
    
    res.json({
      success: true,
      data: {
        po,
        lineItems,
        supplier: {
          legal_name: po.supplier_name,
          supplier_code: po.supplier_code,
          email: po.supplier_email
        }
      }
    });
  } catch (error) {
    console.error('Error verifying delivery token:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify delivery token'
    });
  }
});

// POST /supplier-portal/delivery/update-status - Update delivery status
router.post('/delivery/update-status', portalCompany('supplier_delivery', (req) => req.body?.token), async (req, res) => {
  try {
    const { token, status, notes } = req.body;
    
    if (!token || !status) {
      return res.status(400).json({
        success: false,
        error: 'Token and status are required'
      });
    }
    
    // Validate status
    const validStatuses = ['CONFIRMED', 'PREPARING_DELIVERY', 'IN_TRANSIT', 'DELIVERED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid delivery status'
      });
    }
    
    // Get PO by token with sales relationship info (delivery status updates span
    // multiple calls on the same token, so this stays valid until the delivery
    // window expires — not single-use).
    const poResult = await require('../config/database').query(
      `SELECT id, status as current_status, sales_order_id, source_type FROM purchase_orders
       WHERE supplier_delivery_token = $1
         AND (supplier_delivery_token_expires_at IS NULL OR supplier_delivery_token_expires_at > NOW())`,
      [token]
    );
    
    if (poResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found or invalid token'
      });
    }
    
    const po = poResult.rows[0];
    
    // Determine correct status based on sales relationship when delivered
    let finalStatus = status;
    if (status === 'DELIVERED') {
      // Check if this is a sales-related PO
      const isSalesRelated = po.sales_order_id || 
                            po.source_type?.includes('sales_order') || 
                            po.source_type?.includes('contract_sales');
      
      finalStatus = isSalesRelated ? 'READY_FOR_CUSTOMER_DELIVERY' : 'DELIVERED';
    }
    
    // Update PO status and notes
    const updateQuery = `
      UPDATE purchase_orders 
      SET status = $1::varchar, 
          delivery_notes = $2,
          delivery_confirmed_at = CASE WHEN $1::varchar IN ('DELIVERED', 'READY_FOR_CUSTOMER_DELIVERY') THEN CURRENT_TIMESTAMP ELSE delivery_confirmed_at END,
          updated_at = CURRENT_TIMESTAMP
      WHERE supplier_delivery_token = $3
      RETURNING *
    `;
    
    const updateResult = await require('../config/database').query(updateQuery, [finalStatus, notes, token]);
    
    if (updateResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Failed to update delivery status'
      });
    }
    
    res.json({
      success: true,
      data: updateResult.rows[0],
      message: 'Delivery status updated successfully'
    });
    
  } catch (error) {
    console.error('Error updating delivery status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update delivery status'
    });
  }
});

// Get Sales RFQ for supplier response (public endpoint with token)
router.get('/sales-rfq/:token', portalCompany('supplier_rfq'), async (req, res) => {
  try {
    const { token } = req.params;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Response token is required'
      });
    }

    // Find RFQ by response token (simplified query for reliability)
    const rfqQuery = `
      SELECT sr.*
      FROM sales_rfqs sr
      WHERE sr.response_token = $1
        AND sr.deleted_at IS NULL
        AND sr.status IN ('SENT', 'RESPONDED', 'PARTIALLY_RESPONDED')
        AND (sr.response_token_expires_at IS NULL OR sr.response_token_expires_at > NOW())
    `;

    const rfqResult = await query(rfqQuery, [token]);
    
    if (rfqResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Sales RFQ not found or access denied'
      });
    }

    const rfq = rfqResult.rows[0];

    // Get RFQ items
    const itemsQuery = `
      SELECT * FROM sales_rfq_items 
      WHERE sales_rfq_id = $1 
      ORDER BY created_at ASC
    `;
    
    const itemsResult = await query(itemsQuery, [rfq.id]);
    rfq.items = itemsResult.rows;

    // Get any existing supplier response
    const responseQuery = `
      SELECT * FROM sales_rfq_supplier_responses 
      WHERE sales_rfq_id = $1 
      ORDER BY created_at DESC 
      LIMIT 1
    `;
    
    const responseResult = await query(responseQuery, [rfq.id]);
    rfq.supplier_response = responseResult.rows[0] || null;

    res.json({
      success: true,
      data: rfq
    });
  } catch (error) {
    console.error('Error fetching Sales RFQ for supplier:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch Sales RFQ'
    });
  }
});

// Submit supplier response to Sales RFQ (public endpoint with token)
router.post('/sales-rfq/:token/respond', portalCompany('supplier_rfq'), async (req, res) => {
  try {
    const { token } = req.params;
    const {
      supplier_total_amount,
      supplier_currency,
      supplier_validity_days,
      supplier_comments,
      supplier_alternative_items,
      items
    } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Response token is required'
      });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one item response is required'
      });
    }

    // Validate items
    for (const item of items) {
      if (!item.quoted_unit_price || parseFloat(item.quoted_unit_price) <= 0) {
        return res.status(400).json({
          success: false,
          error: 'All items must have valid quoted unit prices'
        });
      }
    }

    // Find RFQ by token
    const rfqQuery = `
      SELECT * FROM sales_rfqs 
      WHERE response_token = $1 
        
        AND status IN ('SENT', 'RESPONDED', 'PARTIALLY_RESPONDED')
    `;
    
    const rfqResult = await query(rfqQuery, [token]);
    
    if (rfqResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Sales RFQ not found or access denied'
      });
    }

    const rfq = rfqResult.rows[0];

    // Check if response deadline has passed
    if (rfq.response_deadline && new Date() > new Date(rfq.response_deadline)) {
      return res.status(400).json({
        success: false,
        error: 'Response deadline has passed'
      });
    }

    const db = require('../config/database');
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Check if response tables exist, create if not
      await client.query(`
        CREATE TABLE IF NOT EXISTS sales_rfq_supplier_responses (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          sales_rfq_id UUID NOT NULL REFERENCES sales_rfqs(id),
          supplier_total_amount NUMERIC(12,2),
          supplier_currency VARCHAR(3) DEFAULT 'USD',
          supplier_validity_days INTEGER DEFAULT 30,
          supplier_comments TEXT,
          supplier_alternative_items TEXT,
          supplier_response_method VARCHAR(20) DEFAULT 'SYSTEM',
          responded_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS sales_rfq_item_responses (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          response_id UUID NOT NULL,
          sales_rfq_item_id UUID,
          item_name VARCHAR(255) NOT NULL,
          requested_quantity NUMERIC(10,3) NOT NULL,
          unit_of_measure VARCHAR(50) NOT NULL,
          quoted_unit_price NUMERIC(12,2) NOT NULL,
          quoted_total_price NUMERIC(12,2) NOT NULL,
          availability_status VARCHAR(20) DEFAULT 'AVAILABLE',
          lead_time_days INTEGER,
          supplier_notes TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Insert or update supplier response
      const responseData = {
        supplier_total_amount: parseFloat(supplier_total_amount),
        supplier_currency: supplier_currency || 'USD',
        supplier_validity_days: parseInt(supplier_validity_days) || 30,
        supplier_comments,
        supplier_alternative_items,
        supplier_response_method: 'SYSTEM',
        responded_at: new Date()
      };

      // Check if response already exists
      const existingResponseQuery = `
        SELECT id FROM sales_rfq_supplier_responses 
        WHERE sales_rfq_id = $1
      `;
      
      const existingResponse = await client.query(existingResponseQuery, [rfq.id]);
      
      let responseId;
      
      if (existingResponse.rows.length > 0) {
        // Update existing response
        responseId = existingResponse.rows[0].id;
        const updateResponseQuery = `
          UPDATE sales_rfq_supplier_responses 
          SET 
            supplier_total_amount = $2,
            supplier_currency = $3,
            supplier_validity_days = $4,
            supplier_comments = $5,
            supplier_alternative_items = $6,
            supplier_response_method = $7,
            responded_at = $8,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *
        `;
        
        await client.query(updateResponseQuery, [
          responseId,
          responseData.supplier_total_amount,
          responseData.supplier_currency,
          responseData.supplier_validity_days,
          responseData.supplier_comments,
          responseData.supplier_alternative_items,
          responseData.supplier_response_method,
          responseData.responded_at
        ]);
      } else {
        // Create new response
        const insertResponseQuery = `
          INSERT INTO sales_rfq_supplier_responses (
            id, sales_rfq_id, supplier_total_amount, supplier_currency,
            supplier_validity_days, supplier_comments, supplier_alternative_items,
            supplier_response_method, responded_at, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8,
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          ) RETURNING id
        `;
        
        const responseResult = await client.query(insertResponseQuery, [
          rfq.id,
          responseData.supplier_total_amount,
          responseData.supplier_currency,
          responseData.supplier_validity_days,
          responseData.supplier_comments,
          responseData.supplier_alternative_items,
          responseData.supplier_response_method,
          responseData.responded_at
        ]);
        
        responseId = responseResult.rows[0].id;
      }

      // Delete existing item responses
      await client.query('DELETE FROM sales_rfq_item_responses WHERE response_id = $1', [responseId]);

      // Insert item responses
      for (const item of items) {
        const insertItemQuery = `
          INSERT INTO sales_rfq_item_responses (
            id, response_id, sales_rfq_item_id, item_name, 
            requested_quantity, unit_of_measure, quoted_unit_price,
            quoted_total_price, availability_status, lead_time_days,
            supplier_notes, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
        `;
        
        await client.query(insertItemQuery, [
          responseId,
          item.sales_rfq_item_id || null,
          item.item_name,
          parseFloat(item.requested_quantity),
          item.unit_of_measure,
          parseFloat(item.quoted_unit_price),
          parseFloat(item.quoted_total_price),
          item.availability_status || 'AVAILABLE',
          item.lead_time_days ? parseInt(item.lead_time_days) : null,
          item.supplier_notes
        ]);
      }

      // Update RFQ status to RESPONDED
      const updateRfqQuery = `
        UPDATE sales_rfqs 
        SET 
          status = 'RESPONDED',
          supplier_total_amount = $2,
          supplier_currency = $3,
          supplier_validity_days = $4,
          supplier_comments = $5,
          supplier_alternative_items = $6,
          supplier_response_method = 'SYSTEM',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `;
      
      const updatedRfq = await client.query(updateRfqQuery, [
        rfq.id,
        responseData.supplier_total_amount,
        responseData.supplier_currency,
        responseData.supplier_validity_days,
        responseData.supplier_comments,
        responseData.supplier_alternative_items
      ]);

      // Create notification for sales team
      const notificationQuery = `
        INSERT INTO notifications (
          id, type, title, message, user_id, data, is_read, created_at
        ) VALUES (
          gen_random_uuid(), 'SALES_RFQ_SUPPLIER_RESPONDED', 
          'Sales RFQ Response Received',
          'Supplier has responded to Sales RFQ ' || $2,
          $1, $3, false, CURRENT_TIMESTAMP
        )
      `;
      
      await client.query(notificationQuery, [
        rfq.created_by,
        rfq.rfq_number,
        JSON.stringify({ sales_rfq_id: rfq.id, rfq_number: rfq.rfq_number })
      ]);

      await client.query('COMMIT');

      res.json({
        success: true,
        data: updatedRfq.rows[0],
        message: 'Response submitted successfully'
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('Error submitting Sales RFQ response:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to submit response'
    });
  }
});

// Get supplier portal dashboard data (public endpoint with basic supplier info)
router.get('/dashboard/:supplierId', async (req, res) => {
  try {
    const { supplierId } = req.params;
    
    // Get supplier basic info
    const supplierQuery = `
      SELECT id, company_name, contact_person, email, phone, status
      FROM suppliers 
      WHERE id = $1 
    `;
    
    const supplierResult = await query(supplierQuery, [supplierId]);
    
    if (supplierResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Supplier not found'
      });
    }

    const supplier = supplierResult.rows[0];

    // Get pending Sales RFQs
    const pendingRfqsQuery = `
      SELECT 
        sr.id, sr.response_token, sr.rfq_number, sr.rfq_title, sr.status,
        sr.required_delivery_date, sr.response_deadline,
        sr.priority, sr.created_at,
        c.company_name as customer_company_name
      FROM sales_rfqs sr
      LEFT JOIN customers c ON sr.linked_customer_id = c.id
      WHERE sr.supplier_id = $1
        AND sr.status = 'SENT'
        AND sr.deleted_at IS NULL
      ORDER BY sr.response_deadline ASC, sr.created_at DESC
    `;
    
    const pendingRfqs = await query(pendingRfqsQuery, [supplierId]);

    // Get recent responses
    const recentResponsesQuery = `
      SELECT 
        sr.id, sr.response_token, sr.rfq_number, sr.rfq_title, sr.status,
        sr.supplier_total_amount, sr.supplier_currency,
        sr.created_at, sr.updated_at,
        c.company_name as customer_company_name
      FROM sales_rfqs sr
      LEFT JOIN customers c ON sr.linked_customer_id = c.id
      WHERE sr.supplier_id = $1
        AND sr.status IN ('RESPONDED', 'PARTIALLY_RESPONDED', 'COMPLETED')
        AND sr.deleted_at IS NULL
      ORDER BY sr.updated_at DESC
      LIMIT 10
    `;
    
    const recentResponses = await query(recentResponsesQuery, [supplierId]);

    res.json({
      success: true,
      data: {
        supplier,
        pending_rfqs: pendingRfqs.rows,
        recent_responses: recentResponses.rows,
        stats: {
          pending_rfqs: pendingRfqs.rows.length,
          total_responses: recentResponses.rows.length
        }
      }
    });
    
  } catch (error) {
    console.error('Error fetching supplier portal dashboard:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard data'
    });
  }
});


// ---------------------------------------------------------------------------
// Supplier partnership onboarding (public token-free invitation links) and the
// legacy supplier RFQ response flow. These pages existed in the frontend but
// their endpoints were never implemented. All reads/writes go through SECURITY
// DEFINER portal_* functions (migration 202608120700): suppliers and RFQs are
// RLS company-scoped, and a public page has no company context to name.
// ---------------------------------------------------------------------------

// GET /supplier-portal/supplier/:supplierId - public lookup for the
// partnership invitation page.
router.get('/supplier/:supplierId', async (req, res) => {
  try {
    const { rows } = await query('SELECT portal_supplier_lookup($1::uuid) AS row', [req.params.supplierId]);
    const supplier = rows[0]?.row;
    if (!supplier) {
      return res.status(404).json({ success: false, error: 'Supplier not found' });
    }
    const message = supplier.partnership_status === 'ACCEPTED' ? 'already_accepted'
      : supplier.partnership_status === 'DECLINED' ? 'already_declined' : 'pending';
    res.json({ success: true, data: { supplier, message } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || 'Failed to load supplier' });
  }
});

// POST /supplier-portal/partnership/accept/:supplierId
router.post('/partnership/accept/:supplierId', async (req, res) => {
  try {
    const { rows } = await query('SELECT portal_partnership_accept($1::uuid) AS row', [req.params.supplierId]);
    if (!rows[0]?.row) {
      return res.status(404).json({ success: false, error: 'Supplier not found' });
    }
    res.json({ success: true, data: { supplier: rows[0].row } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || 'Failed to accept partnership' });
  }
});

// POST /supplier-portal/partnership/decline/:supplierId
router.post('/partnership/decline/:supplierId', async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || null;
    const { rows } = await query('SELECT portal_partnership_decline($1::uuid, $2) AS row', [req.params.supplierId, reason]);
    if (!rows[0]?.row) {
      return res.status(404).json({ success: false, error: 'Supplier not found' });
    }
    res.json({ success: true, data: { supplier: rows[0].row } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || 'Failed to decline partnership' });
  }
});

// GET /supplier-portal/rfq-response/:token - load an RFQ, its line items, the
// supplier and any quotations already submitted on this token.
router.get('/rfq-response/:token', async (req, res) => {
  try {
    const tokenData = emailService.verifySupplierToken(req.params.token);
    const { rows } = await query(
      'SELECT portal_rfq_response_lookup($1::uuid, $2::uuid) AS row',
      [tokenData.rfqId, tokenData.supplierId]
    );
    const data = rows[0]?.row;
    if (!data) {
      return res.status(404).json({ success: false, error: 'RFQ not found' });
    }
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || 'Invalid or expired token' });
  }
});

// POST /supplier-portal/rfq-response/:token - submit (or update) quotations.
router.post('/rfq-response/:token', async (req, res) => {
  try {
    const tokenData = emailService.verifySupplierToken(req.params.token);
    const quotations = (req.body && req.body.quotations) || [];
    if (!Array.isArray(quotations) || quotations.length === 0) {
      return res.status(400).json({ success: false, error: 'Quotations are required' });
    }
    let submitted = 0;
    for (const q of quotations) {
      if (!q.rfq_line_item_id) continue;
      await query(
        `SELECT portal_rfq_response_upsert($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10)`,
        [tokenData.rfqId, tokenData.supplierId, q.rfq_line_item_id,
         Number(q.unit_price) || 0, q.currency || 'USD',
         q.lead_time_days ? Number(q.lead_time_days) : null,
         q.delivery_terms || null, q.payment_terms || null,
         q.validity_days ? Number(q.validity_days) : null, q.notes || null]
      );
      submitted++;
    }
    if (submitted === 0) {
      return res.status(400).json({ success: false, error: 'No valid line items to submit' });
    }
    res.json({ success: true, data: { submitted }, message: 'Quotation submitted successfully' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || 'Failed to submit quotation' });
  }
});

module.exports = router;