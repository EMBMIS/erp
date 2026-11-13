const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const ApprovalChain = require('../models/ApprovalChain');

// ---- Templates (admin/manager configure these) -----------------------------

router.get('/templates', auth, async (req, res) => {
  try {
    const templates = await ApprovalChain.findAllTemplates();
    res.json({ success: true, data: templates });
  } catch (error) {
    console.error('List approval templates error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/templates/:id', auth, async (req, res) => {
  try {
    const template = await ApprovalChain.findTemplateById(req.params.id);
    if (!template) return res.status(404).json({ success: false, error: 'Template not found' });
    res.json({ success: true, data: template });
  } catch (error) {
    console.error('Get approval template error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /approval-chains/templates
// body: { name, document_type, steps: [{ min_amount, approver_role, approver_user_id? }], second_approver_id? }
router.post('/templates', auth, async (req, res) => {
  try {
    const { name, document_type, steps, second_approver_id } = req.body;
    if (!name || !document_type) return res.status(400).json({ success: false, error: 'name and document_type are required' });

    // Authority over authority (C6): ADMIN role required
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        error: 'Four-eyes governance rule: only ADMIN users can create or modify approval chain templates.'
      });
    }

    const AuthorityEngine = require('../services/authority');
    const authCheck = await AuthorityEngine.can(
      req.user,
      'MODIFY_APPROVAL_TEMPLATE',
      { type: document_type },
      { second_approver_id }
    );

    if (!authCheck.allow) {
      return res.status(403).json({ success: false, error: authCheck.reason });
    }

    const template = await ApprovalChain.createTemplate({ name, document_type, steps }, req.user.id);

    // Audit log governance change
    const { appendAuditRecord } = require('../services/auditTrailService');
    await appendAuditRecord({
      entity_type: 'APPROVAL_CHAIN_TEMPLATE',
      entity_id: template.id,
      from_status: null,
      to_status: 'CREATED',
      changed_by: req.user.id,
      reason: `Created approval chain template '${name}' for ${document_type}`
    });

    res.status(201).json({ success: true, data: template });
  } catch (error) {
    console.error('Create approval template error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// ---- Requests ---------------------------------------------------------------

router.get('/requests', auth, async (req, res) => {
  try {
    const requests = await ApprovalChain.findAllRequests({ status: req.query.status, document_type: req.query.document_type });
    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('List approval requests error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /approval-chains/requests/pending - steps awaiting MY decision
router.get('/requests/pending', auth, async (req, res) => {
  try {
    const pending = await ApprovalChain.findPendingForUser(req.user.id, req.user.role);
    res.json({ success: true, data: pending });
  } catch (error) {
    console.error('List pending approvals error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/requests/:id', auth, async (req, res) => {
  try {
    const request = await ApprovalChain.findRequestById(req.params.id);
    if (!request) return res.status(404).json({ success: false, error: 'Request not found' });
    res.json({ success: true, data: request });
  } catch (error) {
    console.error('Get approval request error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /approval-chains/requests
// body: { template_id, document_type, document_id, amount, currency? }
router.post('/requests', auth, async (req, res) => {
  try {
    const { template_id, document_type, document_id, amount, currency } = req.body;
    if (!template_id || !document_type || !document_id || amount == null) {
      return res.status(400).json({ success: false, error: 'template_id, document_type, document_id and amount are required' });
    }
    const request = await ApprovalChain.startRequest({ template_id, document_type, document_id, amount, currency }, req.user.id);
    res.status(201).json({ success: true, data: request });
  } catch (error) {
    console.error('Start approval request error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /approval-chains/requests/:id/decide - body: { decision: 'APPROVE'|'REJECT', comments? }
router.post('/requests/:id/decide', auth, async (req, res) => {
  try {
    const { decision, comments } = req.body;
    const request = await ApprovalChain.decide(req.params.id, req.user.id, req.user.role, decision, comments || '');
    res.json({ success: true, data: request });
  } catch (error) {
    console.error('Decide approval request error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /approval-chains/requests/:id/cancel
router.post('/requests/:id/cancel', auth, async (req, res) => {
  try {
    const request = await ApprovalChain.cancel(req.params.id, req.user.id);
    res.json({ success: true, data: request });
  } catch (error) {
    console.error('Cancel approval request error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

const ApprovalRulesEngine = require('../services/approvalRulesEngine');

// POST /approval-chains/simulate - Evaluate approval routing rule output
router.post('/simulate', auth, async (req, res) => {
  try {
    const { document_type, amount, cost_center_id } = req.body;
    const evaluation = await ApprovalRulesEngine.evaluateRules({
      documentType: document_type,
      amount,
      costCenterId: cost_center_id,
      requesterId: req.user.id
    });
    res.json({ success: true, data: evaluation });
  } catch (error) {
    console.error('Simulate approval error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;

