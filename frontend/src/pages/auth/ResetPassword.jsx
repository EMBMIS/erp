import React, { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { authAPI } from '../../services/api'
import { useI18n } from '../../contexts/I18nContext'
import { PublicShell, PublicHeader, PublicMessage, PasswordInput } from '../../components/public/PublicPage'
import { Button, Field, InlineNotice, useFieldValidation } from '../../components/ui'

function ResetPassword() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const values = useMemo(() => ({ password, confirmPassword }), [password, confirmPassword])
  const rules = useMemo(() => ({
    password: (v) => ((v || '').length < 6 ? 'Use at least 6 characters.' : null),
    confirmPassword: (v, all) => (!v ? 'Type the new password again.' : v !== all.password ? 'This does not match the password above. Type it again.' : null),
  }), [])
  const { errors, onBlur, validateAll } = useFieldValidation(values, rules)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    const all = validateAll()
    const first = Object.keys(all)[0]
    if (first) {
      document.getElementById(first)?.focus()
      return
    }

    setSubmitting(true)
    try {
      await authAPI.resetPassword(token, password)
      // Leaves this screen, so a toast is the right channel.
      toast.success('Password reset. Sign in with your new password.')
      navigate('/login')
    } catch (err) {
      setError(err.response?.data?.error || 'This password reset link is invalid or has expired.')
    } finally {
      setSubmitting(false)
    }
  }

  if (!token) {
    return (
      <PublicShell width="narrow">
        <PublicMessage
          tone="risk"
          title={t('ui.setANewPassword')}
          action={<Button variant="primary" size="lg" to="/forgot-password">{t('ui.requestANewResetLink')}</Button>}
        >
          <p>{t('ui.thisResetLinkIsMissingIts')} Request a new link and open it from the email.</p>
        </PublicMessage>
      </PublicShell>
    )
  }

  return (
    <PublicShell width="narrow">
      <PublicHeader title={t('ui.setANewPassword')} />
      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        {error && (
          <InlineNotice
            tone="risk"
            title={error}
            action={<Button size="sm" variant="secondary" to="/forgot-password">{t('ui.requestANewResetLink')}</Button>}
          />
        )}
        <Field label={t('ui.newPassword')} error={errors.password} help="At least 6 characters." id="password">
          <PasswordInput
            name="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={onBlur('password')}
            shown={showPassword}
            onToggle={() => setShowPassword((s) => !s)}
          />
        </Field>
        <Field label={t('ui.confirmNewPassword')} error={errors.confirmPassword} id="confirmPassword">
          <PasswordInput
            name="confirmPassword"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            onBlur={onBlur('confirmPassword')}
            shown={showPassword}
            onToggle={() => setShowPassword((s) => !s)}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" block loading={submitting}>
          {submitting ? t('ui.resetting') : t('ui.resetPassword')}
        </Button>
      </form>
    </PublicShell>
  )
}

export default ResetPassword
