import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpTrayIcon, GlobeAltIcon, PencilSquareIcon, SparklesIcon, WrenchScrewdriverIcon, ArrowUturnLeftIcon } from '@heroicons/react/20/solid'
import { aiToolsAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Stat, DataTable, RowAction, Segmented, Badge, Code, InlineNotice, Menu, notify, describeError,
} from '../../components/ui'
import ToolWizard from './tool-library/ToolWizard'
import McpDiscoverPanel from './tool-library/McpDiscoverPanel'
import ToolEditor from './tool-library/ToolEditor'

const IMPACT = {
  read: { label: 'Reads only', tone: 'ink' },
  draft: { label: 'Creates drafts', tone: 'brand' },
  real: { label: 'Changes records', tone: 'warn' },
}
const impactOf = (t) => (t.read_only ? 'read' : t.high_impact ? 'real' : 'draft')

const QUICK = {
  all: { label: 'All', test: () => true },
  builtin: { label: 'Built in', test: (t) => !t.custom },
  custom: { label: 'Built here', test: (t) => t.custom },
  writing: { label: 'Change data', test: (t) => !t.read_only },
}

/**
 * Tool library — everything Simeli can call, and the ones built here.
 */
export default function ToolLibrary() {
  const [quick, setQuick] = useState('all')
  const [editing, setEditing] = useState(null)
  const [describing, setDescribing] = useState(false)
  // false = closed; '' or a string = open, prefilled with that search query
  const [discovering, setDiscovering] = useState(false)
  // null = let the panel choose (browse by default, search when prefilled)
  const [discoverTab, setDiscoverTab] = useState(null)
  const [returnNotice, setReturnNotice] = useState(null)
  const fileRef = useRef(null)

  const { data, loading, error, refetch } = useResource(keys.aiTools(), () => aiToolsAPI.catalog())
  const catalog = useMemo(() => (Array.isArray(data) ? data : []), [data])

  const invalidates = [keys.aiTools()]
  const revoke = useResourceMutation((name) => aiToolsAPI.updateSettings(name, { auto_approve: false }), { invalidates, silent: true })
  const importer = useResourceMutation((payload) => aiToolsAPI.importTool(payload), { invalidates, silent: true })

  // Coming back from an OAuth provider's consent screen. The callback route
  // redirects here with the outcome in the query string — say so on the
  // screen and open the panel on the Connected tab.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const mcpOutcome = params.get('mcp_oauth')
    const connectorOutcome = params.get('connector')
    if (!mcpOutcome && !connectorOutcome) return
    if (mcpOutcome === 'connected') {
      const count = params.get('tools')
      setReturnNotice({ tone: 'ok', text: `${params.get('name') || 'Server'} connected — ${count} tool${count === '1' ? '' : 's'} available.` })
    } else if (connectorOutcome === 'connected') {
      setReturnNotice({ tone: 'ok', text: `${params.get('name') || 'App'} connected — its tools are available to Simeli.` })
    } else {
      setReturnNotice({ tone: 'risk', text: params.get('message') || 'That could not be connected.' })
    }
    setDiscoverTab('connected')
    setDiscovering('')
    window.history.replaceState({}, '', window.location.pathname)
  }, [])

  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, catalog.filter(q.test).length])), [catalog])

  const importTool = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const payload = JSON.parse(await file.text())
      await importer.mutateAsync(payload)
      notify.success('Imported — review the code, then enable it')
    } catch (err) {
      notify.error(`Could not import that file — ${describeError(err).message}`)
    } finally {
      event.target.value = ''
    }
  }

  const columns = useMemo(() => [
    {
      id: 'name', header: 'Tool', accessor: 'name', mobile: 'title', minWidth: 260,
      cell: (tool) => (
        <span className="block min-w-0">
          <Code className="text-fg">{tool.name}</Code>
          <span className="mt-0.5 block line-clamp-2 whitespace-normal text-xs text-ink-600">{tool.description}</span>
          {Object.keys(tool.input_schema?.properties || {}).length > 0 && (
            <span className="mt-0.5 block truncate font-mono text-2xs text-ink-500">({Object.keys(tool.input_schema.properties).join(', ')})</span>
          )}
        </span>
      ),
      exportValue: (tool) => tool.name,
    },
    {
      id: 'impact', header: 'Effect', accessor: (t) => IMPACT[impactOf(t)].label, filter: 'select', width: 150, mobile: 'meta',
      cell: (t) => <Badge tone={IMPACT[impactOf(t)].tone}>{IMPACT[impactOf(t)].label}</Badge>,
    },
    {
      id: 'source', header: 'Source', accessor: (t) => (t.custom ? 'Built here' : t.external ? 'External' : 'Built in'), filter: 'select', width: 130,
      cell: (t) => (t.custom ? <span>Built here <Code className="text-ink-500">v{t.version}</Code></span> : t.external ? 'External' : 'Built in'),
    },
    {
      id: 'state', header: 'State', accessor: (t) => (t.enabled ? 'On' : 'Off'), filter: 'select', width: 170,
      cell: (t) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={t.enabled ? 'ok' : 'ink'} glyph={t.enabled ? 'dot' : 'ring'}>{t.enabled ? 'On' : 'Off'}</Badge>
          {t.auto_approve && <Badge tone="warn">Always allowed</Badge>}
        </span>
      ),
    },
    { id: 'role', header: 'Minimum role', accessor: 'min_role', width: 130, cell: (t) => (t.min_role ? `${t.min_role}+` : '—'), defaultHidden: true },
  ], [])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tool library"
        description="Everything Simeli can call, what each one changes, and the tools built here."
        secondary={(
          <>
            <Button icon={GlobeAltIcon} onClick={() => setDiscovering('')}>Discover</Button>
            <Menu
              label="More"
              items={[
                { label: 'Import a tool (JSON)', icon: ArrowUpTrayIcon, onSelect: () => fileRef.current?.click() },
                { label: 'Refresh', onSelect: () => refetch() },
              ]}
            />
          </>
        )}
        primary={<Button variant="primary" icon={SparklesIcon} onClick={() => setDescribing(true)}>Build a tool</Button>}
      />
      <input ref={fileRef} type="file" accept="application/json" onChange={importTool} className="hidden" aria-label="Import a tool from a JSON file" />

      {returnNotice && (
        <InlineNotice tone={returnNotice.tone} title={returnNotice.tone === 'ok' ? 'Connected' : 'Not connected'} action={<Button size="sm" variant="ghost" onClick={() => setReturnNotice(null)}>Dismiss</Button>}>
          {returnNotice.text}
        </InlineNotice>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Tools available" loading={loading} value={catalog.length.toLocaleString()} />
        <Stat label="Built here" loading={loading} value={counts.custom.toLocaleString()} />
        <Stat label="Change data" loading={loading} value={counts.writing.toLocaleString()} />
        <Stat label="Turned off" loading={loading} value={catalog.filter((t) => !t.enabled).length.toLocaleString()} />
      </div>

      <DataTable
        viewKey="ai.tools"
        caption="Tools"
        noun="tool"
        rows={catalog}
        columns={columns}
        rowKey={(t) => t.name}
        loading={loading}
        error={error}
        onRetry={refetch}
        externalFilter={QUICK[quick].test}
        searchPlaceholder="Search tools"
        onRowClick={(t) => (t.custom ? setEditing({ name: t.name }) : undefined)}
        toolbarStart={(
          <Segmented
            label="Show"
            value={quick}
            onChange={setQuick}
            options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
            className="max-w-full overflow-x-auto"
          />
        )}
        rowActions={(tool) => (
          <>
            {tool.auto_approve && (
              <RowAction
                icon={ArrowUturnLeftIcon}
                label={`Make ${tool.name} ask before running`}
                onClick={async () => {
                  try {
                    await revoke.mutateAsync(tool.name)
                    notify.success(`${tool.name} will ask before running again`)
                  } catch (err) {
                    notify.error(`Could not revoke that — ${describeError(err).message}`)
                  }
                }}
              />
            )}
            {tool.custom && <RowAction icon={PencilSquareIcon} label={`Edit ${tool.name}`} onClick={() => setEditing({ name: tool.name })} />}
          </>
        )}
        empty={{
          icon: WrenchScrewdriverIcon,
          title: 'No tools match',
          description: 'Build one from a description, or discover a connector or MCP server.',
          action: <Button variant="primary" icon={SparklesIcon} onClick={() => setDescribing(true)}>Build a tool</Button>,
        }}
      />

      {describing && (
        <ToolWizard
          onClose={() => setDescribing(false)}
          onSaved={() => { setDescribing(false); refetch() }}
          onHandOff={(tool, sampleInput) => {
            setDescribing(false)
            setEditing({ isNew: true, initial: tool, initialInput: sampleInput })
          }}
          onOpenDiscover={(query) => {
            setDescribing(false)
            setDiscovering(query || '')
          }}
        />
      )}

      {discovering !== false && (
        <McpDiscoverPanel
          initialQuery={discovering || ''}
          initialTab={discoverTab}
          onClose={() => { setDiscovering(false); setDiscoverTab(null) }}
        />
      )}

      {editing && (
        <ToolEditor
          toolName={editing.isNew ? null : editing.name}
          initial={editing.initial}
          initialInput={editing.initialInput}
          allTools={catalog}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refetch() }}
        />
      )}
    </div>
  )
}
