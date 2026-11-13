import React, { useState } from 'react'
import { CheckIcon } from '@heroicons/react/20/solid'
import { mcpAPI } from '../../../services/api'
import { Dialog, Button, Field, Input, InlineNotice, notify, describeError } from '../../../components/ui'
import { hostLabel } from './helpers'

/** A blank connector, for a server that is not in the catalogue. */
export const CUSTOM_CANDIDATE = {
  custom: true,
  name: '',
  description: null,
  category: 'Custom',
  endpoint_url: '',
  url_or_package: null,
  tools_preview: [],
  suggested_auth: 'none',
}

const AUTH_OPTIONS = [
  { key: 'none', label: 'No authentication', hint: 'Public server' },
  { key: 'api_key', label: 'API key', hint: 'Sent as a bearer token, stored encrypted' },
  { key: 'oauth', label: 'OAuth', hint: 'Opens the provider’s sign-in, comes back here' },
]

export default function McpSetupDialog({ candidate, onCancel, onDone }) {
  const [name, setName] = useState(candidate.name || '')
  // Discovery works out the real endpoint and tries connecting to it, so this
  // is usually already correct rather than the page the result linked to.
  const [endpoint, setEndpoint] = useState(
    candidate.endpoint_url || (/^https:\/\//i.test(candidate.url_or_package || '') ? candidate.url_or_package : ''),
  )
  // The catalogue knows how each listed server authenticates.
  const [authType, setAuthType] = useState(candidate.suggested_auth || (candidate.needs_auth ? 'oauth' : 'none'))
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [touched, setTouched] = useState({})

  const submit = async () => {
    setBusy(true)
    try {
      setStep('Recording the server…')
      const created = await mcpAPI.connect({
        name: name.trim() || candidate.name,
        endpoint_url: endpoint.trim(),
        url_or_package: candidate.url_or_package,
        description: candidate.description,
        category: candidate.category,
        tools_preview: candidate.tools_preview,
        auth_type: authType,
      })
      const connection = created.data?.data
      if (!connection?.id) throw new Error('The server could not be recorded.')

      if (authType === 'api_key') {
        setStep('Storing the key…')
        await mcpAPI.setApiKey(connection.id, apiKey)
      }

      if (authType === 'oauth') {
        setStep('Asking the server where to authorize…')
        const res = await mcpAPI.authorizeUrl(connection.id)
        const url = res.data?.data?.authorization_url
        if (url) {
          // Full navigation, not a popup: many providers refuse to be framed.
          // The callback route brings the browser back to this page.
          window.location.href = url
          return
        }
      }

      setStep('Connecting and reading its tools…')
      const synced = await mcpAPI.syncTools(connection.id)
      const count = synced.data?.data?.tools_count ?? 0
      onDone(`${name.trim() || candidate.name} connected — ${count} tool${count === 1 ? '' : 's'} available.`)
    } catch (err) {
      notify.error(`Could not connect that server — ${describeError(err).message}`)
      // The row may exist in a non-working state; the Connected tab explains
      // what went wrong and offers a retry.
      onDone(null)
    } finally {
      setBusy(false)
      setStep('')
    }
  }

  const endpointOk = /^https:\/\/\S+$/i.test(endpoint.trim())
  const keyOk = authType !== 'api_key' || apiKey.trim().length > 0
  const nameOk = !candidate.custom || name.trim().length > 0
  const ready = endpointOk && keyOk && nameOk

  return (
    <Dialog
      open
      onClose={busy ? undefined : onCancel}
      dismissible={!busy}
      title={candidate.custom ? 'Add a connector' : `Connect ${candidate.name}`}
      description={candidate.custom
        ? 'Point Simeli at any remote MCP server.'
        : 'This makes a real connection to the server and reads the tools it offers.'}
      footer={(
        <>
          {busy && <span role="status" className="mr-auto self-center text-xs text-ink-600">{step}</span>}
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!ready} title={!ready ? 'Fill in the address (https) and any key first.' : undefined}>
            {authType === 'oauth' ? 'Authorize' : 'Connect'}
          </Button>
        </>
      )}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) submit() }}>
        {candidate.custom && (
          <Field label="Name" required help="What this shows up as in the tool library." error={touched.name && !nameOk ? 'Give it a name.' : null}>
            <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched((t) => ({ ...t, name: true }))} placeholder="My company's MCP server" />
          </Field>
        )}

        {/* No remote endpoint anywhere — a local/stdio server. Show what the
            vendor published rather than an empty box that cannot be filled. */}
        {!candidate.endpoint_url && (candidate.install_command || candidate.instructions) && (
          <InlineNotice tone="warn" title="This one runs on your own machine">
            <p>EMBMIS connects to remote MCP servers. Host it somewhere reachable over https, then enter that address below.</p>
            {candidate.install_command && <pre className="mt-2 overflow-x-auto rounded border border-warn-200 bg-surface p-2 font-mono text-2xs">{candidate.install_command}</pre>}
            {candidate.instructions && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-warn-200 bg-surface p-2 font-mono text-2xs">{candidate.instructions}</pre>}
          </InlineNotice>
        )}

        <Field
          label="MCP endpoint URL"
          required
          error={touched.endpoint && !endpointOk ? 'An https:// address of the MCP server itself.' : null}
          help={candidate.verified
            ? <span className="inline-flex items-center gap-1 text-ok-700"><CheckIcon className="h-3.5 w-3.5" aria-hidden="true" />Checked: this address answered as an MCP server{candidate.tools_preview?.length ? `, offering ${candidate.tools_preview.length} tools.` : '.'}</span>
            : candidate.needs_auth ? 'This address answered but asked for sign-in.' : 'The server’s own MCP address, not its documentation page.'}
        >
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, endpoint: true }))}
            spellCheck={false}
            inputMode="url"
            placeholder="https://mcp.example.com/mcp"
            className="font-mono"
          />
        </Field>

        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink-800">How does it authenticate?</legend>
          <div className="space-y-1.5">
            {AUTH_OPTIONS.map((o) => (
              <label key={o.key} aria-label={o.label} className="flex min-h-[44px] cursor-pointer items-start gap-2.5 rounded-md border border-ink-200 px-3 py-2 hover:bg-ink-50">
                <input type="radio" name="mcp-auth" checked={authType === o.key} onChange={() => setAuthType(o.key)} className="mt-1" />
                <span>
                  <span className="block text-sm text-fg">{o.label}</span>
                  <span className="block text-xs text-ink-500">{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {authType === 'api_key' && (
          <Field
            label="API key"
            required
            error={touched.key && !keyOk ? 'Paste the key the provider gave you.' : null}
            help={`Encrypted in the credential vault and only ever sent to ${hostLabel(endpoint)}. It cannot be read back out.`}
          >
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} onBlur={() => setTouched((t) => ({ ...t, key: true }))} spellCheck={false} autoComplete="off" className="font-mono" />
          </Field>
        )}
      </form>
    </Dialog>
  )
}
