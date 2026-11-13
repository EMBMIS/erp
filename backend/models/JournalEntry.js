const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { checkSoD } = require('../middleware/rbac');
const { isPlatformOwnerId } = require('../services/platformOwner');

class JournalEntry {
  static async findAll(filters = {}) {
    try {
      let query = `
        SELECT 
          je.*,
          u1.first_name || ' ' || u1.last_name as created_by_name,
          u2.first_name || ' ' || u2.last_name as updated_by_name,
          u3.first_name || ' ' || u3.last_name as approved_by_name,
          u4.first_name || ' ' || u4.last_name as posted_by_name,
          COUNT(jei.id) as line_count
        FROM journal_entries je
        LEFT JOIN users u1 ON je.created_by = u1.id
        LEFT JOIN users u2 ON je.updated_by = u2.id
        LEFT JOIN users u3 ON je.approved_by = u3.id
        LEFT JOIN users u4 ON je.posted_by = u4.id
        LEFT JOIN journal_entry_items jei ON je.id = jei.journal_entry_id
        WHERE je.deleted_at IS NULL
      `;
      
      const conditions = [];
      const values = [];

      if (filters.search) {
        conditions.push(`(
          je.journal_number ILIKE $${values.length + 1} OR
          je.description ILIKE $${values.length + 1} OR
          je.reference ILIKE $${values.length + 1}
        )`);
        values.push(`%${filters.search}%`);
      }

      if (filters.status) {
        conditions.push(`je.status = $${values.length + 1}`);
        values.push(filters.status);
      }

      if (filters.source_type) {
        conditions.push(`je.source_type = $${values.length + 1}`);
        values.push(filters.source_type);
      }

      if (filters.entry_date_from) {
        conditions.push(`je.entry_date >= $${values.length + 1}`);
        values.push(filters.entry_date_from);
      }

      if (filters.entry_date_to) {
        conditions.push(`je.entry_date <= $${values.length + 1}`);
        values.push(filters.entry_date_to);
      }

      if (filters.created_by) {
        conditions.push(`je.created_by = $${values.length + 1}`);
        values.push(filters.created_by);
      }

      if (conditions.length > 0) {
        query += ` AND ${conditions.join(' AND ')}`;
      }

      query += ` GROUP BY je.id, u1.first_name, u1.last_name, u2.first_name, u2.last_name, u3.first_name, u3.last_name, u4.first_name, u4.last_name`;
      query += ` ORDER BY je.entry_date DESC, je.journal_number DESC`;
      
      if (filters.limit) {
        query += ` LIMIT ${parseInt(filters.limit)}`;
      }
      
      if (filters.offset) {
        query += ` OFFSET ${parseInt(filters.offset)}`;
      }

      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      console.error('Error in JournalEntry.findAll:', error);
      throw error;
    }
  }

  static async findById(id) {
    const query = `
      SELECT 
        je.*,
        u1.first_name || ' ' || u1.last_name as created_by_name,
        u2.first_name || ' ' || u2.last_name as updated_by_name,
        u3.first_name || ' ' || u3.last_name as approved_by_name,
        u4.first_name || ' ' || u4.last_name as posted_by_name
      FROM journal_entries je
      LEFT JOIN users u1 ON je.created_by = u1.id
      LEFT JOIN users u2 ON je.updated_by = u2.id
      LEFT JOIN users u3 ON je.approved_by = u3.id
      LEFT JOIN users u4 ON je.posted_by = u4.id
      WHERE je.id = $1 AND je.deleted_at IS NULL
    `;
    
    const result = await pool.query(query, [id]);
    
    if (result.rows.length === 0) return null;
    
    const journalEntry = result.rows[0];
    
    // Get journal entry items
    const itemsQuery = `
      SELECT 
        jei.*,
        coa.account_name as account_name_current,
        coa.account_type,
        coa.normal_balance
      FROM journal_entry_items jei
      LEFT JOIN chart_of_accounts coa ON jei.account_id = coa.id
      WHERE jei.journal_entry_id = $1
      ORDER BY jei.line_number
    `;
    
    const itemsResult = await pool.query(itemsQuery, [id]);
    journalEntry.items = itemsResult.rows;
    
    return journalEntry;
  }

  /**
   * @param {object} entryData
   * @param {Array} items
   * @param {string} userId
   * @param {object} [externalClient] when supplied, the entry is written on the
   *   caller's open transaction instead of a fresh connection. Essential for any
   *   caller that creates a document and its journal entry together: posting on a
   *   separate connection commits the GL independently, so a later rollback in
   *   the caller leaves an orphaned POSTED entry — real revenue in the ledger
   *   with no document behind it.
   */
  static async create(entryData, items = [], userId, externalClient = null) {
    const client = externalClient || await pool.connect();
    const ownTransaction = !externalClient;

    try {
      if (ownTransaction) await client.query('BEGIN');

      const {
        entry_date,
        posting_date = entry_date,
        source_type = 'MANUAL',
        source_id,
        source_document,
        description,
        reference,
        currency = 'USD',
        exchange_rate = 1.000000,
        batch_id,
        external_reference,
        notes,
        // Opt-in idempotency (migration 138). Set it to name a posting that
        // must happen at most once; leave it unset for postings that recur.
        posting_key
      } = entryData;

      if (!entry_date || !description) {
        throw new Error('Entry date and description are required');
      }

      if (!items || items.length === 0) {
        throw new Error('At least one journal entry item is required');
      }

      // Validate balancing
      const totalDebits = items.reduce((sum, item) => sum + parseFloat(item.debit_amount || 0), 0);
      const totalCredits = items.reduce((sum, item) => sum + parseFloat(item.credit_amount || 0), 0);

      if (Math.abs(totalDebits - totalCredits) > 0.01) {
        throw new Error(`Journal entry must balance. Debits: ${totalDebits}, Credits: ${totalCredits}`);
      }

      // Generate journal number
      const journalNumberResult = await client.query('SELECT generate_journal_entry_number() as journal_number');
      const journal_number = journalNumberResult.rows[0].journal_number;

      const entryId = uuidv4();
      const period_year = new Date(entry_date).getFullYear();
      const period_month = new Date(entry_date).getMonth() + 1;

      // Period lock: never allow a posting dated into a CLOSED accounting
      // period. Tolerant of the table not existing yet (migration not applied).
      try {
        const periodCheck = await client.query(
          'SELECT status FROM accounting_periods WHERE period_year = $1 AND period_month = $2',
          [period_year, period_month]
        );
        if (periodCheck.rows.length > 0 && periodCheck.rows[0].status === 'CLOSED') {
          throw new Error(`Accounting period ${period_year}-${String(period_month).padStart(2, '0')} is closed — postings are locked`);
        }
      } catch (err) {
        if (/is closed/.test(err.message)) throw err; // real lock -> propagate
        // otherwise (e.g. table missing) do not block posting
      }

      // Server-derive `requires_approval` based on entry amount against approval chain bands for JOURNAL_ENTRY
      let requires_approval = entryData.requires_approval;
      if (typeof requires_approval !== 'boolean') {
        try {
          const tplRes = await client.query(
            `SELECT id FROM approval_chain_templates WHERE document_type = 'JOURNAL_ENTRY' AND is_active = true LIMIT 1`
          );
          if (tplRes.rows.length > 0) {
            const stepsRes = await client.query(
              `SELECT id FROM approval_chain_steps WHERE template_id = $1 AND min_amount <= $2`,
              [tplRes.rows[0].id, totalDebits]
            );
            requires_approval = stepsRes.rows.length > 0;
          } else {
            // Fail closed as specified in prompt C1a: if no template is configured, default to requires approval
            requires_approval = true;
          }
        } catch (err) {
          // If approval template query fails, fail closed — requiring approval is safer than self-posting.
          requires_approval = true;
        }
      }

      const status = requires_approval ? 'PENDING_APPROVAL' : 'DRAFT';

      // Insert journal entry.
      //
      // `posting_key` is the opt-in idempotency key (migration 138). Callers
      // that must post at most once set it and let the unique index settle any
      // race; callers whose postings legitimately recur leave it undefined.
      // An explicit tenant wins; otherwise the column is omitted so the DB
      // column default (current_company_id()) resolves it — calling the
      // function ourselves here would return NULL (and violate NOT NULL) for
      // callers without a company context (schedulers, migrations, tests).
      const hasCompanyId = Boolean(entryData.company_id);
      const entryQuery = `
        INSERT INTO journal_entries (
          id, journal_number, entry_date, posting_date, period_year, period_month,
          source_type, source_id, source_document, description, reference,
          total_debit, total_credit, status, requires_approval, currency,
          exchange_rate, batch_id, external_reference, notes, created_by, posting_key${hasCompanyId ? ', company_id' : ''}
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22${hasCompanyId ? ', $23' : ''})
        RETURNING *
      `;

      const entryValues = [
        entryId, journal_number, entry_date, posting_date, period_year, period_month,
        source_type, source_id, source_document, description, reference,
        totalDebits, totalCredits, status, requires_approval, currency,
        exchange_rate, batch_id, external_reference, notes, userId, posting_key || null,
      ];
      // Explicit tenant wins; otherwise the column is omitted and the DB
      // column default (current_company_id()) resolves it.
      if (hasCompanyId) entryValues.push(entryData.company_id);

      const entryResult = await client.query(entryQuery, entryValues);

      // Batch-fetch all referenced accounts in a single query (avoids the old
      // N+1: one SELECT per line item). Keyed on the distinct account ids.
      const accountIds = [...new Set(items.map((it) => it.account_id))];
      const accountsResult = await client.query(
        'SELECT id, account_code, account_name FROM chart_of_accounts WHERE id = ANY($1::uuid[])',
        [accountIds]
      );
      const accountById = new Map(accountsResult.rows.map((a) => [a.id, a]));

      // Insert journal entry items
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemId = uuidv4();

        const account = accountById.get(item.account_id);
        if (!account) {
          throw new Error(`Account not found: ${item.account_id}`);
        }

        const itemQuery = `
          INSERT INTO journal_entry_items (
            id, journal_entry_id, line_number, account_id, account_code, account_name,
            debit_amount, credit_amount, department_id, project_id, cost_center_id,
            description, reference, currency, exchange_rate, original_amount,
            original_currency, allocation_percentage, allocation_basis
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        `;

        const itemValues = [
          itemId, entryId, i + 1, item.account_id, account.account_code, account.account_name,
          parseFloat(item.debit_amount || 0), parseFloat(item.credit_amount || 0),
          item.department_id, item.project_id, item.cost_center_id,
          item.description, item.reference, currency, exchange_rate,
          item.original_amount, item.original_currency, item.allocation_percentage,
          item.allocation_basis
        ];

        await client.query(itemQuery, itemValues);
      }

      // Add status history
      await this.addStatusHistory(client, entryId, null, status, userId);

      if (ownTransaction) await client.query('COMMIT');
      // findById reads on the pool, which cannot see an uncommitted row. When
      // running inside the caller's transaction, read it back on their client.
      return ownTransaction
        ? await this.findById(entryId)
        : await this.findByIdOnClient(client, entryId);

    } catch (error) {
      if (ownTransaction) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (ownTransaction) client.release();
    }
  }

  /**
   * Read an entry back on a caller-supplied transaction client, so a freshly
   * inserted (still uncommitted) entry is visible.
   */
  static async findByIdOnClient(client, id) {
    const { rows } = await client.query(
      `SELECT je.*, u.first_name || ' ' || u.last_name AS created_by_name
         FROM journal_entries je
         LEFT JOIN users u ON je.created_by = u.id
        WHERE je.id = $1 AND je.deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return null;
    const items = await client.query(
      `SELECT jei.*, coa.account_code AS coa_account_code, coa.account_name AS coa_account_name
         FROM journal_entry_items jei
         LEFT JOIN chart_of_accounts coa ON jei.account_id = coa.id
        WHERE jei.journal_entry_id = $1
        ORDER BY jei.line_number`,
      [id]
    );
    return { ...rows[0], items: items.rows };
  }

  /**
   * @param {object} [externalClient] see create() — posting must be able to join
   *   the caller's transaction, otherwise the POSTED status and its balance
   *   updates commit independently of the document that triggered them.
   */
  static async updateStatus(id, newStatus, userId, reason = '', externalClient = null) {
    const { applyStatusChange } = require('../services/statusTransitionService');

    const updated = await applyStatusChange(
      {
        entityType: 'JOURNAL_ENTRY',
        entityId: id,
        newStatus,
        actor: userId,
        context: { reason: reason || '' },
        executeSideEffects: async (client, record) => {
          const actorId = typeof userId === 'object' && userId !== null ? userId.id : userId;
          if (newStatus === 'APPROVED') {
            await client.query(
              'UPDATE journal_entries SET approved_by = $2, approved_at = CURRENT_TIMESTAMP WHERE id = $1',
              [id, actorId]
            );
          } else if (newStatus === 'POSTED') {
            await client.query(
              'UPDATE journal_entries SET posted_by = $2, posted_at = CURRENT_TIMESTAMP WHERE id = $1',
              [id, actorId]
            );
            await this.updateAccountBalances(client, id);
          }
        }
      },
      externalClient
    );

    // Fire webhook if posted and running on standalone transaction
    if (newStatus === 'POSTED' && !externalClient) {
      try {
        require('../services/webhookService').emit('journal_entry.posted', {
          id: updated.id,
          journal_number: updated.journal_number,
          source_type: updated.source_type,
          total_debit: updated.total_debit,
          total_credit: updated.total_credit,
        });
      } catch (_) {}
    }

    return updated;
  }

  /**
   * Post an entry the SYSTEM raised as a side-effect of a business document —
   * a goods receipt, an invoice, a payment, payroll, a stock movement, a
   * period close. Use this instead of `updateStatus(id, 'POSTED', userId)`
   * for anything a user did not sit down and key in as a journal.
   *
   * WHY THIS EXISTS
   * ---------------------------------------------------------------------
   * Segregation of duties refuses a posting whose creator is also its poster
   * (middleware/rbac.js checkSoD) — which is the correct rule for a manual
   * journal, and fatal for an automatic one. An automatic entry is always
   * created by whoever triggered the document, so `updateStatus(..., userId)`
   * made creator == poster every single time and the entry could never reach
   * the ledger for anyone but the platform owner. The symptom was silent and
   * expensive: receipts, invoices, payments and payroll appeared to succeed
   * while the GL stayed empty, or the whole transaction rolled back.
   *
   * The trigger stays recorded as the entry's creator (that is the audit
   * trail anyone actually wants), and the deployment's posting authority
   * signs the POSTED transition. Fails closed when none is configured.
   *
   * @param {string} id - journal entry to post
   * @param {string|object} triggeredBy - user whose action raised the entry
   * @param {string} reason - audit reason recorded on the transition
   * @param {import('pg').PoolClient} [externalClient] - existing transaction
   */
  static async postAsSystem(id, triggeredBy, reason = '', externalClient = null) {
    const { resolvePostingAuthority } = require('../services/platformOwner');
    const actorId = typeof triggeredBy === 'object' && triggeredBy !== null ? triggeredBy.id : triggeredBy;
    const postingIdentity = await resolvePostingAuthority(actorId, externalClient);
    return this.updateStatus(id, 'POSTED', postingIdentity, reason, externalClient);
  }

  static async updateAccountBalances(client, journalEntryId) {
    const itemsQuery = `
      SELECT account_id, debit_amount, credit_amount
      FROM journal_entry_items
      WHERE journal_entry_id = $1
    `;

    const itemsResult = await client.query(itemsQuery, [journalEntryId]);

    for (const item of itemsResult.rows) {
      const netAmount = parseFloat(item.debit_amount) - parseFloat(item.credit_amount);

      // current_balance is held in the account's NORMAL direction: a credit-
      // normal account (liability/equity/revenue) with net credits carries a
      // POSITIVE balance. Adding raw debit - credit here inverts every such
      // account the moment it is posted to — the drift that made the cached
      // balance sheet disagree with the ledger. Flip by normal_balance, the
      // same convention the canonical restatement (migration 119) and
      // db-verify.js use.
      const { rows: accountRows } = await client.query(
        `SELECT normal_balance FROM chart_of_accounts WHERE id = $1`,
        [item.account_id]
      );
      const normal = accountRows.length ? String(accountRows[0].normal_balance || 'DEBIT').toUpperCase() : 'DEBIT';
      const signed = normal === 'CREDIT' ? -netAmount : netAmount;

      await client.query(`
        UPDATE chart_of_accounts 
        SET current_balance = current_balance + $2,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [item.account_id, signed]);
    }
  }

  static async addStatusHistory(client, entryId, fromStatus, toStatus, userId, reason = '') {
    const query = `
      INSERT INTO journal_entry_status_history (
        journal_entry_id, from_status, to_status, changed_by, reason
      )
      VALUES ($1, $2, $3, $4, $5)
    `;

    await client.query(query, [entryId, fromStatus, toStatus, userId, reason]);
  }

  static async getStatusHistory(id) {
    const query = `
      SELECT 
        jesh.*,
        u.first_name || ' ' || u.last_name as changed_by_name
      FROM journal_entry_status_history jesh
      LEFT JOIN users u ON jesh.changed_by = u.id
      WHERE jesh.journal_entry_id = $1
      ORDER BY jesh.created_at DESC
    `;

    const result = await pool.query(query, [id]);
    return result.rows;
  }

  static async reverse(id, userId, reason) {
    // NOTE: create() and updateStatus() each manage their own connection and
    // transaction. This method must NOT hold its own open transaction while
    // calling them — doing so previously self-deadlocked (the outer connection
    // locked the new reversing-entry row, then updateStatus() on a second
    // connection blocked on that same row until statement timeout).

    const originalEntry = await this.findById(id);
    if (!originalEntry) {
      throw new Error('Original journal entry not found');
    }
    if (originalEntry.status !== 'POSTED') {
      throw new Error('Can only reverse posted journal entries');
    }
    if (originalEntry.is_reversing_entry) {
      throw new Error('Cannot reverse a reversing entry');
    }

    // Segregation of duties, checked BEFORE anything is created. The final
    // step below (marking the original REVERSED) already goes through
    // applyStatusChange -> AuthorityEngine.can, which independently refuses
    // a self-reversal (its sodActions match is a substring check against the
    // action name, and 'TRANSITION_POSTED_TO_REVERSED' contains 'POST') —
    // but that check used to run LAST, after the reversing entry was already
    // created AND posted to the ledger on its own connection. A refused
    // self-reversal therefore left a live, POSTED, fully-effective
    // compensating entry with no original ever marked REVERSED: the
    // compensating debits/credits landed in the GL for real while the
    // original stayed POSTED as if nothing had happened, silently doubling
    // its effect on every account it touched. Checking here, before create()
    // ever runs, makes a refused reversal leave nothing behind.
    const actorId = typeof userId === 'object' && userId !== null ? userId.id : userId;
    if (!(await isPlatformOwnerId(actorId))) {
      checkSoD(originalEntry.created_by, actorId, 'TRANSITION_POSTED_TO_REVERSED');
    }

    // Create reversing entry (swap debits and credits on every line)
    const reversingEntryData = {
      entry_date: new Date().toISOString().split('T')[0],
      posting_date: new Date().toISOString().split('T')[0],
      source_type: 'MANUAL',
      description: `REVERSAL: ${originalEntry.description}`,
      reference: `REV-${originalEntry.journal_number}`,
      currency: originalEntry.currency,
      exchange_rate: originalEntry.exchange_rate,
      notes: `Reversal of ${originalEntry.journal_number}. Reason: ${reason}`
    };

    const reversingItems = originalEntry.items.map(item => ({
      account_id: item.account_id,
      debit_amount: item.credit_amount,
      credit_amount: item.debit_amount,
      department_id: item.department_id,
      project_id: item.project_id,
      cost_center_id: item.cost_center_id,
      description: `REVERSAL: ${item.description || ''}`,
      reference: item.reference
    }));

    const reversingEntry = await this.create(reversingEntryData, reversingItems, userId);

    // Link and post the reversing entry, then mark the original as reversed.
    await pool.query(
      'UPDATE journal_entries SET is_reversing_entry = true, original_entry_id = $2 WHERE id = $1',
      [reversingEntry.id, id]
    );
    await this.postAsSystem(reversingEntry.id, userId, `Automatic posting of reversal for ${originalEntry.journal_number}`);
    await this.updateStatus(id, 'REVERSED', userId, reason);

    return reversingEntry;
  }

  static async getStats(filters = {}) {
    const whereConditions = [];
    const values = [];
    let paramCount = 0;

    // Default to current year if no date filters
    if (!filters.date_from && !filters.date_to) {
      whereConditions.push(`period_year = EXTRACT(YEAR FROM CURRENT_DATE)`);
    }

    if (filters.date_from) {
      whereConditions.push(`entry_date >= $${++paramCount}`);
      values.push(filters.date_from);
    }

    if (filters.date_to) {
      whereConditions.push(`entry_date <= $${++paramCount}`);
      values.push(filters.date_to);
    }

    const whereClause = whereConditions.length > 0 ? 
      `WHERE ${whereConditions.join(' AND ')} AND deleted_at IS NULL` : 'WHERE deleted_at IS NULL';

    const query = `
      SELECT 
        COUNT(*) as total_entries,
        COUNT(CASE WHEN entry_date = CURRENT_DATE THEN 1 END) as today_entries,
        COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END) as pending_approvals,
        COUNT(CASE WHEN status = 'POSTED' THEN 1 END) as posted_entries,
        SUM(total_debit) as total_debits,
        SUM(total_credit) as total_credits,
        COUNT(CASE WHEN source_type = 'MANUAL' THEN 1 END) as manual_entries,
        COUNT(CASE WHEN source_type = 'SALES_ORDER' THEN 1 END) as sales_entries,
        COUNT(CASE WHEN source_type = 'PURCHASE_ORDER' THEN 1 END) as purchase_entries
      FROM journal_entries 
      ${whereClause}
    `;

    const result = await pool.query(query, values);
    return result.rows[0];
  }

  static async delete(id, userId) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Check if journal entry can be deleted
      const entryResult = await client.query(
        'SELECT status FROM journal_entries WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );

      if (entryResult.rows.length === 0) {
        throw new Error('Journal entry not found');
      }

      const status = entryResult.rows[0].status;
      if (['POSTED', 'REVERSED'].includes(status)) {
        throw new Error('Cannot delete posted or reversed journal entries');
      }

      const result = await client.query(
        `UPDATE journal_entries 
         SET deleted_at = CURRENT_TIMESTAMP, updated_by = $2, status = 'CANCELLED'
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING *`,
        [id, userId]
      );

      // Add status history
      await this.addStatusHistory(client, id, status, 'CANCELLED', userId, 'Entry deleted');

      await client.query('COMMIT');
      return result.rows[0];
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Create journal entry from completed sales order
  static async createFromSalesOrder(salesOrderId, userId, postingKey = null) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get sales order details
      const soResult = await client.query(`
        SELECT so.*, c.customer_name 
        FROM sales_orders so
        LEFT JOIN customers c ON so.customer_id = c.id
        WHERE so.id = $1 AND so.status = 'COMPLETED'
      `, [salesOrderId]);
      
      if (soResult.rows.length === 0) {
        throw new Error('Sales order not found or not completed');
      }
      
      const salesOrder = soResult.rows[0];
      
      // Get required accounts
      const accountsResult = await client.query(`
        SELECT id, account_code, account_name 
        FROM chart_of_accounts 
        WHERE account_code IN ('1120', '4100') 
          AND status = 'ACTIVE' 
          AND deleted_at IS NULL
      `);
      
      const accounts = {};
      accountsResult.rows.forEach(acc => {
        accounts[acc.account_code] = acc;
      });
      
      if (!accounts['1120']) {
        throw new Error('Accounts Receivable account (1120) not found');
      }
      if (!accounts['4100']) {
        throw new Error('Sales Revenue account (4100) not found');
      }
      
      // Create journal entry
      const entryData = {
        entry_date: new Date().toISOString().split('T')[0],
        source_type: 'SALES_ORDER',
        source_id: salesOrderId,
        posting_key: postingKey,
        description: `Revenue recognition - Sales Order ${salesOrder.so_number}`,
        reference: salesOrder.so_number,
        notes: `Customer: ${salesOrder.customer_name}`,
        requires_approval: false // Auto-approve for sales orders
      };
      
      const items = [
        {
          account_id: accounts['1120'].id, // Accounts Receivable
          debit_amount: salesOrder.total_amount,
          credit_amount: 0,
          description: `AR - ${salesOrder.customer_name}`
        },
        {
          account_id: accounts['4100'].id, // Sales Revenue  
          debit_amount: 0,
          credit_amount: salesOrder.total_amount,
          description: `Sales Revenue - ${salesOrder.so_number}`
        }
      ];
      
      const journalEntry = await this.create(entryData, items, userId);
      
      // Auto-post the entry
      await this.postAsSystem(journalEntry.id, userId, 'Auto-posted from sales order');
      
      await client.query('COMMIT');
      return journalEntry;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Create journal entry from completed purchase order
  static async createFromPurchaseOrder(purchaseOrderId, userId, postingKey = null) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get purchase order details
      const poResult = await client.query(`
        SELECT po.*, s.legal_name as supplier_name 
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        WHERE po.id = $1 AND po.status = 'COMPLETED'
      `, [purchaseOrderId]);
      
      if (poResult.rows.length === 0) {
        throw new Error('Purchase order not found or not completed');
      }
      
      const purchaseOrder = poResult.rows[0];
      
      // Check if this PO is sales-related (skip inventory, go direct to COGS)  
      const isSalesRelated = purchaseOrder.sales_order_id || 
                            purchaseOrder.source_type?.includes('sales');

      // Get required accounts - use COGS for sales-related, inventory for
      // procurement, plus Input VAT (1160) to split out recoverable tax.
      const expenseAccount = isSalesRelated ? '5100' : '1130'; // COGS vs Inventory
      const accountsResult = await client.query(`
        SELECT id, account_code, account_name
        FROM chart_of_accounts
        WHERE account_code IN ('2110', '1160', $1)
          AND status = 'ACTIVE'
          AND deleted_at IS NULL
      `, [expenseAccount]);

      const accounts = {};
      accountsResult.rows.forEach(acc => {
        accounts[acc.account_code] = acc;
      });

      if (!accounts['2110']) {
        throw new Error('Accounts Payable account (2110) not found');
      }
      if (!accounts[expenseAccount]) {
        const accountName = expenseAccount === '5100' ? 'Cost of Goods Sold' : 'Inventory';
        throw new Error(`${accountName} account (${expenseAccount}) not found`);
      }

      // Split recoverable input VAT out of the expense when the PO carries tax
      // and the Input VAT account exists:
      //   Dr Inventory/COGS (net) / Dr Input VAT (tax) / Cr AP (total)
      const total = Number(purchaseOrder.total_amount) || 0;
      const taxAmount = Number(purchaseOrder.tax_amount) || 0;
      const useInputVat = taxAmount > 0 && accounts['1160'];
      const netExpense = useInputVat ? Math.round((total - taxAmount) * 100) / 100 : total;

      // Create journal entry
      const entryData = {
        entry_date: new Date().toISOString().split('T')[0],
        source_type: 'PURCHASE_ORDER',
        source_id: purchaseOrderId,
        posting_key: postingKey,
        description: `Expense recognition - Purchase Order ${purchaseOrder.po_number}`,
        reference: purchaseOrder.po_number,
        notes: `Supplier: ${purchaseOrder.supplier_name}`,
        requires_approval: false // Auto-approve for purchase orders
      };

      const items = [
        {
          account_id: accounts[expenseAccount].id, // COGS for sales, Inventory for procurement
          debit_amount: netExpense,
          credit_amount: 0,
          description: isSalesRelated ?
            `COGS - ${purchaseOrder.supplier_name}` :
            `Inventory - ${purchaseOrder.supplier_name}`
        },
      ];
      if (useInputVat) {
        items.push({
          account_id: accounts['1160'].id, // Input VAT (recoverable)
          debit_amount: taxAmount,
          credit_amount: 0,
          description: `Input VAT - ${purchaseOrder.po_number}`
        });
      }
      items.push({
        account_id: accounts['2110'].id, // Accounts Payable
        debit_amount: 0,
        credit_amount: total,
        description: `AP - ${purchaseOrder.po_number}`
      });
      
      const journalEntry = await this.create(entryData, items, userId);
      
      // Auto-post the entry
      await this.postAsSystem(journalEntry.id, userId, 'Auto-posted from purchase order');
      
      await client.query('COMMIT');
      return journalEntry;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = JournalEntry;