const { pool } = require('../config/database');

/**
 * SupplierPayment — money paid to suppliers, allocated to one or more open
 * bills. Updates each bill's paid/outstanding amount and status, and posts the
 * disbursement to the general ledger (Dr Accounts Payable 2110 / Cr Cash 1110),
 * clearing the payable created when the purchase order was completed.
 */
class SupplierPayment {

  static async findAll(filters = {}) {
    let query = `
      SELECT
        sp.*,
        s.legal_name as supplier_name,
        u.first_name || ' ' || u.last_name as created_by_name,
        je.journal_number,
        COALESCE(SUM(spa.allocation_amount), 0) as allocated_amount
      FROM supplier_payments sp
      LEFT JOIN suppliers s ON sp.supplier_id = s.id
      LEFT JOIN users u ON sp.created_by = u.id
      LEFT JOIN journal_entries je ON sp.journal_entry_id = je.id
      LEFT JOIN supplier_payment_allocations spa ON spa.payment_id = sp.id
      WHERE sp.deleted_at IS NULL
    `;
    const conditions = [];
    const values = [];

    if (filters.search) {
      conditions.push(`(sp.payment_number ILIKE $${values.length + 1} OR s.legal_name ILIKE $${values.length + 1})`);
      values.push(`%${filters.search}%`);
    }
    if (filters.status) {
      conditions.push(`sp.status = $${values.length + 1}`);
      values.push(filters.status);
    }
    if (filters.supplier_id) {
      conditions.push(`sp.supplier_id = $${values.length + 1}`);
      values.push(filters.supplier_id);
    }
    if (conditions.length > 0) query += ' AND ' + conditions.join(' AND ');
    query += ' GROUP BY sp.id, s.legal_name, u.first_name, u.last_name, je.journal_number ORDER BY sp.created_at DESC';
    if (filters.limit) {
      query += ` LIMIT $${values.length + 1}`;
      values.push(filters.limit);
    }

    const result = await pool.query(query, values);
    return result.rows;
  }

  static async findById(id) {
    const paymentResult = await pool.query(`
      SELECT sp.*, s.legal_name as supplier_name, je.journal_number
      FROM supplier_payments sp
      LEFT JOIN suppliers s ON sp.supplier_id = s.id
      LEFT JOIN journal_entries je ON sp.journal_entry_id = je.id
      WHERE sp.id = $1 AND sp.deleted_at IS NULL
    `, [id]);
    if (paymentResult.rows.length === 0) return null;
    const payment = paymentResult.rows[0];
    const allocations = await pool.query(`
      SELECT spa.*, si.bill_number
      FROM supplier_payment_allocations spa
      JOIN supplier_invoices si ON spa.bill_id = si.id
      WHERE spa.payment_id = $1
      ORDER BY spa.allocation_date
    `, [id]);
    payment.allocations = allocations.rows;
    return payment;
  }

  /**
   * @param {Object} data - { supplier_id, payment_date, payment_method, reference_number, payment_amount, currency, description, notes }
   * @param {Array}  allocations - [{ bill_id, allocation_amount }]
   */
  static async create(data, allocations = [], userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (!data.supplier_id) throw new Error('supplier_id is required');
      if (!data.payment_amount || Number(data.payment_amount) <= 0) throw new Error('payment_amount must be positive');
      if (!data.payment_method) throw new Error('payment_method is required');

      const totalAllocated = allocations.reduce((s, a) => s + Number(a.allocation_amount || 0), 0);
      if (totalAllocated - Number(data.payment_amount) > 0.01) {
        throw new Error('Allocated amount exceeds payment amount');
      }

      const numResult = await client.query('SELECT generate_supplier_payment_number() as number');
      const payment_number = numResult.rows[0].number;

      const paymentResult = await client.query(`
        INSERT INTO supplier_payments (
          payment_number, supplier_id, payment_date, payment_method,
          reference_number, payment_amount, currency, status,
          description, notes, created_by, updated_by
        )
        VALUES ($1,$2,COALESCE($3, CURRENT_DATE),$4,$5,$6,$7,$8,$9,$10,$11,$11)
        RETURNING *
      `, [
        payment_number,
        data.supplier_id,
        data.payment_date || null,
        data.payment_method,
        data.reference_number || null,
        data.payment_amount,
        data.currency || 'USD',
        data.status || 'CLEARED',
        data.description || null,
        data.notes || null,
        userId,
      ]);
      const payment = paymentResult.rows[0];

      for (const alloc of allocations) {
        if (!alloc.bill_id || Number(alloc.allocation_amount) <= 0) continue;

        // Cap each allocation at the bill's own outstanding balance. Nothing
        // previously checked this — only that the SUM of allocations didn't
        // exceed the payment's own total — so a single fat-fingered allocation
        // could overpay one bill by any amount, driving its
        // outstanding_amount (total_amount - paid_amount, GENERATED) negative
        // and marking it PAID despite the excess. Locked FOR UPDATE so two
        // concurrent payments against the same bill can't both pass this check
        // against a balance neither has actually settled yet.
        const billLock = await client.query(
          'SELECT total_amount, paid_amount, bill_number, payment_hold, payment_hold_reason FROM supplier_invoices WHERE id = $1 FOR UPDATE',
          [alloc.bill_id]
        );
        if (billLock.rows.length === 0) throw new Error(`Bill ${alloc.bill_id} not found`);
        // A person put this bill on hold (services/billedTwice.js) — the money
        // stays put until someone with the authority releases it.
        if (billLock.rows[0].payment_hold) {
          throw new Error(
            `${billLock.rows[0].bill_number} is on payment hold${billLock.rows[0].payment_hold_reason ? `: ${billLock.rows[0].payment_hold_reason}` : ''}. Release the hold before paying it.`
          );
        }
        const billOutstanding = Number(billLock.rows[0].total_amount) - Number(billLock.rows[0].paid_amount);
        if (Number(alloc.allocation_amount) - billOutstanding > 0.01) {
          throw new Error(
            `Allocation of ${Number(alloc.allocation_amount).toFixed(2)} exceeds bill ${alloc.bill_id}'s outstanding balance of ${billOutstanding.toFixed(2)}`
          );
        }

        await client.query(`
          INSERT INTO supplier_payment_allocations (payment_id, bill_id, allocation_amount, created_by)
          VALUES ($1, $2, $3, $4)
        `, [payment.id, alloc.bill_id, alloc.allocation_amount, userId]);

        const billResult = await client.query(`
          UPDATE supplier_invoices
          SET paid_amount = paid_amount + $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $3
          RETURNING total_amount, paid_amount, status
        `, [alloc.allocation_amount, userId, alloc.bill_id]);

        if (billResult.rows.length > 0) {
          const b = billResult.rows[0];
          const newStatus = Number(b.paid_amount) >= Number(b.total_amount) - 0.01 ? 'PAID' : 'PARTIALLY_PAID';
          if (newStatus !== b.status) {
            await client.query('UPDATE supplier_invoices SET status = $1 WHERE id = $2', [newStatus, alloc.bill_id]);
            await client.query(`
              INSERT INTO supplier_invoice_status_history (bill_id, from_status, to_status, changed_by, reason)
              VALUES ($1, $2, $3, $4, $5)
            `, [alloc.bill_id, b.status, newStatus, userId, `Payment ${payment_number} applied`]);
          }
        }
      }

      // Post disbursement: Dr Accounts Payable (2110) / Cr Cash (1110). Posting
      // is mandatory — a payment that clears the bill but never hits the GL
      // desynchronizes AP and cash. Any failure rolls the payment back (B11).
      // Multi-currency: the AP leg is relieved at each bill's booked rate, cash
      // leaves at the payment-date rate, and the difference is realized FX
      // (4910 gain / 5910 loss) — mirrors CustomerPayment.create.
      {
        const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
        const apAccount = await client.query(
          "SELECT id FROM chart_of_accounts WHERE account_code = '2110' AND deleted_at IS NULL"
        );
        if (apAccount.rows.length === 0) {
          throw new Error('Cannot post supplier payment: Accounts Payable account (2110) missing');
        }

        const Currency = require('./Currency');
        const baseCurrency = await Currency.getBaseCurrency();
        const payCurrency = data.currency || 'USD';
        const payDate = data.payment_date || new Date().toISOString().split('T')[0];
        const payRate = payCurrency === baseCurrency ? 1 : ((await Currency.getRate(payCurrency, baseCurrency, payDate)) || 1);

        let baseCash = 0, baseAP = 0;
        if (allocations.length > 0) {
          for (const alloc of allocations) {
            if (!alloc.bill_id || Number(alloc.allocation_amount) <= 0) continue;
            const billRow = await client.query(
              'SELECT exchange_rate FROM supplier_invoices WHERE id = $1',
              [alloc.bill_id]
            );
            const billRate = Number(billRow.rows[0]?.exchange_rate) || 1;
            baseCash += Number(alloc.allocation_amount) * payRate;
            baseAP += Number(alloc.allocation_amount) * billRate;
          }
        } else {
          baseCash = Number(data.payment_amount) * payRate;
          baseAP = baseCash;
        }
        baseCash = round2(baseCash);
        baseAP = round2(baseAP);
        const fx = round2(baseCash - baseAP); // >0 = paying more base than booked (loss)

        let fxAccountId = null;
        let fxAmount = 0;
        let fxGain = false;
        if (Math.abs(fx) > 0.01) {
          const fxAcc = await client.query(
            "SELECT id FROM chart_of_accounts WHERE account_code = $1 AND deleted_at IS NULL",
            [fx > 0 ? '5910' : '4910']
          );
          fxAccountId = fxAcc.rows[0]?.id || null;
          fxAmount = Math.abs(fx);
          fxGain = fx < 0;
        }

        await client.query('UPDATE supplier_payments SET base_amount = $1 WHERE id = $2', [baseCash, payment.id]);

        const FinancialPostingService = require('../services/financialPostingService');
        const journalEntry = await FinancialPostingService.postCashPayment({
          amount: baseAP,
          cash_amount: baseCash,
          fx_amount: fxAmount,
          fx_gain: fxGain,
          fx_account_id: fxAccountId,
          payment_method: data.payment_method,
          vendor_id: data.supplier_id, // vendor => Dr account_id (AP), Cr Cash
          account_id: apAccount.rows[0].id,
          description: `Supplier payment ${payment_number}`,
          reference: payment_number,
        }, userId, client);
        if (journalEntry?.id) {
          await client.query('UPDATE supplier_payments SET journal_entry_id = $1 WHERE id = $2', [journalEntry.id, payment.id]);
        }
      }

      // Append transaction-atomic audit record for Supplier Payment
      const { auditStatusTransition } = require('../services/auditHook');
      await auditStatusTransition({
        client,
        entityType: 'SUPPLIER_PAYMENT',
        entityId: payment.id,
        fromStatus: null,
        toStatus: data.status || 'CLEARED',
        actorId: userId,
        reason: `Supplier payment ${payment_number} created`
      });

      await client.query('COMMIT');
      return payment;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = SupplierPayment;
