import React, { useEffect, useState } from 'react'
import { ArrowDownTrayIcon, PlayIcon, TrashIcon } from '@heroicons/react/20/solid'
import { aiToolsAPI } from '../../../services/api'
import { useResource, useResourceMutation } from '../../../hooks/useResource'
import { keys } from '../../../services/queryKeys'
import {
  Dialog, Button, Tabs, Field, Input, Textarea, Select, Checkbox, ConfirmDialog, InlineNotice, SkeletonRows,
  ErrorState, DateText, Code, Badge, notify, describeError,
} from '../../../components/ui'
import SchemaEditor from './SchemaEditor'

const STARTER_CODE = `// Runs sandboxed. You get \`input\` (the arguments) and \`erp\`.
// erp.sql(text, params)      read-only SELECT, checked against an allowlist
// erp.callTool(name, args)   a read-only built-in tool you allowed below
// erp.log(...)               shows up in the test output

const { rows } = await erp.sql(
  \`SELECT c.customer_name, SUM(ci.total_amount) AS billed
     FROM customer_invoices ci
     JOIN customers c ON c.id = ci.customer_id
    WHERE ci.deleted_at IS NULL
    GROUP BY c.customer_name
    ORDER BY billed DESC
    LIMIT $1\`,
  [input.limit || 5]
);

return { top_customers: rows };`

const BLANK = {
  name: '',
  description: '',
  implementation: STARTER_CODE,
  input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'how many rows' } } },
  allowed_tools: [],
  allow_sql: true,
  timeout_ms: 5000,
  enabled: true,
}

/**
 * The editor is deliberately test-first: the run panel sits next to the code
 * and the save button says what it will do. Saving code Simeli may later call
 * unattended, without having watched it run once, is the mistake worth
 * designing against.
 */
export default function ToolEditor({ toolName, initial, initialInput, allTools, onClose, onSaved }) {
  // `initial` is a draft handed over from the wizard; starting from it rather
  // than the starter template is the point of the hand-off.
  const [form, setForm] = useState({ ...BLANK, ...(initial || {}) })
  const [testInput, setTestInput] = useState(initial ? JSON.stringify(initialInput || {}, null, 2) : '{\n  "limit": 5\n}')
  const [result, setResult] = useState(null)
  const [tab, setTab] = useState('code')
  const [seeded, setSeeded] = useState(!toolName)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState(null)
  const [nameError, setNameError] = useState(null)

  const existing = useResource([...keys.aiTools(), 'one', toolName], () => aiToolsAPI.get(toolName), { enabled: !!toolName, retry: false })
  const versionsQ = useResource([...keys.aiTools(), 'versions', toolName], () => aiToolsAPI.versions(toolName), { enabled: !!toolName, retry: false })
  const versions = Array.isArray(versionsQ.data) ? versionsQ.data : []

  // Seed the form once the stored tool arrives.
  useEffect(() => {
    if (seeded || !existing.data) return
    setForm({ ...BLANK, ...existing.data, allowed_tools: existing.data.allowed_tools || [] })
    setSeeded(true)
  }, [existing.data, seeded])

  const invalidates = [keys.aiTools()]
  const tester = useResourceMutation((payload) => aiToolsAPI.test(payload), { silent: true })
  const saver = useResourceMutation((payload) => (toolName ? aiToolsAPI.update(toolName, payload) : aiToolsAPI.create(payload)), { invalidates, silent: true })
  const remover = useResourceMutation(() => aiToolsAPI.remove(toolName), { invalidates, silent: true })
  const roller = useResourceMutation((version) => aiToolsAPI.rollback(toolName, version), { invalidates, silent: true })

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }))

  const runTest = async () => {
    setResult(null)
    let input = {}
    try {
      input = JSON.parse(testInput || '{}')
    } catch {
      setResult({ ok: false, error: 'The test input is not valid JSON.' })
      return
    }
    try {
      const data = await tester.mutateAsync({
        implementation: form.implementation,
        input,
        allowed_tools: form.allowed_tools,
        allow_sql: form.allow_sql,
        timeout_ms: form.timeout_ms,
      })
      setResult(data)
    } catch (err) {
      setResult({ ok: false, error: describeError(err).message || 'The test could not run.' })
    }
  }

  const save = async () => {
    setError(null)
    if (!form.name?.trim()) { setNameError('Give the tool a name Simeli can call it by.'); setTab('code'); return }
    try {
      await saver.mutateAsync(form)
      notify.success(toolName ? 'Tool updated — the previous version is kept' : 'Tool created. Simeli can call it now.')
      onSaved()
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  const remove = async () => {
    try {
      await remover.mutateAsync()
      notify.success(`${toolName} deleted`)
      setConfirmDelete(false)
      onSaved()
    } catch (err) {
      setConfirmDelete(false)
      setError(describeError(err).message)
    }
  }

  const exportTool = async () => {
    try {
      const r = await aiToolsAPI.exportTool(toolName)
      const blob = new Blob([JSON.stringify(r.data?.data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${toolName}.tool.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  const readOnlyBuiltins = (allTools || []).filter((t) => t.read_only && !t.custom)
  const loading = toolName && !seeded && !existing.error

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={toolName ? `Edit ${toolName}` : 'Build a tool'}
      description="Runs sandboxed and read-only. It cannot change records."
      footer={(
        <div className="flex w-full flex-wrap items-center gap-2">
          {toolName && (
            <>
              <Button variant="destructive" icon={TrashIcon} onClick={() => setConfirmDelete(true)}>Delete</Button>
              <Button variant="ghost" icon={ArrowDownTrayIcon} onClick={exportTool}>Export</Button>
            </>
          )}
          <Checkbox label="Available to Simeli" checked={form.enabled !== false} onChange={(e) => set({ enabled: e.target.checked })} className="ml-1" />
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saver.isPending} disabled={loading}>
            {toolName ? 'Save new version' : 'Create tool'}
          </Button>
        </div>
      )}
    >
      {existing.error ? (
        <ErrorState error={existing.error} what="This tool" onRetry={existing.refetch} compact />
      ) : loading ? (
        <SkeletonRows rows={6} columns={2} />
      ) : (
        <div className="space-y-4">
          {error && <InlineNotice tone="risk" title="That did not work">{error}</InlineNotice>}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name" required error={nameError} help="Lower case and underscores.">
              <Input
                value={form.name}
                className="font-mono"
                placeholder="customer_payment_history"
                onBlur={() => setNameError(form.name?.trim() ? null : 'Give the tool a name Simeli can call it by.')}
                onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
              />
            </Field>
            <Field label="What it does" help="Simeli reads this to decide when to call it.">
              <Input value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="Returns a customer's payment history" />
            </Field>
          </div>

          <Tabs
            value={tab}
            onChange={setTab}
            label="Tool sections"
            tabs={[
              { id: 'code', label: 'Code' },
              { id: 'schema', label: 'Inputs' },
              { id: 'access', label: 'What it may read' },
              ...(toolName ? [{ id: 'history', label: 'History', count: versions.length }] : []),
            ]}
          />

          {tab === 'code' && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Field label="Implementation">
                <Textarea value={form.implementation} onChange={(e) => set({ implementation: e.target.value })} rows={18} spellCheck={false} className="font-mono text-xs leading-relaxed" />
              </Field>
              <div className="flex flex-col gap-2">
                <Field label="Try it — input (JSON)">
                  <Textarea value={testInput} onChange={(e) => setTestInput(e.target.value)} rows={4} spellCheck={false} className="font-mono text-xs" />
                </Field>
                <Button icon={PlayIcon} onClick={runTest} loading={tester.isPending}>Run against real data</Button>
                <div className="min-h-[180px] flex-1 overflow-auto rounded-md border border-ink-200 bg-sunken p-3" aria-live="polite">
                  {!result && <p className="text-xs text-ink-500">Run it to see what it returns.</p>}
                  {result && !result.ok && (
                    <div className="text-xs text-risk-700">
                      <p className="mb-1 font-medium">It failed</p>
                      <p className="whitespace-pre-wrap">{result.error}</p>
                    </div>
                  )}
                  {result?.ok && (
                    <div className="text-xs">
                      <p className="mb-1 font-medium text-ok-700">Returned in {Number(result.duration_ms).toLocaleString()} ms</p>
                      <pre className="whitespace-pre-wrap text-ink-800">{JSON.stringify(result.result, null, 2)}</pre>
                    </div>
                  )}
                  {result?.logs?.length > 0 && (
                    <div className="mt-2 border-t border-ink-200 pt-2">
                      <p className="label-mono mb-1">Log</p>
                      {result.logs.map((l, i) => <p key={i} className="font-mono text-2xs text-ink-600">{l}</p>)}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {tab === 'schema' && (
            <Field label="Input schema" help="JSON Schema describing what Simeli passes in.">
              <SchemaEditor value={form.input_schema} onChange={(input_schema) => set({ input_schema })} />
            </Field>
          )}

          {tab === 'access' && (
            <div className="space-y-4">
              <Checkbox
                label="Read-only SQL"
                description="Single SELECT statements against an allowlist of tables."
                checked={form.allow_sql !== false}
                onChange={(e) => set({ allow_sql: e.target.checked })}
              />
              <fieldset>
                <legend className="text-sm font-medium text-fg">Built-in tools it may call</legend>
                <p className="mb-2 text-xs text-ink-600">Read-only tools only; nothing that changes a record.</p>
                <div className="max-h-64 divide-y divide-ink-100 overflow-y-auto rounded-md border border-ink-200">
                  {readOnlyBuiltins.map((t) => (
                    <Checkbox
                      key={t.name}
                      className="px-3 py-2"
                      label={<Code>{t.name}</Code>}
                      description={t.description}
                      checked={(form.allowed_tools || []).includes(t.name)}
                      onChange={() => set({
                        allowed_tools: (form.allowed_tools || []).includes(t.name)
                          ? form.allowed_tools.filter((n) => n !== t.name)
                          : [...(form.allowed_tools || []), t.name],
                      })}
                    />
                  ))}
                </div>
              </fieldset>
              <Field label="Time limit" className="sm:w-56">
                <Select value={form.timeout_ms} onChange={(e) => set({ timeout_ms: Number(e.target.value) })}>
                  <option value={2000}>2 seconds</option>
                  <option value={5000}>5 seconds</option>
                  <option value={15000}>15 seconds</option>
                  <option value={30000}>30 seconds</option>
                </Select>
              </Field>
            </div>
          )}

          {tab === 'history' && (
            versions.length === 0 ? <p className="text-sm text-ink-500">No earlier versions.</p> : (
              <ul className="divide-y divide-ink-100 rounded-md border border-ink-200">
                {versions.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm text-fg"><Badge mono>v{v.version}</Badge> <DateText value={v.created_at} withTime className="ml-1 text-xs text-ink-500" />{v.created_by_name ? <span className="text-xs text-ink-500"> · {v.created_by_name}</span> : null}</p>
                      {v.note && <p className="mt-0.5 text-xs text-ink-600">{v.note}</p>}
                    </div>
                    <Button
                      size="sm"
                      loading={roller.isPending && roller.variables === v.version}
                      onClick={async () => {
                        try {
                          await roller.mutateAsync(v.version)
                          notify.success(`Restored version ${v.version}`)
                          onSaved()
                        } catch (err) {
                          setError(describeError(err).message)
                        }
                      }}
                    >
                      Restore
                    </Button>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      )}

      {toolName && (
        <ConfirmDialog
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          onConfirm={remove}
          title={`Delete ${toolName}?`}
          consequence="Agents that use it stop working until they are given another tool. Its version history is removed with it."
          confirmLabel={`Delete ${toolName}`}
          confirmText={toolName}
          busy={remover.isPending}
        />
      )}
    </Dialog>
  )
}
