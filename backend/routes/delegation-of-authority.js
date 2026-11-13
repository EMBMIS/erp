/**
 * Delegation of Authority routes.
 *
 * HTTP + persistence only. All rule evaluation ("who approves this", amount
 * bands, applies_to matching, delegation, escalation) lives in
 * services/approvalRulesEngine.js — the single authority on approval routing.
 */

const express = require('express');
const router = express.Router();
const DelegationOfAuthority = require('../models/DelegationOfAuthority');
const ApprovalRulesEngine = require('../services/approvalRulesEngine');
const doaConfig = require('../config/doaConfig');
const { auth, requireRole } = require('../middleware/auth');

/** Wrap a handler with the standard try/catch + 500 envelope. */
function wrap(errorMessage, handler, mapError) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const mapped = mapError && mapError(error);
      if (mapped) {
        return res.status(mapped.status).json({ success: false, error: mapped.error });
      }
      console.error(errorMessage + ':', error);
      res.status(500).json({ success: false, error: errorMessage });
    }
  };
}

/** Compact 4xx envelope. */
function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

/** Engine-owned check: does this user hold active DoA for the transaction type? */
function userHasAuthority(userId, transactionType) {
  return ApprovalRulesEngine.userHasAuthority(userId, transactionType);
}

/**
 * Shared pending-items flow: read the user's engine-evaluated authority for a
 * transaction type; return it (or an empty list) alongside the pending items.
 */
function pendingAuthority(transactionType, fetchData, noAuthMessage, errorMessage, emptyAuthority = false) {
  return async (req, res) => {
    try {
      const authority = await ApprovalRulesEngine.loadDoaDefinitions({
        userId: req.user.id,
        transactionType
      });

      if (authority.length === 0) {
        const payload = emptyAuthority
          ? { success: true, data: [], authority: [], message: noAuthMessage }
          : { success: true, data: [], message: noAuthMessage };
        return res.json(payload);
      }

      res.json({ success: true, data: await fetchData(), authority });
    } catch (error) {
      console.error(errorMessage + ':', error);
      res.status(500).json({ success: false, error: errorMessage });
    }
  };
}

// GET /delegation-of-authority/config - Get configuration options for DOA forms
router.get('/config', auth, requireRole('MANAGER', 'ADMIN'), wrap('Failed to fetch DOA configuration', async (req, res) => {
  res.json({ success: true, data: doaConfig });
}));

// GET /delegation-of-authority - List all authorities with filters
router.get('/', auth, requireRole('MANAGER', 'ADMIN'), wrap('Failed to fetch delegation of authority records', async (req, res) => {
  const authorities = await DelegationOfAuthority.findAll(req.query);
  res.json({ success: true, data: authorities, count: authorities.length });
}));

// GET /delegation-of-authority/stats - Get DoFA statistics
router.get('/stats', auth, requireRole('MANAGER', 'ADMIN'), wrap('Failed to fetch statistics', async (req, res) => {
  res.json({ success: true, data: await DelegationOfAuthority.getStats() });
}));

// GET /delegation-of-authority/cost-centers - Get cost centers with authority
router.get('/cost-centers', auth, wrap('Failed to fetch cost centers', async (req, res) => {
  res.json({ success: true, data: await DelegationOfAuthority.getCostCentersWithAuthority() });
}));

// GET /delegation-of-authority/expired - Get expired authorities
router.get('/expired', auth, requireRole('MANAGER', 'ADMIN'), wrap('Failed to fetch expired authorities', async (req, res) => {
  res.json({ success: true, data: await DelegationOfAuthority.getExpiredAuthorities() });
}));

// GET /delegation-of-authority/expiring - Get authorities expiring soon
router.get('/expiring', auth, requireRole('MANAGER', 'ADMIN'), wrap('Failed to fetch expiring authorities', async (req, res) => {
  const daysAhead = parseInt(req.query.days, 10) || 30;
  res.json({ success: true, data: await DelegationOfAuthority.getExpiringAuthorities(daysAhead) });
}));

// GET /delegation-of-authority/check-authority - Check if user has authority for amount (engine-evaluated)
router.get('/check-authority', auth, wrap('Failed to check authority', async (req, res) => {
  const { user_id, amount, cost_center, transaction_type = 'ALL' } = req.query;

  if (!user_id || !amount) {
    return fail(res, 400, 'User ID and amount are required');
  }

  const authority = await ApprovalRulesEngine.checkUserAuthority(
    user_id,
    parseFloat(amount),
    cost_center,
    transaction_type
  );

  res.json({ success: true, data: { has_authority: !!authority, authority_details: authority } });
}));

// GET /delegation-of-authority/authorized-users - Get users authorized for amount (engine-evaluated)
router.get('/authorized-users', auth, wrap('Failed to fetch authorized users', async (req, res) => {
  const { amount, cost_center, transaction_type = 'ALL' } = req.query;

  if (!amount) {
    return fail(res, 400, 'Amount is required');
  }

  res.json({
    success: true,
    data: await ApprovalRulesEngine.getAuthorizedUsers(parseFloat(amount), cost_center, transaction_type)
  });
}));

// GET /delegation-of-authority/pending-suppliers - Get suppliers pending approval for current user
router.get('/pending-suppliers', auth, pendingAuthority(
  'SUPPLIERS',
  () => require('../models/Supplier').findAll({ status: 'PENDING_APPROVAL' }),
  'No supplier approval authority',
  'Failed to fetch pending suppliers'
));

// GET /delegation-of-authority/pending-contracts - Get contracts pending approval for current user
router.get('/pending-contracts', auth, pendingAuthority(
  'CONTRACTS',
  () => require('../models/Contract').getPendingApprovals(),
  'No contract approval authority',
  'Failed to fetch pending contracts'
));

// GET /delegation-of-authority/pending-purchase-requisitions - Get PRs pending approval for current user
router.get('/pending-purchase-requisitions', auth, pendingAuthority(
  'PURCHASE_REQUISITIONS',
  () => require('../models/PurchaseRequisition').findPendingApproval(),
  'No purchase requisition approval authority',
  'Failed to fetch pending purchase requisitions',
  true
));

// GET /delegation-of-authority/pending-certifications - Get suppliers pending certification for current user
router.get('/pending-certifications', auth, pendingAuthority(
  'CERTIFICATION',
  () => require('../models/Supplier').findAll({ status: 'ACTIVE', certification_status: 'PENDING' }),
  'No certification approval authority',
  'Failed to fetch pending certifications'
));

// GET /delegation-of-authority/user/:userId - Get user's authorities
router.get('/user/:userId', auth, wrap('Failed to fetch user authorities', async (req, res) => {
  const { cost_center, transaction_type = 'ALL' } = req.query;
  res.json({
    success: true,
    data: await DelegationOfAuthority.getUserAuthority(req.params.userId, cost_center, transaction_type)
  });
}));

// GET /delegation-of-authority/cost-center/:costCenter - Get authorities by cost center
router.get('/cost-center/:costCenter', auth, wrap('Failed to fetch authorities by cost center', async (req, res) => {
  res.json({ success: true, data: await DelegationOfAuthority.getByCostCenter(req.params.costCenter) });
}));

// GET /delegation-of-authority/pending-approvals - Get pending documents by type
router.get('/pending-approvals', auth, requireRole('MANAGER', 'ADMIN'), wrap('Failed to fetch pending approvals', async (req, res) => {
  const { type } = req.query;
  let pendingItems = [];

  switch (type) {
    case 'RFQ':
      pendingItems = await require('../models/RequestForQuotation').findAll({ status: 'PENDING_APPROVAL' });
      break;

    case 'CONTRACT':
      pendingItems = await require('../models/Contract').findAll({ status: 'PENDING_APPROVAL' });
      break;

    case 'PR':
      pendingItems = await require('../models/PurchaseRequisition').findAll({ status: 'PENDING_APPROVAL' });
      break;

    default:
      return fail(res, 400, 'Invalid type. Must be one of: RFQ, CONTRACT, PR');
  }

  res.json({ success: true, data: pendingItems, count: pendingItems.length });
}));

// GET /delegation-of-authority/:id - Get single authority by ID
router.get('/:id', auth, requireRole('MANAGER', 'ADMIN'), wrap('Failed to fetch delegation of authority record', async (req, res) => {
  const authority = await DelegationOfAuthority.findById(req.params.id);

  if (!authority) {
    return fail(res, 404, 'Delegation of authority record not found');
  }

  res.json({ success: true, data: authority });
}));

// POST /delegation-of-authority - Create new authority
router.post('/', auth, requireRole('ADMIN'), wrap('Failed to create delegation of authority', async (req, res) => {
  const {
    cost_center,
    user_id,
    min_amount,
    max_amount,
    applies_to,
    effective_from,
    effective_until,
    second_approver_id
  } = req.body;

  if (!cost_center) return fail(res, 400, 'Cost center is required');
  if (!user_id) return fail(res, 400, 'User ID is required');

  if (max_amount === undefined || max_amount === null) {
    return fail(res, 400, 'Maximum amount is required');
  }

  if (parseFloat(min_amount || 0) > parseFloat(max_amount)) {
    return fail(res, 400, 'Minimum amount cannot be greater than maximum amount');
  }

  const AuthorityEngine = require('../services/authority');
  const authCheck = await AuthorityEngine.can(
    req.user,
    'MODIFY_DOA',
    { user_id, cost_center },
    { second_approver_id }
  );

  if (!authCheck.allow) {
    return fail(res, 403, authCheck.reason);
  }

  const overlapping = await DelegationOfAuthority.checkOverlappingAuthorities(
    user_id,
    cost_center,
    min_amount || 0,
    max_amount,
    applies_to || 'ALL',
    effective_from,
    effective_until
  );

  if (overlapping.length > 0) {
    return fail(res, 400, 'User already has an active overlapping authority for this cost center and transaction type');
  }

  const authority = await DelegationOfAuthority.create(req.body, req.user.id);

  // Append audit trail row for DoA modification (C6)
  const { appendAuditRecord } = require('../services/auditTrailService');
  await appendAuditRecord({
    entity_type: 'DELEGATION_OF_AUTHORITY',
    entity_id: authority.id,
    from_status: null,
    to_status: 'ACTIVE',
    changed_by: req.user.id,
    reason: `Created DoA record for user ${user_id} in cost center ${cost_center}`
  });

  res.status(201).json({ success: true, data: authority });
}, (error) => (error.code === '23503' ? { status: 400, error: 'Invalid user ID' } : null)));

// PUT /delegation-of-authority/:id - Update authority
router.put('/:id', auth, requireRole('ADMIN'), wrap('Failed to update delegation of authority', async (req, res) => {
  const existingAuthority = await DelegationOfAuthority.findById(req.params.id);
  if (!existingAuthority) {
    return fail(res, 404, 'Delegation of authority record not found');
  }

  const {
    user_id,
    cost_center,
    min_amount,
    max_amount,
    applies_to,
    effective_from,
    effective_until,
    second_approver_id
  } = req.body;

  // C6 four-eyes: a substantive DoA edit — who holds the grant, its scope,
  // its limits, its dates, or its countersigner — needs a distinct second
  // approver signature exactly like creation does. A bare `is_active` toggle
  // (activate/deactivate from the approvals list) is exempt: forcing a
  // countersignature there would make routine record management impossible.
  const governanceFields = [
    'user_id', 'cost_center', 'min_amount', 'max_amount', 'applies_to',
    'effective_from', 'effective_until', 'second_approver_id'
  ];
  const isGovernanceEdit = governanceFields.some(
    (field) => req.body[field] !== undefined && req.body[field] !== null
  );

  if (isGovernanceEdit) {
    const AuthorityEngine = require('../services/authority');
    const authCheck = await AuthorityEngine.can(
      req.user,
      'MODIFY_DOA',
      {
        user_id: user_id || existingAuthority.user_id,
        cost_center: cost_center || existingAuthority.cost_center
      },
      { second_approver_id: second_approver_id }
    );

    if (!authCheck.allow) {
      return fail(res, 403, authCheck.reason);
    }
  }

  // If updating key fields, check for overlaps
  if (user_id || cost_center || min_amount !== undefined || max_amount !== undefined ||
      applies_to || effective_from || effective_until) {
    const overlapping = await DelegationOfAuthority.checkOverlappingAuthorities(
      user_id || existingAuthority.user_id,
      cost_center || existingAuthority.cost_center,
      min_amount !== undefined ? min_amount : existingAuthority.min_amount,
      max_amount !== undefined ? max_amount : existingAuthority.max_amount,
      applies_to || existingAuthority.applies_to,
      effective_from || existingAuthority.effective_from,
      effective_until !== undefined ? effective_until : existingAuthority.effective_until,
      req.params.id
    );

    if (overlapping.length > 0) {
      return fail(res, 400, 'Overlapping authority exists for this user, cost center, and date range');
    }
  }

  if (min_amount !== undefined && max_amount !== undefined &&
      parseFloat(min_amount) > parseFloat(max_amount)) {
    return fail(res, 400, 'Minimum amount cannot be greater than maximum amount');
  }

  const authority = await DelegationOfAuthority.update(req.params.id, req.body);

  if (!authority) {
    return fail(res, 404, 'Delegation of authority record not found');
  }

  res.json({ success: true, data: authority, message: 'Delegation of authority updated successfully' });
}, (error) => (error.code === '23503' ? { status: 400, error: 'Invalid user ID' } : (error.message === 'No valid fields to update' ? { status: 400, error: error.message } : null))));

// POST /delegation-of-authority/deactivate-expired - Deactivate expired authorities
router.post('/deactivate-expired', auth, requireRole('ADMIN'), wrap('Failed to deactivate expired authorities', async (req, res) => {
  const deactivated = await DelegationOfAuthority.deactivateExpiredAuthorities();
  res.json({
    success: true,
    data: deactivated,
    message: `${deactivated.length} expired authorities deactivated successfully`
  });
}));

// POST /delegation-of-authority/approve-supplier/:supplierId - Approve supplier via DoA
router.post('/approve-supplier/:supplierId', auth, wrap('Failed to approve supplier', async (req, res) => {
  if (!(await userHasAuthority(req.user.id, 'SUPPLIERS'))) {
    return fail(res, 403, 'You do not have authority to approve suppliers');
  }

  const Supplier = require('../models/Supplier');
  const supplier = await Supplier.findById(req.params.supplierId);
  if (!supplier) return fail(res, 404, 'Supplier not found');

  if (supplier.status !== 'PENDING_APPROVAL') {
    return fail(res, 400, 'Supplier is not in pending approval status');
  }

  await Supplier.update(req.params.supplierId, {
    status: 'PENDING_SUPPLIER_CONFIRMATION',
    approved_by: req.user.id,
    approved_at: new Date()
  });

  await require('../services/emailService').sendSupplierOnboardingEmail(
    supplier,
    `${req.user.first_name} ${req.user.last_name}`
  );

  res.json({ success: true, message: 'Supplier approved and partnership email sent' });
}));

// POST /delegation-of-authority/certify-supplier/:supplierId - Certify supplier via DoA
router.post('/certify-supplier/:supplierId', auth, wrap('Failed to certify supplier', async (req, res) => {
  if (!(await userHasAuthority(req.user.id, 'CERTIFICATION'))) {
    return fail(res, 403, 'You do not have authority to certify suppliers');
  }

  const Supplier = require('../models/Supplier');
  const supplier = await Supplier.findById(req.params.supplierId);
  if (!supplier) return fail(res, 404, 'Supplier not found');

  if (supplier.status !== 'ACTIVE') {
    return fail(res, 400, 'Supplier must be active to be certified');
  }

  if (supplier.certification_status !== 'PENDING') {
    return fail(res, 400, 'Supplier is not in pending certification status');
  }

  await Supplier.update(req.params.supplierId, {
    certification_status: 'CERTIFIED',
    certified_by: req.user.id,
    certified_at: new Date()
  });

  res.json({ success: true, message: 'Supplier certified successfully' });
}));

// POST /delegation-of-authority/revoke-certification/:supplierId - Revoke supplier certification via DoA
router.post('/revoke-certification/:supplierId', auth, wrap('Failed to revoke supplier certification', async (req, res) => {
  const { reason } = req.body;
  const Supplier = require('../models/Supplier');

  if (!(await userHasAuthority(req.user.id, 'CERTIFICATION'))) {
    return fail(res, 403, 'You do not have authority to revoke supplier certifications');
  }

  const supplier = await Supplier.findById(req.params.supplierId);
  if (!supplier) return fail(res, 404, 'Supplier not found');

  if (supplier.certification_status !== 'CERTIFIED') {
    return fail(res, 400, 'Supplier is not certified');
  }

  await Supplier.update(req.params.supplierId, {
    certification_status: 'NOT_CERTIFIED',
    certification_revoke_reason: reason,
    certification_revoked_by: req.user.id,
    certification_revoked_at: new Date()
  });

  res.json({ success: true, message: 'Supplier certification revoked successfully' });
}));

// POST /delegation-of-authority/decline-supplier/:supplierId - Decline supplier via DoA
router.post('/decline-supplier/:supplierId', auth, wrap('Failed to decline supplier', async (req, res) => {
  const { reason } = req.body;
  const Supplier = require('../models/Supplier');

  if (!(await userHasAuthority(req.user.id, 'SUPPLIERS'))) {
    return fail(res, 403, 'You do not have authority to decline suppliers');
  }

  const supplier = await Supplier.findById(req.params.supplierId);
  if (!supplier) return fail(res, 404, 'Supplier not found');

  if (supplier.status !== 'PENDING_APPROVAL') {
    return fail(res, 400, 'Supplier is not in pending approval status');
  }

  await Supplier.update(req.params.supplierId, {
    status: 'DRAFT',
    decline_reason: reason,
    declined_by: req.user.id,
    declined_at: new Date()
  });

  res.json({ success: true, message: 'Supplier declined successfully' });
}));

// POST /delegation-of-authority/approve-purchase-requisition/:prId - Approve purchase requisition via DoA
router.post('/approve-purchase-requisition/:prId', auth, wrap('Failed to approve purchase requisition', async (req, res) => {
  const PurchaseRequisition = require('../models/PurchaseRequisition');
  const db = require('../config/database');
  const ApprovalRulesEngine = require('../services/approvalRulesEngine');
  const ApprovalChain = require('../models/ApprovalChain');
  const { prId } = req.params;

  const prResult = await db.query(
    'SELECT id, cost_center, quantity, estimated_unit_price, status FROM purchase_requisitions WHERE id = $1',
    [prId]
  );
  if (prResult.rows.length === 0) {
    return fail(res, 404, 'Purchase requisition not found');
  }
  
  const prRow = prResult.rows[0];
  if (prRow.status !== 'PENDING_APPROVAL') {
    return fail(res, 400, 'Purchase requisition is not in pending approval status');
  }

  const prAmount = parseFloat(
    prRow.total_amount || (parseFloat(prRow.quantity || 0) * parseFloat(prRow.estimated_unit_price || 0)) || 0
  );

  // Amount-scoped DoA binds every role, ADMIN included; the only identity
  // exempt from amount bands is the platform owner, which the engine already
  // synthesizes as an unlimited grant (see loadDoaDefinitions).
  const hasAuthority = await ApprovalRulesEngine.checkUserAuthority(
    req.user.id,
    prAmount,
    prRow.cost_center,
    'PR'
  ) || await ApprovalRulesEngine.checkUserAuthority(
    req.user.id,
    prAmount,
    prRow.cost_center,
    'PURCHASE_REQUISITION'
  );

  if (!hasAuthority) {
    return fail(res, 403, `Insufficient delegation of authority to approve this purchase requisition (amount: $${prAmount})`);
  }

  // Check if an ApprovalChain request exists for this PR
  const pendingChain = await db.query(
    "SELECT id FROM approval_requests WHERE document_type IN ('PR', 'PURCHASE_REQUISITION') AND document_id = $1 AND status = 'PENDING'",
    [prId]
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

  const approvedPR = await PurchaseRequisition.approve(prId, req.user.id);
  res.json({ success: true, data: approvedPR, message: 'Purchase requisition approved successfully' });
}));

// POST /delegation-of-authority/decline-purchase-requisition/:prId - Decline purchase requisition via DoA
router.post('/decline-purchase-requisition/:prId', auth, wrap('Failed to decline purchase requisition', async (req, res) => {
  const { reason } = req.body;
  const PurchaseRequisition = require('../models/PurchaseRequisition');

  if (!reason || reason.trim() === '') {
    return fail(res, 400, 'Decline reason is required');
  }

  if (!(await userHasAuthority(req.user.id, 'PURCHASE_REQUISITIONS'))) {
    return fail(res, 403, 'You do not have authority to decline purchase requisitions');
  }

  const pr = await PurchaseRequisition.findById(req.params.prId);
  if (!pr) return fail(res, 404, 'Purchase requisition not found');

  if (pr.status !== 'PENDING_APPROVAL') {
    return fail(res, 400, 'Purchase requisition is not in pending approval status');
  }

  const declinedPR = await PurchaseRequisition.decline(req.params.prId, req.user.id, reason.trim());
  res.json({ success: true, data: declinedPR, message: 'Purchase requisition declined successfully' });
}));

// POST /delegation-of-authority/approve - Generic approve endpoint for DoA entities
router.post('/approve', auth, requireRole('MANAGER', 'ADMIN'), wrap('Failed to approve entity', async (req, res) => {
  const { entityId, entityType } = req.body;

  if (!entityId || !entityType) {
    return fail(res, 400, 'Entity ID and entity type are required');
  }

  let result;
  switch (entityType) {
    case 'RFQ':
      const RequestForQuotation = require('../models/RequestForQuotation');
      const emailService = require('../services/emailService');

      const rfq = await RequestForQuotation.findById(entityId);
      if (!rfq) return fail(res, 404, 'RFQ not found');

      if (rfq.status !== 'PENDING_APPROVAL') {
        return fail(res, 400, 'RFQ is not in pending approval status');
      }

      result = await RequestForQuotation.update(entityId, { status: 'SENT' });

      try {
        const suppliers = await RequestForQuotation.getSuppliers(entityId);
        const lineItems = await RequestForQuotation.getLineItems(entityId);

        const emailPromises = suppliers.map((supplier) => (
          emailService.sendRFQInvitation(result, supplier, lineItems)
            .catch((error) => {
              console.error(`Failed to send RFQ invitation to ${supplier.legal_name}:`, error);
              return { success: false, error: error.message };
            })
        ));

        const emailResults = await Promise.allSettled(emailPromises);
        const successCount = emailResults.filter((r) => r.status === 'fulfilled' && r.value.success).length;

        console.log(`RFQ ${result.rfq_number} approved and ${successCount}/${suppliers.length} email invitations sent`);
      } catch (error) {
        console.error('Error sending RFQ invitations:', error);
        // Don't fail the approval if email sending fails
      }
      break;

    default:
      return fail(res, 400, 'Invalid entity type. Supported types: RFQ');
  }

  let message = `${entityType} approved successfully`;

  if (entityType === 'RFQ') {
    message += ' and sent to suppliers';
  }

  res.json({ success: true, data: result, message });
}));

// POST /delegation-of-authority/reject - Generic reject endpoint for DoA entities
router.post('/reject', auth, requireRole('MANAGER', 'ADMIN'), wrap('Failed to reject entity', async (req, res) => {
  const { entityId, entityType, reason } = req.body;

  if (!entityId || !entityType) {
    return fail(res, 400, 'Entity ID and entity type are required');
  }

  if (!reason || reason.trim() === '') {
    return fail(res, 400, 'Rejection reason is required');
  }

  let result;
  switch (entityType) {
    case 'RFQ':
      const RequestForQuotation = require('../models/RequestForQuotation');

      const rfq = await RequestForQuotation.findById(entityId);
      if (!rfq) return fail(res, 404, 'RFQ not found');

      if (rfq.status !== 'PENDING_APPROVAL') {
        return fail(res, 400, 'RFQ is not in pending approval status');
      }

      result = await RequestForQuotation.update(entityId, { status: 'DRAFT' });
      break;

    default:
      return fail(res, 400, 'Invalid entity type. Supported types: RFQ');
  }

  res.json({ success: true, data: result, message: `${entityType} rejected successfully` });
}));

// DELETE /delegation-of-authority/:id - Delete authority
router.delete('/:id', auth, requireRole('ADMIN'), wrap('Failed to delete delegation of authority', async (req, res) => {
  const authority = await DelegationOfAuthority.delete(req.params.id);

  if (!authority) {
    return fail(res, 404, 'Delegation of authority record not found');
  }

  res.json({ success: true, message: 'Delegation of authority deleted successfully' });
}, (error) => (error.code === '23503' ? { status: 400, error: 'Cannot delete authority - it is referenced by other records' } : null)));

module.exports = router;
