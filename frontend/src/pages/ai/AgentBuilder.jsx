import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowDownTrayIcon, ArrowLeftIcon, CheckIcon, ClockIcon, HandRaisedIcon, MagnifyingGlassIcon, PlayIcon, PlusIcon,
  SparklesIcon, TrashIcon, WrenchScrewdriverIcon, XMarkIcon,
} from '@heroicons/react/20/solid'
import api, { agentsAPI, aiToolsAPI, aiCredentialsAPI, aiBuilderAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import {
  PageHeader, Button, IconButton, Card, Field, Input, Textarea, Select, Checkbox, Segmented, FormSection, Dialog,
  InlineNotice, Badge, Code, DateText, SkeletonDetail, ErrorState, MaturityBadge, Stat, notify, describeError,
} from '../../components/ui'

// The two agent shapes. The screen leads with the distinction, because choosing
// wrong is the mistake that makes an agent feel broken: a fixed pipeline
// improvising, or a reasoning loop re-deciding something that should be
// identical every month.
const KINDS = [
  {
    key: 'ai',
    label: 'Reasoning agent',
    blurb: 'You give it a goal and a set of tools. It works out its own steps each run, handles what it finds, and asks when unsure.',
    good_for: 'Analysis, judgement calls, anything you cannot fully specify in advance.',
  },
  {
    key: 'pipeline',
    label: 'Fixed sequence',
    blurb: 'An ordered list of tool calls that runs identically every time. No model decides anything at run time.',
    good_for: 'A recurring report that must come out the same way every month.',
  },
]

const DOMAINS = ['FINANCE', 'PROCUREMENT', 'SALES', 'INVENTORY', 'HR', 'DATA']

const SCHEDULES = [
  { seconds: 3600, label: 'Every hour' },
  { seconds: 21600, label: 'Every 6 hours' },
  { seconds: 86400, label: 'Every day' },
  { seconds: 604800, label: 'Every week' },
  { seconds: 2592000, label: 'Every 30 days' },
]

const TRIGGERS = [
  { value: 'schedule', label: 'On a schedule' },
  { value: 'event', label: 'When something happens' },
  { value: 'manual', label: 'Only when I run it' },
]

const EFFORTS = [
  { key: 'low', label: 'Low', hint: 'Fast and cheap. Short, well-scoped work.' },
  { key: 'medium', label: 'Medium', hint: 'Balanced.' },
  { key: 'high', label: 'High', hint: 'Recommended. Thinks before acting.' },
  { key: 'xhigh', label: 'Very high', hint: 'For the hardest judgement calls.' },
  { key: 'max', label: 'Maximum', hint: 'Slowest and most expensive. Correctness over cost.' },
]

const IMPACT = {
  read: { label: 'Reads', tone: 'ink' },
  draft: { label: 'Drafts', tone: 'brand' },
  real: { label: 'Changes records', tone: 'warn' },
}
const impactOf = (tool) => (!tool || tool.read_only ? 'read' : tool.high_impact ? 'real' : 'draft')

const slugify = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)

// Real jobs, not feature demonstrations.
const EXAMPLES = [
  'Check inventory every morning and email me if anything is below its reorder point',
  'Every Friday, summarise the week’s sales and send a report to the sales team',
  'Monitor overdue invoices daily and escalate anything more than 30 days late',
  'Watch for purchase orders received short and tell procurement which suppliers keep doing it',
  'Once a month, find journal entries that look like duplicates and list them for review',
]

const EXAMPLE_GOAL = `You are the collections agent for this company.

Each run: review customer invoices that are past due. For each one, judge whether it is genuinely at risk — consider how overdue it is, the customer's payment history, whether they have other open invoices, and whether the amount matters relative to their usual balance. Do not treat every late invoice the same.

For accounts that are at risk, draft a reminder appropriate to the situation: gentle for a customer who is usually prompt, firmer for a repeat offender. Generate a summary PDF of the ten largest exposures.

Stop and ask a human if: an account is disputed, the customer is a top-five account by revenue, or anything looks like a data error rather than a real debt.

Report what you found and what you did, with the actual figures.`

const BLANK = {
  agent_key: '',
  display_name: '',
  description: '',
  kind: 'ai',
  goal: '',
  domain: 'FINANCE',
  trigger_type: 'schedule',
  schedule_seconds: 604800,
  event_key: '',
  provider: 'anthropic',
  model: '',
  effort: 'high',
  credential_id: '',
  allowed_tools: [],
  max_iterations: 20,
  memory_enabled: true,
  escalation_rules: { guidance: '' },
  config: {},
  steps: [],
}

const fromBlueprint = (bp) => ({
  ...bp,
  credential_id: bp.credential_id || '',
  allowed_tools: bp.allowed_tools || [],
  escalation_rules: bp.escalation_rules || { guidance: '' },
  config: bp.config || {},
})

// Endpoints that answer with extra top-level fields (gaps, note) next to
// `data`. Re-wrapped so useResource's unwrap keeps them.
const whole = (promise) => promise.then((res) => ({ data: { success: true, data: res.data } }))

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export default function AgentBuilder() {
  const { key } = useParams()
  const navigate = useNavigate()
  const editing = !!key

  const [form, setForm] = useState(BLANK)
  const [gaps, setGaps] = useState(null)
  const [toolSearch, setToolSearch] = useState('')
  const [preview, setPreview] = useState(null)
  const [showHistory, setShowHistory] = useState(false)
  const [savedNote, setSavedNote] = useState(null)
  const [error, setError] = useState(null)
  const [nameError, setNameError] = useState(null)

  // Describing comes first; the form is for when the draft is nearly right.
  // Editing an existing agent skips straight to it.
  const [stage, setStage] = useState(editing ? 'form' : 'describe')
  const [description, setDescription] = useState('')
  const [draft, setDraft] = useState(null)

  const toolsQ = useResource(keys.aiTools(), () => aiToolsAPI.catalog())
  const credsQ = useResource(keys.aiCredentials(), () => aiCredentialsAPI.list(), { retry: false })
  const vaultQ = useResource(['ai-credentials', 'status'], () => aiCredentialsAPI.status(), { retry: false })
  const blueprintQ = useResource(
    ['agents', 'blueprint', key],
    () => whole(agentsAPI.getBlueprint(key)),
    { enabled: editing, retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
  )
  const versionsQ = useResource(['agents', 'blueprint', key, 'versions'], () => agentsAPI.blueprintVersions(key), { enabled: editing, retry: false })

  const tools = useMemo(() => (Array.isArray(toolsQ.data) ? toolsQ.data : []), [toolsQ.data])
  const credentials = Array.isArray(credsQ.data) ? credsQ.data : []
  const vaultStatus = vaultQ.data || null
  const versions = Array.isArray(versionsQ.data) ? versionsQ.data : []

  // The stored blueprint fills the form when it arrives, and again after a
  // rollback (an explicit refetch) — never on a background refetch, which is
  // switched off above so it cannot overwrite unsaved edits.
  useEffect(() => {
    const body = blueprintQ.data
    if (!body?.data) return
    setForm((prev) => ({ ...prev, ...fromBlueprint(body.data) }))
    setGaps(body.gaps || null)
  }, [blueprintQ.data, blueprintQ.dataUpdatedAt])

  useRecordTitle(editing ? (form.display_name || key) : null)

  const invalidates = [['agents']]
  const generator = useResourceMutation((text) => aiBuilderAPI.generateAgent(text), { silent: true })
  const saver = useResourceMutation(
    (payload) => (editing ? whole(agentsAPI.updateBlueprint(key, payload)) : agentsAPI.createBlueprint(payload)),
    { invalidates, silent: true },
  )
  const previewer = useResourceMutation(async () => {
    const res = await agentsAPI.run(key, { dry_run: true })
    const summary = res.data?.data
    let actions = []
    let transcript = []
    if (summary?.run_id) {
      const [detail, script] = await Promise.all([
        agentsAPI.getRun(summary.run_id).catch(() => null),
        agentsAPI.runTranscript(summary.run_id).catch(() => null),
      ])
      actions = detail?.data?.data?.actions || []
      transcript = script?.data?.data || []
    }
    return { data: { success: true, data: { summary, actions, transcript } } }
  }, { silent: true })

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }))

  // The name drives the key until the agent exists; after that the key is
  // fixed, because the run history and the authority envelope hang off it.
  const onNameChange = (value) => set({ display_name: value, ...(editing ? {} : { agent_key: slugify(value) }) })

  const selectedTools = form.allowed_tools || []
  const writingSelected = tools.filter((t) => selectedTools.includes(t.name) && !t.read_only)
  const filteredTools = useMemo(() => {
    const needle = toolSearch.toLowerCase()
    return tools.filter((t) => !needle || t.name.includes(needle) || String(t.description).toLowerCase().includes(needle))
  }, [tools, toolSearch])

  const toggleTool = (name) => set({
    allowed_tools: selectedTools.includes(name) ? selectedTools.filter((n) => n !== name) : [...selectedTools, name],
  })

  const generate = async () => {
    setError(null)
    try {
      const data = await generator.mutateAsync(description)
      setForm((prev) => ({ ...prev, ...fromBlueprint(data.blueprint), credential_id: '' }))
      setDraft(data)
      setStage('review')
    } catch (err) {
      setError(describeError(err).message || 'Could not work out an agent from that description.')
    }
  }

  const save = async () => {
    setError(null)
    setSavedNote(null)
    if (!form.display_name?.trim()) { setNameError('Give the agent a name.'); setStage('form'); return }
    try {
      const payload = {
        ...form,
        credential_id: form.credential_id || null,
        schedule_seconds: form.trigger_type === 'schedule' ? Number(form.schedule_seconds) : null,
      }
      const body = await saver.mutateAsync(payload)
      if (editing) {
        setGaps(body?.gaps || null)
        setSavedNote(body?.note || 'Saved. The previous version is kept in the history.')
        versionsQ.refetch()
      } else {
        notify.success('Agent created — it is saved switched off until you enable it')
        navigate(`/ai/agents/${payload.agent_key}`)
      }
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  // A preview runs the agent for real against real data, with every action
  // recorded instead of performed.
  const runPreview = async () => {
    setError(null)
    try {
      setPreview(await previewer.mutateAsync())
    } catch (err) {
      setError(`The preview run failed — ${describeError(err).message}`)
    }
  }

  const exportIt = async () => {
    try {
      const r = await agentsAPI.exportBlueprint(key)
      downloadJson(r.data?.data, `${key}.agent.json`)
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  if (editing && blueprintQ.loading) return <SkeletonDetail />
  if (editing && blueprintQ.error) return <ErrorState error={blueprintQ.error} what="This agent" onRetry={blueprintQ.refetch} />

  if (stage === 'describe') {
    return (
      <DescribeStage
        description={description}
        onDescription={setDescription}
        generating={generator.isPending}
        error={error}
        onGenerate={generate}
        onSkip={() => { setError(null); setStage('form') }}
      />
    )
  }

  if (stage === 'review') {
    return (
      <ReviewStage
        form={form}
        set={set}
        draft={draft}
        tools={tools}
        onToggleTool={toggleTool}
        saving={saver.isPending}
        error={error}
        onCreate={save}
        onBack={() => setStage('describe')}
        onEdit={() => setStage('form')}
      />
    )
  }

  const isAI = form.kind === 'ai'

  return (
    <div className="space-y-5 pb-16">
      <PageHeader
        title={editing ? form.display_name || 'Edit agent' : 'Build an agent'}
        badge={<MaturityBadge level="beta" />}
        description={editing
          ? 'Change what it does. This does not change what it is allowed to do — that is its authority.'
          : 'Describe what it should achieve. It is saved switched off until you enable it.'}
        meta={editing ? <Code>{form.agent_key}</Code> : null}
        secondary={editing ? (
          <>
            <Button icon={ArrowDownTrayIcon} onClick={exportIt}>Export</Button>
            <Button icon={ClockIcon} onClick={() => setShowHistory(true)}>History{versions.length ? ` ${versions.length}` : ''}</Button>
            <Button icon={PlayIcon} onClick={runPreview} loading={previewer.isPending}>Preview run</Button>
          </>
        ) : (
          <Button variant="ghost" icon={ArrowLeftIcon} onClick={() => setStage(draft ? 'review' : 'describe')}>
            {draft ? 'Back to the draft' : 'Describe it instead'}
          </Button>
        )}
        primary={<Button variant="primary" onClick={save} loading={saver.isPending}>{editing ? 'Save changes' : 'Create agent'}</Button>}
      />

      {error && <InlineNotice tone="risk" title="That did not work">{error}</InlineNotice>}
      {savedNote && <InlineNotice tone="ok" title="Saved">{savedNote}</InlineNotice>}

      {/* An agent whose steps outgrew its permissions runs, and escalates everything. */}
      {gaps?.missing_actions?.length > 0 && (
        <InlineNotice tone="warn" title="This agent is not yet authorised for everything it may try">
          It may attempt <Code>{gaps.missing_actions.join(', ')}</Code>, which is not in its authority, so those steps will be escalated to a person.
        </InlineNotice>
      )}

      <FormSection title="What it is" description="How this agent decides what to do.">
        <fieldset className="sm:col-span-2">
          <legend className="sr-only">Kind of agent</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {KINDS.map((k) => (
              <label key={k.key} className={`flex cursor-pointer flex-col rounded-lg border p-4 ${form.kind === k.key ? 'border-ink-900 bg-ink-50' : 'border-ink-200 hover:bg-ink-50'}`}>
                <span className="flex items-center gap-2">
                  <input type="radio" name="agent-kind" checked={form.kind === k.key} onChange={() => set({ kind: k.key })} />
                  <span className="text-sm font-medium text-fg">{k.label}</span>
                </span>
                <span className="mt-1.5 text-xs text-ink-600">{k.blurb}</span>
                <span className="mt-1.5 text-xs text-ink-500">Good for: {k.good_for}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Name" required error={nameError}>
          <Input value={form.display_name} onChange={(e) => onNameChange(e.target.value)} onBlur={() => setNameError(form.display_name?.trim() ? null : 'Give the agent a name.')} placeholder="Collections watch" />
        </Field>
        <Field label="Identifier" help={editing ? 'Fixed — the run history is attached to it.' : 'Generated from the name.'}>
          <Input value={form.agent_key} onChange={(e) => set({ agent_key: slugify(e.target.value) })} disabled={editing} className="font-mono" />
        </Field>
        <Field label="Description" help="One line a colleague could read.">
          <Input value={form.description || ''} onChange={(e) => set({ description: e.target.value })} placeholder="Watches overdue accounts and chases the right ones" />
        </Field>
        <Field label="Area">
          <Select value={form.domain} onChange={(e) => set({ domain: e.target.value })}>
            {DOMAINS.map((d) => <option key={d} value={d}>{d.charAt(0) + d.slice(1).toLowerCase()}</option>)}
          </Select>
        </Field>
      </FormSection>

      {isAI ? (
        <FormSection title="Its goal" description="This is the agent. Say what to achieve, what judgement to apply, and when to stop and ask a person." columns={1}>
          <Field
            label="Goal"
            help="Written in the second person, as a briefing."
            labelAction={!form.goal ? <Button size="xs" variant="ghost" onClick={() => set({ goal: EXAMPLE_GOAL })}>Use an example</Button> : null}
          >
            <Textarea value={form.goal || ''} onChange={(e) => set({ goal: e.target.value })} rows={14} placeholder="You are the … Each run: … Stop and ask a person if: …" className="font-mono leading-relaxed" />
          </Field>
        </FormSection>
      ) : (
        <FormSection title="Steps" description="Run in order. Later steps can use earlier results with {{steps.id.field}}." columns={1}>
          <StepEditor steps={form.steps || []} tools={tools} onChange={(steps) => set({ steps })} />
        </FormSection>
      )}

      <FormSection title="When it runs" columns={1}>
        <Segmented label="Trigger" value={form.trigger_type} onChange={(v) => set({ trigger_type: v })} options={TRIGGERS} className="max-w-full overflow-x-auto" />
        {form.trigger_type === 'schedule' && (
          <Field label="How often" className="sm:w-64">
            <Select value={form.schedule_seconds} onChange={(e) => set({ schedule_seconds: Number(e.target.value) })}>
              {SCHEDULES.map((s) => <option key={s.seconds} value={s.seconds}>{s.label}</option>)}
            </Select>
          </Field>
        )}
        {form.trigger_type === 'event' && (
          <Field label="Event name" help="Anything that emits this event wakes the agent." className="sm:w-80">
            <Input value={form.event_key || ''} onChange={(e) => set({ event_key: e.target.value })} placeholder="invoice.overdue" className="font-mono" />
          </Field>
        )}
      </FormSection>

      <FormSection
        title="What it can use"
        description={selectedTools.length ? `${selectedTools.length} selected. Give it what the goal needs and no more.` : 'Nothing selected means every tool. Narrow it for a focused agent.'}
        columns={1}
      >
        <Input
          value={toolSearch}
          onChange={(e) => setToolSearch(e.target.value)}
          placeholder="Search tools"
          aria-label="Search tools"
          prefix={<MagnifyingGlassIcon className="h-3.5 w-3.5" aria-hidden="true" />}
        />
        {writingSelected.length > 0 && (
          <InlineNotice tone="warn">
            {writingSelected.length} of the selected tools change data. The agent asks before using them unless its authority allows it.
          </InlineNotice>
        )}
        <ToolChecklist tools={filteredTools} selected={selectedTools} onToggle={toggleTool} loading={toolsQ.loading} />
      </FormSection>

      {isAI && (
        <FormSection title="The model it runs on" columns={3}>
          {vaultStatus && !vaultStatus.configured && (
            <InlineNotice tone="warn" className="sm:col-span-2 lg:col-span-3" title="No credential vault is configured on this server">
              Agents use the server’s own key until one is.{vaultStatus.how_to_configure ? ` ${vaultStatus.how_to_configure}` : ''}
            </InlineNotice>
          )}
          <Field label="Provider">
            <Select value={form.provider} onChange={(e) => set({ provider: e.target.value, credential_id: '' })}>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI-compatible</option>
            </Select>
          </Field>
          <Field label="Model" help="Leave blank for the recommended default.">
            <Input value={form.model || ''} onChange={(e) => set({ model: e.target.value })} className="font-mono" />
          </Field>
          <Field label="API key" help="Stored encrypted; never shown again.">
            <Select value={form.credential_id || ''} onChange={(e) => set({ credential_id: e.target.value })}>
              <option value="">Use the server’s key</option>
              {credentials.filter((c) => c.provider === form.provider).map((c) => <option key={c.id} value={c.id}>{c.name} (…{c.hint})</option>)}
            </Select>
          </Field>
          <Field label="How hard it thinks" help={EFFORTS.find((e) => e.key === form.effort)?.hint} className="sm:col-span-2 lg:col-span-3">
            <Segmented label="Effort" value={form.effort} onChange={(v) => set({ effort: v })} options={EFFORTS.map((e) => ({ value: e.key, label: e.label }))} className="max-w-full overflow-x-auto" />
          </Field>
        </FormSection>
      )}

      {isAI && (
        <FormSection title="Judgement and limits">
          <Field label="When it should stop and ask" help="Guidance for the model. The hard limits live in the agent’s authority, where it cannot argue with them." className="sm:col-span-2">
            <Textarea
              value={form.escalation_rules?.guidance || ''}
              onChange={(e) => set({ escalation_rules: { ...form.escalation_rules, guidance: e.target.value } })}
              rows={3}
              placeholder="Anything disputed; any top-five customer; anything that looks like a data error"
            />
          </Field>
          <Field label="Reasoning steps per run" help="Caps the loop, and the cost.">
            <Input type="number" numeric min={1} max={100} value={form.max_iterations} onChange={(e) => set({ max_iterations: Number(e.target.value) })} className="sm:w-32" />
          </Field>
          <Checkbox
            className="sm:pt-6"
            label="Remember between runs"
            description="Keeps what it learns so it does not repeat itself."
            checked={!!form.memory_enabled}
            onChange={(e) => set({ memory_enabled: e.target.checked })}
          />
        </FormSection>
      )}

      <FormSection title="Settings the operator can tune later" advanced columns={1}>
        <KeyValueEditor value={form.config || {}} onChange={(config) => set({ config })} />
      </FormSection>

      {preview && <PreviewResult preview={preview} onClose={() => setPreview(null)} />}
      {showHistory && (
        <HistoryDialog
          agentKey={key}
          versions={versions}
          onClose={() => setShowHistory(false)}
          onRestored={async () => { await blueprintQ.refetch(); await versionsQ.refetch() }}
        />
      )}
    </div>
  )
}

/** Tools as a checklist, each with what it changes. */
function ToolChecklist({ tools, selected, onToggle, loading }) {
  if (loading) return <p className="text-sm text-ink-500">Loading tools…</p>
  if (!tools.length) return <p className="py-6 text-center text-sm text-ink-500">No tools match that search.</p>
  return (
    <ul className="max-h-96 divide-y divide-ink-100 overflow-y-auto rounded-md border border-ink-200">
      {tools.map((tool) => {
        const meta = IMPACT[impactOf(tool)]
        return (
          <li key={tool.name} className={selected.includes(tool.name) ? 'bg-ink-50' : ''}>
            <Checkbox
              className="px-3 py-2.5"
              checked={selected.includes(tool.name)}
              onChange={() => onToggle(tool.name)}
              label={(
                <span className="flex flex-wrap items-center gap-2">
                  <Code className="text-fg">{tool.name}</Code>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  {tool.custom && <Badge>Built here</Badge>}
                </span>
              )}
              description={<span className="line-clamp-2">{tool.description}</span>}
            />
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Stage one: say what you want
// ---------------------------------------------------------------------------

function DescribeStage({ description, onDescription, generating, error, onGenerate, onSkip }) {
  const ready = description.trim().length >= 10
  const { data: aiSettings } = useResource(keys.aiSettings(), ({ signal }) => api.get('/ai-settings', { signal }), { retry: false })
  const noModel = aiSettings && aiSettings.ai_enabled === false

  return (
    <div className="mx-auto max-w-3xl space-y-5 pb-16">
      <PageHeader
        title="What should the agent do for you?"
        badge={<MaturityBadge level="beta" />}
        description="Describe the job in your own words. Simeli drafts the agent — its goal, schedule and tools — for you to read before anything is created."
      />

      {noModel && (
        <InlineNotice tone="warn" title="Drafting from a description needs a language model" action={<Button size="sm" onClick={onSkip}>Configure it myself</Button>}>
          No model key is connected on this server, so this step will fail. You can still build the agent field by field.
        </InlineNotice>
      )}
      {error && <InlineNotice tone="risk" title="No draft was made">{error}</InlineNotice>}

      <Card>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (ready && !generating) onGenerate() }}>
          <Field label="The job" help="The more you say about what matters and when to ask you, the better the draft. Ctrl+Enter to draft.">
            <Textarea
              value={description}
              onChange={(e) => onDescription(e.target.value)}
              onKeyDown={(e) => {
                // Enter is for paragraphs here — this is prose, not a search box.
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready && !generating) onGenerate()
              }}
              rows={6}
              disabled={generating}
              placeholder="Check inventory every morning and email me if anything is below its reorder point"
              className="text-base leading-relaxed sm:text-sm"
            />
          </Field>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Button variant="ghost" onClick={onSkip}>I would rather configure it myself</Button>
            <Button type="submit" variant="primary" size="lg" icon={SparklesIcon} loading={generating} disabled={!ready} title={!ready ? 'Describe it in a few more words.' : undefined}>
              {generating ? 'Working it out…' : 'Draft my agent'}
            </Button>
          </div>
        </form>
      </Card>

      {generating ? (
        <p role="status" className="text-center text-sm text-ink-500">Reading your description, picking the tools and the schedule…</p>
      ) : (
        <div>
          <p className="label-mono mb-2">Or start from one of these</p>
          <ul className="space-y-2">
            {EXAMPLES.map((example) => (
              <li key={example}>
                <button
                  type="button"
                  onClick={() => onDescription(example)}
                  className="min-h-[44px] w-full rounded-md border border-ink-200 bg-surface px-4 py-3 text-left text-sm text-ink-700 hover:border-ink-300 hover:bg-ink-50"
                >
                  “{example}”
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stage two: read what it came up with, then create it
// ---------------------------------------------------------------------------

function ReviewStage({ form, set, draft, tools, onToggleTool, saving, error, onCreate, onBack, onEdit }) {
  const [addingTools, setAddingTools] = useState(false)
  const [toolSearch, setToolSearch] = useState('')

  const byName = useMemo(() => new Map(tools.map((t) => [t.name, t])), [tools])
  const selected = form.allowed_tools || []
  const explanation = draft?.explanation || {}
  const writing = selected.map((n) => byName.get(n)).filter((t) => t && !t.read_only)

  const unselected = useMemo(() => {
    const needle = toolSearch.toLowerCase()
    return tools.filter((t) => !selected.includes(t.name) && (!needle || t.name.includes(needle) || String(t.description).toLowerCase().includes(needle)))
  }, [tools, selected, toolSearch])

  return (
    <div className="mx-auto max-w-3xl space-y-5 pb-16">
      <PageHeader
        title="Here is what Simeli would build"
        description="Read it over and change anything that is not right. Nothing exists until you create it."
        secondary={<Button variant="ghost" icon={ArrowLeftIcon} onClick={onBack}>Describe it differently</Button>}
      />

      {error && <InlineNotice tone="risk" title="Not created">{error}</InlineNotice>}

      {/* Checked against the same validator the save uses: this means the save WOULD fail. */}
      {draft && !draft.valid && (
        <InlineNotice tone="risk" title="This draft is not complete enough to create" action={<Button size="sm" onClick={onEdit}>Open the full editor</Button>}>
          {draft.validation_error}
        </InlineNotice>
      )}
      {draft?.warnings?.map((w) => <InlineNotice key={w} tone="warn">{w}</InlineNotice>)}
      {draft?.reasoning && <InlineNotice tone="ink" title="Why it looks like this">{draft.reasoning}</InlineNotice>}

      <Card padded={false}>
        <div className="space-y-3 p-4">
          <Field label="Name">
            <Input value={form.display_name} onChange={(e) => set({ display_name: e.target.value })} size="lg" />
          </Field>
          {/* Not re-derived on rename: it was checked for collisions server-side. */}
          <p className="text-xs text-ink-500">Identifier <Code>{form.agent_key}</Code></p>
          <Field label="In one line">
            <Input value={form.description || ''} onChange={(e) => set({ description: e.target.value })} placeholder="What a colleague would need to know" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Badge>{form.domain}</Badge>
            <Badge>{form.kind === 'ai' ? 'Decides for itself each run' : 'Runs the same steps every time'}</Badge>
          </div>
        </div>

        <ReviewRow icon={ClockIcon} label="When it runs">
          <p className="text-sm text-ink-800">{explanation.when || '—'}</p>
          {draft?.schedule_note && <p className="mt-1 text-xs text-warn-700">{draft.schedule_note}</p>}
        </ReviewRow>

        <ReviewRow icon={SparklesIcon} label={form.kind === 'ai' ? 'What it will do' : 'The steps it runs'}>
          {(explanation.steps || []).length === 0 ? (
            <p className="text-sm text-ink-500">Nothing described yet.</p>
          ) : (
            <ul className="space-y-2">
              {explanation.steps.map((step, i) => <li key={i} className="text-sm leading-relaxed text-ink-800">{step}</li>)}
            </ul>
          )}
        </ReviewRow>

        {form.escalation_rules?.guidance && (
          <ReviewRow icon={HandRaisedIcon} label="When it stops and asks you">
            <p className="text-sm leading-relaxed text-ink-800">{form.escalation_rules.guidance}</p>
          </ReviewRow>
        )}

        <ReviewRow icon={WrenchScrewdriverIcon} label={`What it can use (${selected.length})`}>
          {selected.length === 0 && <p className="mb-2 text-sm text-warn-700">No tools were selected, which means it may use every tool.</p>}
          <ul className="space-y-1.5">
            {selected.map((name) => {
              const tool = byName.get(name)
              const meta = IMPACT[impactOf(tool)]
              return (
                <li key={name}>
                  <Checkbox
                    checked
                    onChange={() => onToggleTool(name)}
                    label={tool?.description || name}
                    description={<span className="flex items-center gap-2"><Code>{name}</Code><Badge tone={meta.tone}>{meta.label}</Badge></span>}
                  />
                </li>
              )
            })}
          </ul>

          {!addingTools ? (
            <Button size="sm" variant="ghost" icon={PlusIcon} className="mt-3" onClick={() => setAddingTools(true)}>Add another tool</Button>
          ) : (
            <div className="mt-3 space-y-2">
              <Input value={toolSearch} onChange={(e) => setToolSearch(e.target.value)} placeholder="Search the other tools" aria-label="Search the other tools" prefix={<MagnifyingGlassIcon className="h-3.5 w-3.5" aria-hidden="true" />} />
              <ul className="max-h-56 divide-y divide-ink-100 overflow-y-auto rounded-md border border-ink-200">
                {unselected.slice(0, 60).map((t) => (
                  <li key={t.name}>
                    <button type="button" onClick={() => onToggleTool(t.name)} className="w-full px-3 py-2 text-left hover:bg-ink-50">
                      <Code className="text-fg">{t.name}</Code>
                      <span className="block line-clamp-1 text-xs text-ink-600">{t.description}</span>
                    </button>
                  </li>
                ))}
                {unselected.length === 0 && <li className="px-3 py-6 text-center text-sm text-ink-500">Nothing else matches that.</li>}
              </ul>
            </div>
          )}

          {writing.length > 0 && (
            <InlineNotice tone="warn" className="mt-3">
              {writing.length} of these change data ({writing.map((t) => t.name).join(', ')}). The agent is created without permission to use them unattended; it asks first.
            </InlineNotice>
          )}
        </ReviewRow>
      </Card>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="ghost" onClick={onEdit}>Change every setting</Button>
        <Button variant="primary" size="lg" icon={CheckIcon} onClick={onCreate} loading={saving} disabled={draft && !draft.valid}>Create agent</Button>
      </div>
      <p className="text-right text-xs text-ink-500">It is created switched off, in preview mode. Nothing runs until you enable it.</p>
    </div>
  )
}

function ReviewRow({ icon: Icon, label, children }) {
  return (
    <div className="flex gap-4 border-t border-ink-200 p-4">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="label-mono mb-2">{label}</p>
        {children}
      </div>
    </div>
  )
}

function StepEditor({ steps, tools, onChange }) {
  const update = (index, patch) => {
    const next = [...steps]
    next[index] = { ...next[index], ...patch }
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {steps.map((step, index) => (
        <fieldset key={index} className="space-y-2 rounded-md border border-ink-200 p-3">
          <legend className="sr-only">Step {index + 1}</legend>
          <div className="flex items-center gap-2">
            <span className="w-6 font-mono text-xs text-ink-500">{index + 1}.</span>
            <Select value={step.tool || ''} onChange={(e) => update(index, { tool: e.target.value })} aria-label={`Step ${index + 1} tool`} className="flex-1 font-mono">
              <option value="">Choose a tool</option>
              {tools.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </Select>
            <Input value={step.id || ''} onChange={(e) => update(index, { id: e.target.value })} placeholder="id" aria-label={`Step ${index + 1} id`} title="Refer to this step’s output as {{steps.id.field}}" className="w-24 font-mono text-xs" />
            <IconButton icon={TrashIcon} label={`Remove step ${index + 1}`} onClick={() => onChange(steps.filter((_, i) => i !== index))} />
          </div>
          <JsonInput label="Arguments" value={step.args || {}} onChange={(args) => update(index, { args })} />
          <Input value={step.condition || ''} onChange={(e) => update(index, { condition: e.target.value })} placeholder="Only if… e.g. {{steps.overdue.count}} > 0" aria-label={`Step ${index + 1} condition`} className="font-mono text-xs" />
        </fieldset>
      ))}
      <Button size="sm" icon={PlusIcon} onClick={() => onChange([...steps, { id: `step_${steps.length + 1}`, tool: '', args: {} }])}>Add a step</Button>
    </div>
  )
}

/** JSON that stays editable while it is invalid: held locally, lifted when it parses. */
function JsonInput({ label, value, onChange }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2))
  const [error, setError] = useState(null)

  const handle = (next) => {
    setText(next)
    try {
      onChange(JSON.parse(next || '{}'))
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <Field label={label} error={error}>
      <Textarea value={text} onChange={(e) => handle(e.target.value)} rows={3} className="font-mono text-xs" />
    </Field>
  )
}

function KeyValueEditor({ value, onChange }) {
  const entries = Object.entries(value || {})
  const setKey = (oldKey, newKey) => {
    const next = {}
    entries.forEach(([k, v]) => { next[k === oldKey ? newKey : k] = v })
    onChange(next)
  }
  return (
    <div className="space-y-2">
      {entries.length === 0 && <p className="text-sm text-ink-500">No settings yet.</p>}
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-2">
          <Input value={k} onChange={(e) => setKey(k, e.target.value)} aria-label="Setting name" className="w-48 font-mono" />
          <Input
            value={typeof v === 'object' ? JSON.stringify(v) : String(v)}
            aria-label={`Value of ${k}`}
            onChange={(e) => {
              const raw = e.target.value
              const parsed = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
              onChange({ ...value, [k]: parsed })
            }}
            className="flex-1"
          />
          <IconButton
            icon={XMarkIcon}
            label={`Remove ${k}`}
            onClick={() => {
              const next = { ...value }
              delete next[k]
              onChange(next)
            }}
          />
        </div>
      ))}
      <Button size="sm" icon={PlusIcon} onClick={() => onChange({ ...value, [`setting_${entries.length + 1}`]: '' })}>Add a setting</Button>
    </div>
  )
}

const ROLE_LABEL = { assistant: 'Thought', tool: 'Tool', error: 'Problem', system: 'Briefing' }
const VERDICT_TONE = { allow: 'ok', escalate: 'warn', deny: 'risk', dry_run: 'brand', error: 'risk' }

function PreviewResult({ preview, onClose }) {
  const { summary, actions, transcript } = preview
  // The briefing is long and the same every run; what matters is what it concluded.
  const visible = transcript.filter((m) => m.role !== 'system')

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Preview run"
      description="Real data, real reasoning. Nothing was changed: every action was recorded instead of performed."
      footer={<Button variant="primary" icon={CheckIcon} onClick={onClose}>Close</Button>}
    >
      <div className="space-y-4">
        {summary?.status === 'SKIPPED' ? (
          <InlineNotice tone="ink">{summary.reason || 'This run was skipped.'}</InlineNotice>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['Steps', summary?.iterations],
              ['Tools used', summary?.observations],
              ['Would act', summary?.actions_taken],
              ['Would ask', summary?.escalations],
            ].map(([label, v]) => <Stat key={label} label={label} value={v == null ? '—' : Number(v).toLocaleString()} className="p-3" />)}
          </div>
        )}

        {summary?.summary && <InlineNotice tone="ink" title="What it concluded">{summary.summary}</InlineNotice>}
        {summary?.error && <InlineNotice tone="risk" title="The run hit a problem">{summary.error}</InlineNotice>}

        {visible.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-medium text-fg">How it reasoned</h3>
            <ol className="space-y-2">
              {visible.map((m) => (
                <li key={m.id} className={`rounded-md border px-3 py-2 text-xs ${m.role === 'error' ? 'border-risk-200 bg-risk-50 text-risk-800' : 'border-ink-200 bg-surface text-ink-800'}`}>
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="label-mono">{ROLE_LABEL[m.role] || m.role}</span>
                    {m.tool_name && <Code>{m.tool_name}</Code>}
                    {m.verdict && <Badge tone={VERDICT_TONE[m.verdict] || 'ink'}>{m.verdict.replace(/_/g, ' ')}</Badge>}
                  </div>
                  {m.content && <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>}
                  {m.tool_input && <pre className="mt-1 overflow-x-auto text-2xs text-ink-500">{JSON.stringify(m.tool_input).slice(0, 400)}</pre>}
                </li>
              ))}
            </ol>
          </section>
        )}

        {actions.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-medium text-fg">What it would have done</h3>
            <ul className="space-y-1">
              {actions.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-3 rounded-md border border-ink-200 px-3 py-2 text-xs">
                  <span className="min-w-0">
                    <span className="font-medium text-fg">{a.entity_label || a.action_type}</span>
                    <span className="mt-0.5 block text-ink-600">{a.rationale}</span>
                  </span>
                  <Badge tone={VERDICT_TONE[a.decision] || 'ink'}>{String(a.decision || '').replace(/_/g, ' ')}</Badge>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Dialog>
  )
}

/**
 * Every edit to a blueprint is snapshotted, so this is a complete account of
 * what the agent used to be. Restoring is itself a new version (forward-only),
 * so it can be undone by restoring again.
 */
function HistoryDialog({ agentKey, versions, onClose, onRestored }) {
  const [restoring, setRestoring] = useState(null)
  const [error, setError] = useState(null)

  const restore = async (version) => {
    setRestoring(version)
    setError(null)
    try {
      await agentsAPI.rollbackBlueprint(agentKey, version)
      notify.success(`Restored version ${version}`)
      await onRestored()
      onClose()
    } catch (err) {
      setError(describeError(err).message)
    } finally {
      setRestoring(null)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Version history"
      description="Every saved edit to this agent. Restoring makes a new version; nothing is lost."
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {error && <InlineNotice tone="risk" className="mb-3" title="Not restored">{error}</InlineNotice>}
      {versions.length === 0 ? <p className="text-sm text-ink-500">No earlier versions.</p> : (
        <ul className="divide-y divide-ink-100 rounded-md border border-ink-200">
          {versions.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm text-fg">
                  <Badge mono>v{v.version}</Badge>{' '}
                  <DateText value={v.created_at} withTime className="text-xs text-ink-500" />
                  {v.created_by_name ? <span className="text-xs text-ink-500"> · {v.created_by_name}</span> : null}
                </p>
                {v.note && <p className="mt-0.5 text-xs text-ink-600">{v.note}</p>}
              </div>
              <Button size="sm" onClick={() => restore(v.version)} loading={restoring === v.version} disabled={restoring !== null && restoring !== v.version}>Restore</Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
