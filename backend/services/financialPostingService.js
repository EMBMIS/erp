const JournalEntry = require('../models/JournalEntry');
const ChartOfAccounts = require('../models/ChartOfAccounts');
const { pool } = require('../config/database');

class FinancialPostingService {

  // Create inventory adjustment journal entry. `externalClient`, when given,
  // keeps every query here — the account lookups and the journal posting —
  // on the caller's own transaction and connection, so this is atomic with
  // whatever stock change it's accounting for (a stocktake variance, a
  // manual adjustment) instead of racing it as an independent transaction on
  // a separate connection. That gap was real and measured: it's the same
  // pattern that caused goods-issue COGS posting to deadlock under
  // concurrent load until WarehouseTransaction.postCogsForIssue was fixed
  // to pass its client through; this is the same fix for the stock-
  // adjustment (SA) path, which posts through here.
  static async postInventoryAdjustment(adjustmentData, userId, externalClient = null) {
    const db = externalClient || pool;
    try {
      const {
        inventory_item_id,
        adjustment_quantity,
        adjustment_value,
        reason,
        reference
      } = adjustmentData;

      // Get inventory item details
      const inventoryQuery = `
        SELECT ii.*, i.name as item_name
        FROM inventory_items ii
        LEFT JOIN items i ON ii.item_master_id = i.id
        WHERE ii.id = $1
      `;

      const inventoryResult = await db.query(inventoryQuery, [inventory_item_id]);
      if (inventoryResult.rows.length === 0) {
        throw new Error('Inventory item not found');
      }

      const inventoryItem = inventoryResult.rows[0];

      // Get accounts
      const inventoryAccount = await db.query(
        "SELECT id FROM chart_of_accounts WHERE account_code = '1130' AND deleted_at IS NULL"
      );
      const adjustmentAccount = await db.query(
        "SELECT id FROM chart_of_accounts WHERE account_code = '5100' AND deleted_at IS NULL"
      );

      if (inventoryAccount.rows.length === 0 || adjustmentAccount.rows.length === 0) {
        throw new Error('Required accounts not found (Inventory: 1130, COGS: 5100)');
      }

      const entryData = {
        entry_date: new Date().toISOString().split('T')[0],
        source_type: 'INVENTORY_ADJUSTMENT',
        source_id: inventory_item_id,
        description: `Inventory Adjustment - ${inventoryItem.item_name}`,
        reference: reference || `INV-ADJ-${Date.now()}`,
        notes: reason,
        requires_approval: Math.abs(adjustment_value) > 1000 // Require approval for large adjustments
      };

      const items = [];

      if (adjustment_value > 0) {
        // Positive adjustment - increase inventory
        items.push(
          {
            account_id: inventoryAccount.rows[0].id,
            debit_amount: adjustment_value,
            credit_amount: 0,
            description: `Inventory increase - ${inventoryItem.item_name}`
          },
          {
            account_id: adjustmentAccount.rows[0].id,
            debit_amount: 0,
            credit_amount: adjustment_value,
            description: `COGS reduction - ${inventoryItem.item_name}`
          }
        );
      } else {
        // Negative adjustment - decrease inventory
        const absValue = Math.abs(adjustment_value);
        items.push(
          {
            account_id: adjustmentAccount.rows[0].id,
            debit_amount: absValue,
            credit_amount: 0,
            description: `COGS increase - ${inventoryItem.item_name}`
          },
          {
            account_id: inventoryAccount.rows[0].id,
            debit_amount: 0,
            credit_amount: absValue,
            description: `Inventory decrease - ${inventoryItem.item_name}`
          }
        );
      }

      const entry = await JournalEntry.create(entryData, items, userId, externalClient);
      // Auto-post immediately, same as every other automated GL posting in this
      // codebase (COGS, GR/IR, revenue) — the physical event (the count itself)
      // is the authorization. Material adjustments (> $1000) instead go to
      // PENDING_APPROVAL above and are left for a manager to review and post
      // explicitly through the normal journal-entries approval flow.
      if (!entryData.requires_approval) {
        await JournalEntry.postAsSystem(entry.id, userId, 'Auto-posted inventory/stocktake adjustment', externalClient);
      }
      return entry;

    } catch (error) {
      console.error('Error posting inventory adjustment:', error);
      throw error;
    }
  }

  // Create cash payment journal entry. `externalClient`, when given, keeps
  // the account lookup and the journal posting on the caller's own
  // transaction — SupplierPayment.create() calls this mid-transaction
  // (payment row + bill allocations + this posting all need to succeed or
  // fail together), and without threading the client through, the GL entry
  // was committing on its own separate connection: a payment-creation
  // rollback after this point could leave a POSTED journal entry — Dr AP /
  // Cr Cash — with no supplier_payment row behind it. Same bug class as
  // postCogsForIssue and postInventoryAdjustment before this.
  static async postCashPayment(paymentData, userId, externalClient = null) {
    const db = externalClient || pool;
    try {
      const {
        amount,
        payment_method,
        vendor_id,
        customer_id,
        description,
        reference,
        account_id, // Specific GL account to debit/credit
        // Multi-currency: cash_amount is the payment in BASE currency and
        // amount the AP/AR leg at the booked rate; the difference is realized
        // FX, posted to fx_account_id (Dr 5910 loss / Cr 4910 gain). When
        // omitted the entry is the plain face-value posting.
        cash_amount = amount,
        fx_amount = 0,
        fx_gain = false,
        fx_account_id = null
      } = paymentData;

      // Get cash account
      const cashAccount = await db.query(
        "SELECT id FROM chart_of_accounts WHERE account_code = '1110' AND deleted_at IS NULL"
      );

      if (cashAccount.rows.length === 0) {
        throw new Error('Cash account not found (1110)');
      }

      const entryData = {
        entry_date: new Date().toISOString().split('T')[0],
        source_type: 'BANK_TRANSACTION',
        description: description || 'Cash Transaction',
        reference: reference || `CASH-${Date.now()}`,
        requires_approval: amount > 5000 // Require approval for large payments
      };

      const items = [
        {
          account_id: account_id,
          debit_amount: vendor_id ? amount : 0, // Debit expense/AP for vendor payments
          credit_amount: customer_id ? amount : 0, // Credit AR for customer payments
          description: description
        },
        {
          account_id: cashAccount.rows[0].id,
          debit_amount: customer_id ? cash_amount : 0, // Debit cash for customer payments
          credit_amount: vendor_id ? cash_amount : 0, // Credit cash for vendor payments
          description: `Cash ${vendor_id ? 'payment' : 'receipt'}`
        }
      ];
      // Realized FX leg: a payment made at a different rate than the document
      // was booked at changes what the cash movement is actually worth in base
      // currency. Loss (cash > booked) debits 5910; gain credits 4910. Both
      // legs keep the entry balanced: Dr AP booked + Dr loss = Cr cash paid.
      if (fx_account_id && Math.abs(Number(fx_amount)) > 0.01) {
        items.push({
          account_id: fx_account_id,
          debit_amount: fx_gain ? 0 : Number(fx_amount),
          credit_amount: fx_gain ? Number(fx_amount) : 0,
          description: `Realized foreign exchange ${fx_gain ? 'gain' : 'loss'} on payment`
        });
      }

      return await JournalEntry.create(entryData, items, userId, externalClient);

    } catch (error) {
      console.error('Error posting cash payment:', error);
      throw error;
    }
  }

  // Get trial balance
  static async getTrialBalance(asOfDate = null) {
    try {
      // asOfDate was previously interpolated straight into the SQL string, which
      // was a live injection vector reachable two ways: the as_of_date query
      // parameter on GET /financial-reports/trial-balance, and — more sharply —
      // the `get_trial_balance` AI tool, where the value is chosen by a language
      // model and could be steered by prompt injection. Bound as a parameter now.
      const params = [];
      let dateFilter = '';
      if (asOfDate) {
        params.push(asOfDate);
        dateFilter = `AND je.entry_date <= $${params.length}::date`;
      }

      const query = `
        SELECT
          coa.id as account_id,
          coa.account_code,
          coa.account_name,
          coa.account_type,
          coa.normal_balance,
          SUM(jei.debit_amount) as total_debits,
          SUM(jei.credit_amount) as total_credits,
          SUM(jei.debit_amount) - SUM(jei.credit_amount) as net_balance
        FROM chart_of_accounts coa
        LEFT JOIN journal_entry_items jei ON coa.id = jei.account_id
        LEFT JOIN journal_entries je ON jei.journal_entry_id = je.id
        WHERE coa.deleted_at IS NULL
          AND coa.is_active = true
          AND coa.is_header = false
          AND je.status = 'POSTED'
          ${dateFilter}
        GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_type, coa.normal_balance
        HAVING SUM(jei.debit_amount) > 0 OR SUM(jei.credit_amount) > 0
        ORDER BY coa.account_code
      `;

      const result = await pool.query(query, params);
      return result.rows;

    } catch (error) {
      console.error('Error generating trial balance:', error);
      throw error;
    }
  }

  // Validate chart of accounts setup
  static async validateAccountSetup() {
    const requiredAccounts = [
      { code: '1110', name: 'Cash and Cash Equivalents', type: 'ASSET' },
      { code: '1120', name: 'Accounts Receivable', type: 'ASSET' },
      { code: '1130', name: 'Inventory', type: 'ASSET' },
      { code: '2110', name: 'Accounts Payable', type: 'LIABILITY' },
      { code: '4100', name: 'Sales Revenue', type: 'REVENUE' },
      { code: '5100', name: 'Cost of Goods Sold', type: 'EXPENSE' }
    ];

    const missingAccounts = [];

    for (const requiredAccount of requiredAccounts) {
      const result = await pool.query(
        'SELECT id FROM chart_of_accounts WHERE account_code = $1 AND deleted_at IS NULL',
        [requiredAccount.code]
      );

      if (result.rows.length === 0) {
        missingAccounts.push(requiredAccount);
      }
    }

    return {
      isValid: missingAccounts.length === 0,
      missingAccounts
    };
  }
}

module.exports = FinancialPostingService;