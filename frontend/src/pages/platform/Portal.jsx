/**
 * The external portal: sign in, then the application, using the same runtime
 * component the company's own side uses.
 *
 * ===========================================================================
 * WHY THIS IS ITS OWN ENTRY POINT
 * ===========================================================================
 * A portal user is not an employee with fewer menu items. They are a supplier
 * or a customer, anchored to a record in the company's data, and their session
 * lives under its own storage key so it can never travel to an internal
 * endpoint (see portalAPI in services/api.js). This screen sits outside the
 * authenticated shell entirely: no company switcher, no internal navigation,
 * no shared token.
 *
 * What it renders once signed in, though, is exactly <AppRuntime/> — the same
 * component, the same blocks, the same tables. The difference between the two
 * sides is the principal the server builds, and nothing about it lives here.
 */

import React from 'react'
import { Routes, Route, useNavigate, Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { portalAPI, PORTAL_TOKEN_KEY } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { PublicShell, PublicHeader, PublicLoading, PasswordInput } from '../../components/public/PublicPage'
import { Button, Field, Input, Select, InlineNotice, useFieldValidation } from '../../components/ui'
import AppRuntime from './AppRuntime.jsx'

export function PortalLogin() {
  const navigate = useNavigate()
  const [form, setForm] = React.useState({ company: '', email: '', password: '' })
  const [busy, setBusy] = React.useState(false)
  const [showPassword, setShowPassword] = React.useState(false)
  const [submitError, setSubmitError] = React.useState('')

  const rules = React.useMemo(() => ({
    company: (v) => (!v?.trim() ? 'Enter the company code. It is printed on the documents they send you.' : null),
    email: (v) => (!v?.trim() ? 'Enter the email address your invitation was sent to.'
      : !/\S+@\S+\.\S+/.test(v) ? 'Enter a full email address, like name@company.com.' : null),
    password: (v) => (!v ? 'Enter your password.' : null),
  }), [])
  const { errors, onBlur, validateAll } = useFieldValidation(form, rules)
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); if (submitError) setSubmitError('') }

  const submit = async (e) => {
    e.preventDefault()
    const first = Object.keys(validateAll())[0]
    if (first) { document.getElementById(`portal-${first}`)?.focus(); return }
    setBusy(true)
    setSubmitError('')
    try {
      const res = await portalAPI.login(form)
      localStorage.setItem(PORTAL_TOKEN_KEY, res.data.data.token)
      const apps = res.data.data.memberships?.filter((m) => m.status === 'active') || []
      if (!apps.length) {
        setSubmitError('This account has no applications yet. Ask your contact at the company.')
        return
      }
      navigate(`/portal/apps/${apps[0].app_key}`)
    } catch (err) {
      // One message for every failure reason — the server answers the same way,
      // and a login form that distinguishes them is a way to enumerate a
      // company's suppliers.
      setSubmitError(err.response?.data?.error || 'Those details do not match an active portal account.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <PublicShell width="narrow" context="Partner portal">
      <PublicHeader title="Sign in to the partner portal" description="See the work that is with you. You only ever see your own records." />
      <form onSubmit={submit} className="space-y-4" noValidate>
        {submitError && (
          <InlineNotice tone="risk" title={submitError}>
            Check the company code, email and password. If you have not set a password yet, open the invitation email.
          </InlineNotice>
        )}
        <Field label="Company code" id="portal-company" error={errors.company} help="The code on the documents they send you.">
          <Input size="lg" autoComplete="organization" value={form.company} onChange={set('company')} onBlur={onBlur('company')} />
        </Field>
        <Field label="Email" id="portal-email" error={errors.email}>
          <Input size="lg" type="email" autoComplete="email" inputMode="email" value={form.email} onChange={set('email')} onBlur={onBlur('email')} />
        </Field>
        <Field label="Password" id="portal-password" error={errors.password}>
          <PasswordInput autoComplete="current-password" value={form.password} onChange={set('password')} onBlur={onBlur('password')}
            shown={showPassword} onToggle={() => setShowPassword((s) => !s)} />
        </Field>
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </PublicShell>
  )
}

export function PortalAcceptInvite() {
  const navigate = useNavigate()
  const params = new URLSearchParams(window.location.search)
  const hasToken = !!params.get('token')
  const [form, setForm] = React.useState({
    token: params.get('token') || '',
    company: params.get('company') || '',
    password: '',
    confirm: '',
  })
  const [busy, setBusy] = React.useState(false)
  const [showPassword, setShowPassword] = React.useState(false)
  const [submitError, setSubmitError] = React.useState('')

  const rules = React.useMemo(() => ({
    token: (v) => (!v?.trim() ? 'Paste the invitation code from your email.' : null),
    password: (v) => ((v || '').length < 12 ? 'Choose a password of at least 12 characters.' : null),
    confirm: (v, all) => (!v ? 'Type the password again.' : v !== all.password ? 'Those passwords do not match. Type it again.' : null),
  }), [])
  const { errors, onBlur, validateAll } = useFieldValidation(form, rules)
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); if (submitError) setSubmitError('') }

  const submit = async (e) => {
    e.preventDefault()
    const first = Object.keys(validateAll())[0]
    if (first) { document.getElementById(`invite-${first}`)?.focus(); return }
    setBusy(true)
    setSubmitError('')
    try {
      await portalAPI.acceptInvite({ token: form.token, company: form.company, password: form.password })
      toast.success('Your account is ready. Sign in.')
      navigate('/portal/login')
    } catch (err) {
      setSubmitError(err.response?.data?.error || 'That invitation is not valid any more.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <PublicShell width="narrow" context="Partner portal">
      <PublicHeader title="Set up your access" description="Choose a password. Your invitation link identifies who you are." />
      <form onSubmit={submit} className="space-y-4" noValidate>
        {submitError && (
          <InlineNotice tone="risk" title={submitError}>Ask your contact at the company to send a new invitation.</InlineNotice>
        )}
        {!hasToken ? (
          <Field label="Invitation code" id="invite-token" error={errors.token}>
            <Input size="lg" autoComplete="off" value={form.token} onChange={set('token')} onBlur={onBlur('token')} />
          </Field>
        ) : null}
        <Field label="Password" id="invite-password" error={errors.password} help="At least 12 characters.">
          <PasswordInput autoComplete="new-password" value={form.password} onChange={set('password')} onBlur={onBlur('password')}
            shown={showPassword} onToggle={() => setShowPassword((s) => !s)} />
        </Field>
        <Field label="Confirm password" id="invite-confirm" error={errors.confirm}>
          <PasswordInput autoComplete="new-password" value={form.confirm} onChange={set('confirm')} onBlur={onBlur('confirm')}
            shown={showPassword} onToggle={() => setShowPassword((s) => !s)} />
        </Field>
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {busy ? 'Saving…' : 'Set my password'}
        </Button>
      </form>
    </PublicShell>
  )
}

/** The portal shell: a slim header, then the generic runtime. */
export function PortalShell() {
  const navigate = useNavigate()
  const { data: me, error } = useResource(
    ['portal-me'],
    () => portalAPI.me(),
    { retry: false, staleTime: 0, gcTime: 0 }
  )

  // A failed /me means the portal session is gone: drop the stale token.
  React.useEffect(() => {
    if (error) localStorage.removeItem(PORTAL_TOKEN_KEY)
  }, [error])

  const signOut = async () => {
    await portalAPI.logout().catch(() => {})
    localStorage.removeItem(PORTAL_TOKEN_KEY)
    navigate('/portal/login')
  }

  if (error) return <Navigate to="/portal/login" replace />
  if (!me) {
    return (
      <PublicShell width="wide" context="Partner portal" footer={false}>
        <PublicLoading />
      </PublicShell>
    )
  }

  const apps = me.applications || []

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-fg">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-ink-200 bg-surface px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/logo-mark.png" alt="" className="h-7 w-7 shrink-0 rounded-md" />
          <span className="text-sm font-semibold tracking-tight">EMBMIS</span>
          <span className="hidden text-sm text-ink-500 sm:inline">· Partner portal</span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {apps.length > 1 ? (
            <Select size="sm" aria-label="Application" className="w-auto max-w-[12rem]"
              onChange={(e) => navigate(`/portal/apps/${e.target.value}`)}>
              {apps.map((a) => <option key={a.appKey} value={a.appKey}>{a.name}</option>)}
            </Select>
          ) : null}
          <span className="hidden truncate text-xs text-ink-600 sm:inline">{me.identity?.display_name || me.identity?.email}</span>
          <Button variant="ghost" size="sm" onClick={signOut}>Sign out</Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <Routes>
          <Route path="apps/:appKey" element={<AppRuntime client={portalAPI} basePath="/portal/apps" external />} />
          <Route path="apps/:appKey/:pageKey" element={<AppRuntime client={portalAPI} basePath="/portal/apps" external />} />
          <Route path="apps/:appKey/:pageKey/:recordId" element={<AppRuntime client={portalAPI} basePath="/portal/apps" external />} />
          <Route path="*" element={
            apps.length
              ? <Navigate to={`/portal/apps/${apps[0].appKey}`} replace />
              : <p className="p-6 text-sm text-ink-600">You have no applications yet. Ask your contact at the company to add you to one.</p>
          } />
        </Routes>
      </div>
    </div>
  )
}
