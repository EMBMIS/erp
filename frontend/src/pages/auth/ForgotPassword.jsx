import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { authAPI } from '../../services/api'
import { useI18n } from '../../contexts/I18nContext'
import { PublicShell, PublicHeader, PublicMessage } from '../../components/public/PublicPage'
import { Button, Field, Input, InlineNotice, useFieldValidation } from '../../components/ui'

function ForgotPassword() {
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [submitError, setSubmitError] = useState('')

  const values = useMemo(() => ({ email }), [email])
  const rules = useMemo(() => ({
    email: (v) => (!v ? 'Enter the email address you sign in with.'
      : !/\S+@\S+\.\S+/.test(v) ? 'Enter a full email address, like name@company.com.' : null),
  }), [])
  const { errors, onBlur, validateAll } = useFieldValidation(values, rules)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (validateAll().email) {
      document.getElementById('email')?.focus()
      return
    }
    setSubmitting(true)
    setSubmitError('')
    try {
      await authAPI.forgotPassword(email)
      // The server always returns success here regardless of whether the
      // email matched an account, so this message is accurate either way.
      setSubmitted(true)
    } catch (error) {
      setSubmitError(error.response?.data?.error || 'The request did not go through. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <PublicShell width="narrow">
        <PublicMessage
          tone="ok"
          title={t('ui.checkYourEmail')}
          action={<Button variant="secondary" size="lg" to="/login">{t('ui.backToSignIn')}</Button>}
        >
          <p>{t('ui.ifAnAccountWithThatEmail')}</p>
          <p className="text-xs text-ink-500">The link expires after a short time. Nothing arrived? Check spam, or send it again.</p>
        </PublicMessage>
      </PublicShell>
    )
  }

  return (
    <PublicShell width="narrow">
      <PublicHeader title={t('ui.resetYourPassword')} description={t('ui.enterYourEmailAndWeLl')} />
      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        {submitError && <InlineNotice tone="risk">{submitError}</InlineNotice>}
        <Field label={t('ui.emailAddress')} error={errors.email} id="email">
          <Input
            name="email"
            type="email"
            size="lg"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={onBlur('email')}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" block loading={submitting}>
          {submitting ? t('ui.sending') : t('ui.sendResetLink')}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm">
        <Link to="/login" className="font-medium text-brand-600 underline-offset-2 hover:underline">
          {t('ui.backToSignIn')}
        </Link>
      </p>
    </PublicShell>
  )
}

export default ForgotPassword
