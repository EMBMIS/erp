const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const JournalEntry = require('./JournalEntry');
const taxService = require('../services/taxService');

class CustomerInvoice {
  
  // Create invoice from completed sales order
  static async createFromSalesOrder(salesOrderId, userId, externalClient = null) {
    // When invoked inside an existing transaction (e.g. from SalesOrder.updateStatus,
    // right after it sets status=COMPLETED but before it commits), reuse that
    // transaction's client. Otherwise the COMPLETED status is invisible on a fresh
    // connection and this would wrongly throw "not found or not completed". Reusing
    // the client also keeps the sales-order status change and the invoice atomic.
    const client = externalClient || await pool.connect();
    const ownTransaction = !externalClient;

    try {
      if (ownTransaction) await client.query('BEGIN');

      // Get sales order details (with customer tax profile for VAT)
      const soQuery = `
        SELECT so.*, c.customer_name, c.payment_terms, c.credit_days,
               c.tax_exempt, c.tax_rate, c.customer_type
        FROM sales_orders so
        LEFT JOIN customers c ON so.customer_id = c.id
        WHERE so.id = $1 AND so.status = 'COMPLETED'
      `;
      
      const soResult = await client.query(soQuery, [salesOrderId]);
      if (soResult.rows.length === 0) {
        throw new Error('Sales order not found or not completed');
      }

      const salesOrder = soResult.rows[0];

      // Check if invoice already exists
      const existingInvoice = await client.query(
        'SELECT id, invoice_number FROM customer_invoices WHERE sales_order_id = $1 AND deleted_at IS NULL',
        [salesOrderId]
      );

      if (existingInvoice.rows.length > 0) {
        console.log(`Invoice already exists for sales order ${salesOrder.so_number}`);
        if (ownTransaction) await client.query('ROLLBACK');
        return existingInvoice.rows[0];
      }

      // Generate invoice number
      const invoiceNumberResult = await client.query('SELECT generate_invoice_number() as number');
      const invoice_number = invoiceNumberResult.rows[0].number;

      // Calculate due date
      const creditDays = salesOrder.credit_days || 30;
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + creditDays);

      // Resolve VAT. Use the sales order's tax if it already carries one,
      // otherwise compute it from the customer's tax profile / company default.
      const subtotal = Number(salesOrder.subtotal || 0);
      const discount = Number(salesOrder.discount_amount || 0);
      let taxAmount = Number(salesOrder.tax_amount || 0);
      let vatRate = 0;
      if (taxAmount <= 0) {
        vatRate = taxService.resolveCustomerRate(salesOrder);
        taxAmount = taxService.computeTax(subtotal - discount, vatRate);
      }
      const totalAmount = taxService.round2(subtotal - discount + taxAmount);

      // Multi-currency: convert the document total to the base currency using
      // the rate on the invoice date, and record both the rate and base amount.
      const Currency = require('./Currency');
      const invCurrency = salesOrder.currency || 'USD';
      const baseCurrency = await Currency.getBaseCurrency();
      let exchangeRate = 1;
      if (invCurrency !== baseCurrency) {
        exchangeRate = (await Currency.getRate(invCurrency, baseCurrency, new Date().toISOString().split('T')[0])) || 1;
      }
      const baseAmount = taxService.round2(totalAmount * exchangeRate);
      const baseTax = taxService.round2(taxAmount * exchangeRate);

      // Create invoice
      const invoiceId = uuidv4();
      const invoiceQuery = `
        INSERT INTO customer_invoices (
          id, invoice_number, customer_id, sales_order_id,
          invoice_date, due_date, payment_terms, currency,
          subtotal, tax_amount, discount_amount, total_amount,
          exchange_rate, base_amount,
          status, description, created_by, updated_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $16, $17, $13, $14, $15, $15)
        RETURNING *
      `;

      const invoiceValues = [
        invoiceId,
        invoice_number,
        salesOrder.customer_id,
        salesOrderId,
        new Date(),
        dueDate,
        salesOrder.payment_terms || 'Net 30',
        salesOrder.currency || 'USD',
        subtotal,
        taxAmount,
        discount,
        totalAmount,
        'APPROVED', // Auto-approve invoices from completed sales orders
        `Invoice for Sales Order ${salesOrder.so_number}`,
        userId,
        exchangeRate, // $16
        baseAmount,   // $17
      ];

      const invoiceResult = await client.query(invoiceQuery, invoiceValues);
      const invoice = invoiceResult.rows[0];

      // A new invoice is fully outstanding and raises the customer's credit
      // exposure. That must happen on THIS transaction or a rollback would
      // leave an invoice that exists without the exposure it created.
      //
      // outstanding_amount is NOT set here: migration 065 defines it as
      // `GENERATED ALWAYS AS (total_amount - paid_amount) STORED`, so writing it
      // raises 428C9 ("can only be updated to DEFAULT") and aborted the whole
      // transaction — which meant completing a sales order could never produce
      // an invoice at all. A new invoice has paid_amount 0, so the generated
      // value is already the full total.
      await client.query(
        `UPDATE customers SET current_balance = current_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [totalAmount, salesOrder.customer_id]
      );

      // Get sales order items
      const itemsQuery = `
        SELECT * FROM sales_order_items WHERE sales_order_id = $1 ORDER BY line_number
      `;
      const itemsResult = await client.query(itemsQuery, [salesOrderId]);

      // Create invoice items
      for (const item of itemsResult.rows) {
        await client.query(`
          INSERT INTO customer_invoice_items (
            invoice_id, line_number, item_description, quantity,
            unit_of_measure, unit_price, discount_percentage, discount_amount,
            line_total, tax_rate, tax_amount
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          invoiceId,
          item.line_number,
          item.item_description || item.item_name,
          item.quantity,
          item.unit_of_measure,
          item.unit_price,
          item.discount_percentage || 0,
          item.discount_amount || 0,
          item.line_total,
          vatRate / 100, // tax_rate stored as a fraction (e.g. 0.18)
          taxService.computeTax(item.line_total, vatRate)
        ]);
      }

      // Create the AR journal entry in BASE currency with a VAT split when
      // applicable (Dr AR base / Cr Revenue base-net / Cr Output VAT base).
      const journalEntry = await CustomerInvoice.postRevenueJournal(salesOrder, baseAmount, baseTax, userId, client);
      if (journalEntry?.id) {
        await client.query(
          'UPDATE customer_invoices SET journal_entry_id = $1 WHERE id = $2',
          [journalEntry.id, invoiceId]
        );
      }

      // Add status history
      await this.addStatusHistory(client, invoiceId, null, 'APPROVED', userId, 'Invoice created from completed sales order');

      if (ownTransaction) await client.query('COMMIT');
      return invoice;

    } catch (error) {
      if (ownTransaction) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (ownTransaction) client.release();
    }
  }

  // Create a standalone invoice not tied to a sales order — used by recurring
  // billing (ERP-Roadmap P2 #8) and any other direct-bill scenario. Posts the
  // same Dr AR / Cr Revenue (+ Output VAT) entry as createFromSalesOrder.
  static async createStandalone(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const customerResult = await client.query('SELECT * FROM customers WHERE id = $1 AND deleted_at IS NULL', [data.customer_id]);
      if (customerResult.rows.length === 0) throw new Error('Customer not found');
      const customer = customerResult.rows[0];

      const invoiceNumberResult = await client.query('SELECT generate_invoice_number() as number');
      const invoice_number = invoiceNumberResult.rows[0].number;

      const creditDays = customer.credit_days || 30;
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + creditDays);

      const subtotal = taxService.round2(Number(data.amount) || 0);
      const taxAmount = taxService.round2(Number(data.tax_amount) || 0);
      const totalAmount = taxService.round2(subtotal + taxAmount);
      const currency = data.currency || 'USD';

      const invoiceId = uuidv4();
      const result = await client.query(
        `INSERT INTO customer_invoices (
          id, invoice_number, customer_id, sales_order_id, recurring_schedule_id,
          invoice_date, due_date, payment_terms, currency,
          subtotal, tax_amount, discount_amount, total_amount,
          status, description, created_by, updated_by
        ) VALUES ($1,$2,$3,NULL,$4,CURRENT_DATE,$5,$6,$7,$8,$9,0,$10,'APPROVED',$11,$12,$12)
        RETURNING *`,
        [invoiceId, invoice_number, data.customer_id, data.recurring_schedule_id || null,
         dueDate, customer.payment_terms || 'Net 30', currency, subtotal, taxAmount, totalAmount,
         data.description || `Invoice ${invoice_number}`, userId]
      );
      const invoice = result.rows[0];

      // outstanding_amount is generated (total_amount - paid_amount) — see the
      // note in createFromSalesOrder; writing it fails the statement.
      await client.query(
        `UPDATE customers SET current_balance = current_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [totalAmount, data.customer_id]
      );

      // Post on THIS transaction's client. Previously this posted on a separate
      // connection that committed immediately, so any later failure in this
      // method rolled back the invoice but left the revenue and AR entry POSTED
      // in the ledger with no invoice behind it — despite the comment on
      // postRevenueJournal claiming failures roll invoice creation back.
      const journalEntry = await CustomerInvoice.postRevenueJournal(
        { id: null, so_number: invoice_number, customer_name: customer.customer_name },
        totalAmount, taxAmount, userId, client,
        { sourceType: 'DIRECT_INVOICE', documentLabel: 'Invoice' }
      );
      if (journalEntry?.id) {
        await client.query('UPDATE customer_invoices SET journal_entry_id = $1 WHERE id = $2', [journalEntry.id, invoiceId]);
        // Reflect it on the object we return: `invoice` was captured from the
        // INSERT above, so without this the caller gets an invoice whose
        // journal_entry_id is null even though the link was just written.
        invoice.journal_entry_id = journalEntry.id;
      }

      await this.addStatusHistory(client, invoiceId, null, 'APPROVED', userId, data.description || 'Standalone/recurring invoice created');

      await client.query('COMMIT');
      return invoice;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Post the sales/AR journal entry for an invoice, splitting out Output VAT
  // (2140) when tax applies and the account exists. Falls back to a plain
  // Dr AR / Cr Revenue entry otherwise. Posting is mandatory: any failure throws
  // and rolls back invoice creation (audit B11).
  static async postRevenueJournal(salesOrder, totalAmount, taxAmount, userId, externalClient = null, options = {}) {
    // Two other callers (createStandalone, Project.billProject) reuse this
    // posting logic for invoices that are not sales orders at all, by passing
    // a synthetic { id: null, so_number, customer_name } object. Without this,
    // every one of those postings was hardcoded to source_type SALES_ORDER and
    // a description literally reading "Sales Order" — silently misattributing
    // revenue in any report or reconciliation grouped by source_type. Defaults
    // preserve the real sales-order caller's existing behavior unchanged.
    const { sourceType = 'SALES_ORDER', documentLabel = 'Sales Order' } = options;
    // Revenue recognition MUST post to the GL — an invoice that records AR in the
    // subsidiary ledger but silently skips the journal entry overstates cash and
    // understates revenue/VAT (audit B11). Failures propagate to the caller.
    const accs = await pool.query(`
      SELECT id, account_code FROM chart_of_accounts
      WHERE account_code IN ('1120','4100','2140') AND status = 'ACTIVE' AND deleted_at IS NULL
    `);
    const map = {};
    accs.rows.forEach((a) => { map[a.account_code] = a.id; });
    if (!map['1120'] || !map['4100']) {
      throw new Error('Cannot post revenue: AR (1120) and/or Revenue (4100) account missing or inactive');
    }

    const useVat = taxAmount > 0 && map['2140'];
    const revenue = taxService.round2(totalAmount - (useVat ? taxAmount : 0));

    const items = [
      { account_id: map['1120'], debit_amount: totalAmount, credit_amount: 0, description: `AR - ${salesOrder.customer_name}` },
      { account_id: map['4100'], debit_amount: 0, credit_amount: revenue, description: `Sales Revenue - ${salesOrder.so_number}` },
    ];
    if (useVat) {
      items.push({ account_id: map['2140'], debit_amount: 0, credit_amount: taxAmount, description: `Output VAT - ${salesOrder.so_number}` });
    }

    const entry = await JournalEntry.create({
      entry_date: new Date().toISOString().split('T')[0],
      source_type: sourceType,
      source_id: salesOrder.id,
      description: `Revenue recognition - ${documentLabel} ${salesOrder.so_number}`,
      reference: salesOrder.so_number,
      notes: `Customer: ${salesOrder.customer_name}`,
      requires_approval: false,
    }, items, userId, externalClient);

    // Who signs the GL posting. The invoice creator stays recorded as creator of
    // the entry, but the POSTED transition must carry a DIFFERENT identity or
    // checkSoD refuses the self-posting — which meant no customer invoice raised
    // by an ordinary user could ever reach the ledger, and because posting is
    // mandatory here, the invoice (and the sales order completing it) rolled back
    // with it. Same shared resolver the AP, depreciation and goods-receipt
    // postings use; it returns the invoice creator only when they ARE the
    // platform owner (the deliberate SoD exception).
    await JournalEntry.postAsSystem(entry.id, userId, 'Auto-posted from customer invoice', externalClient);
    return entry;
  }

  // Find all invoices with filters
  static async findAll(filters = {}) {
    try {
      let query = `
        SELECT 
          ci.*,
          c.customer_name,
          c.primary_email as customer_email,
          u.first_name || ' ' || u.last_name as created_by_name,
          je.journal_number
        FROM customer_invoices ci
        LEFT JOIN customers c ON ci.customer_id = c.id
        LEFT JOIN users u ON ci.created_by = u.id
        LEFT JOIN journal_entries je ON ci.journal_entry_id = je.id
        WHERE ci.deleted_at IS NULL
      `;
      
      const conditions = [];
      const values = [];

      if (filters.search) {
        conditions.push(`(
          ci.invoice_number ILIKE $${values.length + 1} OR
          c.customer_name ILIKE $${values.length + 1}
        )`);
        values.push(`%${filters.search}%`);
      }

      if (filters.status) {
        conditions.push(`ci.status = $${values.length + 1}`);
        values.push(filters.status);
      }

      if (filters.customer_id) {
        conditions.push(`ci.customer_id = $${values.length + 1}`);
        values.push(filters.customer_id);
      }

      if (filters.overdue_only) {
        conditions.push(`ci.due_date < CURRENT_DATE AND ci.status IN ('SENT', 'PARTIALLY_PAID')`);
      }

      if (conditions.length > 0) {
        query += ' AND ' + conditions.join(' AND ');
      }

      // Total BEFORE paging, so the UI can say "showing 1–25 of 812" instead of
      // guessing from the length of the page it happens to be holding.
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS n FROM customer_invoices ci
           LEFT JOIN customers c ON ci.customer_id = c.id
          WHERE ci.deleted_at IS NULL${conditions.length ? ' AND ' + conditions.join(' AND ') : ''}`,
        values
      );

      // Sorting is whitelisted, never interpolated from the request. A sort
      // column arrives as a string and goes into the SQL text — the one place
      // in a list endpoint where user input reaches the query as code — so the
      // client's value is used only to LOOK UP a fixed expression.
      const SORTABLE = {
        invoice_number: 'ci.invoice_number',
        invoice_date: 'ci.invoice_date',
        due_date: 'ci.due_date',
        total_amount: 'ci.total_amount',
        outstanding_amount: 'ci.outstanding_amount',
        status: 'ci.status',
        customer_name: 'c.customer_name',
        created_at: 'ci.created_at',
      };
      const sortColumn = SORTABLE[filters.sort_by] || 'ci.created_at';
      const sortDirection = String(filters.sort_dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      // Tie-break on id: without it, rows sharing a sort value can swap places
      // between pages, so the same invoice appears on page 1 and page 2 while
      // another is never shown at all.
      query += ` ORDER BY ${sortColumn} ${sortDirection} NULLS LAST, ci.id`;

      if (filters.limit) {
        query += ` LIMIT $${values.length + 1}`;
        values.push(filters.limit);
      }
      if (filters.offset) {
        query += ` OFFSET $${values.length + 1}`;
        values.push(filters.offset);
      }

      const result = await pool.query(query, values);
      return { rows: result.rows, total: countResult.rows[0].n };
    } catch (error) {
      throw error;
    }
  }

  // Add status history
  static async addStatusHistory(client, invoiceId, fromStatus, toStatus, userId, reason) {
    const query = `
      INSERT INTO customer_invoice_status_history 
      (invoice_id, from_status, to_status, changed_by, reason)
      VALUES ($1, $2, $3, $4, $5)
    `;
    
    await client.query(query, [invoiceId, fromStatus, toStatus, userId, reason]);
  }

  // Update customer balance when invoice is created/paid
  static async updateCustomerBalance(customerId, amount, isIncrease = true) {
    const operator = isIncrease ? '+' : '-';
    await pool.query(`
      UPDATE customers
      SET current_balance = current_balance ${operator} $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [Math.abs(amount), customerId]);
  }

  // Get a single invoice with its line items and payment allocations
  static async findById(id) {
    const invoiceResult = await pool.query(`
      SELECT
        ci.*,
        c.customer_name,
        c.primary_email as customer_email,
        so.so_number,
        u.first_name || ' ' || u.last_name as created_by_name,
        je.journal_number
      FROM customer_invoices ci
      LEFT JOIN customers c ON ci.customer_id = c.id
      LEFT JOIN sales_orders so ON ci.sales_order_id = so.id
      LEFT JOIN users u ON ci.created_by = u.id
      LEFT JOIN journal_entries je ON ci.journal_entry_id = je.id
      WHERE ci.id = $1 AND ci.deleted_at IS NULL
    `, [id]);

    if (invoiceResult.rows.length === 0) return null;

    const invoice = invoiceResult.rows[0];

    const items = await pool.query(
      'SELECT * FROM customer_invoice_items WHERE invoice_id = $1 ORDER BY line_number',
      [id]
    );

    const payments = await pool.query(`
      SELECT cpa.*, cp.payment_number, cp.payment_date, cp.payment_method, cp.status as payment_status
      FROM customer_payment_allocations cpa
      JOIN customer_payments cp ON cpa.payment_id = cp.id
      WHERE cpa.invoice_id = $1 AND cp.deleted_at IS NULL
      ORDER BY cpa.allocation_date
    `, [id]);

    invoice.items = items.rows;
    invoice.payments = payments.rows;
    return invoice;
  }

  // Update invoice status with history (e.g. DRAFT -> SENT, -> CANCELLED).
  // Cancelling a posted invoice reverses its revenue journal entry (credit note)
  // so the ledger no longer reflects the revenue/VAT.
  static async updateStatus(id, newStatus, userId, reason = '') {
    const current = await pool.query(
      'SELECT status, journal_entry_id, paid_amount FROM customer_invoices WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (current.rows.length === 0) throw new Error('Invoice not found');
    const inv = current.rows[0];
    const fromStatus = inv.status;

    // Guard + reverse on cancellation.
    if (newStatus === 'CANCELLED' && fromStatus !== 'CANCELLED') {
      if (Number(inv.paid_amount) > 0) {
        throw new Error('Cannot cancel an invoice that has payments — reverse the payment first');
      }
      if (inv.journal_entry_id) {
        try {
          await JournalEntry.reverse(inv.journal_entry_id, userId, reason || `Invoice ${id} cancelled`);
        } catch (revErr) {
          // Not-yet-posted entries or already-reversed: log, don't block the status change.
          console.warn('Invoice revenue reversal skipped:', revErr.message);
        }
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(`
        UPDATE customer_invoices
        SET status = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
        RETURNING *
      `, [newStatus, userId, id]);
      await this.addStatusHistory(client, id, fromStatus, newStatus, userId, reason);
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Accounts Receivable summary statistics
  static async getStats() {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int as total_invoices,
        COALESCE(SUM(total_amount), 0) as total_invoiced,
        COALESCE(SUM(paid_amount), 0) as total_collected,
        COALESCE(SUM(outstanding_amount), 0) as total_outstanding,
        COUNT(*) FILTER (WHERE status = 'PAID')::int as paid_count,
        COUNT(*) FILTER (WHERE status IN ('SENT', 'PARTIALLY_PAID', 'APPROVED'))::int as open_count,
        COUNT(*) FILTER (WHERE due_date < CURRENT_DATE AND status IN ('SENT', 'PARTIALLY_PAID', 'APPROVED', 'OVERDUE'))::int as overdue_count,
        COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date < CURRENT_DATE AND status IN ('SENT', 'PARTIALLY_PAID', 'APPROVED', 'OVERDUE')), 0) as overdue_amount
      FROM customer_invoices
      WHERE deleted_at IS NULL
    `);
    return result.rows[0];
  }
}

module.exports = CustomerInvoice;