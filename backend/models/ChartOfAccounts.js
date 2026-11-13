const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const companyScope = require('../services/companyScope');

// ---------------------------------------------------------------------------
// Standard finance master data for a brand-new company.
//
// Exact copy of the VALUES list in
// database/migrations/202608120500_seed_gl_default_company.sql — the same
// chart that migration re-seeds for the deployment's default company. Signup
// and admin company creation call seedFinanceMasterData() so a newly
// registered company starts from the same chart instead of an empty
// chart_of_accounts, which made every GL posting (goods receipts, invoices,
// payments, payroll) fail with "Required accounts not found" for that tenant
// (ERP blocker #5: "Empty COA at signup with hardcoded posting codes and no
// template").
// ---------------------------------------------------------------------------

// [account_code, account_name, account_type, account_subtype, account_level,
//  is_header, normal_balance, status, allow_manual_posting, balance_sheet_section]
const STANDARD_ACCOUNTS = [
  ['1000', 'ASSETS', 'ASSET', 'HEADER', 1, true, 'DEBIT', 'ACTIVE', false, 'ASSETS'],
  ['1100', 'Current Assets', 'ASSET', 'CURRENT_ASSET', 2, true, 'DEBIT', 'ACTIVE', false, 'CURRENT_ASSETS'],
  ['1110', 'Cash and Cash Equivalents', 'ASSET', 'CASH', 3, false, 'DEBIT', 'ACTIVE', true, 'CURRENT_ASSETS'],
  ['1120', 'Accounts Receivable', 'ASSET', 'ACCOUNTS_RECEIVABLE', 3, false, 'DEBIT', 'ACTIVE', true, 'CURRENT_ASSETS'],
  ['1130', 'Inventory', 'ASSET', 'INVENTORY', 3, false, 'DEBIT', 'ACTIVE', true, 'CURRENT_ASSETS'],
  // Manufacturing's material-issue/production-confirm postings
  // (WorkOrder.postJournal) require 1135 and 5150 specifically — missing from
  // this list, so every company created after migration 105 (which seeded
  // them once, globally, for whichever single company existed at the time)
  // got a chart of accounts that let every other GL posting through but
  // failed "Issue materials" on a work order with "Manufacturing GL accounts
  // missing (need 1135 and 1130)."
  ['1135', 'Work In Progress', 'ASSET', 'CURRENT_ASSET', 3, false, 'DEBIT', 'ACTIVE', true, 'CURRENT_ASSETS'],
  ['1140', 'Prepaid Expenses', 'ASSET', 'PREPAID', 3, false, 'DEBIT', 'ACTIVE', true, 'CURRENT_ASSETS'],
  ['1160', 'Input VAT (VAT Receivable)', 'ASSET', 'VAT_RECEIVABLE', 3, false, 'DEBIT', 'ACTIVE', true, 'CURRENT_ASSETS'],
  ['1200', 'Fixed Assets', 'ASSET', 'FIXED_ASSET', 2, true, 'DEBIT', 'ACTIVE', false, 'FIXED_ASSETS'],
  ['1210', 'Property, Plant & Equipment', 'ASSET', 'PPE', 3, false, 'DEBIT', 'ACTIVE', true, 'FIXED_ASSETS'],
  ['1220', 'Accumulated Depreciation', 'ASSET', 'ACCUMULATED_DEPRECIATION', 3, false, 'CREDIT', 'ACTIVE', true, 'FIXED_ASSETS'],
  ['2000', 'LIABILITIES', 'LIABILITY', 'HEADER', 1, true, 'CREDIT', 'ACTIVE', false, 'LIABILITIES'],
  ['2100', 'Current Liabilities', 'LIABILITY', 'CURRENT_LIABILITY', 2, true, 'CREDIT', 'ACTIVE', false, 'CURRENT_LIABILITIES'],
  ['2110', 'Accounts Payable', 'LIABILITY', 'ACCOUNTS_PAYABLE', 3, false, 'CREDIT', 'ACTIVE', true, 'CURRENT_LIABILITIES'],
  ['2115', 'GR/IR Clearing (Goods Received Not Invoiced)', 'LIABILITY', 'ACCRUED_EXPENSES', 3, false, 'CREDIT', 'ACTIVE', true, 'CURRENT_LIABILITIES'],
  ['2120', 'Accrued Expenses', 'LIABILITY', 'ACCRUED_EXPENSES', 3, false, 'CREDIT', 'ACTIVE', true, 'CURRENT_LIABILITIES'],
  // The RECON_SUSPENSE control account (continuous close parks unexplained
  // differences here; payroll credits deductions to it). Migration
  // 202608160300 gave it to every company that existed then; this list never
  // had it, so a company that signed up later had a mapping target missing.
  ['2126', 'AI Reconciliation Suspense', 'LIABILITY', 'CURRENT_LIABILITY', 3, false, 'CREDIT', 'ACTIVE', true, 'CURRENT_LIABILITIES'],
  ['2130', 'Short-term Debt', 'LIABILITY', 'SHORT_TERM_DEBT', 3, false, 'CREDIT', 'ACTIVE', true, 'CURRENT_LIABILITIES'],
  ['2140', 'Output VAT (VAT Payable)', 'LIABILITY', 'VAT_PAYABLE', 3, false, 'CREDIT', 'ACTIVE', true, 'CURRENT_LIABILITIES'],
  ['2200', 'Long-term Liabilities', 'LIABILITY', 'LONG_TERM_LIABILITY', 2, true, 'CREDIT', 'ACTIVE', false, 'LONG_TERM_LIABILITIES'],
  ['2210', 'Long-term Debt', 'LIABILITY', 'LONG_TERM_DEBT', 3, false, 'CREDIT', 'ACTIVE', true, 'LONG_TERM_LIABILITIES'],
  ['3000', 'EQUITY', 'EQUITY', 'HEADER', 1, true, 'CREDIT', 'ACTIVE', false, 'EQUITY'],
  ['3100', 'Share Capital', 'EQUITY', 'SHARE_CAPITAL', 2, false, 'CREDIT', 'ACTIVE', true, 'EQUITY'],
  ['3200', 'Retained Earnings', 'EQUITY', 'RETAINED_EARNINGS', 2, false, 'CREDIT', 'ACTIVE', true, 'EQUITY'],
  ['3210', 'Revaluation Surplus', 'EQUITY', 'RESERVES', 3, false, 'CREDIT', 'ACTIVE', true, 'EQUITY'],
  ['4000', 'REVENUE', 'REVENUE', 'HEADER', 1, true, 'CREDIT', 'ACTIVE', false, 'REVENUE'],
  ['4100', 'Sales Revenue', 'REVENUE', 'SALES_REVENUE', 2, false, 'CREDIT', 'ACTIVE', true, 'REVENUE'],
  ['4200', 'Service Revenue', 'REVENUE', 'SERVICE_REVENUE', 2, false, 'CREDIT', 'ACTIVE', true, 'REVENUE'],
  ['4900', 'Other Revenue', 'REVENUE', 'OTHER_REVENUE', 2, false, 'CREDIT', 'ACTIVE', true, 'REVENUE'],
  ['4910', 'Foreign Exchange Gain', 'REVENUE', 'OTHER_INCOME', 3, false, 'CREDIT', 'ACTIVE', true, 'REVENUE'],
  ['5000', 'EXPENSES', 'EXPENSE', 'HEADER', 1, true, 'DEBIT', 'ACTIVE', false, 'EXPENSES'],
  ['5100', 'Cost of Goods Sold', 'EXPENSE', 'COGS', 2, false, 'DEBIT', 'ACTIVE', true, 'EXPENSES'],
  ['5150', 'Manufacturing Variance', 'EXPENSE', 'COST_OF_SALES', 3, false, 'DEBIT', 'ACTIVE', true, 'EXPENSES'],
  ['5200', 'Operating Expenses', 'EXPENSE', 'OPERATING_EXPENSE', 2, true, 'DEBIT', 'ACTIVE', false, 'OPERATING_EXPENSES'],
  ['5210', 'Salaries and Wages', 'EXPENSE', 'PAYROLL', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'],
  ['5211', 'Payroll Tax Expense (Employer)', 'EXPENSE', 'OPERATING_EXPENSE', 3, false, 'DEBIT', 'ACTIVE', true, 'OTHER'],
  ['5220', 'Rent Expense', 'EXPENSE', 'RENT', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'],
  ['5230', 'Utilities Expense', 'EXPENSE', 'UTILITIES', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'],
  ['5240', 'Office Supplies', 'EXPENSE', 'SUPPLIES', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'],
  ['5250', 'Professional Services', 'EXPENSE', 'PROFESSIONAL_SERVICES', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'],
  ['5260', 'Depreciation Expense', 'EXPENSE', 'DEPRECIATION', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'],
  ['5850', 'Impairment Loss on Assets', 'EXPENSE', 'OPERATING_EXPENSE', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'],
  ['5900', 'Loss on Asset Disposal', 'EXPENSE', 'OTHER_EXPENSE', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'],
  ['5910', 'Foreign Exchange Loss', 'EXPENSE', 'OTHER_EXPENSE', 3, false, 'DEBIT', 'ACTIVE', true, 'OPERATING_EXPENSES'],
];

// [code, name]
// Default GL control mappings: [purpose, account_code]. Period close, FX
// revaluation, revenue recognition and continuous close refuse to run without
// them. Same values migration 202608160300 gave the companies of its day.
const STANDARD_GL_MAPPINGS = [
  ['AR_CONTROL', '1120'],
  ['AP_CONTROL', '2110'],
  ['INVENTORY_CONTROL', '1130'],
  ['RECON_SUSPENSE', '2126'],
];

// Default approval chains, per document type: [document_type, template name,
// [[step_number, min_amount, approver_role], ...]]. The same bands migration
// 202608120100 seeds for the companies that existed when it ran. A company
// with NO template for a document type cannot get that document approved:
// JournalEntry.create fails closed to PENDING_APPROVAL when no JOURNAL_ENTRY
// template resolves, and with no chain behind it the entry can never post, so
// a new company's general ledger was frozen from its first entry. Defaults,
// not policy: each company tunes them (Settings, approval chains).
const STANDARD_APPROVAL_CHAINS = [
  ['JOURNAL_ENTRY', 'Journal Entry Approval', [[1, 1000, 'FINANCE_MANAGER'], [2, 25000, 'ADMIN']]],
  ['PURCHASE_ORDER', 'Purchase Order Approval', [[1, 1000, 'MANAGER'], [2, 25000, 'ADMIN']]],
  ['SALES_ORDER', 'Sales Order Approval', [[1, 5000, 'MANAGER'], [2, 50000, 'ADMIN']]],
  ['SUPPLIER_INVOICE', 'Supplier Invoice Approval', [[1, 1000, 'FINANCE_MANAGER'], [2, 25000, 'ADMIN']]],
  ['CUSTOMER_PAYMENT', 'Customer Payment Approval', [[1, 5000, 'FINANCE_MANAGER'], [2, 50000, 'ADMIN']]],
  ['SUPPLIER_PAYMENT', 'Supplier Payment Approval', [[1, 5000, 'FINANCE_MANAGER'], [2, 50000, 'ADMIN']]],
  ['CREDIT_NOTE', 'Credit Note Approval', [[1, 500, 'FINANCE_MANAGER'], [2, 10000, 'ADMIN']]],
  ['PAYROLL_RUN', 'Payroll Run Approval', [[1, 0, 'FINANCE_MANAGER'], [2, 100000, 'ADMIN']]],
];

const STANDARD_COST_CENTERS = [
  ['SALES', 'Sales Department'],
  ['PROCUREMENT', 'Procurement Department'],
  ['OPERATIONS', 'Operations Department'],
  ['FINANCE', 'Finance Department'],
  ['IT', 'IT Department'],
  ['HR', 'Human Resources'],
  ['WAREHOUSE', 'Warehouse & Logistics'],
];

class ChartOfAccounts {
  static async findAll(filters = {}) {
    try {
      let query = `
        SELECT 
          coa.*,
          parent.account_name as parent_account_name,
          parent.account_code as parent_account_code,
          u1.first_name || ' ' || u1.last_name as created_by_name,
          u2.first_name || ' ' || u2.last_name as updated_by_name,
          u3.first_name || ' ' || u3.last_name as approved_by_name
        FROM chart_of_accounts coa
        LEFT JOIN chart_of_accounts parent ON coa.parent_account_id = parent.id
        LEFT JOIN users u1 ON coa.created_by = u1.id
        LEFT JOIN users u2 ON coa.updated_by = u2.id
        LEFT JOIN users u3 ON coa.approved_by = u3.id
        WHERE coa.deleted_at IS NULL
      `;
      
      const conditions = [];
      const values = [];

      if (filters.search) {
        conditions.push(`(
          coa.account_code ILIKE $${values.length + 1} OR
          coa.account_name ILIKE $${values.length + 1} OR
          coa.description ILIKE $${values.length + 1}
        )`);
        values.push(`%${filters.search}%`);
      }

      if (filters.account_type) {
        conditions.push(`coa.account_type = $${values.length + 1}`);
        values.push(filters.account_type);
      }

      if (filters.status) {
        conditions.push(`coa.status = $${values.length + 1}`);
        values.push(filters.status);
      }

      if (filters.is_active !== undefined && filters.is_active !== '') {
        conditions.push(`coa.is_active = $${values.length + 1}`);
        values.push(filters.is_active === 'true' || filters.is_active === true);
      }

      if (filters.is_header !== undefined) {
        conditions.push(`coa.is_header = $${values.length + 1}`);
        values.push(filters.is_header);
      }

      if (filters.parent_account_id) {
        conditions.push(`coa.parent_account_id = $${values.length + 1}`);
        values.push(filters.parent_account_id);
      }

      if (conditions.length > 0) {
        query += ` AND ${conditions.join(' AND ')}`;
      }

      query += ` ORDER BY coa.account_code, coa.account_level, coa.created_at DESC`;
      
      if (filters.limit) {
        query += ` LIMIT ${parseInt(filters.limit)}`;
      }
      
      if (filters.offset) {
        query += ` OFFSET ${parseInt(filters.offset)}`;
      }

      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      console.error('Error in ChartOfAccounts.findAll:', error);
      throw error;
    }
  }

  static async findById(id) {
    const query = `
      SELECT 
        coa.*,
        parent.account_name as parent_account_name,
        parent.account_code as parent_account_code,
        u1.first_name || ' ' || u1.last_name as created_by_name,
        u2.first_name || ' ' || u2.last_name as updated_by_name,
        u3.first_name || ' ' || u3.last_name as approved_by_name
      FROM chart_of_accounts coa
      LEFT JOIN chart_of_accounts parent ON coa.parent_account_id = parent.id
      LEFT JOIN users u1 ON coa.created_by = u1.id
      LEFT JOIN users u2 ON coa.updated_by = u2.id
      LEFT JOIN users u3 ON coa.approved_by = u3.id
      WHERE coa.id = $1 AND coa.deleted_at IS NULL
    `;
    
    const result = await pool.query(query, [id]);
    return result.rows[0] || null;
  }

  static async findByCode(accountCode) {
    const query = `
      SELECT * FROM chart_of_accounts 
      WHERE account_code = $1 AND deleted_at IS NULL
    `;
    
    const result = await pool.query(query, [accountCode]);
    return result.rows[0] || null;
  }

  static async create(accountData, userId) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      const {
        account_code,
        account_name,
        account_type,
        account_subtype,
        parent_account_id,
        account_level = 1,
        is_header = false,
        normal_balance,
        current_balance = 0.00,
        beginning_balance = 0.00,
        allow_manual_posting = true,
        require_department = false,
        require_project = false,
        require_cost_center = false,
        balance_sheet_section,
        income_statement_section,
        cash_flow_section,
        description,
        tax_code,
        currency = 'USD',
        bank_name,
        bank_account_number,
        bank_routing_number
      } = accountData;

      // Validate required fields
      if (!account_code || !account_name || !account_type || !normal_balance) {
        throw new Error('Account code, name, type, and normal balance are required');
      }

      // Check if account code already exists
      const existingAccount = await client.query(
        'SELECT id FROM chart_of_accounts WHERE account_code = $1 AND deleted_at IS NULL',
        [account_code]
      );

      if (existingAccount.rows.length > 0) {
        throw new Error('Account code already exists');
      }

      // If parent is specified, validate it exists and is a header
      if (parent_account_id) {
        const parentResult = await client.query(
          'SELECT is_header, account_level FROM chart_of_accounts WHERE id = $1 AND deleted_at IS NULL',
          [parent_account_id]
        );

        if (parentResult.rows.length === 0) {
          throw new Error('Parent account not found');
        }

        if (!parentResult.rows[0].is_header) {
          throw new Error('Parent account must be a header account');
        }
      }

      const accountId = uuidv4();
      
      const query = `
        INSERT INTO chart_of_accounts (
          id, account_code, account_name, account_type, account_subtype,
          parent_account_id, account_level, is_header, normal_balance,
          current_balance, beginning_balance, allow_manual_posting,
          require_department, require_project, require_cost_center,
          balance_sheet_section, income_statement_section, cash_flow_section,
          description, tax_code, currency, bank_name, bank_account_number,
          bank_routing_number, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
        RETURNING *
      `;

      const values = [
        accountId, account_code, account_name, account_type, account_subtype,
        parent_account_id, account_level, is_header, normal_balance,
        current_balance, beginning_balance, allow_manual_posting,
        require_department, require_project, require_cost_center,
        balance_sheet_section, income_statement_section, cash_flow_section,
        description, tax_code, currency, bank_name, bank_account_number,
        bank_routing_number, userId
      ];

      const result = await client.query(query, values);
      const account = result.rows[0];

      // Log status history
      await this.addStatusHistory(client, accountId, null, 'PENDING_APPROVAL', userId);

      await client.query('COMMIT');
      return account;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async update(id, accountData, userId) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Check if account exists
      const existingResult = await client.query(
        'SELECT status FROM chart_of_accounts WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );

      if (existingResult.rows.length === 0) {
        throw new Error('Account not found');
      }

      const currentStatus = existingResult.rows[0].status;
      if (currentStatus === 'CLOSED') {
        throw new Error('Cannot update closed account');
      }

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
      } = accountData;

      const query = `
        UPDATE chart_of_accounts 
        SET account_name = $2, account_type = $3, account_subtype = $4,
            parent_account_id = $5, account_level = $6, is_header = $7,
            normal_balance = $8, allow_manual_posting = $9, require_department = $10,
            require_project = $11, require_cost_center = $12, balance_sheet_section = $13,
            income_statement_section = $14, cash_flow_section = $15, description = $16,
            tax_code = $17, currency = $18, bank_name = $19, bank_account_number = $20,
            bank_routing_number = $21, is_active = $22, updated_by = $23, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `;

      const values = [
        id, account_name, account_type, account_subtype, parent_account_id,
        account_level, is_header, normal_balance, allow_manual_posting,
        require_department, require_project, require_cost_center,
        balance_sheet_section, income_statement_section, cash_flow_section,
        description, tax_code, currency, bank_name, bank_account_number,
        bank_routing_number, is_active, userId
      ];

      const result = await client.query(query, values);
      
      await client.query('COMMIT');
      return result.rows[0];
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateStatus(id, newStatus, userId, reason = '') {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      const currentResult = await client.query(
        'SELECT status FROM chart_of_accounts WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );

      if (currentResult.rows.length === 0) {
        throw new Error('Account not found');
      }

      const currentStatus = currentResult.rows[0].status;

      // Validate status transitions
      const validTransitions = {
        'PENDING_APPROVAL': ['APPROVED', 'REJECTED'],
        'APPROVED': ['ACTIVE', 'INACTIVE'],
        'ACTIVE': ['INACTIVE', 'CLOSED'],
        'INACTIVE': ['ACTIVE', 'CLOSED'],
        'REJECTED': ['PENDING_APPROVAL']
      };

      if (!validTransitions[currentStatus]?.includes(newStatus)) {
        throw new Error(`Invalid status transition from ${currentStatus} to ${newStatus}`);
      }

      let updateQuery = 'UPDATE chart_of_accounts SET status = $2, updated_by = $3, updated_at = CURRENT_TIMESTAMP';
      let updateValues = [id, newStatus, userId];

      if (newStatus === 'APPROVED') {
        updateQuery += ', approved_by = $4, approved_at = CURRENT_TIMESTAMP';
        updateValues.push(userId);
      }

      updateQuery += ' WHERE id = $1 RETURNING *';

      const result = await client.query(updateQuery, updateValues);

      // Add status history
      await this.addStatusHistory(client, id, currentStatus, newStatus, userId, reason);

      await client.query('COMMIT');
      return result.rows[0];
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async addStatusHistory(client, accountId, fromStatus, toStatus, userId, reason = '') {
    const query = `
      INSERT INTO chart_of_accounts_status_history (
        account_id, from_status, to_status, changed_by, reason
      )
      VALUES ($1, $2, $3, $4, $5)
    `;

    await client.query(query, [accountId, fromStatus, toStatus, userId, reason]);
  }

  static async getStatusHistory(id) {
    const query = `
      SELECT 
        ash.*,
        u.first_name || ' ' || u.last_name as changed_by_name
      FROM chart_of_accounts_status_history ash
      LEFT JOIN users u ON ash.changed_by = u.id
      WHERE ash.account_id = $1
      ORDER BY ash.created_at DESC
    `;

    const result = await pool.query(query, [id]);
    return result.rows;
  }

  static async getAccountHierarchy(parentId = null) {
    const query = `
      WITH RECURSIVE account_tree AS (
        SELECT id, account_code, account_name, account_type, parent_account_id, 
               account_level, is_header, status, is_active, 0 as depth
        FROM chart_of_accounts 
        WHERE parent_account_id ${parentId ? '= $1' : 'IS NULL'} AND deleted_at IS NULL
        
        UNION ALL
        
        SELECT coa.id, coa.account_code, coa.account_name, coa.account_type, 
               coa.parent_account_id, coa.account_level, coa.is_header, coa.status, 
               coa.is_active, at.depth + 1
        FROM chart_of_accounts coa
        INNER JOIN account_tree at ON coa.parent_account_id = at.id
        WHERE coa.deleted_at IS NULL
      )
      SELECT * FROM account_tree ORDER BY account_code
    `;

    const values = parentId ? [parentId] : [];
    const result = await pool.query(query, values);
    return result.rows;
  }

  static async getBalanceSheet() {
    const query = `
      SELECT 
        account_type,
        balance_sheet_section,
        SUM(current_balance) as total_balance
      FROM chart_of_accounts 
      WHERE account_type IN ('ASSET', 'LIABILITY', 'EQUITY') 
        AND is_active = true 
        AND deleted_at IS NULL
        AND is_header = false
      GROUP BY account_type, balance_sheet_section
      ORDER BY account_type, balance_sheet_section
    `;

    const result = await pool.query(query);
    return result.rows;
  }

  static async getIncomeStatement() {
    const query = `
      SELECT 
        account_type,
        income_statement_section,
        SUM(current_balance) as total_balance
      FROM chart_of_accounts 
      WHERE account_type IN ('REVENUE', 'EXPENSE') 
        AND is_active = true 
        AND deleted_at IS NULL
        AND is_header = false
      GROUP BY account_type, income_statement_section
      ORDER BY account_type, income_statement_section
    `;

    const result = await pool.query(query);
    return result.rows;
  }

  static async updateBalance(accountId, amount, operation = 'ADD') {
    const query = `
      UPDATE chart_of_accounts 
      SET current_balance = CASE 
        WHEN $3 = 'ADD' THEN current_balance + $2
        WHEN $3 = 'SUBTRACT' THEN current_balance - $2
        ELSE $2
      END,
      updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING current_balance
    `;

    const result = await pool.query(query, [accountId, amount, operation]);
    return result.rows[0];
  }

  static async delete(id, userId) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Check if account has child accounts
      const childResult = await client.query(
        'SELECT COUNT(*) as child_count FROM chart_of_accounts WHERE parent_account_id = $1 AND deleted_at IS NULL',
        [id]
      );

      if (parseInt(childResult.rows[0].child_count) > 0) {
        throw new Error('Cannot delete account with child accounts');
      }

      // Check if account has transactions
      const transactionResult = await client.query(
        'SELECT COUNT(*) as transaction_count FROM journal_entry_items WHERE account_id = $1',
        [id]
      );

      if (parseInt(transactionResult.rows[0].transaction_count) > 0) {
        throw new Error('Cannot delete account with existing transactions');
      }

      const result = await client.query(
        `UPDATE chart_of_accounts 
         SET deleted_at = CURRENT_TIMESTAMP, updated_by = $2, status = 'CLOSED'
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING *`,
        [id, userId]
      );

      if (result.rows.length === 0) {
        throw new Error('Account not found');
      }

      // Add status history
      await this.addStatusHistory(client, id, result.rows[0].status, 'CLOSED', userId, 'Account deleted');

      await client.query('COMMIT');
      return result.rows[0];
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async getStats() {
    const query = `
      SELECT 
        COUNT(*) as total_accounts,
        COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END) as pending_approval,
        COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END) as active_accounts,
        COUNT(CASE WHEN account_type = 'ASSET' THEN 1 END) as asset_accounts,
        COUNT(CASE WHEN account_type = 'LIABILITY' THEN 1 END) as liability_accounts,
        COUNT(CASE WHEN account_type = 'EQUITY' THEN 1 END) as equity_accounts,
        COUNT(CASE WHEN account_type = 'REVENUE' THEN 1 END) as revenue_accounts,
        COUNT(CASE WHEN account_type = 'EXPENSE' THEN 1 END) as expense_accounts,
        SUM(CASE WHEN account_type = 'ASSET' THEN current_balance ELSE 0 END) as total_assets,
        SUM(CASE WHEN account_type = 'LIABILITY' THEN current_balance ELSE 0 END) as total_liabilities,
        SUM(CASE WHEN account_type = 'EQUITY' THEN current_balance ELSE 0 END) as total_equity
      FROM chart_of_accounts 
      WHERE deleted_at IS NULL
    `;

    const result = await pool.query(query);
    return result.rows[0];
  }

  /**
   * Seed the standard finance master data every company needs before the first
   * GL posting can resolve its accounts: the standard chart of accounts, the
   * standard cost centers, and open accounting periods.
   *
   * WHY THIS EXISTS
   * ---------------------------------------------------------------------------
   * The deployment's default company was seeded by migration 202608120500, but
   * the signup path created a brand-new company with an EMPTY chart_of_accounts
   * — so every GL posting (goods receipts, invoices, payments, payroll) failed
   * with "Required accounts not found" for the new tenant. This is the same
   * seed, run from application code, scoped to the company being created.
   *
   * IDEMPOTENT
   * ---------------------------------------------------------------------------
   * Every insert is ON CONFLICT ... DO NOTHING against the per-company natural
   * keys (chart_of_accounts (company_id, account_code), cost_centers
   * (company_id, code), accounting_periods (period_year, period_month)), so
   * re-running company creation — or this helper — never duplicates rows.
   *
   * ROW-LEVEL SECURITY
   * ---------------------------------------------------------------------------
   * chart_of_accounts / cost_centers / accounting_periods are company-scoped
   * under the isolation policy (migration 110), so the seed runs with
   * companyScope.runWithCompany(companyId, ...) as its ambient company — that
   * is what makes the WITH CHECK (company_id = current_company_id()) pass when
   * isolation is on, and it is a no-op when it is off.
   *
   * TRANSACTION
   * ---------------------------------------------------------------------------
   * Owns a transaction (BEGIN/COMMIT) unless a client is passed in, so the
   * three seeds commit or roll back together. A caller that supplies its own
   * client is responsible for the transaction, and must acquire it inside
   * companyScope.runWithCompany(companyId, ...) when isolation is on.
   *
   * @param {string} companyId the company being created
   * @param {string} userId    the registering/admin user (created_by on the seeded rows)
   * @param {{client?: object}} [options]
   * @returns {Promise<{accounts: number, cost_centers: number, periods: number}>} rows actually inserted
   */
  static async seedFinanceMasterData(companyId, userId, { client } = {}) {
    return companyScope.runWithCompany(companyId, async () => {
      const owned = !client;
      const executor = client || await pool.connect();
      try {
        if (owned) await executor.query('BEGIN');

        // Standard chart of accounts — the migration 202608120500 VALUES list.
        const accountValues = STANDARD_ACCOUNTS
          .map(function (a) {
            return '(' + a.map(function (v) {
              // Numbers and booleans must stay unquoted literals: account_level
              // is INTEGER and is_header/allow_manual_posting are BOOLEAN, so
              // quoting them as text makes PostgreSQL refuse the INSERT
              // (42804: expression is of type text). Only strings get quoted.
              if (typeof v === 'number' || typeof v === 'boolean') return String(v);
              return "'" + String(v).replace(/'/g, "''") + "'";
            }).join(',') + ')';
          })
          .join(',\n               ');
        const accountsResult = await executor.query(
          'INSERT INTO chart_of_accounts\n' +
          '             (company_id, account_code, account_name, account_type, account_subtype,\n' +
          '              account_level, is_header, normal_balance, status, created_by,\n' +
          '              allow_manual_posting, balance_sheet_section)\n' +
          '           SELECT $1, v.account_code, v.account_name, v.account_type, v.account_subtype,\n' +
          '                  v.account_level, v.is_header, v.normal_balance, v.status, $2,\n' +
          '                  v.allow_manual_posting, v.balance_sheet_section\n' +
          '             FROM (VALUES\n' +
          '               ' + accountValues + '\n' +
          '             ) AS v(account_code, account_name, account_type, account_subtype,\n' +
          '                    account_level, is_header, normal_balance, status,\n' +
          '                    allow_manual_posting, balance_sheet_section)\n' +
          '           ON CONFLICT (company_id, account_code) DO NOTHING\n' +
          '           RETURNING 1',
          [companyId, userId]
        );

        // Standard cost centers (the DoA form and budget screens expect them).
        const costCenterValues = STANDARD_COST_CENTERS
          .map(function (c) {
            return "('" + c[0] + "','" + c[1].replace(/'/g, "''") + "')";
          })
          .join(',\n               ');
        const costCentersResult = await executor.query(
          'INSERT INTO cost_centers (company_id, code, name, status, created_by)\n' +
          '           SELECT $1, v.code, v.name, \'ACTIVE\', $2\n' +
          '             FROM (VALUES\n' +
          '               ' + costCenterValues + '\n' +
          '             ) AS v(code, name)\n' +
          '           ON CONFLICT (company_id, code) DO NOTHING\n' +
          '           RETURNING 1',
          [companyId, userId]
        );

        // Open accounting periods: previous, current and next year, the pattern
        // migration 202608120500 established for the default company.
        //
        // This used to walk forward a year at a time hunting for months no other
        // tenant had claimed, because accounting_periods was unique on
        // (period_year, period_month) across ALL companies. Migration
        // 202608130100 makes that key per company, so every tenant simply gets
        // the same three real years and the search is gone.
        const baseYear = new Date().getFullYear();
        const periodsResult = await executor.query(
          'INSERT INTO accounting_periods (company_id, period_year, period_month, status)\n' +
          '             SELECT $1, y, m, \'OPEN\'\n' +
          '               FROM unnest($2::int[]) AS y, generate_series(1, 12) AS m\n' +
          '             ON CONFLICT DO NOTHING\n' +
          '             RETURNING 1',
          [companyId, [baseYear - 1, baseYear, baseYear + 1]]
        );
        let periodCount = periodsResult.rows.length;
        if (periodCount < 36) {
          // Re-seeding an existing company: ON CONFLICT swallowed the rows that
          // were already there, so report what the company actually has.
          const { rows } = await executor.query(
            'SELECT COUNT(*)::int AS n FROM accounting_periods WHERE company_id = $1',
            [companyId]
          );
          periodCount = rows[0].n;
        }

        // Default GL control mappings; never overwrites one an admin has set.
        const mappingsResult = await executor.query(
          'INSERT INTO company_gl_mappings (company_id, purpose, account_code)\n' +
          '           SELECT $1, v.purpose, v.account_code\n' +
          '             FROM unnest($2::text[], $3::text[]) AS v(purpose, account_code)\n' +
          '           ON CONFLICT (company_id, purpose) DO NOTHING\n' +
          '           RETURNING 1',
          [companyId,
            STANDARD_GL_MAPPINGS.map(function (m) { return m[0]; }),
            STANDARD_GL_MAPPINGS.map(function (m) { return m[1]; })]
        );

        // Default approval chains. A template is added only for a document
        // type the company has none for (active or not), and steps only to the
        // templates added here, so a company's own chains are never touched.
        const newTemplates = await executor.query(
          'INSERT INTO approval_chain_templates (name, document_type, is_active, created_by, company_id)\n' +
          '           SELECT v.name, v.document_type, true, $2, $1\n' +
          '             FROM unnest($3::text[], $4::text[]) AS v(document_type, name)\n' +
          '            WHERE NOT EXISTS (SELECT 1 FROM approval_chain_templates t\n' +
          '                               WHERE t.company_id = $1 AND t.document_type = v.document_type)\n' +
          '           RETURNING id, document_type',
          [companyId, userId,
            STANDARD_APPROVAL_CHAINS.map(function (c) { return c[0]; }),
            STANDARD_APPROVAL_CHAINS.map(function (c) { return c[1]; })]
        );
        for (const tpl of newTemplates.rows) {
          const chain = STANDARD_APPROVAL_CHAINS.find(function (c) { return c[0] === tpl.document_type; });
          for (const [stepNumber, minAmount, role] of chain[2]) {
            await executor.query(
              'INSERT INTO approval_chain_steps (template_id, step_number, min_amount, approver_role)\n' +
              '             VALUES ($1, $2, $3, $4)',
              [tpl.id, stepNumber, minAmount, role]
            );
          }
        }

        if (owned) await executor.query('COMMIT');
        return {
          accounts: accountsResult.rows.length,
          cost_centers: costCentersResult.rows.length,
          periods: periodCount,
          gl_mappings: mappingsResult.rows.length,
          approval_chains: newTemplates.rows.length,
        };
      } catch (error) {
        if (owned) await executor.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        if (owned) executor.release();
      }
    });
  }
}

module.exports = ChartOfAccounts;