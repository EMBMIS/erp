import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useI18n } from '../contexts/I18nContext'
import { authAPI } from '../services/api'
import { useGoogleSignIn } from '../hooks/useGoogleSignIn'
import { getSafeRedirectUri } from '../utils/redirectAllowlist'
import { PublicShell, PublicHeader, PublicLoading, PasswordInput } from '../components/public/PublicPage'
import { Button, Field, Input, InlineNotice, useFieldValidation } from '../components/ui'
import toast from 'react-hot-toast'

/** The official four-colour Google "G", 18×18 at natural size. */
function GoogleG({ className = '' }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  )
}

function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const { login, loginWithGoogle, isAuthenticated, loading } = useAuth()
  const { t } = useI18n()
  const [isLoading, setIsLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [formData, setFormData] = useState({ email: '', password: '' })
  const [submitError, setSubmitError] = useState('')
  const [needsVerification, setNeedsVerification] = useState(false)
  const [resending, setResending] = useState(false)
  const [resent, setResent] = useState(false)

  // Set by embmis-web's "Log in" link (and by the ERP's own logged-out
  // deep-link redirects) so a successful sign-in lands back wherever the
  // user actually started — the landing page, or a specific ERP page —
  // instead of always going to the dashboard. getSafeRedirectUri rejects
  // anything off-origin (see its own comment) before this is ever used.
  const redirectUri = new URLSearchParams(location.search).get('redirect_uri')
  const completeLogin = useCallback(() => {
    const safe = getSafeRedirectUri(redirectUri)
    if (safe) {
      // Full navigation, not react-router's navigate(): the target may be a
      // different single-page app entirely (embmis-web), not a route within
      // this one, even though same-origin.
      window.location.assign(safe)
    } else {
      navigate('/')
    }
  }, [redirectUri, navigate])

  // Redirect to main page (or redirect_uri) if user is already authenticated
  useEffect(() => {
    if (isAuthenticated && !loading) {
      completeLogin()
    }
  }, [isAuthenticated, loading, completeLogin])

  const handleGoogleCredential = useCallback(async (credential) => {
    setIsLoading(true)
    setSubmitError('')
    try {
      const result = await loginWithGoogle(credential)
      if (result.success) {
        toast.success(t('ui.welcomeBackName', { name: result.user.first_name }))
        completeLogin()
      } else {
        setSubmitError(result.error)
      }
    } finally {
      setIsLoading(false)
    }
  }, [loginWithGoogle, completeLogin, t])

  const { buttonRef: googleButtonRef, wrapperRef: googleWrapperRef, enabled: googleSignInEnabled } = useGoogleSignIn({
    onCredential: handleGoogleCredential
  })

  const rules = useMemo(() => ({
    email: (v) => (!v ? `${t('ui.emailIsRequired')}. Enter the address you were invited with.`
      : !/\S+@\S+\.\S+/.test(v) ? `${t('ui.pleaseEnterAValidEmailAddress')}, like name@company.com.` : null),
    password: (v) => (!v ? t('ui.passwordIsRequired')
      : v.length < 6 ? t('ui.passwordMustBeAtLeast6Characters') : null),
  }), [t])
  const { errors, onBlur, validateAll } = useFieldValidation(formData, rules)

  const handleSubmit = async (e) => {
    e.preventDefault()
    const all = validateAll()
    if (Object.keys(all).length) {
      document.getElementById(Object.keys(all)[0])?.focus()
      return
    }

    setIsLoading(true)
    setNeedsVerification(false)
    setResent(false)
    setSubmitError('')
    try {
      const result = await login(formData)

      if (result.success) {
        toast.success(t('ui.welcomeBackName', { name: result.user.first_name }))
        completeLogin()
      } else {
        setSubmitError(result.error)
        if (result.code === 'EMAIL_NOT_VERIFIED') setNeedsVerification(true)
      }
    } catch (error) {
      console.error('Login error:', error)
      setSubmitError(t('ui.loginFailed'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleChange = (e) => {
    const { name, value } = e.target
    setFormData((prev) => ({ ...prev, [name]: value }))
    if (submitError) setSubmitError('')
  }

  const resend = async () => {
    setResending(true)
    try {
      await authAPI.resendVerification(formData.email)
      setResent(true)
    } catch {
      setSubmitError(t('ui.couldNotResendTryAgain'))
    } finally {
      setResending(false)
    }
  }

  if (loading) {
    return (
      <PublicShell width="narrow">
        <PublicLoading label={t('ui.loading')} />
      </PublicShell>
    )
  }

  return (
    <PublicShell width="narrow">
      <PublicHeader title={t('auth.signInTitle')} />

      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        {submitError && (
          <InlineNotice
            tone="risk"
            title={submitError}
            action={needsVerification ? (
              <Button size="sm" variant="secondary" onClick={resend} loading={resending}>
                {t('auth.resendVerificationEmail')}
              </Button>
            ) : null}
          >
            {needsVerification
              ? 'Open the verification link we emailed you, then sign in again.'
              : 'Check your email and password and try again. If you have forgotten your password, reset it.'}
          </InlineNotice>
        )}
        {resent && <InlineNotice tone="ok">{t('ui.verificationEmailSent')}</InlineNotice>}

        <Field label={t('auth.emailAddress')} error={errors.email} id="email">
          <Input
            name="email"
            type="email"
            size="lg"
            autoComplete="email"
            inputMode="email"
            value={formData.email}
            onChange={handleChange}
            onBlur={onBlur('email')}
          />
        </Field>

        <Field
          label={t('auth.password')}
          error={errors.password}
          id="password"
          labelAction={
            <Link to="/forgot-password" className="text-sm text-brand-600 underline-offset-2 hover:underline">
              {t('auth.forgotPassword')}
            </Link>
          }
        >
          <PasswordInput
            name="password"
            autoComplete="current-password"
            value={formData.password}
            onChange={handleChange}
            onBlur={onBlur('password')}
            shown={showPassword}
            onToggle={() => setShowPassword((s) => !s)}
            showLabel={t('ui.showPassword')}
            hideLabel={t('ui.hidePassword')}
          />
        </Field>

        <Button type="submit" variant="primary" size="lg" block loading={isLoading}>
          {isLoading ? t('auth.signingIn') : t('auth.signIn')}
        </Button>
      </form>

      {googleSignInEnabled && (
        <div className="mt-5">
          <div className="flex items-center gap-3 text-xs text-ink-500" aria-hidden="true">
            <span className="h-px flex-1 bg-ink-200" />
            or
            <span className="h-px flex-1 bg-ink-200" />
          </div>
          {/* The real Google button is rendered invisible on top of the branded
              one (same size, opacity-0), so a click anywhere opens Google's
              account chooser exactly like the official widget. GIS refuses to
              render wider than 400px; the hook clamps the measured width. */}
          <div ref={googleWrapperRef} className="relative mt-4 rounded-md focus-within:ring-[3px] focus-within:ring-brand-500/20">
            <button
              type="button"
              aria-label="Continue with Google"
              className="flex h-10 w-full items-center justify-center gap-3 rounded-md border border-ink-300 bg-surface text-sm font-medium text-fg hover:bg-ink-100"
            >
              <GoogleG className="h-[18px] w-[18px]" />
              Continue with Google
            </button>
            <div ref={googleButtonRef} className="absolute inset-0 opacity-0" />
          </div>
        </div>
      )}

      <p className="mt-6 text-center text-sm text-ink-600">
        {t('auth.newHere')}{' '}
        <Link to="/signup" className="font-medium text-brand-600 underline-offset-2 hover:underline">
          {t('auth.createCompany')}
        </Link>
      </p>

      {/*
        Dev builds only. import.meta.env.DEV is a compile-time constant: Vite
        substitutes false for production builds and the whole branch is dropped
        by dead-code elimination, so these literals are absent from the shipped
        bundle (they were removed from every locale table for the same reason).
      */}
      {import.meta.env.DEV && (
        <div className="mt-6 rounded-md border border-dashed border-ink-300 p-3 text-xs text-ink-600">
          <p className="font-medium">Demo credentials (dev only)</p>
          <p className="mt-1 font-mono">admin@qiraerp.com · admin123</p>
        </div>
      )}
    </PublicShell>
  )
}

export default Login
