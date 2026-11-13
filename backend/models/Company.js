/**
 * Companies, and transactions between them.
 *
 * Intercompany posting is the part worth reading carefully. When entity A
 * charges entity B, both sets of books must move: A records a receivable from
 * B, B records a payable to A. Posting only one side is the classic failure —
 * it looks fine in the entity that posted, and the group stops consolidating
 * to a number that balances, usually noticed a quarter later.
 *
 * Both legs are therefore written in one database transaction. There is no
 * path here that commits one without the other.
 */

const { pool } = require('../config/database');
const JournalEntry = require('./JournalEntry');
const Currency = require('./Currency');
const companyContext = require('../services/companyContext');

const DUE_FROM = '1190';  // asset  — owed to us by another group company
const DUE_TO   = '2190';  // liability — owed by us to another group company

const Companies = {
  async findAll({ include_inactive = false } = {}) {
    const { rows } = await pool.query(
      `SELECT c.*, p.name AS parent_name,
              (SELECT COUNT(*)::int FROM user_companies uc WHERE uc.company_id = c.id) AS user_count
         FROM companies c
         LEFT JOIN companies p ON p.id = c.parent_company_id
        WHERE c.deleted_at IS NULL
          ${include_inactive ? '' : "AND c.status = 'ACTIVE'"}
        ORDER BY c.is_default DESC, c.name`
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query(
      'SELECT * FROM companies WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    return rows[0] || null;
  },

  /**
   * Create a company.
   *
   * The database refuses a second company unless isolation is genuinely in
   * force (migrations 110–112). That check is not repeated here — duplicating
   * it in application code invites the two copies to drift, and the one that
   * matters is the one the database enforces. This only translates the error
   * into something an administrator can act on.
   */
  async create(data, userId) {
    const { company_code, name, legal_name, base_currency, tax_number,
            registration_number, address_line1, address_line2, city, state,
            postal_code, country_code, locale, timezone,
            fiscal_year_start_month, parent_company_id } = data;

    if (!company_code || !String(company_code).trim()) throw new Error('A company needs a code.');
    if (!name || !String(name).trim()) throw new Error('A company needs a name.');

    const currency = (base_currency || 'USD').toUpperCase();
    const known = await pool.query('SELECT 1 FROM currencies WHERE code = $1', [currency]);
    if (!known.rows.length) {
      throw new Error(`Currency ${currency} is not set up. Add it before creating a company that keeps its books in it.`);
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO companies
           (company_code, name, legal_name, base_currency, tax_number, registration_number,
            address_line1, address_line2, city, state, postal_code, country_code,
            locale, timezone, fiscal_year_start_month, parent_company_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [String(company_code).trim().toUpperCase(), String(name).trim(), legal_name || name,
         currency, tax_number || null, registration_number || null,
         address_line1 || null, address_line2 || null, city || null, state || null,
         postal_code || null, country_code || null, locale || 'en-US', timezone || 'UTC',
         fiscal_year_start_month || 1, parent_company_id || null, userId]
      );
      companyContext.resetCache();
      return rows[0];
    } catch (error) {
      if (/Refusing to create a second company/.test(error.message)) {
        // Surface the database's own explanation — it is more precise about
        // which of the several preconditions is unmet than a generic message.
        throw new Error(error.message.replace(/^.*?ERROR:\s*/, ''));
      }
      throw error;
    }
  },

  async update(id, fields) {
    const allowed = ['name', 'legal_name', 'tax_number', 'registration_number',
                     'address_line1', 'address_line2', 'city', 'state', 'postal_code',
                     'country_code', 'locale', 'timezone', 'fiscal_year_start_month',
                     'parent_company_id', 'status'];
    const sets = [];
    const params = [id];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        params.push(fields[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) throw new Error('Nothing to update.');
    sets.push('updated_at = CURRENT_TIMESTAMP');

    // base_currency is deliberately not updatable. Changing the currency a
    // company keeps its books in does not convert the ledger already posted in
    // the old one; it just relabels it, silently misstating every prior
    // balance. The correct operation is a new company.
    const { rows } = await pool.query(
      `UPDATE companies SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      params
    );
    if (!rows.length) throw new Error('Company not found.');
    companyContext.resetCache();
    return rows[0];
  },

  async isolationStatus() {
    const { rows } = await pool.query('SELECT * FROM company_isolation_status()');
    return rows[0];
  },

  // --- User assignment ------------------------------------------------------

  async assignUser(userId, companyId, { role, is_primary } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO user_companies (user_id, company_id, role, is_primary)
       VALUES ($1,$2,$3,COALESCE($4,false))
       ON CONFLICT (user_id, company_id)
       DO UPDATE SET role = EXCLUDED.role, is_primary = EXCLUDED.is_primary
       RETURNING *`,
      [userId, companyId, role || null, is_primary]
    );
    if (is_primary) {
      await pool.query(
        'UPDATE user_companies SET is_primary = false WHERE user_id = $1 AND company_id <> $2',
        [userId, companyId]
      );
    }
    return rows[0];
  },

  async removeUser(userId, companyId) {
    await pool.query('DELETE FROM user_companies WHERE user_id = $1 AND company_id = $2',
      [userId, companyId]);
    return { removed: true };
  },
};

// ===========================================================================
// Intercompany
// ===========================================================================

const Intercompany = {
  /**
   * Post a transaction between two group companies.
   *
   * Books, in one transaction:
   *   From company:  Dr Due from Group (1190)   Cr <credit account>
   *   To   company:  Dr <debit account>          Cr Due to Group (2190)
   *
   * Where the companies keep their books in different currencies, each leg is
   * posted in its own company's currency at the rate for the transaction date.
   * Posting both legs at the same number would leave one entity's ledger
   * denominated in a currency it does not report in.
   */
  async post(data, userId) {
    const { from_company_id, to_company_id, amount, currency, transaction_type,
            transaction_date, description, from_credit_account_code,
            to_debit_account_code } = data;

    if (!from_company_id || !to_company_id) throw new Error('Both companies are required.');
    if (from_company_id === to_company_id) throw new Error('A company cannot transact with itself.');
    const amt = Number(amount);
    if (!(amt > 0)) throw new Error('Amount must be positive.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const companies = await client.query(
        'SELECT id, company_code, name, base_currency, parent_company_id FROM companies WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
        [[from_company_id, to_company_id]]
      );
      if (companies.rows.length !== 2) throw new Error('One or both companies were not found.');
      const from = companies.rows.find((c) => c.id === from_company_id);
      const to = companies.rows.find((c) => c.id === to_company_id);

      // Intercompany posting is only meaningful between entities that actually
      // consolidate together — parent/subsidiary or siblings under the same
      // parent. Without this check any two unrelated companies in the system
      // could book a "due from / due to" pair against each other, which is not
      // an intercompany balance at all, just two unrelated ledgers pretending
      // to be one group.
      const linked = from.id === to.parent_company_id
        || to.id === from.parent_company_id
        || (from.parent_company_id && from.parent_company_id === to.parent_company_id);
      if (!linked) {
        throw new Error(
          `${from.name} and ${to.name} are not linked (neither is the other's parent, and they do not share a parent). `
          + 'Set parent_company_id to relate them before posting an intercompany transaction.'
        );
      }

      const txnCurrency = (currency || from.base_currency).toUpperCase();
      const txnDate = transaction_date || new Date().toISOString().split('T')[0];

      const accounts = await resolveAccounts(client, {
        from_credit_account_code, to_debit_account_code,
      });

      const reference = (await client.query('SELECT generate_intercompany_reference() AS r')).rows[0].r;

      const record = await client.query(
        `INSERT INTO intercompany_transactions
           (reference, from_company_id, to_company_id, transaction_type, amount, currency,
            transaction_date, description, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9) RETURNING *`,
        [reference, from_company_id, to_company_id, transaction_type || 'TRANSFER',
         amt, txnCurrency, txnDate,
         description || `Intercompany ${transaction_type || 'transfer'}: ${from.name} → ${to.name}`,
         userId]
      );

      const fromAmount = await convertFor(from.base_currency, txnCurrency, amt, txnDate);
      const toAmount = await convertFor(to.base_currency, txnCurrency, amt, txnDate);

      const label = `${reference} ${from.company_code}→${to.company_code}`;

      // Leg 1, in the lending/charging company.
      const fromEntry = await postLeg(client, from_company_id, {
        entry_date: txnDate,
        source_type: 'INTERCOMPANY',
        source_id: record.rows[0].id,
        description: `Intercompany due from ${to.name} — ${label}`,
        reference,
        currency: from.base_currency,
        items: [
          { account_id: accounts.dueFrom, debit_amount: fromAmount, credit_amount: 0,
            description: `Due from ${to.name}` },
          { account_id: accounts.fromCredit, debit_amount: 0, credit_amount: fromAmount,
            description: description || `Charge to ${to.name}` },
        ],
      }, userId);

      // Leg 2, in the receiving company.
      const toEntry = await postLeg(client, to_company_id, {
        entry_date: txnDate,
        source_type: 'INTERCOMPANY',
        source_id: record.rows[0].id,
        description: `Intercompany due to ${from.name} — ${label}`,
        reference,
        currency: to.base_currency,
        items: [
          { account_id: accounts.toDebit, debit_amount: toAmount, credit_amount: 0,
            description: description || `Charge from ${from.name}` },
          { account_id: accounts.dueTo, debit_amount: 0, credit_amount: toAmount,
            description: `Due to ${from.name}` },
        ],
      }, userId);

      const final = await client.query(
        `UPDATE intercompany_transactions
            SET from_journal_entry_id = $2, to_journal_entry_id = $3,
                status = 'POSTED', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 RETURNING *`,
        [record.rows[0].id, fromEntry.id, toEntry.id]
      );

      await client.query('COMMIT');
      return {
        ...final.rows[0],
        from_company: from.name,
        to_company: to.name,
        from_amount: fromAmount,
        to_amount: toAmount,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async findAll({ company_id, status, from_date, to_date, limit = 100 } = {}) {
    const params = [];
    let where = 'WHERE 1=1';

    if (company_id) {
      params.push(company_id);
      where += ` AND (it.from_company_id = $${params.length} OR it.to_company_id = $${params.length})`;
    }
    if (status) { params.push(status); where += ` AND it.status = $${params.length}`; }
    if (from_date) { params.push(from_date); where += ` AND it.transaction_date >= $${params.length}`; }
    if (to_date) { params.push(to_date); where += ` AND it.transaction_date <= $${params.length}`; }

    params.push(Math.min(Number(limit) || 100, 500));
    const { rows } = await pool.query(
      `SELECT it.*, fc.name AS from_company_name, fc.company_code AS from_company_code,
              tc.name AS to_company_name, tc.company_code AS to_company_code
         FROM intercompany_transactions it
         JOIN companies fc ON fc.id = it.from_company_id
         JOIN companies tc ON tc.id = it.to_company_id
         ${where}
         ORDER BY it.transaction_date DESC, it.created_at DESC
         LIMIT $${params.length}`,
      params
    );
    return rows;
  },

  /**
   * Intercompany balances that have not been eliminated.
   *
   * On consolidation these must cancel: what A shows as due from B should equal
   * what B shows as due to A. Where they do not, the difference is reported
   * rather than hidden — an unexplained intercompany difference is the single
   * most common reason a group balance sheet fails to balance, and burying it
   * makes it take weeks to find.
   */
  async reconciliation({ as_of } = {}) {
    const asOf = as_of || new Date().toISOString().split('T')[0];

    const { rows } = await pool.query(
      `SELECT it.from_company_id, it.to_company_id,
              fc.name AS from_company_name, tc.name AS to_company_name,
              COUNT(*)::int AS transaction_count,
              COALESCE(SUM(it.amount), 0)::float AS total_amount,
              it.currency
         FROM intercompany_transactions it
         JOIN companies fc ON fc.id = it.from_company_id
         JOIN companies tc ON tc.id = it.to_company_id
        WHERE it.status = 'POSTED'
          AND it.transaction_date <= $1
        GROUP BY it.from_company_id, it.to_company_id, fc.name, tc.name, it.currency
        ORDER BY fc.name, tc.name`,
      [asOf]
    );

    // Net each pair against its mirror so A→B and B→A offset.
    const pairs = new Map();
    for (const r of rows) {
      const key = [r.from_company_id, r.to_company_id].sort().join('|');
      if (!pairs.has(key)) {
        pairs.set(key, { companies: [r.from_company_name, r.to_company_name], currency: r.currency, net: 0, gross: 0, transaction_count: 0 });
      }
      const p = pairs.get(key);
      const forward = r.from_company_id < r.to_company_id ? 1 : -1;
      p.net += forward * r.total_amount;
      p.gross += r.total_amount;
      p.transaction_count += r.transaction_count;
    }

    const balances = [...pairs.values()].map((p) => ({
      ...p,
      net: Number(p.net.toFixed(2)),
      gross: Number(p.gross.toFixed(2)),
    }));

    return {
      as_of: asOf,
      balances,
      total_to_eliminate: Number(balances.reduce((s, b) => s + Math.abs(b.net), 0).toFixed(2)),
      note: balances.length === 0
        ? 'There are no posted intercompany transactions to eliminate.'
        : 'Each net balance must be eliminated on consolidation; it represents money the group owes itself.',
    };
  },

  /**
   * Mark transactions as eliminated for a consolidation period.
   *
   * Recorded rather than deleted: the entries stay in each entity's own books,
   * which is correct — elimination happens at the group level, not by editing a
   * subsidiary's ledger.
   */
  async markEliminated(ids, period, userId) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('No transactions given.');
    if (!/^\d{4}-\d{2}$/.test(period || '')) throw new Error('Period must look like YYYY-MM.');

    const { rows } = await pool.query(
      `UPDATE intercompany_transactions
          SET status = 'ELIMINATED', eliminated_at = CURRENT_TIMESTAMP,
              eliminated_in_period = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = ANY($1::uuid[]) AND status = 'POSTED'
        RETURNING id, reference`,
      [ids, period]
    );
    return { eliminated: rows.length, references: rows.map((r) => r.reference) };
  },
};

// --- helpers ----------------------------------------------------------------

async function resolveAccounts(client, { from_credit_account_code, to_debit_account_code }) {
  const wanted = [DUE_FROM, DUE_TO,
                  from_credit_account_code || '4100',
                  to_debit_account_code || '5900'];

  const { rows } = await client.query(
    `SELECT id, account_code FROM chart_of_accounts
      WHERE account_code = ANY($1) AND status = 'ACTIVE' AND deleted_at IS NULL`,
    [wanted]
  );
  const map = Object.fromEntries(rows.map((r) => [r.account_code, r.id]));

  const missing = wanted.filter((c) => !map[c]);
  if (missing.length) {
    throw new Error(`Cannot post intercompany entry: account(s) ${missing.join(', ')} are missing or inactive.`);
  }

  return {
    dueFrom: map[DUE_FROM],
    dueTo: map[DUE_TO],
    fromCredit: map[from_credit_account_code || '4100'],
    toDebit: map[to_debit_account_code || '5900'],
  };
}

/**
 * Post one leg in a specific company.
 *
 * The company is written onto the entry explicitly rather than relying on the
 * column default, because this is the one place in the system that deliberately
 * writes outside the caller's own company: the second leg belongs to the other
 * entity. Under isolation that write is only possible because both legs are
 * posted by an operation the user holds rights in both companies for.
 */
async function postLeg(client, companyId, { items, ...entryData }, userId) {
  const entry = await JournalEntry.create(entryData, items, userId, client);
  await client.query('UPDATE journal_entries SET company_id = $2 WHERE id = $1',
    [entry.id, companyId]);
  await JournalEntry.postAsSystem(entry.id, userId, 'Intercompany posting', client);
  return entry;
}

async function convertFor(companyCurrency, txnCurrency, amount, date) {
  if (!companyCurrency || companyCurrency.toUpperCase() === txnCurrency.toUpperCase()) {
    return Number(amount.toFixed ? amount.toFixed(2) : amount);
  }
  const result = await Currency.convert(amount, txnCurrency, companyCurrency, date);
  if (result.converted == null) {
    throw new Error(
      `No exchange rate for ${txnCurrency}→${companyCurrency} on ${date}. Add the rate before posting, so the entry is not booked at an assumed value.`
    );
  }
  return result.converted;
}

module.exports = { Companies, Intercompany, DUE_FROM, DUE_TO };
