import React, { useMemo, useState } from 'react'
import { ArrowPathIcon, MagnifyingGlassIcon, PlusIcon, TrashIcon } from '@heroicons/react/20/solid'
import { mcpAPI, connectorsAPI } from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import {
  Sheet, Tabs, Button, Input, Segmented, Badge, Code, InlineNotice, SkeletonRows, EmptyState, ConfirmDialog,
  ErrorState, notify, describeError,
} from '../../../components/ui'
import SourceLink from './SourceLink'
import McpSetupDialog, { CUSTOM_CANDIDATE } from './McpSetupDialog'
import ConnectorSetupDialog from './ConnectorSetupDialog'

const MCP_EXAMPLES = [
  'process Stripe payments',
  'sync with QuickBooks',
  'search the web',
  'send SMS notifications',
]

const MCP_STATUS = {
  connected: { label: 'Connected', tone: 'ok' },
  pending_auth: { label: 'Needs sign-in', tone: 'warn' },
  error: { label: 'Not working', tone: 'risk' },
  disconnected: { label: 'Disconnected', tone: 'ink' },
}

const AUTH_LABEL = { oauth: 'Sign in', api_key: 'API key', none: 'No key needed' }

const MCP_KEYS = {
  connections: ['mcp', 'connections'],
  catalog: ['mcp', 'catalog'],
  providers: ['connectors', 'providers'],
  connectors: ['connectors', 'list'],
}

/** The tools a server says it offers, as identifiers. */
function ToolChips({ names = [], title }) {
  if (!names.length) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={title || 'Tools'}>
      {names.slice(0, 6).map((n) => <li key={typeof n === 'string' ? n : n.name} title={n.description || ''}><Code>{typeof n === 'string' ? n : n.name}</Code></li>)}
      {names.length > 6 && <li className="text-2xs text-ink-500">+{names.length - 6} more</li>}
    </ul>
  )
}

/** One server, app or connection: what it is, then its actions on the right. */
function Row({ title, badges, children, actions }) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-ink-200 bg-surface px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold text-fg">{title}</p>
          {badges}
        </div>
        {children}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">{actions}</div>}
    </li>
  )
}

const candidateFrom = (s) => ({
  name: s.name,
  description: s.description,
  category: s.category,
  endpoint_url: s.endpoint_url,
  url_or_package: s.url_or_package,
  tools_preview: s.tools_preview,
  verified: true,
  needs_auth: s.auth !== 'none',
  suggested_auth: s.auth,
})

/**
 * Search for external MCP servers and app connectors, and connect them.
 *
 * "Connect" is two steps on purpose. A discovery result gives a name and a
 * link, but the link is often a documentation page rather than the server's
 * MCP address. So picking a result opens a setup step — real endpoint, how it
 * authenticates — and only the handshake that follows puts any tool in front
 * of Simeli.
 */
export default function McpDiscoverPanel({ initialQuery, initialTab, onClose }) {
  const [tab, setTab] = useState(initialTab || (initialQuery ? 'search' : 'apps'))
  const [catFilter, setCatFilter] = useState('erp')
  const [catSearch, setCatSearch] = useState('')
  const [connectorFor, setConnectorFor] = useState(null)
  const [query, setQuery] = useState(initialQuery || '')
  // The query actually searched. Set from the box on submit, and from the
  // hand-off ("try connecting X") so that search runs without retyping.
  const [submitted, setSubmitted] = useState(initialQuery?.trim().length >= 2 ? initialQuery.trim() : null)
  const [setupFor, setSetupFor] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [confirm, setConfirm] = useState(null) // { kind: 'mcp'|'app', id, name }
  const [notice, setNotice] = useState(null)

  const connectionsQ = useResource(MCP_KEYS.connections, () => mcpAPI.connections())
  const catalogQ = useResource(MCP_KEYS.catalog, () => mcpAPI.catalog(), { retry: false })
  const providersQ = useResource(MCP_KEYS.providers, () => connectorsAPI.providers(), { retry: false })
  const connectorsQ = useResource(MCP_KEYS.connectors, () => connectorsAPI.list(), { retry: false })
  const searchQ = useResource(['mcp', 'discover', submitted], () => mcpAPI.discover(submitted), { enabled: !!submitted, retry: false, staleTime: 5 * 60 * 1000 })

  const connections = Array.isArray(connectionsQ.data) ? connectionsQ.data : []
  const catalog = catalogQ.data?.servers || []
  const providers = providersQ.data?.providers || []
  const redirectUri = providersQ.data?.redirect_uri || ''
  const connectorRows = Array.isArray(connectorsQ.data) ? connectorsQ.data : []
  const connectedApps = connectorRows.filter((c) => c.status === 'connected')
  const results = submitted ? (Array.isArray(searchQ.data) ? searchQ.data : null) : null

  const invalidates = [MCP_KEYS.connections, MCP_KEYS.connectors]
  const disconnectMcp = useResourceMutation((id) => mcpAPI.disconnect(id), { invalidates, silent: true })
  const disconnectApp = useResourceMutation((id) => connectorsAPI.disconnect(id), { invalidates, silent: true })
  const sync = useResourceMutation((id) => mcpAPI.syncTools(id), { invalidates, silent: true })

  const shownCatalog = useMemo(() => {
    const needle = catSearch.trim().toLowerCase()
    return catalog.filter((s) => {
      if (catFilter === 'erp' && !s.erp) return false
      if (catFilter !== 'erp' && catFilter !== 'all' && s.category !== catFilter) return false
      if (!needle) return true
      return `${s.name} ${s.description} ${s.category} ${(s.tools_preview || []).join(' ')}`.toLowerCase().includes(needle)
    })
  }, [catalog, catFilter, catSearch])

  const shownProviders = providers.filter((p) => (catFilter === 'erp' ? p.erp : catFilter === 'all' ? true : p.category === catFilter))

  const filterOptions = (items) => [
    { value: 'erp', label: 'For an ERP' },
    { value: 'all', label: 'Everything' },
    ...[...new Set(items.map((x) => x.category).filter(Boolean))].sort().map((c) => ({ value: c, label: c })),
  ]

  const search = () => {
    const q = query.trim()
    if (q.length < 2) return
    setSubmitted(q)
  }

  const onSetupDone = (message) => {
    setSetupFor(null)
    if (message) setNotice(message)
    connectionsQ.refetch()
    setTab('connected')
  }

  /** Finish (or restart) a sign-in for a connection waiting on authorization. */
  const signIn = async (connection) => {
    setBusyId(connection.id)
    try {
      const res = await mcpAPI.authorizeUrl(connection.id)
      const url = res.data?.data?.authorization_url
      if (!url) throw new Error('That server is already authorized — try syncing its tools.')
      window.location.href = url
    } catch (err) {
      notify.error(describeError(err).message || 'Could not start sign-in')
      setBusyId(null)
    }
  }

  const syncTools = async (connection) => {
    setBusyId(connection.id)
    try {
      const data = await sync.mutateAsync(connection.id)
      const count = data?.tools_count ?? 0
      setNotice(`${connection.name}: ${count} tool${count === 1 ? '' : 's'} available to Simeli.`)
    } catch (err) {
      notify.error(`Could not reach ${connection.name} — ${describeError(err).message}`)
    } finally {
      setBusyId(null)
    }
  }

  const runDisconnect = async () => {
    const { kind, id, name } = confirm
    try {
      if (kind === 'mcp') await disconnectMcp.mutateAsync(id)
      else await disconnectApp.mutateAsync(id)
      setNotice(`Disconnected ${name}.`)
    } catch (err) {
      notify.error(`Could not disconnect ${name} — ${describeError(err).message}`)
    } finally {
      setConfirm(null)
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      width="xl"
      title="Discover tools"
      description="Connect apps and MCP servers. Their tools become available to Simeli after a real handshake."
    >
      <div className="space-y-4 p-4">
        <Tabs
          value={tab}
          onChange={setTab}
          label="Discover"
          tabs={[
            { id: 'apps', label: 'Apps', count: providers.length },
            { id: 'browse', label: 'MCP servers', count: catalog.length },
            { id: 'search', label: 'Search the web' },
            { id: 'connected', label: 'Connected', count: connections.length + connectedApps.length },
          ]}
        />

        {notice && (
          <InlineNotice tone="ok" action={<Button size="sm" variant="ghost" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</InlineNotice>
        )}

        {tab === 'apps' && (
          <>
            <p className="text-sm text-ink-600">Sign in with the product itself. Each app gets its own ready-made tools plus direct API access.</p>
            <Segmented label="Category" value={catFilter} onChange={setCatFilter} options={filterOptions(providers)} className="max-w-full overflow-x-auto" />
            {providersQ.loading ? <SkeletonRows rows={4} columns={2} /> : providersQ.error ? (
              <ErrorState error={providersQ.error} what="App connectors" onRetry={providersQ.refetch} compact />
            ) : shownProviders.length === 0 ? (
              <EmptyState compact title="No apps in this category" description="Choose Everything to see all of them." />
            ) : (
              <ul className="space-y-2">
                {shownProviders.map((p) => {
                  const existing = connectorRows.find((c) => c.provider === p.key && c.status === 'connected')
                  // The same product as a one-click MCP server, where one exists:
                  // preferred, because it needs nothing set up in a developer console.
                  const viaMcp = p.mcp_alternative ? catalog.find((s) => s.name === p.mcp_alternative) : null
                  return (
                    <Row
                      key={p.key}
                      title={p.name}
                      badges={<>{p.category && <Badge>{p.category}</Badge>}{existing && <Badge tone="ok" glyph="dot">Connected</Badge>}</>}
                      actions={existing ? (
                        <Button size="sm" variant="destructive" icon={TrashIcon} onClick={() => setConfirm({ kind: 'app', id: existing.id, name: p.name })}>Disconnect</Button>
                      ) : viaMcp ? (
                        <>
                          <Button size="sm" variant="primary" onClick={() => setSetupFor(candidateFrom(viaMcp))}>Connect</Button>
                          <Button size="sm" variant="link" onClick={() => setConnectorFor(p)}>Use my own OAuth app</Button>
                        </>
                      ) : (
                        <Button size="sm" onClick={() => setConnectorFor(p)}>Set up</Button>
                      )}
                    >
                      <p className="mt-1 text-sm text-ink-600">{p.description}</p>
                      {p.tool_count > 0 && <p className="mt-1 text-xs text-ink-500">{p.tool_count} ready-made tool{p.tool_count === 1 ? '' : 's'}, plus direct API access</p>}
                      {viaMcp && !existing && <p className="mt-1 text-xs text-ink-600">Also has an MCP server — connect in one step, no developer console.</p>}
                    </Row>
                  )
                })}
              </ul>
            )}
          </>
        )}

        {tab === 'browse' && (
          <>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={catSearch}
                onChange={(e) => setCatSearch(e.target.value)}
                placeholder="Filter the list"
                aria-label="Filter MCP servers"
                className="flex-1"
                prefix={<MagnifyingGlassIcon className="h-3.5 w-3.5" aria-hidden="true" />}
              />
              {/* The escape hatch: an internal server, or anything not on the list. */}
              <Button icon={PlusIcon} onClick={() => setSetupFor({ ...CUSTOM_CANDIDATE })}>Add your own</Button>
            </div>
            <Segmented label="Category" value={catFilter} onChange={setCatFilter} options={filterOptions(catalog)} className="max-w-full overflow-x-auto" />
            <p className="text-xs text-ink-500">Everything here connects directly — nothing to install on this server.</p>
            {catalogQ.loading ? <SkeletonRows rows={4} columns={2} /> : shownCatalog.length === 0 ? (
              <EmptyState compact title="Nothing matches that filter" description="Clear the filter, or add your own server." />
            ) : (
              <ul className="space-y-2">
                {shownCatalog.map((s) => (
                  <Row
                    key={s.name}
                    title={s.name}
                    badges={<>{s.category && <Badge>{s.category}</Badge>}<Badge tone={s.auth === 'api_key' ? 'warn' : 'ink'}>{AUTH_LABEL[s.auth] || s.auth}</Badge></>}
                    actions={<Button size="sm" variant="primary" onClick={() => setSetupFor(candidateFrom(s))}>Connect</Button>}
                  >
                    <p className="mt-1 text-sm text-ink-600">{s.description}</p>
                    <ToolChips names={s.tools_preview || []} />
                  </Row>
                ))}
              </ul>
            )}
          </>
        )}

        {tab === 'search' && (
          <>
            <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); search() }}>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Describe what you need"
                aria-label="Describe what you need"
                size="lg"
                className="flex-1"
              />
              <Button type="submit" size="lg" icon={MagnifyingGlassIcon} loading={searchQ.isFetching} disabled={query.trim().length < 2}>Search</Button>
            </form>

            {!submitted && (
              <div>
                <p className="label-mono mb-2">Or try one of these</p>
                <ul className="flex flex-wrap gap-2">
                  {MCP_EXAMPLES.map((example) => (
                    <li key={example}>
                      <button type="button" onClick={() => { setQuery(example); setSubmitted(example) }} className="rounded-md border border-ink-200 px-3 py-1.5 text-sm text-ink-700 hover:border-ink-300 hover:bg-ink-50">
                        {example}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {submitted && searchQ.loading && <p role="status" className="py-6 text-center text-sm text-ink-500">Searching the registry and the web…</p>}
            {submitted && searchQ.error && <ErrorState error={searchQ.error} what="The search" onRetry={searchQ.refetch} compact />}
            {results && results.length === 0 && (
              <EmptyState compact title="No MCP servers matched" description="Try other words, or add your own server from the MCP servers tab." />
            )}
            {results && results.length > 0 && (
              <ul className="space-y-2">
                {results.map((r) => (
                  <Row
                    key={r.url_or_package || r.name}
                    title={r.name}
                    badges={(
                      <>
                        {r.category && <Badge>{r.category}</Badge>}
                        {/* Whether it could actually be reached, decided by trying. */}
                        {r.verified && <Badge tone="ok" glyph="check">Connects</Badge>}
                        {!r.verified && r.needs_auth && <Badge tone="warn">Needs sign-in</Badge>}
                        {!r.verified && !r.needs_auth && r.kind === 'local' && <Badge>Runs locally</Badge>}
                      </>
                    )}
                    actions={<Button size="sm" variant={r.verified ? 'primary' : 'secondary'} onClick={() => setSetupFor(r)}>{r.verified ? 'Connect' : 'Set up'}</Button>}
                  >
                    <p className="mt-1 line-clamp-2 text-sm text-ink-600">{r.description}</p>
                    <SourceLink url={r.endpoint_url || r.url_or_package} />
                    {!r.endpoint_url && r.install_command && <p className="mt-1 font-mono text-xs text-ink-500">{r.install_command}</p>}
                    <ToolChips names={r.tools_preview || []} />
                  </Row>
                ))}
              </ul>
            )}
          </>
        )}

        {tab === 'connected' && (
          <>
            {connectionsQ.loading && <SkeletonRows rows={3} columns={2} />}
            {connectionsQ.error && <ErrorState error={connectionsQ.error} what="Connected servers" onRetry={connectionsQ.refetch} compact />}

            {connectedApps.length > 0 && (
              <section className="space-y-2" aria-label="Apps">
                <p className="label-mono">Apps</p>
                <ul className="space-y-2">
                  {connectedApps.map((c) => (
                    <Row
                      key={c.id}
                      title={c.label}
                      badges={<><Badge tone="ok" glyph="dot">Connected</Badge><Badge>Signed in</Badge></>}
                      actions={<Button size="sm" variant="destructive" icon={TrashIcon} onClick={() => setConfirm({ kind: 'app', id: c.id, name: c.label })}>Disconnect</Button>}
                    >
                      {c.last_error && <p className="mt-1 text-xs text-risk-700">{c.last_error}</p>}
                    </Row>
                  ))}
                </ul>
              </section>
            )}

            {!connectionsQ.loading && !connectionsQ.error && connections.length === 0 && connectedApps.length === 0 && (
              <EmptyState compact title="Nothing connected yet" description="Start from Apps or MCP servers." />
            )}

            {connections.length > 0 && (
              <section className="space-y-2" aria-label="MCP servers">
                <p className="label-mono">MCP servers</p>
                <p className="text-xs text-ink-500">Tools from these servers are available to Simeli, subject to the same approval rules as built-in tools.</p>
                <ul className="space-y-2">
                  {connections.map((c) => {
                    const synced = Array.isArray(c.tools_cache) ? c.tools_cache : []
                    const st = MCP_STATUS[c.status] || { label: c.status, tone: 'ink' }
                    return (
                      <Row
                        key={c.id}
                        title={c.name}
                        badges={(
                          <>
                            {c.category && <Badge>{c.category}</Badge>}
                            <Badge tone={st.tone}>{st.label}</Badge>
                            {c.auth_type && c.auth_type !== 'none' && <Badge>{c.auth_type === 'oauth' ? 'OAuth' : 'API key'}</Badge>}
                          </>
                        )}
                        actions={(
                          <>
                            {/* A sign-in started but never finished is otherwise a dead end. */}
                            {c.status === 'pending_auth' && c.auth_type === 'oauth' && (
                              <Button size="sm" variant="primary" loading={busyId === c.id} onClick={() => signIn(c)}>Sign in</Button>
                            )}
                            {c.status !== 'disconnected' && c.status !== 'pending_auth' && (
                              <Button size="sm" icon={ArrowPathIcon} loading={busyId === c.id} onClick={() => syncTools(c)}>{c.status === 'error' ? 'Retry' : 'Sync tools'}</Button>
                            )}
                            {c.status !== 'disconnected' && (
                              <Button size="sm" variant="destructive" icon={TrashIcon} onClick={() => setConfirm({ kind: 'mcp', id: c.id, name: c.name })}>Disconnect</Button>
                            )}
                          </>
                        )}
                      >
                        {c.description && <p className="mt-1 line-clamp-2 text-sm text-ink-600">{c.description}</p>}
                        <SourceLink url={c.endpoint_url || c.url_or_package} />
                        {c.last_error && <p className="mt-2 rounded border border-risk-200 bg-risk-50 px-2 py-1.5 text-xs text-risk-800">{c.last_error}</p>}
                        {synced.length > 0 ? <ToolChips names={synced} title="Synced tools" /> : (c.status === 'connected' && <p className="mt-2 text-xs text-ink-500">No tools reported by this server yet. Sync to fetch them.</p>)}
                      </Row>
                    )
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      {setupFor && <McpSetupDialog candidate={setupFor} onCancel={() => setSetupFor(null)} onDone={onSetupDone} />}

      {connectorFor && (
        <ConnectorSetupDialog
          provider={connectorFor}
          redirectUri={redirectUri}
          onCancel={() => setConnectorFor(null)}
          onDone={() => { setConnectorFor(null); connectorsQ.refetch() }}
        />
      )}

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={runDisconnect}
        title={confirm ? `Disconnect ${confirm.name}?` : ''}
        consequence="Simeli and your agents lose its tools straight away. You can connect it again later; a sign-in or key will be needed."
        reversible
        confirmLabel={confirm ? `Disconnect ${confirm.name}` : 'Disconnect'}
        busy={disconnectMcp.isPending || disconnectApp.isPending}
      />
    </Sheet>
  )
}
