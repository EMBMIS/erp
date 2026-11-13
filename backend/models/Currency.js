const { pool } = require('../config/database');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Currency + exchange-rate engine. Rates are dated; getRate returns the most
 * recent rate on or before the requested date, trying the inverse rate when a
 * direct one is not available.
 */
class Currency {

  static async listCurrencies() {
    const result = await pool.query('SELECT * FROM currencies WHERE is_active = true ORDER BY is_base DESC, code ASC');
    return result.rows;
  }

  static async getBaseCurrency() {
    const result = await pool.query('SELECT code FROM currencies WHERE is_base = true LIMIT 1');
    return result.rows[0]?.code || 'USD';
  }

  static async addCurrency(data) {
    const result = await pool.query(`
      INSERT INTO currencies (code, name, symbol, is_active)
      VALUES ($1,$2,$3, COALESCE($4, true))
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, symbol = EXCLUDED.symbol, is_active = EXCLUDED.is_active, updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [data.code.toUpperCase(), data.name, data.symbol || null, data.is_active]);
    return result.rows[0];
  }

  static async listRates(filters = {}) {
    let query = `
      SELECT er.*, u.first_name || ' ' || u.last_name AS created_by_name
      FROM exchange_rates er
      LEFT JOIN users u ON er.created_by = u.id
      WHERE 1=1
    `;
    const values = [];
    if (filters.from) { values.push(filters.from.toUpperCase()); query += ` AND er.from_currency = $${values.length}`; }
    if (filters.to) { values.push(filters.to.toUpperCase()); query += ` AND er.to_currency = $${values.length}`; }
    query += ' ORDER BY er.rate_date DESC, er.from_currency, er.to_currency';
    if (filters.limit) { values.push(filters.limit); query += ` LIMIT $${values.length}`; }
    const result = await pool.query(query, values);
    return result.rows;
  }

  static async addRate(data, userId) {
    const from = data.from_currency.toUpperCase();
    const to = data.to_currency.toUpperCase();
    if (from === to) throw new Error('from and to currencies must differ');
    if (!(Number(data.rate) > 0)) throw new Error('rate must be positive');
    const result = await pool.query(`
      INSERT INTO exchange_rates (from_currency, to_currency, rate, rate_date, created_by)
      VALUES ($1,$2,$3, COALESCE($4, CURRENT_DATE), $5)
      ON CONFLICT (from_currency, to_currency, rate_date)
      DO UPDATE SET rate = EXCLUDED.rate, created_by = EXCLUDED.created_by
      RETURNING *
    `, [from, to, data.rate, data.rate_date || null, userId]);
    return result.rows[0];
  }

  // Most recent rate on or before `date` (default today). Tries inverse.
  static async getRate(from, to, date = null) {
    from = (from || '').toUpperCase();
    to = (to || '').toUpperCase();
    if (!from || !to) return null;
    if (from === to) return 1;

    const asOf = date || new Date().toISOString().split('T')[0];

    const direct = await pool.query(`
      SELECT rate FROM exchange_rates
      WHERE from_currency = $1 AND to_currency = $2 AND rate_date <= $3
      ORDER BY rate_date DESC LIMIT 1
    `, [from, to, asOf]);
    if (direct.rows.length > 0) return Number(direct.rows[0].rate);

    const inverse = await pool.query(`
      SELECT rate FROM exchange_rates
      WHERE from_currency = $1 AND to_currency = $2 AND rate_date <= $3
      ORDER BY rate_date DESC LIMIT 1
    `, [to, from, asOf]);
    if (inverse.rows.length > 0 && Number(inverse.rows[0].rate) > 0) {
      return 1 / Number(inverse.rows[0].rate);
    }
    return null;
  }

  static async convert(amount, from, to, date = null) {
    const rate = await this.getRate(from, to, date);
    if (rate == null) return { converted: null, rate: null, error: `No exchange rate for ${from}->${to}` };
    return { converted: round2(Number(amount) * rate), rate, from: from.toUpperCase(), to: to.toUpperCase(), amount: Number(amount) };
  }
}

module.exports = Currency;
