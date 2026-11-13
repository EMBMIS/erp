const express = require('express');
const router = express.Router();
const ChartOfAccounts = require('../models/ChartOfAccounts');
const { auth: requireAuth, requireRole, requireFinanceManager } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const filters = {
      search: req.query.search,
      account_type: req.query.account_type,
      status: req.query.status,
      is_active: req.query.is_active,
      is_header: req.query.is_header,
      parent_account_id: req.query.parent_account_id,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    };

    const accounts = await ChartOfAccounts.findAll(filters);
    
    res.json({
      success: true,
      data: accounts,
      total: accounts.length
    });
  } catch (error) {
    console.error('Error fetching chart of accounts:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch chart of accounts' 
    });
  }
});

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const stats = await ChartOfAccounts.getStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching account stats:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch account statistics' 
    });
  }
});

router.get('/hierarchy', requireAuth, async (req, res) => {
  try {
    const parentId = req.query.parent_id || null;
    const hierarchy = await ChartOfAccounts.getAccountHierarchy(parentId);
    
    res.json({
      success: true,
      data: hierarchy
    });
  } catch (error) {
    console.error('Error fetching account hierarchy:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch account hierarchy' 
    });
  }
});

router.get('/balance-sheet', requireAuth, async (req, res) => {
  try {
    const balanceSheet = await ChartOfAccounts.getBalanceSheet();
    
    res.json({
      success: true,
      data: balanceSheet
    });
  } catch (error) {
    console.error('Error fetching balance sheet:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch balance sheet data' 
    });
  }
});

router.get('/income-statement', requireAuth, async (req, res) => {
  try {
    const incomeStatement = await ChartOfAccounts.getIncomeStatement();
    
    res.json({
      success: true,
      data: incomeStatement
    });
  } catch (error) {
    console.error('Error fetching income statement:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch income statement data' 
    });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const account = await ChartOfAccounts.findById(req.params.id);
    
    if (!account) {
      return res.status(404).json({ 
        success: false, 
        error: 'Account not found' 
      });
    }
    
    res.json({
      success: true,
      data: account
    });
  } catch (error) {
    console.error('Error fetching account:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch account' 
    });
  }
});

router.get('/:id/status-history', requireAuth, async (req, res) => {
  try {
    const history = await ChartOfAccounts.getStatusHistory(req.params.id);
    
    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    console.error('Error fetching account status history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch status history' 
    });
  }
});

router.post('/', requireAuth, requireFinanceManager, async (req, res) => {
  try {
    const {
      account_code,
      account_name,
      account_type,
      account_subtype,
      parent_account_id,
      account_level,
      is_header,
      normal_balance,
      current_balance,
      beginning_balance,
      allow_manual_posting,
      require_department,
      require_project,
      require_cost_center,
      balance_sheet_section,
      income_statement_section,
      cash_flow_section,
      description,
      tax_code,
      currency,
      bank_name,
      bank_account_number,
      bank_routing_number
    } = req.body;

    if (!account_code || !account_name || !account_type || !normal_balance) {
      return res.status(400).json({ 
        success: false, 
        error: 'Account code, name, type, and normal balance are required' 
      });
    }

    const accountData = {
      account_code,
      account_name,
      account_type,
      account_subtype,
      parent_account_id,
      account_level,
      is_header,
      normal_balance,
      current_balance,
      beginning_balance,
      allow_manual_posting,
      require_department,
      require_project,
      require_cost_center,
      balance_sheet_section,
      income_statement_section,
      cash_flow_section,
      description,
      tax_code,
      currency,
      bank_name,
      bank_account_number,
      bank_routing_number
    };

    const account = await ChartOfAccounts.create(accountData, req.user.id);
    
    res.status(201).json({
      success: true,
      data: account,
      message: 'Chart of account created successfully'
    });
  } catch (error) {
    console.error('Error creating account:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to create account' 
    });
  }
});

router.put('/:id', requireAuth, requireFinanceManager, async (req, res) => {
  try {
    const {
      account_name,
      account_type,
      account_subtype,
      parent_account_id,
      account_level,
      is_header,
      normal_balance,
      allow_manual_posting,
      require_department,
      require_project,
      require_cost_center,
      balance_sheet_section,
      income_statement_section,
      cash_flow_section,
      description,
      tax_code,
      currency,
      bank_name,
      bank_account_number,
      bank_routing_number,
      is_active
    } = req.body;

    const accountData = {
      account_name,
      account_type,
      account_subtype,
      parent_account_id,
      account_level,
      is_header,
      normal_balance,
      allow_manual_posting,
      require_department,
      require_project,
      require_cost_center,
      balance_sheet_section,
      income_statement_section,
      cash_flow_section,
      description,
      tax_code,
      currency,
      bank_name,
      bank_account_number,
      bank_routing_number,
      is_active
    };

    const account = await ChartOfAccounts.update(req.params.id, accountData, req.user.id);
    
    if (!account) {
      return res.status(404).json({ 
        success: false, 
        error: 'Account not found' 
      });
    }
    
    res.json({
      success: true,
      data: account,
      message: 'Account updated successfully'
    });
  } catch (error) {
    console.error('Error updating account:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update account' 
    });
  }
});

router.put('/:id/status', requireAuth, requireFinanceManager, async (req, res) => {
  try {
    const { status, reason } = req.body;
    
    if (!status) {
      return res.status(400).json({ 
        success: false, 
        error: 'Status is required' 
      });
    }

    const validStatuses = ['PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'INACTIVE', 'CLOSED', 'REJECTED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid status' 
      });
    }

    const account = await ChartOfAccounts.updateStatus(
      req.params.id, 
      status, 
      req.user.id, 
      reason || ''
    );
    
    if (!account) {
      return res.status(404).json({ 
        success: false, 
        error: 'Account not found' 
      });
    }
    
    res.json({
      success: true,
      data: account,
      message: 'Account status updated successfully'
    });
  } catch (error) {
    console.error('Error updating account status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update account status' 
    });
  }
});

router.delete('/:id', requireAuth, requireFinanceManager, async (req, res) => {
  try {
    const account = await ChartOfAccounts.delete(req.params.id, req.user.id);
    
    if (!account) {
      return res.status(404).json({ 
        success: false, 
        error: 'Account not found' 
      });
    }
    
    res.json({
      success: true,
      message: 'Account deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting account:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to delete account' 
    });
  }
});

module.exports = router;