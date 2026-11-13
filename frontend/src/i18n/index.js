/**
 * Translation and locale formatting.
 *
 * Written rather than pulled in from react-i18next, matching how the rest of
 * this codebase treats dependencies (the schedulers hand-roll intervals rather
 * than add a cron parser). What an ERP actually needs from i18n is lookup,
 * interpolation, plurals and Intl formatting — about 150 lines — and the
 * library's remaining surface is configuration this project would never use.
 *
 * ===========================================================================
 * THE RULE THAT MATTERS MOST
 * ===========================================================================
 *
 * A money amount is never formatted from the UI locale alone. Amount and
 * currency code always travel together, because the locale says how to write a
 * number and the currency says what the number *is*. Getting this wrong shows
 * a French user "1 234,56 $" for an amount that is actually euros — the digits
 * are right and the meaning is wrong, which is worse than an untranslated
 * string. `formatMoney` therefore requires an explicit currency and throws
 * rather than guessing one.
 */

// English is the only catalogue bundled with the app shell. It is the fallback
// for every missing key in every other language, so it has to be available
// synchronously on the very first render — a lazily-loaded fallback is not a
// fallback.
//
// The other 21 are fetched on demand. Bundling them all cost ~40 KB gzipped
// and rising, on an initial payload with a 200 KB budget, to ship 21 languages
// to every user so that one of them could be read. Each is now its own chunk
// pulled in when someone actually selects it.
import en from './locales/en.json';

// Vite turns this glob into one dynamic chunk per file. It has to be a literal
// — a computed `import('./locales/' + code + '.json')` gives the bundler
// nothing to statically analyse and silently ships nothing.
// en.json is excluded because it is imported statically above. Leaving it in
// makes Vite warn on every build that a module is both statically and
// dynamically imported, and the dynamic form would be dead code — English is
// already in the shell.
const loaders = import.meta.glob(['./locales/*.json', '!./locales/en.json']);

const catalogues = { 'en-US': en };

/**
 * Fetch a locale's catalogue, if it is not already in memory.
 *
 * Resolves to true when the requested locale is usable. A failed fetch (an
 * offline reload, a chunk evicted by a deploy) resolves false rather than
 * throwing: the caller falls back to English, which is already loaded, instead
 * of leaving the user on a blank screen because a translation did not arrive.
 */
export async function loadLocale(code) {
  const resolved = resolveLocale(code);
  if (catalogues[resolved]) return true;

  const file = `./locales/${resolved.split('-')[0]}.json`;
  const loader = loaders[file];
  if (!loader) return false;

  try {
    const mod = await loader();
    catalogues[resolved] = mod.default || mod;
    return true;
  } catch {
    return false;
  }
}

/** Whether a locale's messages are in memory right now. */
export const isLocaleLoaded = (code) => Boolean(catalogues[code]);

/**
 * Every locale the product ships in.
 *
 * `dir` is load-bearing, not decoration: Arabic, Urdu and Persian lay the whole
 * document out right-to-left, and a numeric column that does not flip with the
 * rest of the page reads as a broken table rather than a translated one. The
 * provider writes this onto <html dir> so CSS logical properties and the
 * browser's own bidi handling do the work, instead of every component
 * re-deciding.
 *
 * `nativeName` is what the switcher shows. A speaker looking for their own
 * language scans for "Азərbaycan dili", not for "Azerbaijani" — an endonym list
 * is findable by the people who need it, an English-exonym list is findable
 * only by people who already read English.
 */
export const LOCALES = {
  'en-US': { name: 'English',      nativeName: 'English',            dir: 'ltr' },
  'ar-SA': { name: 'Arabic',       nativeName: 'العربية',             dir: 'rtl' },
  'az-AZ': { name: 'Azerbaijani',  nativeName: 'Azərbaycan dili',    dir: 'ltr' },
  'bn-BD': { name: 'Bengali',      nativeName: 'বাংলা',                dir: 'ltr' },
  'de-DE': { name: 'German',       nativeName: 'Deutsch',            dir: 'ltr' },
  'es-ES': { name: 'Spanish',      nativeName: 'Español',            dir: 'ltr' },
  'fa-IR': { name: 'Persian',      nativeName: 'فارسی',               dir: 'rtl' },
  'fr-FR': { name: 'French',       nativeName: 'Français',           dir: 'ltr' },
  'hi-IN': { name: 'Hindi',        nativeName: 'हिन्दी',                dir: 'ltr' },
  'id-ID': { name: 'Indonesian',   nativeName: 'Bahasa Indonesia',   dir: 'ltr' },
  'it-IT': { name: 'Italian',      nativeName: 'Italiano',           dir: 'ltr' },
  'ja-JP': { name: 'Japanese',     nativeName: '日本語',              dir: 'ltr' },
  'ko-KR': { name: 'Korean',       nativeName: '한국어',               dir: 'ltr' },
  'nl-NL': { name: 'Dutch',        nativeName: 'Nederlands',         dir: 'ltr' },
  'pl-PL': { name: 'Polish',       nativeName: 'Polski',             dir: 'ltr' },
  'pt-BR': { name: 'Portuguese',   nativeName: 'Português',          dir: 'ltr' },
  'ru-RU': { name: 'Russian',      nativeName: 'Русский',            dir: 'ltr' },
  'tr-TR': { name: 'Turkish',      nativeName: 'Türkçe',             dir: 'ltr' },
  'uk-UA': { name: 'Ukrainian',    nativeName: 'Українська',         dir: 'ltr' },
  'ur-PK': { name: 'Urdu',         nativeName: 'اردو',                dir: 'rtl' },
  'vi-VN': { name: 'Vietnamese',   nativeName: 'Tiếng Việt',         dir: 'ltr' },
  'zh-CN': { name: 'Chinese',      nativeName: '中文',                dir: 'ltr' },
};

export const DEFAULT_LOCALE = 'en-US';
export const STORAGE_KEY = 'qira.locale';

/**
 * Resolve a requested locale to one that exists.
 *
 * Falls back by language before falling back to English, so a browser
 * reporting `ar-EG` gets Arabic rather than English. Region-only differences
 * are a far smaller error than the wrong language entirely.
 */
export function resolveLocale(requested) {
  if (!requested) return DEFAULT_LOCALE;
  if (LOCALES[requested]) return requested;

  const language = String(requested).split('-')[0].toLowerCase();
  const match = Object.keys(LOCALES).find((code) => code.split('-')[0].toLowerCase() === language);
  return match || DEFAULT_LOCALE;
}

function lookup(messages, key) {
  // Dotted keys index nested objects: 'nav.dashboard' -> messages.nav.dashboard
  return key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), messages);
}

/**
 * Translate `key`, substituting `{name}` placeholders from `values`.
 *
 * A missing key returns the key itself rather than an empty string. A blank
 * space in the UI is a bug someone has to hunt for; a visible `invoice.overdue`
 * says exactly what is missing and where.
 */
export function translate(locale, key, values = {}) {
  // Reads whatever is in memory. A locale whose chunk has not arrived yet
  // simply has no entry, and every key falls through to English for that one
  // render — the same path a partially-translated locale already takes.
  const active = catalogues[locale];

  let template = active ? lookup(active, key) : undefined;
  if (template === undefined && active && !key.includes('.')) {
    template = lookup(active, `ui2.${key}`) ?? lookup(active, `ui.${key}`);
  }

  // Fall back to English for a key this locale has not translated yet, so a
  // partial translation degrades to English rather than to raw key names.
  if (template === undefined) {
    const enCat = catalogues[DEFAULT_LOCALE];
    template = lookup(enCat, key);
    if (template === undefined && !key.includes('.')) {
      template = lookup(enCat, `ui2.${key}`) ?? lookup(enCat, `ui.${key}`);
    }
  }
  if (template === undefined) return key;

  // Plural forms: { "one": "...", "other": "..." } selected by `values.count`.
  if (template && typeof template === 'object') {
    const count = Number(values.count);
    const rule = Number.isFinite(count)
      ? new Intl.PluralRules(locale).select(count)
      : 'other';
    template = template[rule] ?? template.other ?? Object.values(template)[0] ?? key;
  }

  return String(template).replace(/\{(\w+)\}/g, (match, name) =>
    (values[name] !== undefined && values[name] !== null ? String(values[name]) : match));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a money amount.
 *
 * `currency` is required and has no default — see the header. A caller that
 * does not know the currency has a data problem, and defaulting to USD would
 * hide it behind a plausible-looking number.
 */
export function formatMoney(amount, currency, locale = DEFAULT_LOCALE, options = {}) {
  if (!currency) {
    throw new Error('formatMoney requires a currency code — an amount without one cannot be displayed correctly.');
  }
  if (amount === null || amount === undefined || amount === '') return '—';

  const value = Number(amount);
  if (!Number.isFinite(value)) return '—';

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: String(currency).toUpperCase(),
      ...options,
    }).format(value);
  } catch {
    // An unrecognised currency code still has to render something honest:
    // show the code beside the number rather than silently dropping it.
    return `${new Intl.NumberFormat(locale).format(value)} ${String(currency).toUpperCase()}`;
  }
}

export function formatNumber(value, locale = DEFAULT_LOCALE, options = {}) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(locale, options).format(n);
}

/**
 * Format a date.
 *
 * Date-only values (`2026-07-26`) are parsed as local rather than UTC. `new
 * Date('2026-07-26')` is UTC midnight, which renders as the 25th anywhere west
 * of Greenwich — an invoice date that moves by a day depending on who is
 * looking at it.
 */
export function formatDate(value, locale = DEFAULT_LOCALE, options = { dateStyle: 'medium' }) {
  if (!value) return '—';

  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`)
    : new Date(value);

  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, options).format(date);
}

export function formatDateTime(value, locale = DEFAULT_LOCALE) {
  return formatDate(value, locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatPercent(value, locale = DEFAULT_LOCALE, digits = 1) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  // Values arrive as percentages (12.5 meaning 12.5%), not fractions.
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n / 100);
}

/** Relative time ("3 days ago"), for activity feeds and audit trails. */
export function formatRelative(value, locale = DEFAULT_LOCALE) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units = [
    ['year', 31536000], ['month', 2592000], ['week', 604800],
    ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1],
  ];

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, secondsInUnit] of units) {
    if (Math.abs(seconds) >= secondsInUnit || unit === 'second') {
      return rtf.format(Math.round(seconds / secondsInUnit), unit);
    }
  }
  return '—';
}
