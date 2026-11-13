import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react'
import {
  LOCALES, DEFAULT_LOCALE, STORAGE_KEY, resolveLocale, translate, loadLocale, isLocaleLoaded,
  formatMoney, formatNumber, formatDate, formatDateTime, formatPercent, formatRelative,
} from '../i18n'

/**
 * Locale, translation and formatting for the whole app.
 *
 * Two things this provider owns that individual components must not decide for
 * themselves:
 *
 *   Text direction. Switching to Arabic sets `dir="rtl"` on <html>, which flips
 *   the entire layout through CSS logical properties rather than through each
 *   component checking the language. A component that hardcodes `margin-left`
 *   breaks in RTL; one that uses `margin-inline-start` does not.
 *
 *   Currency. `money()` takes an explicit currency code because a number's
 *   locale and its currency are different facts — see the note in i18n/index.js.
 *   The company's base currency is exposed as a *fallback for new input*, never
 *   as an assumption about existing data: an invoice raised in EUR stays EUR
 *   however the viewer's company is configured.
 */

const I18nContext = createContext(null)

export const useI18n = () => {
  const context = useContext(I18nContext)
  if (!context) {
    throw new Error('useI18n must be used within an I18nProvider')
  }
  return context
}

function detectInitialLocale() {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && LOCALES[stored]) return stored
  return resolveLocale(navigator.language || DEFAULT_LOCALE)
}

export const I18nProvider = ({ children, companyCurrency = null, companyLocale = null }) => {
  const [locale, setLocaleState] = useState(detectInitialLocale)

  // Message catalogues other than English arrive as their own chunk. This
  // counter exists only to force a re-render once one lands — translate() is
  // synchronous and falls back to English until then, so nothing blocks and
  // nothing flashes a raw key.
  //
  // It MUST be a dependency of the context value below. Bumping state
  // re-renders this provider, but the value it hands down is memoised: without
  // the counter in the deps the memo returns the identical object, React sees
  // an unchanged context and skips every consumer, and the app sits in English
  // with the correct locale set on <html>. That is exactly how this first went
  // wrong — the language switched everywhere except the words.
  const [catalogueTick, setCatalogueTick] = useState(0)

  useEffect(() => {
    if (isLocaleLoaded(locale)) return
    let cancelled = false
    loadLocale(locale).then(() => { if (!cancelled) setCatalogueTick((n) => n + 1) })
    return () => { cancelled = true }
  }, [locale])

  // A company's configured locale applies only when the user has not chosen
  // one. An explicit choice outranks configuration — someone who picked English
  // in a Spanish subsidiary meant it.
  useEffect(() => {
    if (!companyLocale) return
    if (localStorage.getItem(STORAGE_KEY)) return
    setLocaleState(resolveLocale(companyLocale))
  }, [companyLocale])

  const dir = LOCALES[locale]?.dir || 'ltr'

  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = dir
  }, [locale, dir])

  // Fetch the catalogue BEFORE switching. Flipping the locale first would
  // render the whole app in English for one frame and then repaint in the
  // chosen language — a visible flash on every switch. The chunk is a few KB;
  // waiting for it is imperceptible, and the repaint is not.
  const setLocale = useCallback(async (next) => {
    const resolved = resolveLocale(next)
    localStorage.setItem(STORAGE_KEY, resolved)
    await loadLocale(resolved)
    setLocaleState(resolved)
  }, [])

  const value = useMemo(() => ({
    locale,
    dir,
    isRtl: dir === 'rtl',
    setLocale,
    availableLocales: Object.entries(LOCALES).map(([code, meta]) => ({
      code, name: meta.name, nativeName: meta.nativeName, dir: meta.dir,
    })),

    t: (key, values) => translate(locale, key, values),

    /**
     * Format money. `currency` falls back to the company's base currency only
     * when the caller genuinely has no currency to pass — which should be rare,
     * since every amount stored by this system is stored beside its currency.
     */
    money: (amount, currency, options) =>
      formatMoney(amount, currency || companyCurrency, locale, options),

    number: (value, options) => formatNumber(value, locale, options),
    date: (value, options) => formatDate(value, locale, options),
    dateTime: (value) => formatDateTime(value, locale),
    percent: (value, digits) => formatPercent(value, locale, digits),
    relative: (value) => formatRelative(value, locale),
  }), [locale, dir, setLocale, companyCurrency, catalogueTick])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export default I18nContext
