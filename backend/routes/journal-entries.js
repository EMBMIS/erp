const express = require('express');
const router = express.Router();
const JournalEntry = require('../models/JournalEntry');
const { auth: requireAuth, requireRole, requireFinanceUser, requireFinanceManager } = require('../middleware/auth');
const { requireSoD } = require('../middleware/rbac');
const { recordCreator } = require('../middleware/recordOwner');

router.get('/', requireAuth, async (req, res) => {
  try {
    const filters = {
      search: req.query.search,
      status: req.query.status,
      source_type: req.query.source_type,
      entry_date_from: req.query.entry_date_from,
      entry_date_to: req.query.entry_date_to,
      created_by: req.query.created_by,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    };

    const entries = await JournalEntry.findAll(filters);
    
    res.json({
      success: true,
      data: entries,
      total: entries.length
    });
  } catch (error) {
    console.error('Error fetching journal entries:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch journal entries' 
    });
  }
});

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const stats = await JournalEntry.getStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching journal entry stats:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch journal entry statistics' 
    });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const entry = await JournalEntry.findById(req.params.id);
    
    if (!entry) {
      return res.status(404).json({ 
        success: false, 
        error: 'Journal entry not found' 
      });
    }
    
    res.json({
      success: true,
      data: entry
    });
  } catch (error) {
    console.error('Error fetching journal entry:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch journal entry' 
    });
  }
});

router.get('/:id/status-history', requireAuth, async (req, res) => {
  try {
    const history = await JournalEntry.getStatusHistory(req.params.id);
    
    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    console.error('Error fetching journal entry status history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch status history' 
    });
  }
});

router.post('/', requireAuth, requireFinanceUser, async (req, res) => {
  try {
    const {
      entry_date,
      posting_date,
      source_type,
      source_id,
      source_document,
      description,
      reference,
      currency,
      exchange_rate,
      batch_id,
      external_reference,
      notes,
      items
    } = req.body;

    if (!entry_date || !description) {
      return res.status(400).json({ 
        success: false, 
        error: 'Entry date and description are required' 
      });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'At least one journal entry item is required' 
      });
    }

    // Validate that each item has either debit or credit (not both)
    for (const item of items) {
      if (!item.account_id) {
        return res.status(400).json({ 
          success: false, 
          error: 'Account ID is required for all items' 
        });
      }

      const debit = parseFloat(item.debit_amount || 0);
      const credit = parseFloat(item.credit_amount || 0);

      if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Each item must have either debit or credit amount (not both or neither)' 
        });
      }
    }

    const entryData = {
      entry_date,
      posting_date,
      source_type,
      source_id,
      source_document,
      description,
      reference,
      currency,
      exchange_rate,
      batch_id,
      external_reference,
      notes,
    };

    const entry = await JournalEntry.create(entryData, items, req.user.id);
    
    res.status(201).json({
      success: true,
      data: entry,
      message: 'Journal entry created successfully'
    });
  } catch (error) {
    console.error('Error creating journal entry:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to create journal entry' 
    });
  }
});

router.post('/from-sales-order/:salesOrderId', requireAuth, requireFinanceUser, async (req, res) => {
  try {
    const entry = await JournalEntry.createFromSalesOrder(req.params.salesOrderId, req.user.id);
    
    res.status(201).json({
      success: true,
      data: entry,
      message: 'Journal entry created from sales order successfully'
    });
  } catch (error) {
    console.error('Error creating journal entry from sales order:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to create journal entry from sales order' 
    });
  }
});

router.post('/from-purchase-order/:purchaseOrderId', requireAuth, requireFinanceUser, async (req, res) => {
  try {
    const entry = await JournalEntry.createFromPurchaseOrder(req.params.purchaseOrderId, req.user.id);
    
    res.status(201).json({
      success: true,
      data: entry,
      message: 'Journal entry created from purchase order successfully'
    });
  } catch (error) {
    console.error('Error creating journal entry from purchase order:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to create journal entry from purchase order' 
    });
  }
});

router.put('/:id/status', requireAuth, requireFinanceUser, async (req, res) => {
  try {
    const { status, reason } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        error: 'Status is required'
      });
    }

    // Reversing a posted entry through this generic endpoint does NOT create a
    // compensating entry — the proper, audited path is POST /:id/reverse. Block
    // it here so the ledger cannot be silently de-audited.
    if (status === 'REVERSED') {
      return res.status(400).json({
        success: false,
        error: 'Use POST /:id/reverse to reverse a posted entry (creates a compensating reversing entry)'
      });
    }

    const { applyStatusChange } = require('../services/statusTransitionService');
    const updatedEntry = await applyStatusChange({
      entityType: 'JOURNAL_ENTRY',
      entityId: req.params.id,
      newStatus: status,
      actor: req.user,
      context: { reason: reason || '' },
      executeSideEffects: async (client, record) => {
        if (status === 'POSTED') {
          await JournalEntry.updateAccountBalances(client, record.id);
        }
      }
    });

    res.json({
      success: true,
      data: updatedEntry,
      message: 'Journal entry status updated successfully'
    });
  } catch (error) {
    console.error('Error updating journal entry status:', error);
    res.status(error.status || 500).json({ 
      success: false, 
      error: error.message || 'Failed to update journal entry status' 
    });
  }
});

// Reversal requires a distinct authority from whoever raised the original
// entry (SoD, same rule as approvals elsewhere in this codebase) — a
// FINANCE_MANAGER role alone let the entry's own creator both post and
// reverse it, which is exactly the "who audits the auditor" gap a reversal
// control exists to close. The platform owner keeps its usual exemption via
// requireSoD itself.
router.post('/:id/reverse', requireAuth, requireFinanceManager, requireSoD(recordCreator('journal_entries'), 'reversal'), async (req, res) => {
  try {
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({ 
        success: false, 
        error: 'Reason is required for reversing entries' 
      });
    }

    const reversingEntry = await JournalEntry.reverse(req.params.id, req.user.id, reason);
    
    res.status(201).json({
      success: true,
      data: reversingEntry,
      message: 'Journal entry reversed successfully'
    });
  } catch (error) {
    console.error('Error reversing journal entry:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to reverse journal entry' 
    });
  }
});

router.delete('/:id', requireAuth, requireFinanceManager, async (req, res) => {
  try {
    const entry = await JournalEntry.delete(req.params.id, req.user.id);
    
    if (!entry) {
      return res.status(404).json({ 
        success: false, 
        error: 'Journal entry not found' 
      });
    }
    
    res.json({
      success: true,
      message: 'Journal entry deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting journal entry:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to delete journal entry' 
    });
  }
});

module.exports = router;