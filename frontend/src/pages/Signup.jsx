import React, { useState, useEffect, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { authAPI, companyModulesAPI } from '../services/api'
import { useResource } from '../hooks/useResource'
import { PublicShell, PublicHeader, PublicMessage, PasswordInput } from '../components/public/PublicPage'
import { Button, Field, Input, Select, Textarea, InlineNotice, ErrorSummary, useFieldValidation } from '../components/ui'
import toast from 'react-hot-toast'
import { useI18n } from '../contexts/I18nContext'

const FIELD_ORDER = ['first_name', 'last_name', 'email', 'password', 'company_name']

function Signup() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { registerCompany, isAuthenticated, loading } = useAuth()
  const [isLoading, setIsLoading] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [suggestion, setSuggestion] = useState(null) // { ok, text }
  const [showPassword, setShowPassword] = useState(false)
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', password: '',
    company_name: '', business_description: '', business_type_code: '',
  })
  const [submitError, setSubmitError] = useState('')
  const [summary, setSummary] = useState({})
  // Set once signup succeeds but the account still needs email verification —
  // switches the page to a "check your inbox" panel instead of the form.
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState(null)
  const [resending, setResending] = useState(false)
  const [resendNote, setResendNote] = useState(null)

  useEffect(() => {
    if (isAuthenticated && !loading) navigate('/')
  }, [isAuthenticated, loading, navigate])

  // Best-effort list; the field still works (empty) if it fails.
  const { data: businessTypesRaw } = useResource(
    ['public-business-types'],
    () => companyModulesAPI.listBusinessTypes(),
    { retry: false, staleTime: 5 * 60 * 1000 }
  )
  const businessTypes = Array.isArray(businessTypesRaw) ? businessTypesRaw : []

  const rules = useMemo(() => ({
    first_name: (v) => (!v?.trim() ? 'Enter your first name.' : null),
    last_name: (v) => (!v?.trim() ? 'Enter your last name.' : null),
    email: (v) => (!/\S+@\S+\.\S+/.test(v || '') ? `${t('ui.pleaseEnterAValidEmailAddress')}, like name@company.com.` : null),
    password: (v) => ((v || '').length < 6 ? `${t('ui.passwordMustBeAtLeast6Characters')}.` : null),
    company_name: (v) => (!v?.trim() ? 'Enter the name your company trades under.' : null),
  }), [t])
  const { errors, onBlur, validateAll } = useFieldValidation(form, rules)

  const handleChange = (e) => {
    const { name, value } = e.target
    setForm((prev) => ({ ...prev, [name]: value }))
    if (submitError) setSubmitError('')
  }

  const requestSuggestion = async () => {
    if (!form.business_description.trim()) return
    setSuggesting(true)
    setSuggestion(null)
    try {
      const res = await authAPI.suggestBusinessType(form.business_description)
      const s = res.data?.data
      if (s) {
        setForm((prev) => ({ ...prev, business_type_code: s.code }))
        setSuggestion({ ok: true, text: t('ui.suggestedBusinessType', { name: s.name }) })
      } else {
        setSuggestion({ ok: false, text: t('ui.noSuggestionPickManually') })
      }
    } catch {
      setSuggestion({ ok: false, text: t('ui.noSuggestionPickManually') })
    } finally {
      setSuggesting(false)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const all = validateAll()
    const ordered = Object.fromEntries(FIELD_ORDER.filter((k) => all[k]).map((k) => [k, all[k]]))
    setSummary(ordered)
    if (Object.keys(ordered).length) return
    setIsLoading(true)
    setSubmitError('')
    try {
      const result = await registerCompany(form)
      if (result.success) {
        if (result.requiresVerification) {
          setPendingVerificationEmail(result.email)
        } else {
          toast.success(t('ui.welcomeToQira', { name: result.user.first_name }))
          navigate('/')
        }
      } else {
        setSubmitError(result.error)
      }
    } finally {
      setIsLoading(false)
    }
  }

  const handleResend = async () => {
    if (!pendingVerificationEmail) return
    setResending(true)
    setResendNote(null)
    try {
      await authAPI.resendVerification(pendingVerificationEmail)
      setResendNote({ tone: 'ok', text: t('ui.verificationEmailSent') })
    } catch {
      setResendNote({ tone: 'risk', text: t('ui.couldNotResendTryAgain') })
    } finally {
      setResending(false)
    }
  }

  if (loading) return null

  if (pendingVerificationEmail) {
    return (
      <PublicShell width="narrow">
        <PublicMessage
          tone="ok"
          title={t('ui.checkYourEmail')}
          action={
            <>
              <Button variant="secondary" size="lg" onClick={handleResend} loading={resending}>
                {"Didn't get it? Resend"}
              </Button>
              <Button variant="primary" size="lg" to="/login">{t('ui.goToSignIn')}</Button>
            </>
          }
        >
          <p>
            We sent a verification link to <span className="font-medium text-fg">{pendingVerificationEmail}</span>.
            Open it to activate your account, then sign in.
          </p>
          <p className="text-xs text-ink-500">{t('ui.yourFree30DayTrialStarts')}</p>
          {resendNote && <InlineNotice tone={resendNote.tone} className="text-left">{resendNote.text}</InlineNotice>}
        </PublicMessage>
      </PublicShell>
    )
  }

  return (
    <PublicShell width="narrow">
      <PublicHeader title={t('ui.createYourCompany')} description={t('ui.setUpYourOwnWorkspaceTakes')} />

      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        <ErrorSummary errors={summary} title="Fix these to create your company" />
        {submitError && (
          <InlineNotice tone="risk" title={submitError}>
            Check the details above and try again. If you already have an account, <Link to="/login" className="underline">sign in</Link> instead.
          </InlineNotice>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('ui.firstName')} error={errors.first_name} id="first_name">
            <Input name="first_name" size="lg" autoComplete="given-name" value={form.first_name} onChange={handleChange} onBlur={onBlur('first_name')} />
          </Field>
          <Field label={t('ui.lastName')} error={errors.last_name} id="last_name">
            <Input name="last_name" size="lg" autoComplete="family-name" value={form.last_name} onChange={handleChange} onBlur={onBlur('last_name')} />
          </Field>
        </div>

        <Field label={t('ui.workEmail')} error={errors.email} id="email">
          <Input name="email" type="email" size="lg" autoComplete="email" inputMode="email" value={form.email} onChange={handleChange} onBlur={onBlur('email')} />
        </Field>

        <Field label="Password" error={errors.password} help="At least 6 characters." id="password">
          <PasswordInput
            name="password"
            autoComplete="new-password"
            value={form.password}
            onChange={handleChange}
            onBlur={onBlur('password')}
            shown={showPassword}
            onToggle={() => setShowPassword((s) => !s)}
          />
        </Field>

        <Field label={t('ui.companyName')} error={errors.company_name} id="company_name">
          <Input name="company_name" size="lg" autoComplete="organization" value={form.company_name} onChange={handleChange} onBlur={onBlur('company_name')} />
        </Field>

        <Field
          label={t('ui.whatDoesYourBusinessDo')}
          optional
          id="business_description"
          help="Used to suggest a business type, which sets up the modules you start with."
        >
          <Textarea
            name="business_description"
            value={form.business_description}
            onChange={handleChange}
            rows={2}
            placeholder={t('ui.eGWeManufactureAndSell')}
          />
        </Field>

        <div className="space-y-2">
          <Field label={t('ui.businessType2')} optional id="business_type_code">
            <Select name="business_type_code" size="lg" value={form.business_type_code} onChange={handleChange}>
              <option value="">{t('ui.selectABusinessType')}</option>
              {businessTypes.map((bt) => (
                <option key={bt.code} value={bt.code}>{bt.name}</option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={requestSuggestion}
              loading={suggesting}
              disabled={!form.business_description.trim()}
              title={!form.business_description.trim() ? 'Describe your business above first' : undefined}
            >
              {suggesting ? t('ui.thinking') : t('ui.suggestABusinessType')}
            </Button>
            {suggestion && (
              <span role="status" className={suggestion.ok ? 'text-xs text-ok-700' : 'text-xs text-ink-600'}>{suggestion.text}</span>
            )}
          </div>
        </div>

        <Button type="submit" variant="primary" size="lg" block loading={isLoading}>
          {isLoading ? t('ui.creatingYourCompany') : t('ui.createCompany')}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-600">
        {t('ui.alreadyHaveAnAccount')}{' '}
        <Link to="/login" className="font-medium text-brand-600 underline-offset-2 hover:underline">
          {t('ui.signIn2')}
        </Link>
      </p>
    </PublicShell>
  )
}

export default Signup
