const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

/**
 * SupplierInvoice (Vendor Bill) — Accounts Payable.
 *
 * The AP liability is already posted to the GL when a purchase order is
 * completed (Dr Inventory/COGS / Cr Accounts Payable 2110). A bill therefore
 * records the vendor's own document against that payable and links to the
 * existing purchase-order journal entry for traceability — it does NOT create a
 * second GL entry (which would double-count the liability). The payment clears
 * the payable (see SupplierPayment).
 */
class SupplierInvoice {

  /**
   * Create a draft supplier invoice from arbitrary data (used by AI invoice intake).
   * Minimal validation — the draft can be edited before approval.
   */
  static async create(data, userId) {
    const { supplier_name, supplier_id, bill_number, supplier_invoice_number, invoice_date, due_date, total_amount, tax_amount, currency, items, notes } = data;
    if (!supplier_name || !total_amount) throw new Error('supplier_name and total_amount are required');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = uuidv4();
      const billNum = bill_number || `BILL-${Date.now()}`;
      const gTotal = Number(total_amount) || 0;
      const gTax = Number(tax_amount) || 0;

      // supplier_invoices has no supplier_name column -- only supplier_id.
      // When intake couldn't resolve the extracted name to a real supplier,
      // fold it into notes instead of silently dropping it; a reviewer
      // editing the draft still needs to know what name was on the document.
      const mergedNotes = supplier_id ? (notes || null) : `Supplier (unresolved): ${supplier_name}${notes ? `\n${notes}` : ''}`;

      await client.query(
        `INSERT INTO supplier_invoices (id, bill_number, supplier_invoice_number, supplier_id, invoice_date, due_date,
         total_amount, tax_amount, currency, status, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10,$11)`,
        [id, billNum, supplier_invoice_number || null, supplier_id || null, invoice_date || new Date().toISOString().slice(0, 10),
         due_date || new Date().toISOString().slice(0, 10), gTotal, gTax, currency || 'USD', mergedNotes, userId]
      );

      if (items && items.length > 0) {
        for (const item of items) {
          await client.query(
            `INSERT INTO supplier_invoice_items (bill_id, item_description, quantity, unit_of_measure, unit_price, line_total)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [id, item.item_description || item.description || '', Number(item.quantity) || 1,
             item.unit_of_measure || 'EA', Number(item.unit_price) || 0, Number(item.line_total) || 0]
          );
        }
      }

      await client.query('COMMIT');
      const { rows: [bill] } = await pool.query('SELECT * FROM supplier_invoices WHERE id = $1', [id]);
      // Is this the same invoice again? Checked the moment it is recorded.
      if (bill?.supplier_id) require('../services/billedTwice').checkAfterRecording(bill.company_id, bill.id);
      return bill;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  }

  static async createFromPurchaseOrder(purchaseOrderId, data = {}, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const poResult = await client.query(`
        SELECT po.*, s.legal_name as supplier_name, s.payment_terms as supplier_terms
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        WHERE po.id = $1
      `, [purchaseOrderId]);
      if (poResult.rows.length === 0) throw new Error('Purchase order not found');

      const po = poResult.rows[0];

      const existing = await client.query(
        'SELECT * FROM supplier_invoices WHERE purchase_order_id = $1 AND deleted_at IS NULL',
        [purchaseOrderId]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return existing.rows[0];
      }

      const numResult = await client.query('SELECT generate_supplier_bill_number() as number');
      const bill_number = numResult.rows[0].number;

      // Due date from terms (default 30 days)
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 30);

      // The AP journal entry is posted below (after the bill exists) and linked back.
      const journalEntryId = null;

      const billId = uuidv4();
      const billResult = await client.query(`
        INSERT INTO supplier_invoices (
          id, bill_number, supplier_invoice_number, supplier_id, purchase_order_id,
          journal_entry_id, invoice_date, due_date, payment_terms, currency,
          subtotal, tax_amount, discount_amount, total_amount,
          status, description, created_by, updated_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
        RETURNING *
      `, [
        billId,
        bill_number,
        data.supplier_invoice_number || null,
        po.supplier_id,
        purchaseOrderId,
        journalEntryId,
        dueDate,
        po.payment_terms || po.supplier_terms || 'Net 30',
        po.currency || 'USD',
        po.subtotal || 0,
        po.tax_amount || 0,
        0,
        po.total_amount,
        'APPROVED',
        `Bill for Purchase Order ${po.po_number}`,
        userId,
      ]);
      const bill = billResult.rows[0];

      // Copy PO line items onto the bill (the PO line-items table keys on po_id).
      const items = await client.query(
        'SELECT * FROM purchase_order_line_items WHERE po_id = $1',
        [purchaseOrderId]
      );
      let line = 1;
      for (const item of items.rows) {
        await client.query(`
          INSERT INTO supplier_invoice_items (
            bill_id, line_number, item_description, quantity,
            unit_of_measure, unit_price, line_total, tax_rate, tax_amount
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,0)
        `, [
          billId,
          line++,
          item.item_description,
          item.quantity,
          item.unit_of_measure,
          item.unit_price,
          item.line_total,
        ]);
      }

      // 3-way match: how much of this PO has actually been received? The received
      // portion clears the GR/IR accrual; any not-yet-received portion debits
      // Inventory directly (invoiced-not-received). This is the PO↔receipt↔invoice
      // reconciliation surfaced through the GR/IR account.
      const recvRes = await client.query(
        'SELECT COALESCE(SUM(quantity_received), 0) AS qty FROM goods_receipts WHERE po_id = $1',
        [purchaseOrderId]
      );
      const hasReceipts = Number(recvRes.rows[0].qty) > 0;

      // Post AP recognition (Dr GR/IR or Inventory + Dr Input VAT / Cr AP). This
      // is now the payable-recognition point of Procure-to-Pay; it MUST post.
      const gross = Number(po.total_amount) || 0;
      const tax = Number(po.tax_amount) || 0;
      const net = Math.round((gross - tax) * 100) / 100;
      if (gross > 0) {
        const JournalEntry = require('./JournalEntry');
        const accs = await client.query(`
          SELECT id, account_code FROM chart_of_accounts
          WHERE account_code IN ('2110','2115','1130','1160') AND status = 'ACTIVE' AND deleted_at IS NULL
        `);
        const map = {};
        accs.rows.forEach((a) => { map[a.account_code] = a.id; });
        if (!map['2110']) {
          throw new Error('Cannot post supplier invoice: Accounts Payable account (2110) missing or inactive');
        }
        // Received goods clear GR/IR (2115); otherwise the net debits Inventory (1130).
        const netAccount = hasReceipts ? (map['2115'] || map['1130']) : (map['1130'] || map['2115']);
        if (!netAccount) {
          throw new Error('Cannot post supplier invoice: GR/IR (2115) and Inventory (1130) both missing or inactive');
        }
        const useVat = tax > 0 && map['1160'];
        const items2 = [
          { account_id: netAccount, debit_amount: useVat ? net : gross, credit_amount: 0, description: hasReceipts ? 'Clear GR/IR accrual' : 'Inventory (invoiced not received)' },
        ];
        if (useVat) {
          items2.push({ account_id: map['1160'], debit_amount: tax, credit_amount: 0, description: `Input VAT - ${po.po_number}` });
        }
        items2.push({ account_id: map['2110'], debit_amount: 0, credit_amount: gross, description: `AP - ${po.po_number}` });

        // Thread the open transaction client (externalClient) into BOTH the
        // journal-entry create and its status post. Without it, JournalEntry
        // opens its own connection/transaction and COMMITs the GL entry while
        // this bill transaction is still open — a later ROLLBACK here then
        // leaves a POSTED journal entry with no bill linkage (an orphaned GL
        // posting). Same pattern financialPostingService uses: everything in
        // the procure-to-pay posting commits or rolls back as one unit.
        const entry = await JournalEntry.create({
          entry_date: new Date().toISOString().split('T')[0],
          source_type: 'PURCHASE_ORDER',
          source_id: purchaseOrderId,
          description: `Supplier invoice ${bill_number} - ${po.supplier_name}`,
          reference: po.po_number,
          requires_approval: false,
        }, items2, userId, client);
        // Who signs the GL posting. The bill creator stays recorded as creator
        // of the entry; the POSTED transition must carry a DIFFERENT identity,
        // or checkSoD refuses the self-posting and no supplier invoice can ever
        // reach the ledger for a non-owner user (same refusal that blocked
        // depreciation and goods receipts). Shared resolver in
        // services/platformOwner.js returns the platform owner unless the
        // creator IS the owner (deliberate SoD exception).
        await JournalEntry.postAsSystem(entry.id, userId, 'Auto-posted supplier invoice (AP)', client);
        await client.query('UPDATE supplier_invoices SET journal_entry_id = $1 WHERE id = $2', [entry.id, billId]);
        bill.journal_entry_id = entry.id;
      }

      await this.addStatusHistory(client, billId, null, 'APPROVED', userId, 'Bill created from purchase order');

      await client.query('COMMIT');
      require('../services/billedTwice').checkAfterRecording(bill.company_id, bill.id);
      return bill;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async findAll(filters = {}) {
    let query = `
      SELECT
        si.*,
        s.legal_name as supplier_name,
        po.po_number,
        u.first_name || ' ' || u.last_name as created_by_name,
        je.journal_number
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON si.supplier_id = s.id
      LEFT JOIN purchase_orders po ON si.purchase_order_id = po.id
      LEFT JOIN users u ON si.created_by = u.id
      LEFT JOIN journal_entries je ON si.journal_entry_id = je.id
      WHERE si.deleted_at IS NULL
    `;
    const conditions = [];
    const values = [];

    if (filters.search) {
      conditions.push(`(si.bill_number ILIKE $${values.length + 1} OR si.supplier_invoice_number ILIKE $${values.length + 1} OR s.legal_name ILIKE $${values.length + 1})`);
      values.push(`%${filters.search}%`);
    }
    if (filters.status) {
      conditions.push(`si.status = $${values.length + 1}`);
      values.push(filters.status);
    }
    if (filters.supplier_id) {
      conditions.push(`si.supplier_id = $${values.length + 1}`);
      values.push(filters.supplier_id);
    }
    if (filters.overdue_only) {
      conditions.push(`si.due_date < CURRENT_DATE AND si.status IN ('APPROVED', 'PARTIALLY_PAID')`);
    }
    if (conditions.length > 0) query += ' AND ' + conditions.join(' AND ');

    // Total BEFORE paging, so the UI can say "showing 1–50 of 812" instead of
    // guessing from the length of the page it happens to be holding. Runs before
    // limit/offset are appended to `values`, so the shared placeholder indexes
    // still line up. The suppliers join is kept because the search condition
    // references s.legal_name.
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS n FROM supplier_invoices si
         LEFT JOIN suppliers s ON si.supplier_id = s.id
        WHERE si.deleted_at IS NULL${conditions.length ? ' AND ' + conditions.join(' AND ') : ''}`,
      values
    );

    // Sorting is whitelisted, never interpolated from the request — the client's
    // value is used only to LOOK UP a fixed expression (see CustomerInvoice).
    const SORTABLE = {
      bill_number: 'si.bill_number',
      supplier_invoice_number: 'si.supplier_invoice_number',
      invoice_date: 'si.invoice_date',
      due_date: 'si.due_date',
      total_amount: 'si.total_amount',
      outstanding_amount: 'si.outstanding_amount',
      status: 'si.status',
      supplier_name: 's.legal_name',
      created_at: 'si.created_at',
    };
    const sortColumn = SORTABLE[filters.sort_by] || 'si.created_at';
    const sortDirection = String(filters.sort_dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    // Tie-break on id: without it, rows sharing a sort value can swap places
    // between pages, so the same bill appears on page 1 and page 2.
    query += ` ORDER BY ${sortColumn} ${sortDirection} NULLS LAST, si.id`;

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
  }

  static async findById(id) {
    const billResult = await pool.query(`
      SELECT si.*, s.legal_name as supplier_name, po.po_number, je.journal_number
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON si.supplier_id = s.id
      LEFT JOIN purchase_orders po ON si.purchase_order_id = po.id
      LEFT JOIN journal_entries je ON si.journal_entry_id = je.id
      WHERE si.id = $1 AND si.deleted_at IS NULL
    `, [id]);
    if (billResult.rows.length === 0) return null;

    const bill = billResult.rows[0];
    const items = await pool.query('SELECT * FROM supplier_invoice_items WHERE bill_id = $1 ORDER BY line_number', [id]);
    const payments = await pool.query(`
      SELECT spa.*, sp.payment_number, sp.payment_date, sp.payment_method, sp.status as payment_status
      FROM supplier_payment_allocations spa
      JOIN supplier_payments sp ON spa.payment_id = sp.id
      WHERE spa.bill_id = $1 AND sp.deleted_at IS NULL
      ORDER BY spa.allocation_date
    `, [id]);
    bill.items = items.rows;
    bill.payments = payments.rows;
    return bill;
  }

  static async updateStatus(id, newStatus, userId, reason = '') {
    const { applyStatusChange } = require('../services/statusTransitionService');

    return await applyStatusChange({
      entityType: 'SUPPLIER_INVOICE',
      entityId: id,
      newStatus,
      actor: userId,
      context: { reason },
      executeSideEffects: async (client, record) => {
        // 3-way match enforcement: block approval when critical discrepancies exist
        if (newStatus === 'APPROVED' && record.purchase_order_id) {
          const { threeWayMatch } = require('../services/ai/invoiceMatching');
          const matchResult = await threeWayMatch(id);

          if (matchResult.passed === false) {
            const reasons = (matchResult.discrepancies || [])
              .filter((d) => d.severity === 'critical')
              .map((d) => d.detail)
              .join('; ');
            throw new Error(
              `3-way match BLOCKED: Cannot approve this bill. ${reasons || 'Critical discrepancies found.'} ` +
              `Review the match report before overriding.`
            );
          }
        }
      }
    });
  }

  static async getStats() {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int as total_bills,
        COALESCE(SUM(total_amount), 0) as total_billed,
        COALESCE(SUM(paid_amount), 0) as total_paid,
        COALESCE(SUM(outstanding_amount), 0) as total_outstanding,
        COUNT(*) FILTER (WHERE status = 'PAID')::int as paid_count,
        COUNT(*) FILTER (WHERE status IN ('APPROVED', 'PARTIALLY_PAID'))::int as open_count,
        COUNT(*) FILTER (WHERE due_date < CURRENT_DATE AND status IN ('APPROVED', 'PARTIALLY_PAID', 'OVERDUE'))::int as overdue_count,
        COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date < CURRENT_DATE AND status IN ('APPROVED', 'PARTIALLY_PAID', 'OVERDUE')), 0) as overdue_amount
      FROM supplier_invoices
      WHERE deleted_at IS NULL
    `);
    return result.rows[0];
  }

  static async addStatusHistory(client, billId, fromStatus, toStatus, userId, reason) {
    await client.query(`
      INSERT INTO supplier_invoice_status_history (bill_id, from_status, to_status, changed_by, reason)
      VALUES ($1, $2, $3, $4, $5)
    `, [billId, fromStatus, toStatus, userId, reason]);
  }
}

module.exports = SupplierInvoice;
