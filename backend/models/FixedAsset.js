const { pool } = require('../config/database');
const JournalEntry = require('./JournalEntry');
const calc = require('../services/financeCalc');
const { isPlatformOwnerId } = require('../services/platformOwner');

const round2 = calc.round2;

// Postgres unique-violation, raised by uq_journal_entries_posting_key when a
// period is charged twice.
const UNIQUE_VIOLATION = '23505';

/**
 * The period a depreciation charge belongs to, as a stable string.
 *
 * `months` is part of it because a one-month charge and a twelve-month
 * catch-up for the same date are different postings, and collapsing them would
 * make the second silently vanish rather than post.
 */
function periodKey(effectiveDate, months) {
  const d = new Date(effectiveDate);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}x${months}`;
}

/**
 * FixedAsset — asset register with straight-line and accelerated depreciation.
 *
 * Depreciation for a period posts Dr Depreciation Expense (5260) / Cr
 * Accumulated Depreciation (1220) and updates the asset's accumulated
 * depreciation. An asset stops depreciating once its book value reaches its
 * salvage value (status FULLY_DEPRECIATED).
 *
 * Which curve is charged is the asset's own `depreciation_method`; the
 * arithmetic for each lives in services/financeCalc.
 */
const METHOD_LABELS = {
  STRAIGHT_LINE: 'straight-line',
  DECLINING_BALANCE: 'declining balance',
  DOUBLE_DECLINING: 'double declining balance',
  SUM_OF_YEARS_DIGITS: "sum of years' digits",
};

class FixedAsset {

  static async create(data, userId) {
    const numResult = await pool.query('SELECT generate_asset_number() as number');
    const asset_number = numResult.rows[0].number;

    // Rejected at registration rather than at the first depreciation run: an
    // asset that cannot be depreciated is not a valid asset, and finding that
    // out a month later means finding it out during a period close.
    const method = String(data.depreciation_method || 'STRAIGHT_LINE').toUpperCase();
    if (!calc.DEPRECIATION_METHODS.includes(method)) {
      throw new Error(
        `Unknown depreciation method "${data.depreciation_method}". Supported: ${calc.DEPRECIATION_METHODS.join(', ')}.`
      );
    }
    const factor = data.declining_balance_factor != null
      ? Number(data.declining_balance_factor)
      : null;
    if (factor !== null && !(factor > 0 && factor <= 5)) {
      throw new Error('The declining balance factor must be greater than 0 and no more than 5.');
    }

    const result = await pool.query(`
      INSERT INTO fixed_assets (
        asset_number, name, description, category, acquisition_date,
        acquisition_cost, salvage_value, useful_life_years, depreciation_method,
        declining_balance_factor, location, serial_number, supplier_id, notes,
        created_by, updated_by
      ) VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_DATE),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
      RETURNING *
    `, [
      asset_number,
      data.name,
      data.description || null,
      data.category || null,
      data.acquisition_date || null,
      data.acquisition_cost,
      data.salvage_value || 0,
      data.useful_life_years || 5,
      method,
      factor,
      data.location || null,
      data.serial_number || null,
      data.supplier_id || null,
      data.notes || null,
      userId,
    ]);
    const asset = result.rows[0];

    // Optionally capitalize the acquisition to the ledger:
    // Dr Property, Plant & Equipment (1210) / Cr funding account (default Cash 1110).
    if (data.post_acquisition) {
      // Caller explicitly asked to capitalize to the ledger — if that cannot be
      // done, fail loudly rather than returning a "registered" asset with no
      // posting (audit B11).
      const funding = (data.funding_account_code || '1110');
      const accs = await pool.query(
        "SELECT id, account_code FROM chart_of_accounts WHERE account_code IN ('1210', $1) AND status = 'ACTIVE' AND deleted_at IS NULL",
        [funding]
      );
      const map = {};
      accs.rows.forEach((a) => { map[a.account_code] = a.id; });
      if (!map['1210'] || !map[funding]) {
        throw new Error(`Cannot post asset acquisition: account 1210 (PP&E) and/or funding account ${funding} missing or inactive`);
      }
      const cost = Number(asset.acquisition_cost);
      const entry = await JournalEntry.create({
        entry_date: (data.acquisition_date || new Date().toISOString().split('T')[0]),
        source_type: 'FIXED_ASSET',
        source_id: asset.id,
        description: `Asset acquisition - ${asset.asset_number} ${asset.name}`,
        reference: asset.asset_number,
        requires_approval: false,
      }, [
        { account_id: map['1210'], debit_amount: cost, credit_amount: 0, description: 'PP&E acquisition' },
        { account_id: map[funding], debit_amount: 0, credit_amount: cost, description: `Funding (${funding})` },
      ], userId);
      await JournalEntry.postAsSystem(entry.id, userId, 'Auto-posted asset acquisition');
    }

    return asset;
  }

  static async findAll(filters = {}) {
    let query = `
      SELECT fa.*, u.first_name || ' ' || u.last_name as created_by_name
      FROM fixed_assets fa
      LEFT JOIN users u ON fa.created_by = u.id
      WHERE fa.deleted_at IS NULL
    `;
    let countQuery = `
      SELECT COUNT(*)::int AS n
      FROM fixed_assets fa
      WHERE fa.deleted_at IS NULL
    `;
    const conditions = [];
    const values = [];
    if (filters.search) {
      conditions.push(`(fa.asset_number ILIKE $${values.length + 1} OR fa.name ILIKE $${values.length + 1})`);
      values.push(`%${filters.search}%`);
    }
    if (filters.status) {
      conditions.push(`fa.status = $${values.length + 1}`);
      values.push(filters.status);
    }
    if (filters.category) {
      conditions.push(`fa.category = $${values.length + 1}`);
      values.push(filters.category);
    }
    if (conditions.length > 0) {
      query += ' AND ' + conditions.join(' AND ');
      countQuery += ' AND ' + conditions.join(' AND ');
    }

    // Total BEFORE paging — the count query only carries the filter values, so
    // it runs before the limit/offset parameters are appended below. Matches
    // the CustomerInvoice.findAll pattern the list endpoints share.
    const countResult = await pool.query(countQuery, values);

    // Sorting is whitelisted, never interpolated from the request (same rule
    // as customer-invoices GET /): the client's sort_by only LOOKS UP a fixed
    // column expression. Tie-break on id so equal sort values cannot shuffle
    // rows between pages.
    const SORTABLE = {
      asset_number: 'fa.asset_number',
      name: 'fa.name',
      category: 'fa.category',
      status: 'fa.status',
      acquisition_date: 'fa.acquisition_date',
      acquisition_cost: 'fa.acquisition_cost',
      created_at: 'fa.created_at',
    };
    const sortColumn = SORTABLE[filters.sort_by] || 'fa.created_at';
    const sortDirection = String(filters.sort_dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    query += ` ORDER BY ${sortColumn} ${sortDirection} NULLS LAST, fa.id`;

    if (filters.limit) { query += ` LIMIT $${values.length + 1}`; values.push(filters.limit); }
    if (filters.offset) { query += ` OFFSET $${values.length + 1}`; values.push(filters.offset); }

    const result = await pool.query(query, values);
    return { rows: result.rows, total: countResult.rows[0].n };
  }

  static async findById(id) {
    const assetResult = await pool.query('SELECT * FROM fixed_assets WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (assetResult.rows.length === 0) return null;
    const asset = assetResult.rows[0];
    const history = await pool.query(`
      SELECT fad.*, je.journal_number
      FROM fixed_asset_depreciation fad
      LEFT JOIN journal_entries je ON fad.journal_entry_id = je.id
      WHERE fad.asset_id = $1 ORDER BY fad.period_date DESC
    `, [id]);
    asset.depreciation_history = history.rows;
    return asset;
  }

  static async getStats() {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total_assets,
        COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_assets,
        COALESCE(SUM(acquisition_cost), 0) AS total_cost,
        COALESCE(SUM(accumulated_depreciation), 0) AS total_accumulated_depreciation,
        COALESCE(SUM(book_value), 0) AS total_book_value
      FROM fixed_assets WHERE deleted_at IS NULL AND status <> 'DISPOSED'
    `);
    return result.rows[0];
  }

  /**
   * Compute one period's depreciation for an asset under its own method and
   * post it.
   *
   * The method comes from the asset, not from this function — an asset
   * registered as declining-balance that is charged straight-line is wrong from
   * its first period and stays wrong for its whole life, and nothing in the
   * resulting numbers says so. `financeCalc.depreciationForPeriod` therefore
   * throws on a method it does not recognise rather than falling back.
   *
   * The accelerated methods need to know how far into its life the asset is,
   * which accumulated depreciation alone cannot say (a declining-balance asset
   * that has switched to straight-line, or one revalued part-way through, can
   * carry any accumulated figure at any age). It is measured from the
   * acquisition date to the period being charged.
   */
  static async runDepreciation(assetId, userId, periodDate = null, months = 1) {
    const assetResult = await pool.query('SELECT * FROM fixed_assets WHERE id = $1 AND deleted_at IS NULL', [assetId]);
    if (assetResult.rows.length === 0) throw new Error('Asset not found');
    const asset = assetResult.rows[0];

    if (asset.status !== 'ACTIVE') {
      return { skipped: true, reason: `Asset is ${asset.status}` };
    }

    const cost = Number(asset.acquisition_cost);
    const salvage = Number(asset.salvage_value);
    const depreciableBase = round2(cost - salvage);
    const accumulated = Number(asset.accumulated_depreciation);
    const remaining = round2(depreciableBase - accumulated);

    if (remaining <= 0) {
      await pool.query("UPDATE fixed_assets SET status = 'FULLY_DEPRECIATED' WHERE id = $1", [assetId]);
      return { skipped: true, reason: 'Already fully depreciated' };
    }

    const method = String(asset.depreciation_method || 'STRAIGHT_LINE').toUpperCase();
    const effectiveDate = periodDate || new Date().toISOString().split('T')[0];
    const elapsedMonths = calc.monthsBetween(asset.acquisition_date, effectiveDate);

    const amount = calc.depreciationForPeriod({
      method,
      cost,
      salvage,
      usefulLifeYears: asset.useful_life_years,
      accumulated,
      months,
      elapsedMonths,
      decliningFactor: asset.declining_balance_factor,
    });
    if (amount <= 0) return { skipped: true, reason: 'Zero depreciation' };

    const newAccumulated = round2(accumulated + amount);

    // Post GL: Dr Depreciation Expense (5260) / Cr Accumulated Depreciation (1220).
    // This MUST succeed — a depreciation run that updates the subsidiary ledger
    // but silently skips the GL posting corrupts the books (audit B11). Any
    // failure here (missing accounts, posting error) propagates and aborts.
    const accs = await pool.query(`
      SELECT id, account_code FROM chart_of_accounts
      WHERE account_code IN ('5260','1220') AND status = 'ACTIVE' AND deleted_at IS NULL
    `);
    const map = {};
    accs.rows.forEach((a) => { map[a.account_code] = a.id; });
    if (!map['5260'] || !map['1220']) {
      throw new Error('Cannot post depreciation: required GL accounts 5260 (Depreciation Expense) and/or 1220 (Accumulated Depreciation) are missing or inactive');
    }

    // The ledger entry and the asset register move together or not at all.
    // Posting outside this transaction leaves a journal entry with no
    // corresponding depreciation row whenever the update below fails.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const entry = await JournalEntry.create({
        entry_date: effectiveDate,
        source_type: 'DEPRECIATION',
        source_id: assetId,
        // One charge per asset per period, enforced by the database (migration
        // 138). There was previously nothing preventing the month-end job from
        // being run twice: the second run recomputed happily and posted a
        // second full month of expense, overstating depreciation and
        // understating profit with nothing to indicate it had happened. The
        // period is part of the key precisely so that next month still posts.
        posting_key: `DEPRECIATION:${assetId}:${periodKey(effectiveDate, months)}`,
        description: `Depreciation (${METHOD_LABELS[method] || method}) - ${asset.asset_number} ${asset.name}`,
        reference: asset.asset_number,
        requires_approval: false,
      }, [
        { account_id: map['5260'], debit_amount: amount, credit_amount: 0, description: `Depreciation expense (${months} month${months === 1 ? '' : 's'})` },
        { account_id: map['1220'], debit_amount: 0, credit_amount: amount, description: 'Accumulated depreciation' },
      ], userId, client);
      // Who signs the GL posting. The runner stays recorded as creator of the
      // entry (and of the fixed_asset_depreciation row) below; the POSTED
      // transition must carry a DIFFERENT identity, or checkSoD refuses the
      // self-posting and depreciation can never reach the ledger (blocker #4).
      // resolvePostingAuthority() returns the platform owner unless the runner
      // IS the owner (the deliberate SoD exception in services/authority.js).
      await JournalEntry.postAsSystem(entry.id, userId, 'Auto-posted depreciation', client);

      await client.query(`
        INSERT INTO fixed_asset_depreciation (asset_id, period_date, depreciation_amount, accumulated_after, journal_entry_id, created_by)
        VALUES ($1, COALESCE($2, CURRENT_DATE), $3, $4, $5, $6)
      `, [assetId, periodDate, amount, newAccumulated, entry.id, userId]);

      const fullyDepreciated = newAccumulated >= depreciableBase - 0.01;
      await client.query(`
        UPDATE fixed_assets
        SET accumulated_depreciation = $1,
            last_depreciation_date = COALESCE($2, CURRENT_DATE),
            status = $3,
            updated_by = $4,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $5
      `, [newAccumulated, periodDate, fullyDepreciated ? 'FULLY_DEPRECIATED' : 'ACTIVE', userId, assetId]);

      await client.query('COMMIT');
      return {
        amount,
        method,
        accumulated_after: newAccumulated,
        book_value_after: round2(cost - newAccumulated),
        fully_depreciated: fullyDepreciated,
        journal_entry_id: entry.id,
      };
    } catch (error) {
      await client.query('ROLLBACK');

      // The period was already charged — by a concurrent run, or by someone
      // running month-end twice. Not an error: the books are exactly as they
      // should be, and the transaction above rolled back cleanly, so nothing
      // was half-applied. Report it as skipped so a batch run over hundreds of
      // assets carries on instead of aborting on the first one already done.
      if (error.code === UNIQUE_VIOLATION) {
        return {
          skipped: true,
          reason: `Depreciation for this period has already been posted for ${asset.asset_number}.`,
        };
      }

      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The full remaining depreciation schedule for an asset, period by period,
   * without posting anything.
   *
   * Projected by replaying the same calculation the posting path uses, so the
   * forecast cannot drift from what will actually be charged.
   */
  static async schedule(assetId, { maxPeriods = 600 } = {}) {
    const { rows } = await pool.query(
      'SELECT * FROM fixed_assets WHERE id = $1 AND deleted_at IS NULL', [assetId]
    );
    if (!rows.length) throw new Error('Asset not found');
    const asset = rows[0];

    const cost = Number(asset.acquisition_cost);
    const salvage = Number(asset.salvage_value);
    const method = String(asset.depreciation_method || 'STRAIGHT_LINE').toUpperCase();
    const start = asset.last_depreciation_date || asset.acquisition_date;

    let accumulated = Number(asset.accumulated_depreciation);
    let cursor = new Date(start);
    const periods = [];

    for (let i = 0; i < maxPeriods; i += 1) {
      if (round2(cost - salvage - accumulated) <= 0) break;
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate());
      const periodDate = cursor.toISOString().split('T')[0];

      const amount = calc.depreciationForPeriod({
        method,
        cost,
        salvage,
        usefulLifeYears: asset.useful_life_years,
        accumulated,
        months: 1,
        elapsedMonths: calc.monthsBetween(asset.acquisition_date, periodDate),
        decliningFactor: asset.declining_balance_factor,
      });
      if (amount <= 0) break;

      accumulated = round2(accumulated + amount);
      periods.push({
        period_date: periodDate,
        depreciation_amount: amount,
        accumulated_after: accumulated,
        book_value_after: round2(cost - accumulated),
      });
    }

    return {
      asset: {
        id: asset.id,
        asset_number: asset.asset_number,
        name: asset.name,
        method,
        acquisition_cost: cost,
        salvage_value: salvage,
        useful_life_years: asset.useful_life_years,
        accumulated_depreciation: Number(asset.accumulated_depreciation),
      },
      periods,
      total_projected: round2(periods.reduce((s, p) => s + p.depreciation_amount, 0)),
    };
  }

  static async runDepreciationAll(userId, periodDate = null, months = 1) {
    const assets = await pool.query("SELECT id FROM fixed_assets WHERE deleted_at IS NULL AND status = 'ACTIVE'");
    const results = [];
    for (const row of assets.rows) {
      try {
        const r = await this.runDepreciation(row.id, userId, periodDate, months);
        results.push({ asset_id: row.id, ...r });
      } catch (err) {
        results.push({ asset_id: row.id, error: err.message });
      }
    }
    const posted = results.filter((r) => r.amount > 0);
    return {
      processed: results.length,
      posted: posted.length,
      total_depreciation: round2(posted.reduce((s, r) => s + Number(r.amount || 0), 0)),
      results,
    };
  }

  static async dispose(id, userId, reason = '', proceeds = 0, cashAccountCode = '1110') {
    const asset = await pool.query('SELECT * FROM fixed_assets WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (asset.rows.length === 0) throw new Error('Asset not found');
    const a = asset.rows[0];
    if (a.status === 'DISPOSED') throw new Error('Asset is already disposed');

    const cost = Number(a.acquisition_cost);
    const accumulated = Number(a.accumulated_depreciation);
    const bookValue = round2(cost - accumulated);
    const proceedsAmt = round2(Number(proceeds) || 0);
    const gain = proceedsAmt > bookValue ? round2(proceedsAmt - bookValue) : 0;
    const loss = bookValue > proceedsAmt ? round2(bookValue - proceedsAmt) : 0;

    // Post the disposal:
    //   Dr Accumulated Depreciation (1220)  accumulated
    //   Dr Cash (1110)                       proceeds
    //   Dr Loss on Disposal (5900)           loss (if any)
    //     Cr PP&E (1210)                     cost
    //     Cr Gain on Disposal (4900)         gain (if any)
    // The disposal GL posting MUST succeed — a disposal recorded in the asset
    // register with no ledger entry misstates both the asset and any gain/loss
    // (audit B11). Missing accounts or an unbalanced set is a hard error.
    let journalEntryId = null;
    const accs = await pool.query(`
      SELECT id, account_code FROM chart_of_accounts
      WHERE account_code IN ('1210','1220','4900','5900', $1) AND status = 'ACTIVE' AND deleted_at IS NULL
    `, [cashAccountCode]);
    const map = {};
    accs.rows.forEach((x) => { map[x.account_code] = x.id; });
    if (!map['1210'] || !map['1220']) {
      throw new Error('Cannot post asset disposal: account 1210 (PP&E) and/or 1220 (Accumulated Depreciation) missing or inactive');
    }
    if (proceedsAmt > 0 && !map[cashAccountCode]) {
      throw new Error(`Cannot post asset disposal: cash/receivable account ${cashAccountCode} missing or inactive`);
    }
    if (loss > 0 && !map['5900']) {
      throw new Error('Cannot post asset disposal: Loss on Disposal account (5900) missing or inactive');
    }
    if (gain > 0 && !map['4900']) {
      throw new Error('Cannot post asset disposal: Gain on Disposal account (4900) missing or inactive');
    }
    const items = [];
    if (accumulated > 0) items.push({ account_id: map['1220'], debit_amount: accumulated, credit_amount: 0, description: 'Remove accumulated depreciation' });
    if (proceedsAmt > 0) items.push({ account_id: map[cashAccountCode], debit_amount: proceedsAmt, credit_amount: 0, description: 'Disposal proceeds' });
    if (loss > 0) items.push({ account_id: map['5900'], debit_amount: loss, credit_amount: 0, description: 'Loss on disposal' });
    items.push({ account_id: map['1210'], debit_amount: 0, credit_amount: cost, description: 'Remove asset cost' });
    if (gain > 0) items.push({ account_id: map['4900'], debit_amount: 0, credit_amount: gain, description: 'Gain on disposal' });

    const dr = items.reduce((s, i) => s + Number(i.debit_amount), 0);
    const cr = items.reduce((s, i) => s + Number(i.credit_amount), 0);
    if (Math.abs(dr - cr) >= 0.01) {
      throw new Error(`Cannot post asset disposal: entry does not balance (Dr ${dr} vs Cr ${cr})`);
    }
    const entry = await JournalEntry.create({
      entry_date: new Date().toISOString().split('T')[0],
      source_type: 'FIXED_ASSET',
      source_id: id,
      description: `Asset disposal - ${a.asset_number} ${a.name}`,
      reference: a.asset_number,
      requires_approval: false,
    }, items, userId);
    await JournalEntry.postAsSystem(entry.id, userId, 'Auto-posted asset disposal');
    journalEntryId = entry.id;

    const result = await pool.query(`
      UPDATE fixed_assets
      SET status = 'DISPOSED',
          notes = COALESCE(notes || ' | ', '') || $2,
          updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [id, `Disposed (proceeds ${proceedsAmt}, ${gain ? 'gain ' + gain : 'loss ' + loss}): ${reason || 'n/a'}`, userId]);
    return { ...result.rows[0], disposal: { book_value: bookValue, proceeds: proceedsAmt, gain, loss, journal_entry_id: journalEntryId } };
  }

  /**
   * Revalue an asset to a new carrying amount (IAS 16 / IAS 36).
   *
   * The split between equity and profit is the whole of the accounting here,
   * and it is not symmetric — which is why it cannot be derived from the sign
   * of the adjustment alone:
   *
   *   An increase goes to the revaluation surplus in equity, EXCEPT to the
   *   extent it reverses an impairment previously charged to profit for this
   *   same asset. That part goes back through profit.
   *
   *   A decrease is charged against this asset's own accumulated revaluation
   *   surplus first, and only the excess becomes an impairment loss in profit.
   *
   * Both rules are per asset, against that asset's own history — which is what
   * `fixed_asset_revaluations` exists to record. Getting this wrong in the
   * common direction (routing every increase to income) lets a company report
   * profit by re-estimating things it already owns.
   */
  static async revalue(id, { revalued_amount, revaluation_date, basis }, userId) {
    const assetResult = await pool.query(
      'SELECT * FROM fixed_assets WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (assetResult.rows.length === 0) throw new Error('Asset not found');
    const a = assetResult.rows[0];

    if (a.status === 'DISPOSED') throw new Error('A disposed asset cannot be revalued.');

    const newAmount = round2(Number(revalued_amount));
    if (!(newAmount >= 0)) throw new Error('The revalued amount must be zero or more.');

    const cost = Number(a.acquisition_cost);
    const accumulated = Number(a.accumulated_depreciation);
    const carrying = round2(cost - accumulated);
    const adjustment = round2(newAmount - carrying);

    if (Math.abs(adjustment) < 0.01) {
      return { skipped: true, reason: 'The revalued amount matches the current carrying amount.', carrying_amount: carrying };
    }

    // This asset's own history decides the split.
    //
    // Both figures must be NET, not gross. Summing only the charges would let
    // an impairment be "reversed" more than once: charge 20k, reverse 15k, and
    // a gross reading still believes 20k is outstanding, so the next increase
    // routes another 20k through profit — recognising income that was never
    // lost. The same applies to surplus in the other direction.
    const history = await pool.query(
      `SELECT COALESCE(SUM(to_equity), 0)::float          AS surplus,
              COALESCE(SUM(to_profit_or_loss), 0)::float  AS profit_net
         FROM fixed_asset_revaluations WHERE asset_id = $1`,
      [id]
    );
    // Charges are negative and reversals positive, so a net negative is what
    // remains outstanding; a net positive means nothing is left to reverse.
    const priorSurplus = Math.max(0, round2(history.rows[0].surplus));
    const priorImpairment = Math.max(0, round2(-history.rows[0].profit_net));

    let toEquity = 0;
    let toProfit = 0;

    if (adjustment > 0) {
      // Reverse prior impairment through profit first, then equity.
      const reversal = Math.min(adjustment, priorImpairment);
      toProfit = round2(reversal);
      toEquity = round2(adjustment - reversal);
    } else {
      const decrease = Math.abs(adjustment);
      // Against this asset's own surplus first, then profit.
      const againstEquity = Math.min(decrease, priorSurplus);
      toEquity = round2(-againstEquity);
      toProfit = round2(-(decrease - againstEquity));
    }

    const date = revaluation_date || new Date().toISOString().split('T')[0];

    // Accounts. 3210 revaluation surplus (equity), 5850 impairment (expense),
    // 1210 PP&E, 4900 reused for the profit-side reversal of a prior
    // impairment, which is a gain rather than negative expense.
    //
    // 3210, not 3200: 3200 is Retained Earnings. A dedicated code is used
    // because 3200 already existed under every company's chart of accounts
    // before this feature was built, so crediting revaluation gains there
    // would commingle an unrealized IAS 16 reserve with realized,
    // distributable profit (found and fixed in the Fixed Assets §29 session —
    // migration 202608160100_fix_revaluation_surplus_account).
    const accs = await pool.query(`
      SELECT id, account_code FROM chart_of_accounts
       WHERE account_code IN ('1210','3210','5850','4900')
         AND status = 'ACTIVE' AND deleted_at IS NULL
    `);
    const map = {};
    accs.rows.forEach((x) => { map[x.account_code] = x.id; });
    if (!map['1210']) throw new Error('Cannot post revaluation: account 1210 (PP&E) is missing or inactive.');
    if (toEquity !== 0 && !map['3210']) {
      throw new Error('Cannot post revaluation: account 3210 (Revaluation Surplus) is missing or inactive.');
    }
    if (toProfit < 0 && !map['5850']) {
      throw new Error('Cannot post revaluation: account 5850 (Impairment Loss on Assets) is missing or inactive.');
    }
    if (toProfit > 0 && !map['4900']) {
      throw new Error('Cannot post revaluation: account 4900 (Gain on Disposal/Reversal) is missing or inactive.');
    }

    const items = [];
    if (adjustment > 0) {
      items.push({ account_id: map['1210'], debit_amount: adjustment, credit_amount: 0, description: 'Revaluation increase' });
      if (toProfit > 0) items.push({ account_id: map['4900'], debit_amount: 0, credit_amount: toProfit, description: 'Reversal of prior impairment' });
      if (toEquity > 0) items.push({ account_id: map['3210'], debit_amount: 0, credit_amount: toEquity, description: 'Revaluation surplus' });
    } else {
      if (toEquity < 0) items.push({ account_id: map['3210'], debit_amount: Math.abs(toEquity), credit_amount: 0, description: 'Reversal of revaluation surplus' });
      if (toProfit < 0) items.push({ account_id: map['5850'], debit_amount: Math.abs(toProfit), credit_amount: 0, description: 'Impairment loss' });
      items.push({ account_id: map['1210'], debit_amount: 0, credit_amount: Math.abs(adjustment), description: 'Revaluation decrease' });
    }

    const dr = items.reduce((s, i) => s + Number(i.debit_amount), 0);
    const cr = items.reduce((s, i) => s + Number(i.credit_amount), 0);
    if (Math.abs(dr - cr) >= 0.01) {
      throw new Error(`Cannot post revaluation: entry does not balance (Dr ${dr} vs Cr ${cr}).`);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const entry = await JournalEntry.create({
        entry_date: date,
        source_type: 'ASSET_REVALUATION',
        source_id: id,
        description: `Revaluation - ${a.asset_number} ${a.name}`,
        reference: a.asset_number,
        notes: basis || null,
        requires_approval: false,
      }, items, userId, client);
      await JournalEntry.postAsSystem(entry.id, userId, 'Auto-posted asset revaluation', client);

      await client.query(
        `INSERT INTO fixed_asset_revaluations
           (asset_id, revaluation_date, carrying_amount_before, revalued_amount, adjustment,
            to_equity, to_profit_or_loss, method, basis, journal_entry_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, date, carrying, newAmount, adjustment, toEquity, toProfit,
         adjustment < 0 && toProfit < 0 ? 'IMPAIRMENT' : 'REVALUATION',
         basis || null, entry.id, userId]
      );

      // The gross carrying amount carries the adjustment; accumulated
      // depreciation is left alone so the asset's depreciation history stays
      // intact and future charges are computed from the new value.
      const updated = await client.query(
        `UPDATE fixed_assets
            SET acquisition_cost = $2, updated_by = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 RETURNING *`,
        [id, round2(cost + adjustment), userId]
      );

      await client.query('COMMIT');
      return {
        ...updated.rows[0],
        revaluation: {
          carrying_amount_before: carrying,
          revalued_amount: newAmount,
          adjustment,
          to_equity: toEquity,
          to_profit_or_loss: toProfit,
          journal_entry_id: entry.id,
          explanation: adjustment > 0
            ? (toProfit > 0
                ? `Increase of ${adjustment}: ${toProfit} reverses impairment previously charged to profit, ${toEquity} to revaluation surplus.`
                : `Increase of ${adjustment} credited to revaluation surplus in equity, not to profit.`)
            : (toEquity < 0
                ? `Decrease of ${Math.abs(adjustment)}: ${Math.abs(toEquity)} charged against this asset's revaluation surplus, ${Math.abs(toProfit)} to impairment loss.`
                : `Decrease of ${Math.abs(adjustment)} charged to impairment loss — this asset has no revaluation surplus to absorb it.`),
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async revaluationHistory(assetId) {
    const { rows } = await pool.query(
      `SELECT r.*, je.journal_number
         FROM fixed_asset_revaluations r
         LEFT JOIN journal_entries je ON je.id = r.journal_entry_id
        WHERE r.asset_id = $1
        ORDER BY r.revaluation_date DESC, r.created_at DESC`,
      [assetId]
    );
    return rows;
  }
}

module.exports = FixedAsset;
