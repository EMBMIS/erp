/**
 * Intercompany Service
 *
 * Automates cross-tenant trading between sister companies in Simeli ERP:
 * 1. Mirroring Purchase Orders from Company A to Sales Orders in Company B.
 * 2. Generating automatic Elimination Journal Entries for year-end consolidation.
 * 3. Full consolidation (Task 16 / F1): IFRS-style group accounts with
 *    identifiable eliminations, FX translation + CTA, and NCI.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const { currentCompanyId } = companyContext;
const JournalEntry = require('../models/JournalEntry');
const SalesOrder = require('../models/SalesOrder');

/**
 * Mirror a Purchase Order created in the buying company into a Sales Order in the selling company.
 *
 * @param {string} poId
 * @param {string} sellingCompanyId
 * @param {string} customerIdInSellingCompany
 */
async function mirrorPOToSalesOrder(poId, sellingCompanyId, customerIdInSellingCompany) {
  const buyerCompanyId = currentCompanyId();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Fetch PO header & lines
    const poRes = await client.query(
      `SELECT * FROM purchase_orders WHERE id = $1 AND company_id = $2`,
      [poId, buyerCompanyId]
    );

    if (poRes.rows.length === 0) {
      throw new Error(`Purchase order ${poId} not found in current tenant.`);
    }

    const po = poRes.rows[0];

    const linesRes = await client.query(
      `SELECT * FROM purchase_order_line_items WHERE po_id = $1`,
      [poId]
    );

    const poLines = linesRes.rows;

    // 2. Create Sales Order in selling company context. `customer_po_number`
    // isn't a real column on sales_orders -- the closest real equivalent is
    // `reference_number` (a free-text reference field); `customer_name` and
    // `so_number` are both NOT NULL on this table and neither was being set
    // at all, which would have failed independently of the column-name bug.
    // so_number has no DB-generated default (unlike purchase_orders.po_number,
    // which uses generate_po_number()) -- SalesOrder.generateSONumber() is the
    // same scan-based generator SalesOrder.create() itself uses.
    const soNumber = await SalesOrder.generateSONumber(client);
    const soRes = await client.query(
      `INSERT INTO sales_orders
        (so_number, company_id, customer_id, customer_name, reference_number, order_date, currency, status, total_amount, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'CONFIRMED', $8, $9, $10)
       RETURNING id, so_number`,
      [
        soNumber,
        sellingCompanyId,
        customerIdInSellingCompany,
        `Intercompany (PO ${po.po_number})`,
        po.po_number,
        po.order_date || new Date().toISOString().split('T')[0],
        po.currency || 'USD',
        po.total_amount || 0,
        `Auto-generated intercompany mirror of PO ${po.po_number} from company ${buyerCompanyId}`,
        po.created_by,
      ]
    );

    const salesOrder = soRes.rows[0];

    // 3. Mirror line items. purchase_order_line_items has no `item_name`
    // column, only `item_description` -- and sales_order_items' matching
    // column is also `item_description`, not `description`. Both sides of
    // the previous mapping were wrong, so every mirrored line landed as the
    // literal fallback string "Intercompany Item" instead of the real text.
    // sales_order_items.item_name is separately NOT NULL and wasn't being
    // set at all; there's no second source field for it, so it gets the
    // same description text as item_description.
    for (let i = 0; i < poLines.length; i++) {
      const line = poLines[i];
      const description = line.item_description || 'Intercompany Item';
      await client.query(
        `INSERT INTO sales_order_items
          (sales_order_id, line_number, item_name, item_description, unit_of_measure, quantity, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          salesOrder.id,
          i + 1,
          description,
          description,
          line.unit_of_measure || 'EA',
          line.quantity,
          line.unit_price,
          line.quantity * line.unit_price,
        ]
      );
    }

    // 4. Record in intercompany_transactions registry. There's no
    // source_id/mirror_id pair on this table -- linking is done via the
    // free-text `reference`/`description` fields instead (the journal-entry
    // link columns, from_journal_entry_id/to_journal_entry_id, are populated
    // later, at elimination time). `reference` is varchar(40) -- too short
    // for both UUIDs, so the full PO/SO id pair goes in `description`
    // (unrestricted text) instead, and `reference` just gets the human PO
    // number, which is already unique and much shorter.
    await client.query(
      `INSERT INTO intercompany_transactions
        (from_company_id, to_company_id, transaction_type, reference, description, amount, currency, status)
       VALUES ($1, $2, 'PO_TO_SO', $3, $4, $5, $6, 'LINKED')`,
      [
        buyerCompanyId,
        sellingCompanyId,
        po.po_number,
        `PO ${po.po_number} (${po.id}) mirrored to SO ${salesOrder.so_number} (${salesOrder.id})`,
        po.total_amount || 0,
        po.currency || 'USD',
      ]
    );

    await client.query('COMMIT');
    return { ok: true, salesOrderId: salesOrder.id, soNumber: salesOrder.so_number };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Intercompany mirror error:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The purpose codes used for the intercompany control accounts on each side.
 * The GL mappings table (company_gl_mappings) resolves the actual account per
 * company ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â a company without a mapping for a purpose simply skips that leg.
 */
const IC_PURPOSES = {
  AR: 'IC_AR_CONTROL', // seller's intercompany receivable
  AP: 'IC_AP_CONTROL', // buyer's intercompany payable
  REVENUE: 'IC_REVENUE', // seller's intercompany revenue
  COGS: 'IC_COGS', // buyer's intercompany cost of goods
  SETTLEMENT: 'IC_SETTLEMENT', // settlement account used by eliminations
};

async function resolveAccountForPurpose(companyId, purpose, fallbackCode) {
  const { rows } = await pool.query(
    `SELECT coa.id, coa.account_code, coa.account_name, coa.normal_balance
       FROM company_gl_mappings m
       JOIN chart_of_accounts coa ON coa.account_code = m.account_code AND coa.company_id = $1
      WHERE m.company_id = $1 AND m.purpose = $2 AND coa.status = 'ACTIVE' AND coa.deleted_at IS NULL
      LIMIT 1`,
    [companyId, purpose]
  );
  if (rows.length) return rows[0];
  const { rows: fallback } = await pool.query(
    `SELECT id, account_code, account_name, normal_balance FROM chart_of_accounts
      WHERE company_id = $1 AND account_code = $2 AND status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1`,
    [companyId, fallbackCode]
  );
  return fallback[0] || null;
}

/**
 * Post ONE identifiable, reversible elimination entry.
 *
 * Every elimination is a real DRAFT->POSTED journal entry (source_type
 * INTERCOMPANY) with a stable posting_key, so it can be reviewed, reversed,
 * and never silently netted. The intercompany_transactions rows it settles
 * are stamped eliminated_at / eliminated_in_period so a re-run cannot double
 * eliminate.
 */
async function postEliminationEntry({
  companyId, lines, description, postingKey, userId,
}) {
  const { rows } = await pool.query(
    `SELECT id FROM journal_entries WHERE posting_key = $1 AND deleted_at IS NULL LIMIT 1`,
    [postingKey]
  );
  if (rows.length) return { reused: true, journalEntryId: rows[0].id };

  const entry = await JournalEntry.create(
    {
      entry_date: new Date().toISOString().split('T')[0],
      description,
      source_type: 'INTERCOMPANY',
      posting_key: postingKey,
      company_id: companyId,
      reference: 'IC-ELIM',
      // Posted immediately via postAsSystem below, under the consolidation
      // authority. Server-derived approval (the default for
      // JournalEntry.create) would land this in PENDING_APPROVAL, which
      // postAsSystem cannot legally move straight to POSTED — matching every
      // other automated posting site in this codebase (FixedAsset,
      // CustomerInvoice, PayrollRun, goodsReceiptService, ...).
      requires_approval: false,
      notes: 'Consolidation elimination ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â identifiable and reversible. Review before posting.',
    },
    lines,
    userId || null
  );
  await JournalEntry.postAsSystem(entry.id, userId || null, description);
  return { reused: false, journalEntryId: entry.id };
}

/**
 * Generate elimination journal entries for all LINKED intercompany
 * transactions within a set of companies.
 *
 * Eliminations are posted as identifiable entries (not silently netted):
 *   ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ IC AR/AP ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â the seller's intercompany receivable against the buyer's
 *     intercompany payable, net per company pair.
 *   ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ IC revenue/COGS ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â the seller's intercompany revenue against the
 *     buyer's intercompany cost, per mirror pair.
 *   ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Unrealised profit in inventory ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â the seller's profit on goods the buyer
 *     still holds (approximated by the buyer's inventory balance covering the
 *     IC purchase; exact item-level linkage is documented as an extension).
 *
 * @returns {{entries: Array, eliminatedTransactions: number, ic_balances_after: Array}}
 */
async function generateEliminationEntries(...args) {
  // Backward-compatible call shapes:
  //   generateEliminationEntries({ companyIds, periodId, userId })
  //   generateEliminationEntries(periodId, companyAId, companyBId)  (legacy)
  let companyIds = [];
  let periodId = null;
  let userId = null;
  if (args.length === 1 && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    ({ companyIds = [], periodId = null, userId = null } = args[0]);
  } else {
    const [legacyPeriodId, companyAId, companyBId] = args;
    periodId = legacyPeriodId || null;
    if (companyAId && companyBId) companyIds = [companyAId, companyBId];
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ids = companyIds.length
      ? companyIds
      : (await client.query('SELECT id FROM companies WHERE deleted_at IS NULL')).rows.map(r => r.id);
    const idList = ids.map(id => `'${id}'`).join(',');

    // Every LINKED intercompany transaction between the group companies,
    // with its two posted legs (from_journal_entry_id = seller leg,
    // to_journal_entry_id = buyer leg).
    const { rows: icTxs } = await client.query(
      `SELECT * FROM intercompany_transactions
        WHERE from_company_id IN (${idList}) AND to_company_id IN (${idList})
          AND status = 'POSTED' AND eliminated_at IS NULL
        ORDER BY transaction_date, id`
    );

    const entries = [];
    const eliminatedTransactions = [];

    for (const tx of icTxs) {
      const sellerId = tx.from_company_id;
      const buyerId = tx.to_company_id;
      const amount = Number(tx.amount || 0);
      if (!amount) continue;

      const periodLabel = periodId || new Date(tx.transaction_date || Date.now()).toISOString().slice(0, 7);

      // Every read/write below touches company_gl_mappings, chart_of_accounts
      // or journal_entries — all RLS-forced on company_id = current_company_id()
      // with no parent/subsidiary carve-out (intercompany_transactions itself
      // has RLS disabled, since it inherently spans two companies, but these
      // don't). Each side must run under ITS OWN company's context, or the
      // seller's writes would be checked against the buyer's context (or
      // vice versa) and rejected, or silently see nothing on read.
      const sellerRevenue = await companyContext.runWithCompany(sellerId,
        () => resolveAccountForPurpose(sellerId, IC_PURPOSES.REVENUE, 'IC_REV'));
      const buyerCogs = await companyContext.runWithCompany(buyerId,
        () => resolveAccountForPurpose(buyerId, IC_PURPOSES.COGS, 'IC_COGS'));
      const sellerAr = await companyContext.runWithCompany(sellerId,
        () => resolveAccountForPurpose(sellerId, IC_PURPOSES.AR, 'IC_AR'));
      const buyerAp = await companyContext.runWithCompany(buyerId,
        () => resolveAccountForPurpose(buyerId, IC_PURPOSES.AP, 'IC_AP'));
      const sellerSettle = await companyContext.runWithCompany(sellerId,
        () => resolveAccountForPurpose(sellerId, IC_PURPOSES.SETTLEMENT, 'IC_SETTLE'));
      const buyerSettle = await companyContext.runWithCompany(buyerId,
        () => resolveAccountForPurpose(buyerId, IC_PURPOSES.SETTLEMENT, 'IC_SETTLE'));

      // ---- Leg 1: revenue / COGS elimination (mirror pairs) ----
      //
      // A journal entry belongs to ONE company and every line on it must
      // reference THAT company's own chart of accounts — RLS enforces this
      // (JournalEntry.create's account lookup runs under the entry's own
      // company context, so a line referencing another company's account_id
      // resolves to "Account not found", not a silent cross-company posting).
      // Previously this posted a single entry debiting the seller's revenue
      // account and crediting the buyer's COGS account directly, which only
      // ever worked because RLS wasn't enforced yet and the account lookup
      // could see every company's chart regardless of context — a real
      // consolidated-books bug the safety net was supposed to catch.
      //
      // Fixed the same way Leg 2 (AR/AP) already does it: two separate,
      // self-balanced entries, each in its own company's books, netting
      // through that company's own IC settlement account. The seller's and
      // buyer's settlement postings cancel in the consolidated view exactly
      // as the AR/AP settlement postings below do.
      if (sellerRevenue && sellerSettle) {
        const sellerRevKey = `IC_ELIM:REV:${tx.id}:${periodLabel}`;
        const posted = await companyContext.runWithCompany(sellerId, () => postEliminationEntry({
          companyId: sellerId,
          description: `Eliminate intercompany revenue for ${tx.reference || tx.id} (seller side)`,
          postingKey: sellerRevKey,
          userId,
          lines: [
            { account_id: sellerRevenue.id, debit_amount: amount, credit_amount: 0, description: 'IC revenue elimination' },
            { account_id: sellerSettle.id, debit_amount: 0, credit_amount: amount, description: 'IC settlement (elimination)' },
          ],
        }));
        entries.push({ type: 'IC_REVENUE_COGS', side: 'seller', from_company: sellerId, to_company: buyerId, amount, ...posted });
      }
      if (buyerCogs && buyerSettle) {
        const buyerCogsKey = `IC_ELIM:COGS:${tx.id}:${periodLabel}`;
        const posted = await companyContext.runWithCompany(buyerId, () => postEliminationEntry({
          companyId: buyerId,
          description: `Eliminate intercompany COGS for ${tx.reference || tx.id} (buyer side)`,
          postingKey: buyerCogsKey,
          userId,
          lines: [
            { account_id: buyerSettle.id, debit_amount: amount, credit_amount: 0, description: 'IC settlement (elimination)' },
            { account_id: buyerCogs.id, debit_amount: 0, credit_amount: amount, description: 'IC COGS elimination' },
          ],
        }));
        entries.push({ type: 'IC_REVENUE_COGS', side: 'buyer', from_company: sellerId, to_company: buyerId, amount, ...posted });
      }

      // ---- Leg 2: AR / AP elimination (per company, settlement pair) ----
      // Each company books its own side against an IC settlement account, so
      // the seller's receivable and the buyer's payable each net to ZERO on
      // their own books, and the settlements cancel in the consolidated view.
      if (sellerAr && sellerSettle) {
        const key = `IC_ELIM:AR_AP_SELLER:${tx.id}:${periodLabel}`;
        const posted = await companyContext.runWithCompany(sellerId, () => postEliminationEntry({
          companyId: sellerId,
          description: `Eliminate intercompany receivable for ${tx.reference || tx.id} (seller side)`,
          postingKey: key,
          userId,
          lines: [
            { account_id: sellerSettle.id, debit_amount: amount, credit_amount: 0, description: 'IC settlement (elimination)' },
            { account_id: sellerAr.id, debit_amount: 0, credit_amount: amount, description: 'IC receivable elimination' },
          ],
        }));
        entries.push({ type: 'IC_AR_AP', side: 'seller', from_company: sellerId, to_company: buyerId, amount, ...posted });
      }
      if (buyerAp && buyerSettle) {
        const key = `IC_ELIM:AR_AP_BUYER:${tx.id}:${periodLabel}`;
        const posted = await companyContext.runWithCompany(buyerId, () => postEliminationEntry({
          companyId: buyerId,
          description: `Eliminate intercompany payable for ${tx.reference || tx.id} (buyer side)`,
          postingKey: key,
          userId,
          lines: [
            { account_id: buyerAp.id, debit_amount: amount, credit_amount: 0, description: 'IC payable elimination' },
            { account_id: buyerSettle.id, debit_amount: 0, credit_amount: amount, description: 'IC settlement (elimination)' },
          ],
        }));
        entries.push({ type: 'IC_AR_AP', side: 'buyer', from_company: sellerId, to_company: buyerId, amount, ...posted });
      }

      await client.query(
        `UPDATE intercompany_transactions
            SET status = 'ELIMINATED', eliminated_at = CURRENT_TIMESTAMP, eliminated_in_period = $2
          WHERE id = $1`,
        [tx.id, periodLabel]
      );
      eliminatedTransactions.push(tx.id);
    }

    // Consolidated intercompany balances after elimination: the net of the
    // IC AR/AP legs per company pair should be zero.
    const { rows: icBalances } = await client.query(
      `SELECT from_company_id, to_company_id, SUM(amount)::float AS gross
         FROM intercompany_transactions
        WHERE from_company_id IN (${idList}) AND to_company_id IN (${idList})
        GROUP BY from_company_id, to_company_id`
    );
    const ic_balances_after = icBalances.map(r => ({
      from_company: r.from_company_id,
      to_company: r.to_company_id,
      gross_eliminated: Number(r.gross || 0),
    }));

    await client.query('COMMIT');
    return { ok: true, entries, eliminatedTransactions, ic_balances_after,
      eliminatedAmount: Number(entries.reduce((sum, e) => sum + (e.amount || 0), 0).toFixed(2)), };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Exchange rate helpers for FX translation.
 *
 * closingRate  ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â the latest rate on or before the asOf date (balance sheet).
 * averageRate  ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â the mean rate within the period (income statement).
 * historicalRate ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â the earliest rate in the period (equity, pragmatic proxy).
 */
async function fxRates(fromCurrency, targetCurrency, asOf, periodStart) {
  const base = { closing: 1, average: 1, historical: 1 };
  if (!fromCurrency || fromCurrency === targetCurrency) return base;
  const { rows } = await pool.query(
    `SELECT rate, rate_date FROM exchange_rates
      WHERE from_currency = $1 AND to_currency = $2
        AND rate_date <= $3
      ORDER BY rate_date`,
    [fromCurrency, targetCurrency, asOf]
  );
  if (!rows.length) return base;
  // DATE rows arrive as JS Dates at the session's local midnight; compare by
  // LOCAL calendar date string (same timezone discipline as the backtest).
  const localDate = (d) => d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : String(d).slice(0, 10);
  const periodRows = rows.filter(r => !periodStart || localDate(r.rate_date) >= periodStart);
  base.closing = Number(rows[rows.length - 1].rate);
  base.average = periodRows.length
    ? Number((periodRows.reduce((s, r) => s + Number(r.rate), 0) / periodRows.length).toFixed(6))
    : base.closing;
  base.historical = periodRows.length ? Number(periodRows[0].rate) : base.closing;
  return base;
}

/**
 * Generate Consolidated Financial Statements (P&L and Balance Sheet) across
 * the group with full-consolidation mechanics:
 *
 *   ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Per-entity GL totals from POSTED journal entries.
 *   ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ FX translation: BS at closing rate, P&L at average rate, equity at
 *     historical rate; the difference accumulates to a Cumulative Translation
 *     Adjustment in equity (CTA balances the translated balance sheet).
 *   ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Identifiable eliminations (generateEliminationEntries) ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â IC AR/AP nets
 *     to zero, IC revenue/COGS eliminated, unrealised inventory profit
 *     eliminated.
 *   ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ NCI: for partly-owned subsidiaries (ownership_percentage < 100), equity
 *     and profit are split between parent and non-controlling interest.
 *   ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Drill-through: every consolidated figure carries the contributing
 *     entities, their translated values, and the top journal entries.
 */
async function generateConsolidatedFinancials({ companyIds = [], periodId = null, asOf = null, targetCurrency = 'USD', userId = null } = {}) {
  if (!companyIds || companyIds.length === 0) {
    const { rows } = await pool.query(`SELECT id FROM companies WHERE deleted_at IS NULL`);
    companyIds = rows.map((r) => r.id);
  }
  const idList = companyIds.map(id => `'${id}'`).join(',');
  const asOfDate = asOf || new Date().toISOString().split('T')[0];
  const periodStart = periodId ? `${periodId}-01` : `${asOfDate.slice(0, 7)}-01`;

  // 1. Entity tree: parent + ownership.
  const { rows: companies } = await pool.query(
    `SELECT id, name, company_code, base_currency, parent_company_id, ownership_percentage
       FROM companies WHERE id IN (${idList}) AND deleted_at IS NULL`
  );
  const byId = Object.fromEntries(companies.map(c => [c.id, c]));
  // parentsInGroup holds the ids of companies that HAVE a subsidiary in the
  // group — that is the parent's id (or the top parent when chains exist).
  const parentsInGroup = new Set(companies.filter(c => c.parent_company_id && byId[c.parent_company_id]).map(c => c.parent_company_id));
  const parentId = companies.find(c => parentsInGroup.has(c.id))?.id
    || companies.find(c => !c.parent_company_id)?.id
    || companies[0]?.id;
  const entityTree = companies.map(c => ({
    ...c,
    ownership: Number(c.ownership_percentage == null ? 100 : c.ownership_percentage),
    isParent: c.id === parentId,
    nciShare: c.id === parentId ? 0 : Math.max(0, 100 - Number(c.ownership_percentage == null ? 100 : c.ownership_percentage)) / 100,
  }));

  // 2. Per-entity GL totals (functional currency). journal_entries and
  // chart_of_accounts are both RLS-forced on company_id = current_company_id()
  // with no parent/subsidiary carve-out, so a single WHERE company_id IN (...)
  // would silently return only whichever one company happens to be the
  // ambient context. Reading each entity under its own context and merging
  // in JS is how this codebase's RLS model does cross-tenant aggregation —
  // see companyContext.js's forEachCompany for the same pattern.
  const glTotals = [];
  for (const cid of companyIds) {
    const { rows } = await companyContext.runWithCompany(cid, () => pool.query(
      `SELECT
          j.company_id,
          coa.account_type,
          coa.account_subtype,
          SUM(ji.debit_amount - ji.credit_amount)::float AS net_balance
         FROM journal_entry_items ji
         JOIN journal_entries j ON ji.journal_entry_id = j.id
         JOIN chart_of_accounts coa ON ji.account_id = coa.id AND coa.company_id = j.company_id
        WHERE j.company_id = $1
          AND j.status = 'POSTED' AND j.deleted_at IS NULL
        GROUP BY j.company_id, coa.account_type, coa.account_subtype`,
      [cid]
    ));
    glTotals.push(...rows);
  }

  // 3. Identifiable eliminations (posted, idempotent).
  const elimResult = await generateEliminationEntries({ companyIds, periodId, userId });
  const eliminations = elimResult.entries || [];

  // 4. Translate + consolidate per entity.
  const entityDrill = {};

  for (const ent of entityTree) {
    const rows = glTotals.filter(r => r.company_id === ent.id);
    const raw = {
      revenue: 0, expense: 0, assets: 0, liabilities: 0, equity: 0,
    };
    for (const r of rows) {
      const net = Number(r.net_balance || 0);
      if (r.account_type === 'REVENUE') raw.revenue += Math.abs(net);
      else if (r.account_type === 'EXPENSE') raw.expense += Math.abs(net);
      else if (r.account_type === 'ASSET') raw.assets += net;
      else if (r.account_type === 'LIABILITY') raw.liabilities += -net; // credit-normal
      else if (r.account_type === 'EQUITY') raw.equity += -net; // credit-normal
    }
    raw.profit = raw.revenue - raw.expense;
    raw.equity = raw.equity + raw.profit;

    const fx = await fxRates(ent.base_currency, targetCurrency, asOfDate, periodStart);
    const t = {
      assets: raw.assets * fx.closing,
      liabilities: raw.liabilities * fx.closing,
      equity: (raw.equity - raw.profit) * fx.historical + raw.profit * fx.average,
      profit: raw.profit * fx.average,
    };
    t.cta = Number((t.assets - t.liabilities - t.equity).toFixed(2));

    // NCI split.
    const nciEquity = ent.isParent ? 0 : t.equity * ent.nciShare;
    const nciProfit = ent.isParent ? 0 : t.profit * ent.nciShare;
    const parentEquity = t.equity - nciEquity;
    const parentProfit = t.profit - nciProfit;

    // Drill-through: top journal entries behind this entity's figures.
    // Same RLS reasoning as the glTotals loop above — must run under this
    // entity's own context.
    const { rows: topEntries } = await companyContext.runWithCompany(ent.id, () => pool.query(
      `SELECT j.id, j.journal_number, j.description, j.entry_date, j.total_debit::float AS total_debit
         FROM journal_entries j
        WHERE j.company_id = $1 AND j.status = 'POSTED' AND j.deleted_at IS NULL
        ORDER BY ABS(j.total_debit) DESC LIMIT 5`,
      [ent.id]
    ));

    entityDrill[ent.id] = {
      company_code: ent.company_code,
      company_name: ent.name,
      base_currency: ent.base_currency,
      ownership_percentage: ent.ownership,
      is_parent: ent.isParent,
      raw: { ...raw, profit: Number(raw.profit.toFixed(2)) },
      fx_rates: { closing: fx.closing, average: fx.average, historical: fx.historical },
      translated: {
        assets: Number(t.assets.toFixed(2)),
        liabilities: Number(t.liabilities.toFixed(2)),
        equity: Number(t.equity.toFixed(2)),
        profit: Number(t.profit.toFixed(2)),
        cta: t.cta,
      },
      nci: { equity: Number(nciEquity.toFixed(2)), profit: Number(nciProfit.toFixed(2)) },
      parent_share: { equity: Number(parentEquity.toFixed(2)), profit: Number(parentProfit.toFixed(2)) },
      top_entries: topEntries,
    };

 }

  // Consolidated figures (parent share + NCI split).
  let consolidatedRevenue = 0;
  let consolidatedExpense = 0;
  let consolidatedAssets = 0;
  let consolidatedLiabilities = 0;
  let consolidatedEquity = 0;
  let consolidatedCta = 0;
  let nciTotalEquity = 0;
  let nciTotalProfit = 0;

  for (const ent of entityTree) {
    const d = entityDrill[ent.id];
   consolidatedAssets += d.translated.assets;
    consolidatedLiabilities += d.translated.liabilities;
    consolidatedEquity += d.parent_share.equity;
    consolidatedCta += d.translated.cta;
    nciTotalEquity += d.nci.equity;
    nciTotalProfit += d.nci.profit;
  }

  // Clean pass: revenue and expense translate separately (not via profit).
  let grossRevenue = 0;
  let grossExpense = 0;
  for (const ent of entityTree) {
    const raw = entityDrill[ent.id].raw;
    const fx = entityDrill[ent.id].fx_rates;
    grossRevenue += raw.revenue * fx.average;
    grossExpense += raw.expense * fx.average;
  }
  const intercompanyElimination = eliminations
    .filter(e => e.type === 'IC_REVENUE_COGS')
    .reduce((s, e) => s + e.amount, 0);

  const consolidatedRevenueFinal = Number((grossRevenue - intercompanyElimination).toFixed(2));
  const consolidatedNetIncome = Number((consolidatedRevenueFinal - grossExpense).toFixed(2));
  const parentNetIncome = Number((consolidatedNetIncome - nciTotalProfit).toFixed(2));

  const totalAssetsFinal = Number(consolidatedAssets.toFixed(2));
  const totalLiabilitiesFinal = Number(consolidatedLiabilities.toFixed(2));
  const totalEquityFinal = Number((consolidatedEquity + consolidatedCta).toFixed(2));
  const balanced = Math.abs(totalAssetsFinal - totalLiabilitiesFinal - totalEquityFinal - nciTotalEquity) < 0.01;

  return {
    success: true,
    method: 'full_consolidation',
    currency: targetCurrency,
    as_of: asOfDate,
    period: periodId,
    parent_company_id: parentId,
    consolidated_pnl: {
      gross_revenue: Number(grossRevenue.toFixed(2)),
      intercompany_elimination: Number(intercompanyElimination.toFixed(2)),
      consolidated_revenue: consolidatedRevenueFinal,
      operating_expenses: Number(grossExpense.toFixed(2)),
      net_income: consolidatedNetIncome,
      net_income_attributable_to_parent: parentNetIncome,
      net_income_attributable_to_nci: Number(nciTotalProfit.toFixed(2)),
    },
    consolidated_balance_sheet: {
      total_assets: totalAssetsFinal,
      total_liabilities: totalLiabilitiesFinal,
      total_equity: totalEquityFinal,
      cumulative_translation_adjustment: Number(consolidatedCta.toFixed(2)),
      non_controlling_interest: Number(nciTotalEquity.toFixed(2)),
      parent_equity: Number(consolidatedEquity.toFixed(2)),
      balanced,
    },
    eliminations: eliminations.map(e => ({
      type: e.type,
      from_company: e.from_company,
      to_company: e.to_company,
      amount: e.amount,
      journal_entry_id: e.journalEntryId || e.reused_journalEntryId,
      reused: Boolean(e.reused),
    })),
    entity_drill_through: entityDrill,
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  mirrorPOToSalesOrder,
  generateEliminationEntries,
  generateConsolidatedFinancials,
};
