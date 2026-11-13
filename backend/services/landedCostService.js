const { pool } = require('../config/database');
const { currentCompanyId } = require('./companyContext');
const JournalEntry = require('../models/JournalEntry');

class LandedCostService {
  /**
   * Allocate freight, customs duty, and insurance costs onto inventory goods receipts.
   */
  static async allocateAndPost(
    { voucherNumber, postingDate, totalLandedCost, receiptIds = [], method = 'VALUE' },
    userId = null,
    companyId = currentCompanyId()
  ) {
    const { rows: receiptItems } = await pool.query(
      `SELECT gri.id, gri.goods_receipt_id, gri.item_id, gri.received_quantity, gri.unit_cost, (gri.received_quantity * gri.unit_cost) AS total_val
         FROM goods_receipt_items gri
        WHERE gri.goods_receipt_id = ANY($1)`,
      [receiptIds]
    );

    if (receiptItems.length === 0) {
      throw new Error('No goods receipt items found for landed cost allocation.');
    }

    const totalValuation = receiptItems.reduce((sum, item) => sum + Number(item.total_val || 0), 0) || 1;

    // Create Landed Cost Voucher
    const { rows: vouchers } = await pool.query(
      `INSERT INTO landed_cost_vouchers (voucher_number, posting_date, total_landed_cost, allocation_method, status, company_id)
       VALUES ($1, $2, $3, $4, 'POSTED', COALESCE($5, public.current_company_id()))
       RETURNING *`,
      [
        voucherNumber || `LCV-${Date.now().toString().slice(-6)}`,
        postingDate || new Date().toISOString().split('T')[0],
        totalLandedCost,
        method,
        companyId,
      ]
    );
    const voucher = vouchers[0];

    // Allocate landed cost per item & update unit cost in inventory + cost_layers
    for (const item of receiptItems) {
      const share = Number(item.total_val || 0) / totalValuation;
      const allocated = Number((totalLandedCost * share).toFixed(2));

      await pool.query(
        `INSERT INTO landed_cost_items (voucher_id, goods_receipt_id, inventory_item_id, allocated_amount)
         VALUES ($1, $2, $3, $4)`,
        [voucher.id, item.goods_receipt_id, item.item_id, allocated]
      );

      // Increase inventory valuation layer unit cost
      const perUnitAdd = allocated / Number(item.received_quantity || 1);
      await pool.query(
        `UPDATE inventory_items
            SET unit_price = unit_price + $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2`,
        [perUnitAdd, item.item_id]
      );

      // Also update corresponding cost_layers for accurate COGS / FIFO tracking
      await pool.query(
        `UPDATE cost_layers
            SET unit_cost = unit_cost + $1
          WHERE receipt_id = $2 AND inventory_item_id = $3`,
        [perUnitAdd, item.goods_receipt_id, item.item_id]
      ).catch(() => {});
    }

    // Post GL Journal Entry: Dr Inventory (1130) / Cr Freight & Duty Accrual (2120)
    const { rows: glAccounts } = await pool.query(
      `SELECT id, account_code FROM chart_of_accounts
        WHERE account_code IN ('1130', '2120') AND deleted_at IS NULL`
    );
    const glAccountByCode = Object.fromEntries(glAccounts.map((a) => [a.account_code, a.id]));
    if (!glAccountByCode['1130'] || !glAccountByCode['2120']) {
      throw new Error('Landed cost GL accounts (1130 Inventory / 2120 Freight & Duty Accrual) not found.');
    }

    const entry = await JournalEntry.create({
      entry_date: postingDate || new Date().toISOString().split('T')[0],
      description: `Landed Cost Allocation Voucher ${voucher.voucher_number}`,
      source_type: 'LANDED_COST',
      source_id: voucher.id,
      company_id: voucher.company_id || companyId,
    }, [
      { account_id: glAccountByCode['1130'], debit_amount: totalLandedCost, credit_amount: 0, description: 'Inventory Capitalized Landed Cost' },
      { account_id: glAccountByCode['2120'], debit_amount: 0, credit_amount: totalLandedCost, description: 'Freight & Duty Accrual' },
    ], userId);

    await JournalEntry.postAsSystem(entry.id, userId, 'Auto-posted landed cost allocation');

    await pool.query(
      `UPDATE landed_cost_vouchers
          SET journal_entry_id = $1
        WHERE id = $2`,
      [entry.id, voucher.id]
    );

    return {
      success: true,
      voucher,
      allocated_items_count: receiptItems.length,
      journal_entry_id: entry.id,
    };
  }
}

module.exports = LandedCostService;

