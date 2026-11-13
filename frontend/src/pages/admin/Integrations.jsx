import { useMemo, useState } from 'react'
import { PlusIcon, TrashIcon, PauseIcon, PlayIcon, KeyIcon, SignalIcon, ClipboardIcon } from '@heroicons/react/20/solid'
import { apiKeysAPI, webhooksAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import {
  PageHeader, Button, Tabs, DataTable, RowAction, StatusBadge, Badge, Code, DateText, ConfirmDialog, Dialog,
  Field, Input, Select, Checkbox, ErrorSummary, InlineNotice, notify, describeError,
} from '../../components/ui'

/**
 * Integrations — machine credentials (API keys) and outbound event delivery
 * (webhooks). Both secrets are stored hashed and shown exactly once.
 */

const SCOPES = [
  { key: 'read', label: 'Read', hint: 'Fetch data' },
  { key: 'write', label: 'Write', hint: 'Create and change records' },
]

const KEYS_KEY = ['api-keys']
const HOOKS_KEY = ['webhooks']

export default function Integrations() {
  const [tab, setTab] = useState('keys')
  const [createOpen, setCreateOpen] = useState(null) // 'keys' | 'webhooks'
  const [revealed, setRevealed] = useState(null) // { kind, secret }

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Machine credentials and outbound event delivery."
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setCreateOpen(tab)}>{tab === 'keys' ? 'New API key' : 'New webhook'}</Button>}
      />

      <Tabs
        value={tab}
        onChange={setTab}
        label="Integration types"
        tabs={[{ id: 'keys', label: 'API keys' }, { id: 'webhooks', label: 'Webhooks' }]}
      >
        {(t) => (t === 'keys'
          ? <ApiKeys onCreate={() => setCreateOpen('keys')} />
          : <Webhooks onCreate={() => setCreateOpen('webhooks')} />)}
      </Tabs>

      {createOpen === 'keys' && (
        <CreateKeyDialog onClose={() => setCreateOpen(null)} onCreated={(data) => { setCreateOpen(null); setRevealed({ kind: 'key', secret: data.key }) }} />
      )}
      {createOpen === 'webhooks' && (
        <CreateWebhookDialog onClose={() => setCreateOpen(null)} onCreated={(data) => { setCreateOpen(null); setRevealed({ kind: 'webhook', secret: data.secret }) }} />
      )}

      {revealed && (
        <SecretDialog
          title={revealed.kind === 'key' ? 'Your new API key' : 'Your webhook signing secret'}
          secret={revealed.secret}
          note={revealed.kind === 'key'
            ? 'This is the only time it is shown. It is stored hashed — if it is lost, revoke the key and create another.'
            : 'This is the only time it is shown. Use it to verify the X-Webhook-Signature header on every delivery — without it, anything could post to your endpoint claiming to be this ERP.'}
          onClose={() => setRevealed(null)}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

const isExpired = (k) => k.expires_at && new Date(k.expires_at) < new Date()
const keyState = (k) => (k.status !== 'ACTIVE' ? 'Revoked' : isExpired(k) ? 'Expired' : 'Active')

function ApiKeys({ onCreate }) {
  const [confirm, setConfirm] = useState(null)
  const { data, loading, error, refetch } = useResource(KEYS_KEY, () => apiKeysAPI.list())
  const keys = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const revoke = useResourceMutation((id) => apiKeysAPI.revoke(id), { invalidates: [KEYS_KEY], silent: true })

  const columns = useMemo(() => [
    { id: 'name', header: 'Name', accessor: 'name', mobile: 'title', minWidth: 180, cell: (k) => <span className="font-medium text-fg">{k.name}</span> },
    // Only the prefix is stored in the clear; the rest is hashed and was shown once at creation.
    { id: 'prefix', header: 'Key', accessor: 'key_prefix', width: 140, mobile: 'subtitle', cell: (k) => <Code className="text-ink-600">{k.key_prefix}…</Code> },
    { id: 'scopes', header: 'Scopes', accessor: (k) => (k.scopes || []).join(', '), width: 140, cell: (k) => <span className="flex gap-1">{(k.scopes || []).map((s) => <Badge key={s} mono>{s}</Badge>)}</span> },
    { id: 'role', header: 'Acts as', accessor: 'role', filter: 'select', width: 110, cell: (k) => <span className="font-mono text-xs">{k.role}</span> },
    { id: 'lastUsed', header: 'Last used', accessor: 'last_used_at', width: 170, cell: (k) => (k.last_used_at ? <DateText value={k.last_used_at} withTime /> : <span className="text-ink-500">Never</span>) },
    { id: 'expires', header: 'Expires', accessor: 'expires_at', width: 120, defaultHidden: true, cell: (k) => (k.expires_at ? <DateText value={k.expires_at} /> : <span className="text-ink-500">Never</span>) },
    {
      id: 'status', header: 'Status', accessor: keyState, filter: 'select', width: 110, mobile: 'meta',
      cell: (k) => <StatusBadge status={keyState(k) === 'Revoked' ? 'CANCELLED' : keyState(k) === 'Expired' ? 'EXPIRED' : 'ACTIVE'} label={keyState(k)} />,
    },
  ], [])

  const run = async () => {
    const k = confirm
    try {
      await revoke.mutateAsync(k.id)
      setConfirm(null)
    } catch (e) {
      setConfirm(null)
      notify.error(`${k.name} was not revoked — ${describeError(e).message}`)
    }
  }

  return (
    <>
      <p className="mb-3 text-sm text-ink-600">Keys authenticate machines rather than people. Each is scoped and can be revoked on its own.</p>
      <DataTable
        viewKey="admin.integrations.api-keys"
        caption="API keys"
        noun="key"
        rows={keys}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        defaultSort={{ id: 'name', dir: 'asc' }}
        rowClassName={(k) => (keyState(k) === 'Active' ? undefined : 'text-ink-500')}
        rowActions={(k) => keyState(k) !== 'Revoked' && <RowAction icon={TrashIcon} tone="risk" label={`Revoke ${k.name}`} onClick={() => setConfirm(k)} />}
        empty={{
          icon: KeyIcon,
          title: 'No API keys',
          description: 'Create one to let another system read or write here. Name it after what will use it — that is what makes it safe to revoke later.',
          action: <Button variant="primary" icon={PlusIcon} onClick={onCreate}>New API key</Button>,
        }}
      />
      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title={`Revoke ${confirm.name}?`}
          consequence="Anything using this key stops working immediately. A revoked key cannot be restored — the system using it needs a new key."
          confirmLabel={`Revoke ${confirm.name}`}
          busy={revoke.isPending}
        />
      )}
    </>
  )
}

const KEY_RULES = {
  name: (v) => (!String(v || '').trim() ? 'Give the key a name.' : null),
  scopes: (v) => (!v?.length ? 'A key with no scopes can do nothing — pick at least one.' : null),
}

function CreateKeyDialog({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', scopes: ['read'], role: 'USER', expires_at: '' })
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)
  const errors = Object.fromEntries(Object.entries(KEY_RULES).map(([k, r]) => [k, r(form[k])]).filter(([, m]) => m))
  const [nameTouched, setNameTouched] = useState(false)
  const create = useResourceMutation((payload) => apiKeysAPI.create(payload), { invalidates: [KEYS_KEY], silent: true })

  const toggleScope = (s) => setForm({ ...form, scopes: form.scopes.includes(s) ? form.scopes.filter((x) => x !== s) : [...form.scopes, s] })

  const save = async () => {
    setSubmitted(true)
    if (Object.keys(errors).length) return
    setServerError(null)
    try {
      const data = await create.mutateAsync({ name: form.name.trim(), scopes: form.scopes, role: form.role, expires_at: form.expires_at || null })
      onCreated(data || {})
    } catch (e) {
      setServerError(describeError(e).message)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="New API key"
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={create.isPending}>Create key</Button>
        </>
      }
    >
      <div className="space-y-4">
        {submitted && <ErrorSummary errors={Object.fromEntries(Object.entries(errors).map(([k, v]) => [`key-${k}`, v]))} />}
        {serverError && <InlineNotice tone="risk" title="Not created">{serverError}</InlineNotice>}
        <Field label="Name" required id="key-name" error={(submitted || nameTouched) ? errors.name : null} help="Name it after what will use it — that is what makes it safe to revoke later.">
          <Input value={form.name} onBlur={() => setNameTouched(true)} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Warehouse scanner integration" />
        </Field>
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink-800">Scopes</legend>
          <div className="space-y-2" id="key-scopes" tabIndex={-1}>
            {SCOPES.map((s) => (
              <Checkbox key={s.key} label={s.label} description={s.hint} checked={form.scopes.includes(s.key)} onChange={() => toggleScope(s.key)} />
            ))}
          </div>
          {submitted && errors.scopes && <p className="mt-1 text-xs text-risk-600">{errors.scopes}</p>}
        </fieldset>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Acts as role" help="The key can do what a person with this role can.">
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {['USER', 'MANAGER', 'ADMIN'].map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
          </Field>
          <Field label="Expires" optional help="A key with no expiry stays valid until it is revoked.">
            <Input type="date" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
          </Field>
        </div>
      </div>
    </Dialog>
  )
}

/**
 * A secret shown once.
 *
 * Both API keys and webhook secrets are stored hashed, so this dialog is the
 * only moment the value exists anywhere the user can reach. It is blocking,
 * with an explicit acknowledgement, rather than a toast: a dismissable
 * notification is the wrong shape for something that cannot be recovered.
 */
function SecretDialog({ title, secret, note, onClose }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopyFailed(true)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={false}
      title={title}
      footer={<Button variant="primary" onClick={onClose} disabled={!acknowledged}>Done</Button>}
    >
      <div className="space-y-3">
        <InlineNotice tone="warn">{note}</InlineNotice>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 select-all break-all rounded-md border border-ink-200 bg-sunken px-3 py-2 font-mono text-xs">{secret || '(not returned)'}</code>
          <Button icon={ClipboardIcon} onClick={copy} disabled={!secret}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
        {copyFailed && <p className="text-xs text-risk-600">Could not copy — select the value and copy it manually.</p>}
        <Checkbox label="I have saved this somewhere safe" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function Webhooks({ onCreate }) {
  const [confirm, setConfirm] = useState(null)
  const { data, loading, error, refetch } = useResource(HOOKS_KEY, () => webhooksAPI.list())
  const hooks = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const toggle = useResourceMutation((h) => webhooksAPI.update(h.id, { status: h.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }), { invalidates: [HOOKS_KEY] })
  const remove = useResourceMutation((id) => webhooksAPI.remove(id), { invalidates: [HOOKS_KEY], silent: true })

  const columns = useMemo(() => [
    { id: 'url', header: 'Endpoint', accessor: 'url', mobile: 'title', minWidth: 240, maxWidth: 420, cell: (h) => <Code className="block truncate text-fg">{h.url}</Code> },
    {
      id: 'events', header: 'Events', accessor: (h) => (h.event_types || []).join(', '), minWidth: 200, mobile: 'subtitle',
      cell: (h) => <span className="block truncate font-mono text-xs text-ink-600" title={(h.event_types || []).join(', ')}>{(h.event_types || []).join(', ')}</span>,
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 120, mobile: 'meta', cell: (h) => <StatusBadge status={h.status} /> },
    {
      id: 'last', header: 'Last delivery', accessor: 'last_delivery_at', width: 220, mobile: 'trailing',
      cell: (h) => (h.last_delivery_at ? (
        <span className="flex items-center gap-1.5">
          <DateText value={h.last_delivery_at} withTime />
          {h.last_delivery_status && (
            <span className={`font-mono text-2xs ${Number(h.last_delivery_status) >= 400 ? 'text-risk-600' : 'text-ok-600'}`}>
              {Number(h.last_delivery_status) >= 400 ? '✕' : '✓'} {h.last_delivery_status}
            </span>
          )}
        </span>
      ) : <span className="text-ink-500">Never delivered</span>),
    },
  ], [])

  const run = async () => {
    const h = confirm
    try {
      await remove.mutateAsync(h.id)
      setConfirm(null)
    } catch (e) {
      setConfirm(null)
      notify.error(`Not deleted — ${describeError(e).message}`)
    }
  }

  return (
    <>
      <p className="mb-3 text-sm text-ink-600">Events posted to a URL you control, signed so the receiver can verify they came from here.</p>
      <DataTable
        viewKey="admin.integrations.webhooks"
        caption="Webhook subscriptions"
        noun="subscription"
        rows={hooks}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowClassName={(h) => (h.status === 'ACTIVE' ? undefined : 'text-ink-500')}
        rowActions={(h) => (
          <>
            <RowAction icon={h.status === 'ACTIVE' ? PauseIcon : PlayIcon} label={h.status === 'ACTIVE' ? `Disable ${h.url}` : `Enable ${h.url}`} disabled={toggle.isPending} onClick={() => toggle.mutate(h)} />
            <RowAction icon={TrashIcon} tone="risk" label={`Delete ${h.url}`} onClick={() => setConfirm(h)} />
          </>
        )}
        empty={{
          icon: SignalIcon,
          title: 'No webhook subscriptions',
          description: 'Register a URL to be told when journal entries post or orders complete.',
          action: <Button variant="primary" icon={PlusIcon} onClick={onCreate}>New webhook</Button>,
        }}
      />
      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title="Delete this webhook subscription?"
          consequence={`${confirm.url} stops receiving events, and its delivery history is deleted too. Disable it instead if you may want it back.`}
          confirmLabel="Delete subscription"
          busy={remove.isPending}
        />
      )}
    </>
  )
}

function CreateWebhookDialog({ onClose, onCreated }) {
  const [form, setForm] = useState({ url: '', event_types: [] })
  const [submitted, setSubmitted] = useState(false)
  const [urlTouched, setUrlTouched] = useState(false)
  const [serverError, setServerError] = useState(null)
  const events = useResource([...HOOKS_KEY, 'event-types'], () => webhooksAPI.eventTypes())
  const eventTypes = Array.isArray(events.data) ? events.data : []
  const create = useResourceMutation((payload) => webhooksAPI.create(payload), { invalidates: [HOOKS_KEY], silent: true })

  const errors = {}
  if (!form.url.trim()) errors.url = 'Give the endpoint URL.'
  else if (!/^https?:\/\//i.test(form.url.trim())) errors.url = 'The URL must start with http:// or https://.'
  if (form.event_types.length === 0) errors.events = 'Pick at least one event.'

  const toggleEvent = (t) => setForm({ ...form, event_types: form.event_types.includes(t) ? form.event_types.filter((x) => x !== t) : [...form.event_types, t] })

  const save = async () => {
    setSubmitted(true)
    if (Object.keys(errors).length) return
    setServerError(null)
    try {
      const data = await create.mutateAsync({ url: form.url.trim(), event_types: form.event_types })
      onCreated(data || {})
    } catch (e) {
      setServerError(describeError(e).message)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="New webhook"
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={create.isPending}>Create webhook</Button>
        </>
      }
    >
      <div className="space-y-4">
        {submitted && <ErrorSummary errors={Object.fromEntries(Object.entries(errors).map(([k, v]) => [`hook-${k}`, v]))} />}
        {serverError && <InlineNotice tone="risk" title="Not created">{serverError}</InlineNotice>}
        <Field label="Endpoint URL" required id="hook-url" error={(submitted || urlTouched) ? errors.url : null}>
          <Input value={form.url} onBlur={() => setUrlTouched(true)} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/hooks/embmis" className="font-mono" />
        </Field>
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink-800">Events</legend>
          <div id="hook-events" tabIndex={-1} className="max-h-60 space-y-1.5 overflow-y-auto ui-scroll">
            {events.loading && <p className="text-xs text-ink-500">Loading event types…</p>}
            {events.error && <p className="text-xs text-risk-600">Event types did not load — {describeError(events.error).message}</p>}
            {!events.loading && !events.error && eventTypes.length === 0 && <p className="text-xs text-ink-500">No event types available.</p>}
            {eventTypes.map((t) => (
              <Checkbox key={t} label={<span className="font-mono text-xs">{t}</span>} checked={form.event_types.includes(t)} onChange={() => toggleEvent(t)} />
            ))}
          </div>
          {submitted && errors.events && <p className="mt-1 text-xs text-risk-600">{errors.events}</p>}
        </fieldset>
      </div>
    </Dialog>
  )
}
