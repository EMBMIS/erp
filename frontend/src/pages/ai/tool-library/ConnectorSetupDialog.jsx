import React, { useState } from 'react'
import { ArrowTopRightOnSquareIcon, ClipboardDocumentIcon } from '@heroicons/react/20/solid'
import { connectorsAPI } from '../../../services/api'
import { Dialog, Button, Field, Input, InlineNotice, Code, describeError } from '../../../components/ui'

/**
 * Connect a product through its own OAuth application.
 *
 * The client id and secret cannot be shipped with this software: every vendor
 * issues one per organisation. So the dialog makes that step short — name the
 * console page, and put the exact callback URL on screen to copy, since a
 * mismatched redirect URI is what usually breaks this.
 */
export default function ConnectorSetupDialog({ provider, redirectUri, onCancel, onDone: _onDone }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [accountValue, setAccountValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)

  const needsAccount = !!provider.account_param

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const created = await connectorsAPI.create({
        provider: provider.key,
        client_id: clientId.trim(),
        client_secret: clientSecret.trim(),
        account_info: needsAccount ? { [provider.account_param.key]: accountValue.trim() } : {},
      })
      const id = created.data?.data?.id
      if (!id) throw new Error('The connector could not be saved.')
      const res = await connectorsAPI.authorizeUrl(id)
      const url = res.data?.data?.authorization_url
      if (!url) throw new Error('Could not work out where to send you to sign in.')
      // Full navigation — providers refuse to be framed, and the callback
      // brings the browser back here.
      window.location.href = url
    } catch (err) {
      setError(describeError(err).message || 'Could not set that up.')
      setBusy(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(redirectUri)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { /* selectable anyway */ }
  }

  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientId.trim())
  // When the server already holds an OAuth app for this provider, there is
  // nothing to supply — just the sign-in.
  const ready = provider.preconfigured
    ? (!needsAccount || accountValue.trim())
    : clientId.trim() && clientSecret.trim() && !looksLikeEmail && (!needsAccount || accountValue.trim())

  return (
    <Dialog
      open
      onClose={busy ? undefined : onCancel}
      dismissible={!busy}
      title={`Connect ${provider.name}`}
      description={`You sign in with ${provider.name} at the end; these are the details it asks for first.`}
      footer={(
        <>
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!ready}>Sign in with {provider.name}</Button>
        </>
      )}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) submit() }}>
        {error && <InlineNotice tone="risk" title="Not connected">{error}</InlineNotice>}

        {provider.mcp_alternative && (
          <InlineNotice tone="ok" title="You probably do not need this">
            {provider.name} also runs an MCP server, which connects in one step with no developer console. Use Connect on the Apps tab instead.
          </InlineNotice>
        )}

        {provider.preconfigured ? (
          <InlineNotice tone="ok" title="Ready to go">
            This server already has a {provider.name} application configured, so there is nothing to fill in.
          </InlineNotice>
        ) : (
          <InlineNotice tone="ink" title={`One-time setup with ${provider.name}`}>
            {provider.setup_steps ? (
              <ol className="mt-1.5 list-inside list-decimal space-y-1 text-xs">
                {provider.setup_steps.map((s) => <li key={s}>{s}</li>)}
              </ol>
            ) : (
              <p className="mt-1">{provider.setup_hint}</p>
            )}
            {provider.setup_url && (
              <a href={provider.setup_url} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-xs text-brand-600 underline">
                Open the {provider.name} console <ArrowTopRightOnSquareIcon className="h-3 w-3" aria-hidden="true" />
              </a>
            )}
            <p className="mt-2 text-xs">Paste this in as the redirect (callback) URL:</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto rounded border border-ink-200 bg-surface px-2 py-1 font-mono text-2xs">{redirectUri}</code>
              <Button size="sm" variant="ghost" icon={ClipboardDocumentIcon} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>
            <p className="mt-2 text-xs">
              Running this for a team? Set <Code>{provider.env_var_prefix}_CLIENT_ID</Code> and <Code>{provider.env_var_prefix}_CLIENT_SECRET</Code> on the server instead, and everyone just signs in.
            </p>
          </InlineNotice>
        )}

        {needsAccount && (
          <Field label={provider.account_param.label} required help={provider.account_param.hint}>
            <Input value={accountValue} onChange={(e) => setAccountValue(e.target.value)} spellCheck={false} className="font-mono" />
          </Field>
        )}

        {!provider.preconfigured && (
          <>
            <Field
              label="Client ID"
              required
              error={looksLikeEmail ? `That is an email address. The client ID is issued by ${provider.name} when you create the OAuth app.` : null}
              help={`Not your email or password — ${provider.name} issues it when you create the app${provider.client_id_example ? `; it looks like ${provider.client_id_example}` : ''}.`}
            >
              <Input value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} autoComplete="off" placeholder={provider.client_id_example || 'From the provider’s console'} className="font-mono" />
            </Field>
            <Field label="Client secret" required help={`Shown once by ${provider.name}, next to the client ID. Encrypted here and never shown again.`}>
              <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} spellCheck={false} autoComplete="off" placeholder={provider.client_secret_example || ''} className="font-mono" />
            </Field>
          </>
        )}

        {provider.scopes?.length > 0 && (
          <div>
            <p className="label-mono mb-1">Access it will ask for</p>
            <ul className="flex flex-wrap gap-1.5">
              {provider.scopes.map((s) => <li key={s}><Code>{s.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '')}</Code></li>)}
            </ul>
          </div>
        )}
      </form>
    </Dialog>
  )
}
