import React from 'react'
import { useSearchParams } from 'react-router-dom'
import { authAPI } from '../services/api'
import { useResource } from '../hooks/useResource'
import { useI18n } from '../contexts/I18nContext'
import { PublicShell, PublicMessage, PublicLoading } from '../components/public/PublicPage'
import { Button } from '../components/ui'

function VerifyEmail() {
  const { t } = useI18n()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')

  // One verification per token: no retries, never refetched. React Query also
  // de-duplicates the StrictMode double mount, so the link is spent once.
  const { isSuccess, error, loading } = useResource(
    ['verify-email', token],
    () => authAPI.verifyEmail(token),
    { enabled: !!token, retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false }
  )

  const signIn = <Button variant="primary" size="lg" to="/login">{t('ui.goToSignIn')}</Button>

  let body
  if (!token) {
    body = (
      <PublicMessage tone="risk" title={t('ui.couldNotVerify')} action={signIn}>
        <p>This link has no verification token. Open the link from your email again, or sign in to request a new one.</p>
      </PublicMessage>
    )
  } else if (loading && !error) {
    body = <PublicLoading label={t('ui.verifyingYourEmail')} />
  } else if (isSuccess) {
    body = (
      <PublicMessage tone="ok" title={t('ui.emailVerified')} action={signIn}>
        <p>{t('ui.youReAllSet')}</p>
      </PublicMessage>
    )
  } else {
    body = (
      <PublicMessage tone="risk" title={t('ui.couldNotVerify')} action={signIn}>
        <p>{error?.response?.data?.error || error?.message || 'Verification failed.'}</p>
        <p>The link may have expired or already been used. Sign in — if your address still needs verifying, you can resend the email from there.</p>
      </PublicMessage>
    )
  }

  return <PublicShell width="narrow">{body}</PublicShell>
}

export default VerifyEmail
