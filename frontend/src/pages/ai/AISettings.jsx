import React, { useEffect, useState } from 'react'
import { KeyIcon, PlusIcon, TrashIcon } from '@heroicons/react/20/solid'
import api, { aiSettingsAPI, aiCredentialsAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Tabs, Card, Field, Input, Select, Segmented, FormSection, DataTable, RowAction, Badge, Code,
  Dialog, ConfirmDialog, InlineNotice, SkeletonDetail, ErrorState, DateText, notify, describeError,
} from '../../components/ui'

const STYLES = [
  { key: 'concise', label: 'Concise', hint: 'Leads with the number or the decision.' },
  { key: 'balanced', label: 'Balanced', hint: 'The default.' },
  { key: 'detailed', label: 'Detailed', hint: 'Shows the intermediate figures so you can check it.' },
]

const MODES = [
  { key: 'manual', label: 'Confirm everything' },
  { key: 'accept_edits', label: 'Confirm changes only' },
  { key: 'auto', label: 'Run everything automatically' },
  { key: 'bypass', label: 'No confirmations' },
]

const ROLES = ['USER', 'FINANCE_USER', 'FINANCE_MANAGER', 'MANAGER', 'ADMIN']
const SETTINGS_TOOLS_KEY = ['ai-settings', 'tools']
const IMPACT = { read: { label: 'Reads', tone: 'ink' }, draft: { label: 'Drafts', tone: 'brand' }, real: { label: 'Changes records', tone: 'warn' } }

export default function AISettings() {
  const [tab, setTab] = useState('general')

  const settingsQ = useResource(keys.aiSettings(), ({ signal }) => api.get('/ai-settings', { signal }))
  // Its own key: the settings view of the tools, not the catalog the tool
  // library caches under keys.aiTools().
  const toolsQ = useResource(SETTINGS_TOOLS_KEY, ({ signal }) => api.get('/ai-settings/tools', { signal }))
  const settings = settingsQ.data
  const tools = Array.isArray(toolsQ.data) ? toolsQ.data : []

  const saveSettings = useResourceMutation((patch) => aiSettingsAPI.update(patch), { invalidates: [['ai-settings']], silent: true })
  const [saved, setSaved] = useState(null)
  const save = async (patch) => {
    setSaved(null)
    try {
      await saveSettings.mutateAsync(patch)
      setSaved({ tone: 'ok', text: 'Saved.' })
    } catch (err) {
      setSaved({ tone: 'risk', text: `Not saved — ${describeError(err).message}` })
    }
  }

  if (settingsQ.loading) return <SkeletonDetail />
  if (settingsQ.error) return <ErrorState error={settingsQ.error} what="AI settings" onRetry={settingsQ.refetch} />

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI settings"
        description="How Simeli answers, what it may use, who may let it act, and the keys it runs on."
      />

      {!settings.ai_enabled && (
        <InlineNotice tone="warn" title="No language model is connected">
          Simeli cannot answer questions and reasoning agents cannot run until the server has an OpenAI, Anthropic or OpenRouter key
          (set in the server environment, e.g. <Code>OPENAI_API_KEY</Code> or <Code>ANTHROPIC_API_KEY</Code>). Counted figures, findings and fixed-sequence agents still work.
        </InlineNotice>
      )}

      {/* What this server can actually provide. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Capability ok={settings.ai_enabled} label="Language model" detail={settings.ai_enabled ? `${settings.provider || 'openai'} · ${settings.effective_model}` : 'No API key set'} />
        <Capability ok={settings.capabilities?.latex?.available} label="LaTeX documents" detail={settings.capabilities?.latex?.available ? settings.capabilities.latex.engine : 'No engine installed'} />
        <Capability ok={settings.capabilities?.vault?.configured} label="Credential vault" detail={settings.capabilities?.vault?.configured ? 'Ready' : 'AI_VAULT_KEY not set'} />
        <Capability ok={settings.capabilities?.agent_scheduler} label="Agent scheduler" detail={settings.capabilities?.agent_scheduler ? 'Running' : 'Agents run only by hand'} />
      </div>

      <ProviderKeyCard onChange={settingsQ.refetch} />

      <Tabs
        value={tab}
        onChange={(v) => { setTab(v); setSaved(null) }}
        label="AI settings"
        tabs={[
          { id: 'general', label: 'Simeli' },
          { id: 'tools', label: 'Tools', count: tools.length },
          { id: 'permissions', label: 'Who may do what' },
          { id: 'credentials', label: 'API keys' },
        ]}
      />

      {saved && <InlineNotice tone={saved.tone}>{saved.text}</InlineNotice>}

      {tab === 'general' && <GeneralTab settings={settings} onSave={save} saving={saveSettings.isPending} />}
      {tab === 'tools' && <ToolsTab tools={tools} loading={toolsQ.loading} error={toolsQ.error} onRetry={toolsQ.refetch} />}
      {tab === 'permissions' && <PermissionsTab settings={settings} onSave={save} saving={saveSettings.isPending} />}
      {tab === 'credentials' && <CredentialsTab vaultStatus={settings.capabilities?.vault} />}
    </div>
  )
}

/**
 * The key every AI feature runs on, for the platform owner. Replacing a rejected or expired key here needs no
 * server access: it is tested with the provider first, stored encrypted, and used at once (backend providerKey.js).
 * Anyone else gets a 403 from the endpoint, and the card is not shown.
 */
function ProviderKeyCard({ onChange }) {
  const q = useResource(['ai-provider'], ({ signal }) => api.get('/ai-provider', { signal, params: { check: 1 } }))
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  if (q.loading) return null
  if (q.error) return null // not the platform owner, or an older server
  const s = q.data
  const provider = { openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI' }[s.provider] || s.provider
  const accepted = s.check?.ok
  const run = async (fn, ok) => {
    setBusy(true); setResult(null)
    try { await fn(); setKey(''); setResult({ tone: 'ok', text: ok }); await q.refetch(); onChange?.() }
    catch (err) { setResult({ tone: 'risk', text: describeError(err).message }) }
    finally { setBusy(false) }
  }
  return (
    <Card
      title="Provider key"
      description={`The ${provider} key Simeli and every AI feature use, for every company on this server. A key entered here replaces the server's own (${s.envVariable}); it is checked with ${provider} before it is kept, and stored encrypted.`}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {s.source === 'none' ? <Badge tone="warn" glyph="triangle">No key</Badge>
            : <Badge tone={accepted === false ? 'risk' : accepted ? 'ok' : 'ink'} glyph={accepted === false ? 'triangle' : accepted ? 'check' : undefined}>{accepted === false ? `Rejected by ${provider}` : accepted ? `Accepted by ${provider}` : 'Not checked'}</Badge>}
          {s.source !== 'none' && <span className="text-ink-600">{s.source === 'settings' ? 'Entered here' : 'From the server'} · ending in <Code>{s.last4}</Code>{s.setAt ? <> · <DateText value={s.setAt} /></> : null}</span>}
          {accepted === false && s.check?.reason && <span className="text-risk-600">{s.check.reason}</span>}
        </div>
        {!s.vault ? (
          <InlineNotice tone="warn">Keys cannot be stored until the credential vault is set up (AI_VAULT_KEY on the server).</InlineNotice>
        ) : (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (key.trim()) run(() => api.put('/ai-provider', { key: key.trim() }), `Saved. ${provider} accepted the key and Simeli uses it now.`) }}>
            <Field label={`New ${provider} key`} className="min-w-[280px] flex-1">
              <Input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={s.provider === 'openrouter' ? 'sk-or-…' : s.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'} />
            </Field>
            <Button type="submit" variant="primary" icon={KeyIcon} disabled={!key.trim() || busy}>{busy ? 'Checking…' : 'Check and save'}</Button>
            {s.source === 'settings' && <Button type="button" variant="secondary" disabled={busy} onClick={() => run(() => api.delete('/ai-provider'), "The server's own key is used again.")}>Use the server's key</Button>}
          </form>
        )}
        {result && <InlineNotice tone={result.tone}>{result.text}</InlineNotice>}
      </div>
    </Card>
  )
}

function Capability({ ok, label, detail }) {
  return (
    <div className="rounded-lg border border-ink-200 bg-surface p-3">
      <div className="flex items-center gap-2">
        <Badge tone={ok ? 'ok' : 'warn'} glyph={ok ? 'check' : 'triangle'}>{ok ? 'Ready' : 'Missing'}</Badge>
        <span className="truncate text-sm font-medium text-fg">{label}</span>
      </div>
      <p className="mt-1 truncate text-xs text-ink-600" title={detail}>{detail}</p>
    </div>
  )
}

function GeneralTab({ settings, onSave, saving }) {
  const fromSettings = () => ({
    model: settings.model || '',
    response_style: settings.response_style,
    default_agent_mode: settings.default_agent_mode,
    max_steps: settings.max_steps,
  })
  const [form, setForm] = useState(fromSettings)
  const ceiling = settings.max_step_ceiling || 200

  // Re-sync when the server's copy changes, so a clamped value shows what was
  // actually stored rather than what was typed.
  useEffect(() => {
    setForm({
      model: settings.model || '',
      response_style: settings.response_style,
      default_agent_mode: settings.default_agent_mode,
      max_steps: settings.max_steps,
    })
  }, [settings.model, settings.response_style, settings.default_agent_mode, settings.max_steps])

  const stepsError = form.max_steps === '' || form.max_steps < 1 || form.max_steps > ceiling ? `Between 1 and ${ceiling}.` : null

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!stepsError) onSave(form) }}>
      <FormSection title="How Simeli answers">
        <Field label="Model" help={<>Leave blank for the server’s default ({settings.provider || 'openai'} · {settings.environment_model}). Currently answering as <Code>{settings.provider || 'openai'} · {settings.effective_model}</Code>.</>}>
          <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={settings.environment_model} className="font-mono" />
        </Field>
        <Field label="Answer style" help={STYLES.find((s) => s.key === form.response_style)?.hint}>
          <Segmented label="Answer style" value={form.response_style} onChange={(v) => setForm({ ...form, response_style: v })} options={STYLES.map((s) => ({ value: s.key, label: s.label }))} />
        </Field>
        <Field label="Default confirmation level in chat" help="People can choose a stricter level per conversation. The chat itself only offers the two levels that ask before changing records.">
          <Select value={form.default_agent_mode} onChange={(e) => setForm({ ...form, default_agent_mode: e.target.value })}>
            {MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </Select>
        </Field>
        <Field
          label="Tool steps per answer"
          error={stepsError}
          help={`How many tools Simeli may call before it pauses and asks whether to keep going (1 to ${ceiling}). The bound stops a looping model spending money nobody is watching; a paused turn can carry on.`}
        >
          <Input type="number" numeric min={1} max={ceiling} value={form.max_steps ?? ''} onChange={(e) => setForm({ ...form, max_steps: e.target.value === '' ? '' : Number(e.target.value) })} className="w-28" />
        </Field>
      </FormSection>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={saving} disabled={!!stepsError}>Save</Button>
      </div>
    </form>
  )
}

function ToolsTab({ tools, loading, error, onRetry }) {
  const [busy, setBusy] = useState(null)
  const updateTool = useResourceMutation(({ name, patch }) => aiSettingsAPI.updateTool(name, patch), { invalidates: [SETTINGS_TOOLS_KEY, keys.aiTools()], silent: true })

  const update = async (name, patch) => {
    setBusy(name)
    try {
      await updateTool.mutateAsync({ name, patch })
    } catch (err) {
      notify.error(`${name} was not changed — ${describeError(err).message}`)
    } finally {
      setBusy(null)
    }
  }

  const columns = [
    {
      id: 'name', header: 'Tool', accessor: 'name', mobile: 'title', minWidth: 240,
      cell: (t) => (
        <span className="block min-w-0">
          <span className="flex items-center gap-2"><Code className="text-fg">{t.name}</Code>{t.custom && <Badge>Built here</Badge>}</span>
          <span className="block truncate text-xs text-ink-600">{t.description}</span>
        </span>
      ),
    },
    { id: 'impact', header: 'Effect', accessor: (t) => (IMPACT[t.impact] || IMPACT.draft).label, filter: 'select', width: 150, mobile: 'meta', cell: (t) => <Badge tone={(IMPACT[t.impact] || IMPACT.draft).tone}>{(IMPACT[t.impact] || IMPACT.draft).label}</Badge> },
    {
      id: 'role', header: 'Who may use it', accessor: (t) => t.min_role || '', width: 190,
      cell: (t) => (
        <Select size="sm" aria-label={`Minimum role for ${t.name}`} value={t.min_role || ''} disabled={busy === t.name} onChange={(e) => update(t.name, { min_role: e.target.value || null })} onClick={(e) => e.stopPropagation()}>
          <option value="">Anyone</option>
          {ROLES.map((r) => <option key={r} value={r}>{r}+</option>)}
        </Select>
      ),
    },
    {
      id: 'enabled', header: 'On', accessor: (t) => (t.enabled ? 1 : 0), width: 80,
      cell: (t) => <input type="checkbox" aria-label={`${t.name} on`} checked={!!t.enabled} disabled={busy === t.name} onChange={(e) => update(t.name, { enabled: e.target.checked })} onClick={(e) => e.stopPropagation()} className="h-4 w-4 rounded border-ink-300" />,
    },
  ]

  return (
    <div className="space-y-2">
      <DataTable
        viewKey="ai.settings.tools"
        caption="Tools Simeli may call"
        noun="tool"
        rows={tools}
        columns={columns}
        rowKey={(t) => t.name}
        loading={loading}
        error={error}
        onRetry={onRetry}
        searchPlaceholder="Search tools"
        empty={{ title: 'No tools are registered' }}
      />
      <p className="text-xs text-ink-500">A tool that is off, or above someone’s role, is not offered to Simeli in their conversations at all.</p>
    </div>
  )
}

function PermissionsTab({ settings, onSave, saving }) {
  const [perms, setPerms] = useState(settings.role_permissions || {})
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave({ role_permissions: perms }) }} className="space-y-4">
      <FormSection title="Highest confirmation level each role may choose" description="Stops ordinary users putting Simeli on a level that acts without asking." columns={1}>
        <ul className="divide-y divide-ink-100 rounded-md border border-ink-200">
          {ROLES.map((role) => (
            <li key={role} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <Code className="text-fg">{role}</Code>
              <Select aria-label={`Limit for ${role}`} value={perms[role] || ''} onChange={(e) => setPerms({ ...perms, [role]: e.target.value || undefined })} className="sm:w-64">
                <option value="">No limit</option>
                {MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </Select>
            </li>
          ))}
        </ul>
      </FormSection>
      <div className="flex justify-end"><Button type="submit" variant="primary" loading={saving}>Save</Button></div>
    </form>
  )
}

function CredentialsTab({ vaultStatus }) {
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(null)
  const { data, loading, error, refetch } = useResource(keys.aiCredentials(), ({ signal }) => aiCredentialsAPI.list({ signal }))
  const credentials = Array.isArray(data) ? data : []
  const remove = useResourceMutation((id) => aiCredentialsAPI.remove(id), { invalidates: [['ai-credentials']], silent: true })
  const vaultMissing = vaultStatus && !vaultStatus.configured

  const confirmRemove = async () => {
    try {
      await remove.mutateAsync(removing.id)
      notify.success(`Key ${removing.name} deleted`)
    } catch (err) {
      notify.error(`Not deleted — ${describeError(err).message}`)
    } finally {
      setRemoving(null)
    }
  }

  const columns = [
    {
      id: 'name', header: 'Key', accessor: 'name', mobile: 'title', minWidth: 220,
      cell: (c) => (
        <span className="block min-w-0">
          <span className="flex items-center gap-2"><KeyIcon className="h-3.5 w-3.5 shrink-0 text-ink-400" aria-hidden="true" /><span className="truncate font-medium text-fg">{c.name}</span></span>
          {c.description && <span className="block truncate text-xs text-ink-500">{c.description}</span>}
        </span>
      ),
    },
    { id: 'provider', header: 'For', accessor: 'provider', filter: 'select', width: 120, mobile: 'meta' },
    { id: 'hint', header: 'Ends', accessor: 'hint', width: 100, cell: (c) => <Code>…{c.hint}</Code> },
    { id: 'hosts', header: 'May be sent to', accessor: (c) => (c.allowed_hosts || []).join(', '), cell: (c) => (c.allowed_hosts?.length ? c.allowed_hosts.join(', ') : '—') },
    { id: 'agents', header: 'Agents', accessor: (c) => Number(c.agent_count) || 0, align: 'right', width: 90 },
    { id: 'state', header: 'State', accessor: (c) => (c.enabled ? 'On' : 'Off'), width: 90, cell: (c) => <Badge tone={c.enabled ? 'ok' : 'ink'}>{c.enabled ? 'On' : 'Off'}</Badge> },
    { id: 'used', header: 'Last used', accessor: 'last_used_at', width: 130, mobile: 'subtitle', cell: (c) => (c.last_used_at ? <DateText value={c.last_used_at} /> : 'Never') },
  ]

  return (
    <div className="space-y-4">
      {vaultMissing && (
        <InlineNotice tone="warn" title="Keys cannot be stored yet">
          {vaultStatus.error || vaultStatus.how_to_configure} Nothing is ever stored unencrypted, so adding a key waits for the vault.
        </InlineNotice>
      )}
      <Card
        title="API keys"
        description="Keys for the models your agents run on, and for external services Simeli may call. They cannot be read back out."
        actions={<Button size="sm" variant="primary" icon={PlusIcon} onClick={() => setAdding(true)} disabled={vaultMissing} title={vaultMissing ? 'Set up the credential vault first.' : undefined}>Add a key</Button>}
        padded={false}
      >
        <DataTable
          viewKey="ai.settings.credentials"
          caption="API keys"
          noun="key"
          search={false}
          rows={credentials}
          columns={columns}
          loading={loading}
          error={error}
          onRetry={refetch}
          rowActions={(c) => <RowAction icon={TrashIcon} tone="risk" label={`Delete ${c.name}`} onClick={() => setRemoving(c)} />}
          empty={{ icon: KeyIcon, title: 'No keys stored', description: vaultMissing ? 'Set up the credential vault, then add a key.' : 'Add a key for an agent to run on its own account.' }}
        />
      </Card>

      {adding && <AddCredential onClose={() => setAdding(false)} />}

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={confirmRemove}
        title={removing ? `Delete the key ${removing.name}?` : ''}
        consequence={removing?.agent_count ? `${removing.agent_count} agent(s) use it and fall back to the server's key, or stop if there is none.` : 'Nothing uses it at the moment.'}
        confirmLabel="Delete key"
        busy={remove.isPending}
      />
    </div>
  )
}

function AddCredential({ onClose }) {
  const [form, setForm] = useState({ name: '', provider: 'anthropic', secret: '', description: '', allowed_hosts: '', base_url: '' })
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(null)
  const create = useResourceMutation((payload) => aiCredentialsAPI.create(payload), { invalidates: [['ai-credentials']], silent: true })

  const errors = { name: !form.name.trim() ? 'Give the key a name.' : null, secret: !form.secret ? 'Paste the key.' : null }

  const save = async () => {
    setSubmitted(true)
    setError(null)
    if (errors.name || errors.secret) return
    try {
      await create.mutateAsync({ ...form, allowed_hosts: form.allowed_hosts.split(',').map((h) => h.trim()).filter(Boolean) })
      notify.success('Key stored encrypted')
      onClose()
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add an API key"
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={create.isPending}>Store it</Button>
        </>
      )}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save() }}>
        {error && <InlineNotice tone="risk" title="Not stored">{error}</InlineNotice>}
        <Field label="Name" required error={submitted ? errors.name : null}>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Claude production key" />
        </Field>
        <Field label="What it is for">
          <Select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
            <option value="anthropic">Anthropic — running agents on Claude</option>
            <option value="openai">OpenAI-compatible — running agents on GPT and similar</option>
            <option value="http">An external service Simeli may call</option>
          </Select>
        </Field>
        <Field label="The key" required error={submitted ? errors.secret : null} help="Encrypted immediately. It cannot be read back out, only replaced.">
          <Input type="password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} autoComplete="off" className="font-mono" />
        </Field>
        {form.provider === 'http' ? (
          <Field label="Hosts it may be sent to" help="Comma-separated. The key is only ever sent to these hosts.">
            <Input value={form.allowed_hosts} onChange={(e) => setForm({ ...form, allowed_hosts: e.target.value })} placeholder="api.stripe.com, shipping-provider.com" className="font-mono" />
          </Field>
        ) : (
          <Field label="Custom endpoint" optional>
            <Input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://…" inputMode="url" className="font-mono" />
          </Field>
        )}
      </form>
    </Dialog>
  )
}
