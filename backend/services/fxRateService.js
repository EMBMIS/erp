/**
 * FX Rate Service — daily exchange rate sync.
 *
 * Pulls real, live rates from Frankfurter (https://www.frankfurter.dev), a
 * free ECB-rate mirror that needs no API key. Writes them into the
 * `exchange_rates` table (date-keyed, unique on from/to/date) via the
 * Currency model — the same table intercompanyService.js's FX translation
 * and Currency.convert()/getRate() already read. There used to be a second,
 * disconnected path here that wrote a hardcoded rate table into a
 * `currencies.exchange_rate` column that does not exist on this schema (the
 * UPDATE silently no-opped, caught and swallowed, while the function still
 * reported success) — nothing downstream ever read it. Any book kept in a
 * non-USD currency was translating against those hardcoded, frozen numbers,
 * silently, indefinitely.
 */

const Currency = require('../models/Currency');

const FRANKFURTER_URL = 'https://api.frankfurter.app/latest';

class FXRateService {
  /**
   * Fetch today's live rates from baseCurrency to every OTHER currency this
   * install actually has configured (currencies.is_active = true), and
   * record them. Currencies this install doesn't track, or that the feed
   * doesn't cover, are skipped rather than guessed at or invented.
   */
  static async syncCentralBankRates(baseCurrency = 'USD', userId = null) {
    const base = String(baseCurrency).toUpperCase();
    const tracked = await Currency.listCurrencies();
    const targets = new Set(tracked.map((c) => c.code).filter((c) => c !== base));

    let liveRates;
    const source = 'frankfurter';
    try {
      const res = await fetch(`${FRANKFURTER_URL}?from=${encodeURIComponent(base)}`);
      if (!res.ok) throw new Error(`Frankfurter responded ${res.status}`);
      const body = await res.json();
      liveRates = body.rates || {};
    } catch (error) {
      throw new Error(`FX rate sync failed: could not reach the exchange rate feed (${error.message}). No rates were changed.`);
    }

    const updated = [];
    const skipped = [];
    for (const code of targets) {
      const rate = liveRates[code];
      if (rate == null) {
        skipped.push(code);
        continue;
      }
      const saved = await Currency.addRate(
        { from_currency: base, to_currency: code, rate, rate_date: new Date().toISOString().split('T')[0] },
        userId
      );
      updated.push(saved);
    }

    return {
      success: true,
      source,
      base_currency: base,
      synced_at: new Date().toISOString(),
      updated_count: updated.length,
      rates: updated,
      skipped, // tracked currencies the feed had no rate for — not an error, just not covered
    };
  }
}

module.exports = FXRateService;
