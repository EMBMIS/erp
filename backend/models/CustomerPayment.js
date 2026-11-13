const { pool } = require('../config/database');

/**
 * CustomerPayment — records money received from customers and allocates it to
 * one or more outstanding invoices, updating each invoice's paid/outstanding
 * amount and status, and posting the cash receipt to the general ledger
 * (Dr Cash 1110 / Cr Accounts Receivable 1120).
 */
class CustomerPayment {

  static async findAll(filters = {}) {
    let query = `
      SELECT
        cp.*,
        c.customer_name,
        u.first_name || ' ' || u.last_name as created_by_name,
        je.journal_number,
        COALESCE(SUM(cpa.allocation_amount), 0) as allocated_amount
      FROM customer_payments cp
      LEFT JOIN customers c ON cp.customer_id = c.id
      LEFT JOIN users u ON cp.created_by = u.id
      LEFT JOIN journal_entries je ON cp.journal_entry_id = je.id
      LEFT JOIN customer_payment_allocations cpa ON cpa.payment_id = cp.id
      WHERE cp.deleted_at IS NULL
    `;
    const conditions = [];
    const values = [];

    if (filters.search) {
      conditions.push(`(cp.payment_number ILIKE $${values.length + 1} OR c.customer_name ILIKE $${values.length + 1})`);
      values.push(`%${filters.search}%`);
    }
    if (filters.status) {
      conditions.push(`cp.status = $${values.length + 1}`);
      values.push(filters.status);
    }
    if (filters.customer_id) {
      conditions.push(`cp.customer_id = $${values.length + 1}`);
      values.push(filters.customer_id);
    }
    if (conditions.length > 0) query += ' AND ' + conditions.join(' AND ');

    query += ' GROUP BY cp.id, c.customer_name, u.first_name, u.last_name, je.journal_number ORDER BY cp.created_at DESC';

    if (filters.limit) {
      query += ` LIMIT $${values.length + 1}`;
      values.push(filters.limit);
    }

    const result = await pool.query(query, values);
    return result.rows;
  }

  static async findById(id) {
    const paymentResult = await pool.query(`
      SELECT cp.*, c.customer_name, je.journal_number
      FROM customer_payments cp
      LEFT JOIN customers c ON cp.customer_id = c.id
      LEFT JOIN journal_entries je ON cp.journal_entry_id = je.id
      WHERE cp.id = $1 AND cp.deleted_at IS NULL
    `, [id]);
    if (paymentResult.rows.length === 0) return null;

    const payment = paymentResult.rows[0];
    const allocations = await pool.query(`
      SELECT cpa.*, ci.invoice_number
      FROM customer_payment_allocations cpa
      JOIN customer_invoices ci ON cpa.invoice_id = ci.id
      WHERE cpa.payment_id = $1
      ORDER BY cpa.allocation_date
    `, [id]);
    payment.allocations = allocations.rows;
    return payment;
  }

  /**
   * Record a payment and apply it to invoices.
   * @param {Object} data - { customer_id, payment_date, payment_method, reference_number, payment_amount, currency, description, notes }
   * @param {Array}  allocations - [{ invoice_id, allocation_amount }]
   * @param {String} userId
   */
  static async create(data, allocations = [], userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (!data.customer_id) throw new Error('customer_id is required');
      if (!data.payment_amount || Number(data.payment_amount) <= 0) throw new Error('payment_amount must be positive');
      if (!data.payment_method) throw new Error('payment_method is required');

      const totalAllocated = allocations.reduce((s, a) => s + Number(a.allocation_amount || 0), 0);
      if (totalAllocated - Number(data.payment_amount) > 0.01) {
        throw new Error('Allocated amount exceeds payment amount');
      }

      // Generate payment number
      const numResult = await client.query('SELECT generate_payment_number() as number');
      const payment_number = numResult.rows[0].number;

      const paymentResult = await client.query(`
        INSERT INTO customer_payments (
          payment_number, customer_id, payment_date, payment_method,
          reference_number, payment_amount, currency, status,
          description, notes, created_by, updated_by
        )
        VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5, $6, $7, $8, $9, $10, $11, $11)
        RETURNING *
      `, [
        payment_number,
        data.customer_id,
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

      // Apply allocations to invoices
      for (const alloc of allocations) {
        if (!alloc.invoice_id || Number(alloc.allocation_amount) <= 0) continue;

        // Cap each allocation at the invoice's own outstanding balance —
        // mirrors the same fix in SupplierPayment.create. Only the SUM of
        // allocations was ever checked against the payment total; a single
        // allocation could still overpay one invoice by any amount, driving
        // its outstanding_amount (GENERATED, total_amount - paid_amount)
        // negative and marking it PAID despite the excess. FOR UPDATE so two
        // concurrent payments against the same invoice can't both pass this
        // check against a balance neither has actually settled yet.
        const invLock = await client.query(
          'SELECT total_amount, paid_amount FROM customer_invoices WHERE id = $1 FOR UPDATE',
          [alloc.invoice_id]
        );
        if (invLock.rows.length === 0) throw new Error(`Invoice ${alloc.invoice_id} not found`);
        const invOutstanding = Number(invLock.rows[0].total_amount) - Number(invLock.rows[0].paid_amount);
        if (Number(alloc.allocation_amount) - invOutstanding > 0.01) {
          throw new Error(
            `Allocation of ${Number(alloc.allocation_amount).toFixed(2)} exceeds invoice ${alloc.invoice_id}'s outstanding balance of ${invOutstanding.toFixed(2)}`
          );
        }

        await client.query(`
          INSERT INTO customer_payment_allocations (payment_id, invoice_id, allocation_amount, created_by)
          VALUES ($1, $2, $3, $4)
        `, [payment.id, alloc.invoice_id, alloc.allocation_amount, userId]);

        // Update invoice paid amount and status
        const invResult = await client.query(`
          UPDATE customer_invoices
          SET paid_amount = paid_amount + $1,
              -- outstanding_amount is GENERATED ALWAYS AS (total_amount -
              -- paid_amount) (migration 065). Assigning it raises 428C9 and
              -- rolled the whole receipt back; moving paid_amount is what
              -- updates it.
              updated_by = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $3
          RETURNING total_amount, paid_amount, status
        `, [alloc.allocation_amount, userId, alloc.invoice_id]);
        if (invResult.rows.length > 0) {
          const inv = invResult.rows[0];
          const newStatus = Number(inv.paid_amount) >= Number(inv.total_amount) - 0.01 ? 'PAID' : 'PARTIALLY_PAID';
          if (newStatus !== inv.status) {
            await client.query(
              'UPDATE customer_invoices SET status = $1 WHERE id = $2',
              [newStatus, alloc.invoice_id]
            );
            await client.query(`
              INSERT INTO customer_invoice_status_history (invoice_id, from_status, to_status, changed_by, reason)
              VALUES ($1, $2, $3, $4, $5)
            `, [alloc.invoice_id, inv.status, newStatus, userId, `Payment ${payment_number} applied`]);
          }
        }
      }

      // Reduce customer outstanding balance
      await client.query(`
        UPDATE customers
        SET current_balance = current_balance - $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [data.payment_amount, data.customer_id]);

      // Post cash receipt to the GL in BASE currency, recognizing realized FX
      // gain/loss when an invoice was booked at a different rate than the
      // payment. Cash is received at the payment-date rate; AR is relieved at
      // the invoice's booked rate; the difference is FX gain/loss.
      // Posting is mandatory: a payment that clears AR in the subsidiary ledger
      // but never hits the GL desynchronizes cash and AR (audit B11). Any failure
      // propagates and rolls back the whole payment.
      {
        const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
        const Currency = require('./Currency');
        const JournalEntry = require('./JournalEntry');
        const baseCurrency = await Currency.getBaseCurrency();
        const payCurrency = data.currency || 'USD';
        const payDate = data.payment_date || new Date().toISOString().split('T')[0];
        const payRate = payCurrency === baseCurrency ? 1 : ((await Currency.getRate(payCurrency, baseCurrency, payDate)) || 1);

        // Base cash received, and base AR to relieve (at each invoice's rate).
        let baseCash = 0, baseAR = 0;
        if (allocations.length > 0) {
          for (const alloc of allocations) {
            if (!alloc.invoice_id || Number(alloc.allocation_amount) <= 0) continue;
            const invRow = await client.query('SELECT exchange_rate FROM customer_invoices WHERE id = $1', [alloc.invoice_id]);
            const invRate = Number(invRow.rows[0]?.exchange_rate) || 1;
            const amt = Number(alloc.allocation_amount);
            baseCash += amt * payRate;
            baseAR += amt * invRate;
          }
        } else {
          baseCash = Number(data.payment_amount) * payRate;
          baseAR = baseCash;
        }
        baseCash = round2(baseCash);
        baseAR = round2(baseAR);
        const fx = round2(baseCash - baseAR); // >0 gain, <0 loss

        await client.query('UPDATE customer_payments SET base_amount = $1 WHERE id = $2', [baseCash, payment.id]);

        const accs = await pool.query(`
          SELECT id, account_code FROM chart_of_accounts
          WHERE account_code IN ('1110','1120','4910','5910') AND status = 'ACTIVE' AND deleted_at IS NULL
        `);
        const map = {};
        accs.rows.forEach((a) => { map[a.account_code] = a.id; });
        if (!map['1110'] || !map['1120']) {
          throw new Error('Cannot post customer payment: Cash (1110) and/or AR (1120) account missing or inactive');
        }
        const items = [
          { account_id: map['1110'], debit_amount: baseCash, credit_amount: 0, description: `Cash receipt ${payment_number}` },
          { account_id: map['1120'], debit_amount: 0, credit_amount: baseAR, description: `AR settlement ${payment_number}` },
        ];
        if (fx > 0 && map['4910']) items.push({ account_id: map['4910'], debit_amount: 0, credit_amount: fx, description: 'FX gain' });
        else if (fx < 0 && map['5910']) items.push({ account_id: map['5910'], debit_amount: -fx, credit_amount: 0, description: 'FX loss' });
        else if (Math.abs(fx) >= 0.01) {
          // FX account missing — fold the difference into cash to stay balanced.
          items[0].debit_amount = baseAR;
        }

        const entry = await JournalEntry.create({
          entry_date: payDate,
          source_type: 'BANK_TRANSACTION',
          description: `Customer payment ${payment_number}`,
          reference: payment_number,
          requires_approval: false,
        }, items, userId, client);
        await JournalEntry.postAsSystem(entry.id, userId, 'Auto-posted customer payment', client);
        await client.query('UPDATE customer_payments SET journal_entry_id = $1 WHERE id = $2', [entry.id, payment.id]);
        // `payment` was captured from the INSERT above, before this link
        // existed. Without reflecting it here the API returns a receipt whose
        // journal_entry_id is null, so the UI cannot offer the GL entry it just
        // posted (same trap as CustomerInvoice.createStandalone).
        payment.journal_entry_id = entry.id;
      }

      // Append transaction-atomic audit record for Customer Payment
      const { auditStatusTransition } = require('../services/auditHook');
      await auditStatusTransition({
        client,
        entityType: 'CUSTOMER_PAYMENT',
        entityId: payment.id,
        fromStatus: null,
        toStatus: data.status || 'CLEARED',
        actorId: userId,
        reason: `Customer payment ${payment_number} created`
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

module.exports = CustomerPayment;
