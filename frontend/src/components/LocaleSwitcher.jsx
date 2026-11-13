import React from 'react'
import { Globe, Building2 } from 'lucide-react'
import { useI18n } from '../contexts/I18nContext'
import { useCompany } from '../contexts/CompanyContext'

/**
 * Off until the translations are real.
 *
 * The i18n plumbing works, but the non-English locale tables are not
 * hand-translated yet, so offering the choice ships a half-translated UI —
 * worse than an English-only one, because the user has no way back except
 * guessing which entry in an unreadable list means "English". Flip this to
 * true per-locale once a human has actually gone through the strings.
 */
const LANGUAGE_SWITCHER_ENABLED = false

/**
 * Language picker. Renders nothing while the switcher is disabled, so the six
 * call sites (Layout, Login, Signup, ForgotPassword, ResetPassword) don't each
 * need to know about it.
 */
export function LanguageSwitcher({ className = '' }) {
  if (!LANGUAGE_SWITCHER_ENABLED) return null

  return <LanguagePicker className={className} />
}

/**
 * Each language is listed in its own script — someone who has landed on the
 * wrong language cannot read "Arabic" written in English, but they can read
 * "العربية". That is the whole reason native names exist in the locale table.
 *
 * Split out from LanguageSwitcher so the hooks below are never called while the
 * control is disabled, rather than running and having their result discarded.
 */
function LanguagePicker({ className }) {
  const { locale, setLocale, availableLocales, t } = useI18n()

  return (
    <label className={`inline-flex items-center gap-2 ${className}`}>
      <Globe className="h-4 w-4 text-gray-500" aria-hidden="true" />
      <span className="sr-only">{t('nav.settings')}</span>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value)}
        className="rounded-md border border-gray-300 bg-white py-1.5 ps-2 pe-8 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        {availableLocales.map((l) => (
          <option key={l.code} value={l.code}>{l.nativeName}</option>
        ))}
      </select>
    </label>
  )
}

/**
 * Off by product decision, not because it is unfinished.
 *
 * Unlike LANGUAGE_SWITCHER_ENABLED above, the company picker works — switching
 * re-scopes every query through the RLS company context. Turning it off means
 * a user who genuinely belongs to two companies has no way to reach the second
 * one, so flip this back on before onboarding a multi-entity customer.
 */
const COMPANY_SWITCHER_ENABLED = false

/**
 * Company picker. Hidden entirely while disabled; even when enabled it renders
 * nothing when there is only one company, rather than a disabled dropdown. A
 * control that cannot do anything still invites people to try it.
 */
export function CompanySwitcher({ className = '' }) {
  if (!COMPANY_SWITCHER_ENABLED) return null

  return <CompanyPicker className={className} />
}

function CompanyPicker({ className }) {
  const { companies, current, isMultiCompany, switchCompany } = useCompany()
  const { t } = useI18n()

  if (!isMultiCompany) return null

  return (
    <label className={`inline-flex items-center gap-2 ${className}`}>
      <Building2 className="h-4 w-4 text-gray-500" aria-hidden="true" />
      <span className="sr-only">{t('company.switchCompany')}</span>
      <select
        value={current?.id || ''}
        onChange={(e) => switchCompany(e.target.value)}
        className="rounded-md border border-gray-300 bg-white py-1.5 ps-2 pe-8 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.base_currency})
          </option>
        ))}
      </select>
    </label>
  )
}

export default LanguageSwitcher
