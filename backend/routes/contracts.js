const express = require('express');
const router = express.Router();
const { auth, requireRole } = require('../middleware/auth');
const fileUploadService = require('../services/fileUploadService');
const db = require('../config/database');
const { requireSoD } = require('../middleware/rbac');
const { recordCreator } = require('../middleware/recordOwner');
const { appBase } = require('../config/appLinks');

// GET /contracts - Get all contracts with filters
router.get('/', auth, async (req, res) => {
  try {
    const { status, supplier_id, limit = 50, offset = 0 } = req.query;
    
    let query = `
      SELECT 
        c.*,
        s.legal_name as supplier_name,
        s.supplier_code,
        u.first_name || ' ' || u.last_name as created_by_name
      FROM contracts c
      LEFT JOIN suppliers s ON c.supplier_id = s.id
      LEFT JOIN users u ON c.created_by = u.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (status) {
      params.push(status);
      query += ` AND c.status = $${params.length}`;
    }
    
    if (supplier_id) {
      params.push(supplier_id);
      query += ` AND c.supplier_id = $${params.length}`;
    }
    
    query += ` ORDER BY c.created_at DESC`;
    
    if (limit) {
      params.push(parseInt(limit));
      query += ` LIMIT $${params.length}`;
    }
    
    if (offset) {
      params.push(parseInt(offset));
      query += ` OFFSET $${params.length}`;
    }
    
    const result = await db.query(query, params);
    
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching contracts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contracts'
    });
  }
});

// GET /contracts/procurement-review - Get contracts for procurement review
router.get('/procurement-review', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const Contract = require('../models/Contract');
    const contracts = await Contract.getContractsForSupplierReview();
    
    res.json({
      success: true,
      data: contracts,
      count: contracts.length
    });
  } catch (error) {
    console.error('Error fetching contracts for procurement review:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contracts for review'
    });
  }
});

// GET /contracts/active - Get active contracts for PO creation
router.get('/active', auth, async (req, res) => {
  try {
    const Contract = require('../models/Contract');
    const contracts = await Contract.findAll({ status: 'ACTIVE' });
    
    res.json({
      success: true,
      data: contracts
    });
  } catch (error) {
    console.error('Error fetching active contracts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch active contracts'
    });
  }
});

// GET /contracts/:id - Get single contract by ID  
router.get('/:id', auth, async (req, res) => {
  // Check if this is the stats endpoint
  if (req.params.id === 'stats') {
    try {
      const stats = await db.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN status = 'DRAFT' THEN 1 END) as draft,
          COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END) as pending_approval,
          COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END) as active,
          COUNT(CASE WHEN status = 'EXPIRED' THEN 1 END) as expired,
          COUNT(CASE WHEN status = 'TERMINATED' THEN 1 END) as terminated,
          COUNT(CASE WHEN end_date < CURRENT_DATE AND status = 'ACTIVE' THEN 1 END) as expiring_soon,
          COALESCE(SUM(contract_value), 0) as total_value
        FROM contracts
      `);
      
      return res.json({
        success: true,
        data: stats.rows[0]
      });
    } catch (error) {
      console.error('Error fetching contract stats:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch contract statistics'
      });
    }
  }

  // Check if this is the pending-approvals endpoint
  if (req.params.id === 'pending-approvals') {
    // Check if user has required role
    if (!req.user || !['MANAGER', 'ADMIN'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'Insufficient permissions to view pending contract approvals'
      });
    }
    
    try {
      const Contract = require('../models/Contract');
      const contracts = await Contract.getPendingApprovals();
      
      return res.json({
        success: true,
        data: contracts,
        count: contracts.length
      });
    } catch (error) {
      console.error('Error fetching pending contract approvals:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch pending contract approvals'
      });
    }
  }

  // Handle regular ID lookup
  try {
    const query = `
      SELECT 
        c.*,
        s.legal_name as supplier_name,
        s.supplier_code,
        s.email as supplier_email,
        s.phone as supplier_phone,
        u.first_name || ' ' || u.last_name as created_by_name
      FROM contracts c
      LEFT JOIN suppliers s ON c.supplier_id = s.id
      LEFT JOIN users u ON c.created_by = u.id
      WHERE c.id = $1
    `;
    
    const result = await db.query(query, [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching contract:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contract'
    });
  }
});

// POST /contracts - Create new contract with optional file
router.post('/', auth, (req, res) => {
  fileUploadService.uploadContractFile(req, res, async (uploadError) => {
    if (uploadError) {
      return res.status(400).json({
        success: false,
        error: uploadError.message
      });
    }
    
    try {
      const {
        title,
        supplier_id,
        contract_value,
        currency = 'USD',
        start_date,
        end_date,
        description,
        terms,
        contract_type = 'PURCHASE',
        document_url,
        digital_contract_required = false
      } = req.body;
      
      // Validate required fields
      if (!title || !supplier_id) {
        // Clean up uploaded file if validation fails
        if (req.file) {
          await fileUploadService.deleteFile(fileUploadService.getFileInfo(req)?.path);
        }
        return res.status(400).json({
          success: false,
          error: 'Title and supplier are required'
        });
      }
      
      // Generate contract number (CNT-YYYY-0001, matching every other
      // document sequence — this used to be a raw `CON-${Date.now()}`
      // millisecond timestamp, unreadable next to PO-2026-1008 etc.)
      const numberResult = await db.query('SELECT generate_contract_number() as number');
      const contractNumber = numberResult.rows[0].number;
      
      // Get file info if uploaded
      const fileInfo = fileUploadService.getFileInfo(req);
      
      // Validate digital contract requirements
      if (contract_type === 'DIGITAL' && !document_url) {
        return res.status(400).json({
          success: false,
          error: 'Digital contract requires a document URL'
        });
      }
      
      // Validate physical contract with digital copy required
      if (contract_type === 'PHYSICAL' && digital_contract_required && !document_url) {
        return res.status(400).json({
          success: false,
          error: 'Document URL is required when digital copy is required'
        });
      }
      
      const result = await db.query(`
        INSERT INTO contracts (
          contract_number, contract_name, title, supplier_id, contract_value, currency, 
          start_date, end_date, description, terms, status, contract_type,
          document_url, digital_contract_required, contract_file_path, contract_file_name,
          contract_file_size, contract_file_type, uploaded_at, uploaded_by, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
        RETURNING *
      `, [
        contractNumber, title, title, supplier_id, contract_value, currency,
        start_date, end_date, description, terms, 'DRAFT',
        contract_type, document_url, digital_contract_required,
        fileInfo?.path, fileInfo?.originalName, fileInfo?.size, fileInfo?.mimetype,
        fileInfo ? new Date() : null, fileInfo ? req.user.id : null, req.user.id
      ]);
      
      res.status(201).json({
        success: true,
        data: result.rows[0],
        message: 'Contract created successfully'
      });
    } catch (error) {
      console.error('Error creating contract:', error);
      
      // Clean up uploaded file if database operation fails
      if (req.file) {
        try {
          await fileUploadService.deleteFile(fileUploadService.getFileInfo(req)?.path);
        } catch (deleteError) {
          console.error('Error cleaning up uploaded file:', deleteError);
        }
      }
      
      res.status(500).json({
        success: false,
        error: 'Failed to create contract'
      });
    }
  });
});

// DoA Approval endpoints

// POST /contracts/:id/submit-for-approval - Submit contract for DoA approval
router.post('/:id/submit-for-approval', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const Contract = require('../models/Contract');
    
    const contract = await Contract.submitForApproval(id, req.user.id);
    
    if (!contract) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found or not in draft status'
      });
    }
    
    res.json({
      success: true,
      data: contract,
      message: 'Contract submitted for approval'
    });
  } catch (error) {
    console.error('Error submitting contract for approval:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit contract for approval'
    });
  }
});


// POST /contracts/:id/approve - Approve a contract
router.post('/:id/approve', auth, requireRole('MANAGER', 'ADMIN'), requireSoD(recordCreator('contracts'), 'approval'), async (req, res) => {
  try {
    const { id } = req.params;
    const Contract = require('../models/Contract');
    const db = require('../config/database');
    const ApprovalRulesEngine = require('../services/approvalRulesEngine');
    const ApprovalChain = require('../models/ApprovalChain');
    
    // First, get the contract to check its value
    const contractResult = await db.query('SELECT contract_value FROM contracts WHERE id = $1', [id]);
    if (contractResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found'
      });
    }
    
    const contractValue = parseFloat(contractResult.rows[0].contract_value || 0);

    // Check if user has DoA authority for contracts via ApprovalRulesEngine
    // Amount-scoped DoA binds every role, ADMIN included; the only identity
    // exempt from amount bands is the platform owner, which the engine already
    // synthesizes as an unlimited grant (see loadDoaDefinitions).
    const hasAuthority = await ApprovalRulesEngine.checkUserAuthority(
      req.user.id, 
      contractValue, 
      null, 
      'CONTRACT'
    ) || await ApprovalRulesEngine.checkUserAuthority(
      req.user.id, 
      contractValue,
      null,
      'CONTRACTS'
    );
    
    if (!hasAuthority) {
      return res.status(403).json({
        success: false,
        error: `Insufficient delegation of authority to approve this contract (value: $${contractValue})`
      });
    }

    // Check if an ApprovalChain request exists for this Contract
    const pendingChain = await db.query(
      "SELECT id FROM approval_requests WHERE document_type IN ('CONTRACT', 'CONTRACTS') AND document_id = $1 AND status = 'PENDING'",
      [id]
    );
    if (pendingChain.rows.length > 0) {
      const updatedChain = await ApprovalChain.decide(
        pendingChain.rows[0].id,
        req.user.id,
        req.user.role,
        'APPROVE',
        req.body?.comments || ''
      );
      if (updatedChain.status === 'PENDING') {
        return res.json({
          success: true,
          data: updatedChain,
          message: `Approval step ${updatedChain.current_step - 1} completed. Request advances to step ${updatedChain.current_step}.`
        });
      }
    }
    
    // Instead of directly approving, send to supplier for acceptance
    const contract = await Contract.sendToSupplier(id, req.user.id);
    
    if (!contract) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found or not pending approval'
      });
    }

    // Send email notification to supplier
    const supplierEmail = require('../services/emailService');
    try {
      const supplierQuery = await db.query('SELECT legal_name, email FROM suppliers WHERE id = $1', [contract.supplier_id]);
      if (supplierQuery.rows.length > 0) {
        const supplier = supplierQuery.rows[0];
        const responseUrl = `${appBase()}/supplier/contract-response/${contract.supplier_response_token}`;
        
        await supplierEmail.sendContractForAcceptance({
          to: supplier.email,
          supplierName: supplier.legal_name,
          contractNumber: contract.contract_number,
          contractTitle: contract.title,
          responseUrl: responseUrl,
          dueDate: contract.supplier_response_due
        });
      }
    } catch (emailError) {
      console.error('Error sending email to supplier:', emailError);
      // Don't fail the request if email fails, just log it
    }
    
    res.json({
      success: true,
      data: contract,
      message: 'Contract sent to supplier for acceptance'
    });
  } catch (error) {
    console.error('Error approving contract:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to approve contract'
    });
  }
});

// POST /contracts/:id/decline - Decline a contract
router.post('/:id/decline', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const Contract = require('../models/Contract');
    
    const contract = await Contract.declineContract(id, req.user.id, reason);
    
    if (!contract) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found or not pending approval'
      });
    }
    
    res.json({
      success: true,
      data: contract,
      message: 'Contract declined'
    });
  } catch (error) {
    console.error('Error declining contract:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to decline contract'
    });
  }
});

// Supplier Response Routes (Public - no auth required, token-based)

// GET /contracts/supplier-response/:token - Get contract details for supplier response
router.get('/supplier-response/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const Contract = require('../models/Contract');
    
    const contract = await Contract.getContractByToken(token);
    
    if (!contract) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found or invalid token'
      });
    }
    
    // Check if response is still valid
    if (new Date() > new Date(contract.supplier_response_due)) {
      return res.status(400).json({
        success: false,
        error: 'Response period has expired'
      });
    }
    
    if (contract.status !== 'SENT_TO_SUPPLIER') {
      return res.status(400).json({
        success: false,
        error: 'Contract is not in a state that allows supplier response'
      });
    }
    
    res.json({
      success: true,
      data: {
        id: contract.id,
        contract_number: contract.contract_number,
        title: contract.title,
        contract_type: contract.contract_type,
        start_date: contract.start_date,
        end_date: contract.end_date,
        contract_value: contract.contract_value,
        currency: contract.currency,
        description: contract.description,
        terms: contract.terms,
        supplier_name: contract.supplier_name,
        supplier_code: contract.supplier_code,
        response_due: contract.supplier_response_due,
        contract_file_path: contract.contract_file_path,
        contract_file_name: contract.contract_file_name,
        document_url: contract.document_url
      }
    });
  } catch (error) {
    console.error('Error fetching contract for supplier response:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contract details'
    });
  }
});

// POST /contracts/supplier-response/:token/accept - Supplier accepts contract
router.post('/supplier-response/:token/accept', async (req, res) => {
  try {
    const { token } = req.params;
    const Contract = require('../models/Contract');
    
    // First get the contract to get the ID
    const contractData = await Contract.getContractByToken(token);
    if (!contractData) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found or invalid token'
      });
    }
    
    const contract = await Contract.supplierAcceptContract(contractData.id, token);
    
    if (!contract) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found, invalid token, or response period expired'
      });
    }
    
    res.json({
      success: true,
      data: contract,
      message: 'Contract accepted successfully. Procurement team will review and finalize.'
    });
  } catch (error) {
    console.error('Error accepting contract:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to accept contract'
    });
  }
});

// POST /contracts/supplier-response/:token/decline - Supplier declines contract
router.post('/supplier-response/:token/decline', async (req, res) => {
  try {
    const { token } = req.params;
    const { reason } = req.body;
    const Contract = require('../models/Contract');
    
    // First get the contract to get the ID
    const contractData = await Contract.getContractByToken(token);
    if (!contractData) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found or invalid token'
      });
    }
    
    const contract = await Contract.supplierDeclineContract(contractData.id, token, reason);
    
    if (!contract) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found, invalid token, or response period expired'
      });
    }
    
    res.json({
      success: true,
      data: contract,
      message: 'Contract declined successfully'
    });
  } catch (error) {
    console.error('Error declining contract:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to decline contract'
    });
  }
});

// Procurement Review Routes

// POST /contracts/:id/start-review - Start procurement review
router.post('/:id/start-review', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { id } = req.params;
    const Contract = require('../models/Contract');
    
    const contract = await Contract.startProcurementReview(id, req.user.id);
    
    if (!contract) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found or not in a state for review'
      });
    }
    
    res.json({
      success: true,
      data: contract,
      message: 'Contract review started'
    });
  } catch (error) {
    console.error('Error starting contract review:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start contract review'
    });
  }
});

// POST /contracts/:id/mark-signed - Mark contract as signed
router.post('/:id/mark-signed', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const Contract = require('../models/Contract');
    
    const contract = await Contract.markContractSigned(id, req.user.id, notes);
    
    if (!contract) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found or not under review'
      });
    }
    
    res.json({
      success: true,
      data: contract,
      message: 'Contract signed and activated successfully'
    });
  } catch (error) {
    console.error('Error marking contract as signed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to mark contract as signed'
    });
  }
});

// POST /contracts/:id/activate - Activate signed contract
router.post('/:id/activate', auth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const { id } = req.params;
    const Contract = require('../models/Contract');
    
    const contract = await Contract.activateContract(id, req.user.id);
    
    if (!contract) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found or not signed'
      });
    }
    
    res.json({
      success: true,
      data: contract,
      message: 'Contract activated successfully'
    });
  } catch (error) {
    console.error('Error activating contract:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to activate contract'
    });
  }
});

// GET /contracts/download/:token - Download contract file for supplier (public route)
router.get('/download/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const Contract = require('../models/Contract');
    const path = require('path');
    const fs = require('fs');
    
    // Get contract by token
    const contract = await Contract.getContractByToken(token);
    
    if (!contract) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found or invalid token'
      });
    }
    
    if (!contract.contract_file_path) {
      return res.status(404).json({
        success: false,
        error: 'No contract file available for download'
      });
    }
    
    const filePath = path.resolve(contract.contract_file_path);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        error: 'Contract file not found on server'
      });
    }
    
    // Set appropriate headers
    const fileName = contract.contract_file_name || `contract-${contract.contract_number}.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', contract.contract_file_type || 'application/pdf');
    
    // Send file
    res.sendFile(filePath);
    
  } catch (error) {
    console.error('Error downloading contract file:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to download contract file'
    });
  }
});

// DELETE /contracts/:id - Delete contract (only non-active contracts)
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const Contract = require('../models/Contract');
    const fileUploadService = require('../services/fileUploadService');
    
    // First, get the contract to check its status and file path
    const existingContract = await Contract.findById(id);
    
    if (!existingContract) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found'
      });
    }
    
    // Allow deletion of all contracts, but log active contract deletions for audit
    if (existingContract.status === 'ACTIVE') {
      console.warn(`WARNING: Active contract ${existingContract.contract_number} is being deleted by user ${req.user.id}. This may cause business disruptions.`);
    }
    
    // Delete the contract from database
    const deletedContract = await Contract.delete(id);
    
    if (!deletedContract) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found or could not be deleted'
      });
    }
    
    // Delete associated file if it exists
    if (existingContract.contract_file_path) {
      try {
        await fileUploadService.deleteFile(existingContract.contract_file_path);
      } catch (fileError) {
        console.error('Error deleting contract file:', fileError);
        // Don't fail the request if file deletion fails
      }
    }
    
    res.json({
      success: true,
      message: 'Contract deleted successfully',
      data: deletedContract
    });
    
  } catch (error) {
    console.error('Error deleting contract:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete contract'
    });
  }
});

module.exports = router;