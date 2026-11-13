/**
 * The Capability Studio.
 *
 * ===========================================================================
 * WHAT THIS SCREEN IS FOR
 * ===========================================================================
 * A person describes a business capability in a sentence and watches an
 * application appear: the plan first (what existing EMBMIS data it will use,
 * what new data it needs, which surfaces, which screens, which workflow), then
 * the application itself with sample data in it, then whatever they want
 * changed, then deployment.
 *
 * The conversation on the left is the record of that, and every turn that
 * changed the design points at the version it produced — so "why does it look
 * like this?" is answerable by scrolling rather than by guessing.
 *
 * The preview on the right renders through the SAME components the deployed
 * application uses (components/platform/blocks.jsx), over synthetic data the
 * server generated from the specification. That matters: a preview drawn by
 * different code than the real thing is a mock-up, and people approve
 * mock-ups and are then surprised.
 */

import React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { platformAPI } from '../../services/api'
import PublishToMarketplace from '../../components/platform/PublishToMarketplace'
import { Block } from '../../components/platform/blocks.jsx'
import { PageHeader, Button, Card, Field, Textarea, EmptyState, Tabs, MaturityBadge } from '../../components/ui'

const EXAMPLES = [
  'Create a supplier risk monitor',
  'Create a digital twin of my warehouse',
  'Build a supplier quality management application where our employees manage findings and suppliers can respond to their own findings in a portal.',
  'Create a customer warranty portal where customers submit claims and track their status.',
  'Build a construction site inspection application with issues tracked to closure.',
  'Create a fleet maintenance application covering vehicles, servicing and costs.',
  'Build an application for managing a specialised laboratory certification process.',
]

export default function Studio() {
  const { sessionId: routeSessionId } = useParams()
  const navigate = useNavigate()

  const [context, setContext] = React.useState(null)
  const [sessions, setSessions] = React.useState([])
  const [requirement, setRequirement] = React.useState('')
  const [sessionId, setSessionId] = React.useState(routeSessionId || null)
  const [session, setSession] = React.useState(null)
  const [messages, setMessages] = React.useState([])
  const [spec, setSpec] = React.useState(null)
  const [preview, setPreview] = React.useState(null)
  const [report, setReport] = React.useState(null)
  const [tab, setTab] = React.useState('plan')
  const [previewPage, setPreviewPage] = React.useState(null)
  const [instruction, setInstruction] = React.useState('')
  const [busy, setBusy] = React.useState(null)
  const [pendingApproval, setPendingApproval] = React.useState(null)
  // The build's steps as they arrive. Append-only while a build runs; the last
  // entry for a step wins, so a step reports itself running and then done.
  const [buildSteps, setBuildSteps] = React.useState([])

  React.useEffect(() => {
    platformAPI.studioContext().then((r) => setContext(r.data.data)).catch(() => {})
    platformAPI.listSessions().then((r) => setSessions(r.data.data || [])).catch(() => {})
  }, [])

  const loadSession = React.useCallback(async (id) => {
    const res = await platformAPI.getSession(id)
    const data = res.data.data
    setSession(data)
    setMessages(data.messages || [])
    setSpec(data.spec || null)
    if (data.spec) setPreviewPage((p) => p || firstPage(data.spec))
  }, [])

  React.useEffect(() => {
    if (!sessionId) return
    loadSession(sessionId).catch(() => toast.error('Could not open that session.'))
  }, [sessionId, loadSession])

  // -- build ---------------------------------------------------------------
  /**
   * Put the session in the address bar WITHOUT routing to it.
   *
   * `navigate()` looks like the obvious call and is wrong here. Moving from
   * /studio to /studio/:sessionId is a different match, so React Router
   * unmounts the Studio and mounts a fresh one — throwing away the build
   * progress the user is watching, mid-build. (An optional `:sessionId?`
   * parameter does not help: the router expands it into two matches
   * internally, so it remounts too.) Nothing about the page needs to change
   * when the session gets an id: the component already holds it in state. Only
   * the URL needs to, so that a reload or a shared link opens this session.
   *
   * The router's own history state is preserved, or back and forward break.
   */
  const setUrl = React.useCallback((path) => {
    const base = import.meta.env.PROD ? '/platform' : ''
    window.history.replaceState(window.history.state, '', `${base}${path}`)
  }, [])

  /**
   * Fold one progress event into the list.
   *
   * Keyed by step rather than appended, so a step that reports itself running
   * and then done occupies ONE row that changes state — an append-only log
   * would show every step twice. A step that finishes without a detail keeps
   * the one it had while running, so a line never goes blank on completion.
   */
  const onStep = React.useCallback((event) => {
    setBuildSteps((prev) => {
      const previous = prev.find((s) => s.step === event.step)
      const rest = prev.filter((s) => s.step !== event.step)
      return [...rest, { ...event, detail: event.detail ?? previous?.detail ?? null }]
    })
  }, [])

  const build = async (text) => {
    const requirementText = (text ?? requirement).trim()
    if (requirementText.length < 10) {
      toast.error('Describe what you would like built in a sentence or two.')
      return
    }
    setBusy('build')
    // Show the requirement being worked on straight away. Waiting for the first
    // server event to draw anything reproduces the blank screen this replaces.
    setBuildSteps([{ step: 'submitted', label: 'Reading your requirement', detail: requirementText, status: 'done' }])
    try {
      const data = await platformAPI.startSessionStream({ requirement: requirementText }, onStep)
      setSessionId(data.sessionId)
      setUrl(`/studio/${data.sessionId}`)
      setSpec(data.spec)
      setPreviewPage(firstPage(data.spec))
      setRequirement('')
      await loadSession(data.sessionId)
      await refreshPreview(data.sessionId)
      setTab('plan')
      setBuildSteps([])
      if (data.source === 'analyzer') {
        toast('Designed without a language model — a sound starting point you can iterate on.', { icon: '⚙️' })
      }
    } catch (err) {
      // The failed steps stay on screen: which step it got to is the most
      // useful thing on the page when a build does not finish.
      setBuildSteps((prev) => [...prev, {
        step: 'failed', label: 'Could not finish', detail: err.message, status: 'failed',
      }])
      toast.error(err.message || 'Could not design that.')
    } finally {
      setBusy(null)
    }
  }

  const refreshPreview = async (id = sessionId) => {
    try {
      const res = await platformAPI.previewSession(id)
      setPreview(res.data.data)
    } catch { /* preview is best-effort; validation reports the real problem */ }
  }

  const iterate = async () => {
    const text = instruction.trim()
    if (!text) return
    setBusy('iterate')
    setBuildSteps([{ step: 'submitted', label: 'Your change', detail: text, status: 'done' }])
    try {
      const data = await platformAPI.iterateStream(sessionId, text, onStep)
      setInstruction('')
      await loadSession(sessionId)
      if (data.noChange) toast(data.note, { icon: 'ℹ️' })
      else {
        setSpec(data.spec)
        toast.success(data.applied.map((a) => a.summary).join(' '))
        await refreshPreview()
      }
      setBuildSteps([])
    } catch (err) {
      setBuildSteps((prev) => [...prev, {
        step: 'failed', label: 'Could not make that change', detail: err.message, status: 'failed',
      }])
      toast.error(err.message || 'Could not make that change.')
      await loadSession(sessionId).catch(() => {})
    } finally {
      setBusy(null)
    }
  }

  const validate = async () => {
    setBusy('validate')
    try {
      const res = await platformAPI.validateSession(sessionId)
      setReport(res.data.data.report)
      setTab('validation')
      toast[res.data.data.report.ok ? 'success' : 'error'](
        res.data.data.report.ok
          ? 'Everything checks out.'
          : `${res.data.data.report.summary.errors} problem(s) to fix.`
      )
      await loadSession(sessionId)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Validation failed to run.')
    } finally {
      setBusy(null)
    }
  }

  const deploy = async (acknowledge = null) => {
    setBusy('deploy')
    try {
      const res = await platformAPI.deploySession(sessionId, acknowledge)
      const data = res.data.data
      if (data.status === 'deployed') {
        setPendingApproval(null)
        toast.success('Deployed. The application is live for this company.')
        await loadSession(sessionId)
      } else {
        // Not safe to apply unreviewed: show exactly what it would do and make
        // the person accept those specific steps.
        setPendingApproval(data.plan)
        setTab('deploy')
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Deployment failed.')
      await loadSession(sessionId).catch(() => {})
    } finally {
      setBusy(null)
    }
  }

  const open = () => {
    if (session?.application?.appKey) navigate(`/apps/${session.application.appKey}`)
  }

  // -- render --------------------------------------------------------------
  const plan = lastPayload(messages, 'plan')

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row">
      {/* conversation */}
      <aside className="flex min-h-0 w-full flex-col lg:w-[380px]">
        <PageHeader
          className="mb-3"
          title="Capability Studio"
          badge={<MaturityBadge level="beta" />}
          description="Describe a capability. EMBMIS designs the application, shows you what it would build, and creates nothing until you say so."
        />

        {!sessionId ? (
          <Card>
            <Field label="What should it do?" help="Plain words. Name who uses it, what they record and who approves what.">
              <Textarea rows={5} value={requirement}
                placeholder="Build a supplier quality management application where…"
                onChange={(e) => setRequirement(e.target.value)} />
            </Field>
            <Button variant="primary" className="mt-3 w-full" loading={busy === 'build'} disabled={!requirement.trim() && busy !== 'build'} onClick={() => build()}>
              {busy === 'build' ? 'Designing…' : 'Design it'}
            </Button>

            <p className="label-mono mb-2 mt-5">Or start from one of these</p>
            <ul className="divide-y divide-ink-100 rounded-md border border-ink-200">
              {EXAMPLES.map((e) => (
                <li key={e}>
                  <button type="button" className="w-full px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-50 hover:text-fg disabled:opacity-50"
                    onClick={() => build(e)} disabled={busy === 'build'}>
                    {e}
                  </button>
                </li>
              ))}
            </ul>

            {context ? (
              <div className="mt-5">
                <p className="label-mono mb-2">What the Studio can already see</p>
                <ul className="space-y-1">
                  {context.canonical.filter((c) => c.populated).map((c) => (
                    <li key={c.key} className="flex items-center justify-between bos-caption">
                      <span>{c.label}</span><span className="tabular-nums">{c.count}</span>
                    </li>
                  ))}
                  {!context.canonical.some((c) => c.populated) ? (
                    <li className="bos-caption">No EMBMIS records yet — applications can still create their own data.</li>
                  ) : null}
                </ul>
                <p className="bos-caption mt-3">
                  {context.designer.modelAvailable
                    ? `Designing with ${context.designer.provider}.`
                    : 'No language model configured — designs come from the built-in process analyser.'}
                </p>
              </div>
            ) : null}

            {sessions.length ? (
              <div className="mt-5">
                <p className="label-mono mb-2">Earlier sessions</p>
                <ul className="space-y-1">
                  {sessions.slice(0, 8).map((s) => (
                    <li key={s.id}>
                      <button type="button" className="bos-link text-left text-[12px]"
                        onClick={() => { setSessionId(s.id); setUrl(`/studio/${s.id}`) }}>
                        {s.title} · v{s.latest_version} · {s.instance_status || s.status}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
        ) : (
          <>
            <div className="bos-scroll min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              {messages.map((m) => (
                <div key={m.id} className={`bos-panel p-3 ${m.role === 'user' ? 'bos-panel--sunken' : ''}`}>
                  <p className="bos-eyebrow mb-1">
                    {m.role === 'user' ? 'You' : m.kind === 'error' ? 'Problem' : 'EMBMIS'}
                    {m.version ? ` · v${m.version}` : ''}
                  </p>
                  <p className="whitespace-pre-wrap text-[12.5px] bos-text">{m.content}</p>
                </div>
              ))}
            </div>

            <div className="bos-panel mt-3 p-3">
              <Textarea rows={3} aria-label="What to change" value={instruction}
                placeholder="Add a 90-day risk trend…"
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) iterate() }} />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="primary" loading={busy === 'iterate'} disabled={!instruction.trim()} onClick={iterate} kbd="⌘↵">
                  Change it
                </Button>
                <Button size="sm" loading={busy === 'validate'} onClick={validate}>Validate</Button>
                {session?.deployed ? <Button size="sm" onClick={open}>Open the application</Button> : null}
                {/* Offered only once it is deployed and running here. Nobody
                    should be able to sell a design its own author has not yet
                    lived with. */}
                {session?.deployed && session?.application?.appKey ? (
                  <PublishToMarketplace appKey={session.application.appKey} name={session.application.name} />
                ) : null}
                <Button size="sm" loading={busy === 'deploy'} onClick={() => deploy()}>
                  {session?.deployed ? 'Deploy the change' : 'Deploy'}
                </Button>
                <Button size="sm" variant="ghost"
                  onClick={() => {
                    setSessionId(null); setSession(null); setSpec(null); setPreview(null)
                    setMessages([]); setReport(null); setPendingApproval(null); setBuildSteps([])
                    setUrl('/studio')
                  }}>
                  New
                </Button>
              </div>
            </div>
          </>
        )}
      </aside>

      {/* the application */}
      <section className="min-h-0 min-w-0 flex-1">
        {buildSteps.length ? (
          <BuildProgress steps={buildSteps} running={!!busy} onDismiss={() => setBuildSteps([])} />
        ) : !spec ? (
          <Card className="grid h-full min-h-[240px] place-items-center">
            <EmptyState
              compact
              title="Nothing designed yet"
              description="Describe a capability and EMBMIS designs the data model, screens, workflow and permissions, then shows you before it creates anything."
            />
          </Card>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <Tabs
              label="Design"
              listClassName="mb-0"
              value={tab}
              onChange={(t) => { setTab(t); if (t === 'preview' && !preview) refreshPreview() }}
              tabs={['plan', 'preview', 'specification', 'validation', 'deploy'].map((t) => ({ id: t, label: t[0].toUpperCase() + t.slice(1) }))}
            >
            <div className="bos-scroll min-h-0 flex-1 overflow-y-auto">
              {tab === 'plan' ? <PlanView plan={plan} spec={spec} /> : null}
              {tab === 'preview' ? (
                <PreviewView spec={spec} preview={preview} pageKey={previewPage} onPage={setPreviewPage} />
              ) : null}
              {tab === 'specification' ? <SpecView spec={spec} /> : null}
              {tab === 'validation' ? <ValidationView report={report} onRun={validate} busy={busy === 'validate'} /> : null}
              {tab === 'deploy' ? (
                <DeployView session={session} pending={pendingApproval} busy={busy === 'deploy'}
                  onDeploy={deploy} onOpen={open} />
              ) : null}
            </div>
            </Tabs>
          </div>
        )}
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
/**
 * The build, while it is happening.
 *
 * The steps come from the server as it does the work, so this is a report and
 * not an animation on a timer: a step that is slow LOOKS slow, and a build that
 * has stopped stops here too. That honesty is the point — a fake progress bar
 * that keeps moving while nothing happens is worse than the spinner it
 * replaced, because it takes longer to stop trusting.
 */
function BuildProgress({ steps, running, onDismiss }) {
  const failed = steps.some((s) => s.status === 'failed')
  const currentIndex = steps.findIndex((s) => s.status === 'running')
  const changing = steps.some((s) => s.step === 'interpreting' || s.step === 'applying')

  return (
    <div className="bos-panel flex h-full flex-col p-6">
      <header className="mb-5">
        <p className="bos-eyebrow">{failed ? 'Stopped' : running ? 'Working' : 'Done'}</p>
        <h2 className="bos-title mt-1">
          {failed
            ? 'That did not finish'
            : running
              ? (changing ? 'Making your change' : 'Designing your application')
              : 'Done'}
        </h2>
        <p className="bos-caption mt-1">
          {failed
            ? 'Nothing was created. The step it stopped on is marked below.'
            : running
              ? 'Nothing is created until you deploy. You can watch it take shape here.'
              : 'Opening it now.'}
        </p>
      </header>

      <ol className="bos-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {steps.map((s, i) => {
          const done = s.status === 'done'
          const isFailed = s.status === 'failed'
          // A step is only "waiting" while something after it is still running.
          const active = s.status === 'running' && (currentIndex === i)
          return (
            <li key={`${s.step}-${i}`} className="flex gap-3 py-2">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center" aria-hidden="true">
                {isFailed ? (
                  <span className="text-[13px] leading-none text-red-500">✕</span>
                ) : done ? (
                  <span className="text-[13px] leading-none text-emerald-500">✓</span>
                ) : active ? (
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent opacity-60" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-current opacity-25" />
                )}
              </span>
              <span className="min-w-0">
                <span className={`block text-[13px] ${isFailed ? 'text-red-500' : done ? 'bos-text' : 'bos-text font-medium'}`}>
                  {s.label}
                </span>
                {s.detail ? (
                  <span className="bos-caption mt-0.5 block break-words">{s.detail}</span>
                ) : null}
              </span>
            </li>
          )
        })}
      </ol>

      {failed ? (
        <button type="button" className="bos-btn bos-btn--sm mt-4 self-start" onClick={onDismiss}>
          Back
        </button>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
function PlanView({ plan, spec }) {
  if (!plan) return <p className="bos-caption">No plan recorded for this session.</p>
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Existing EMBMIS data it will use">
        {plan.existingData.length ? (
          <ul className="space-y-1">
            {plan.existingData.map((d) => (
              <li key={d.key} className="flex items-center justify-between text-[13px] bos-text">
                <span>✓ {d.label}</span>
                <span className="bos-caption tabular-nums">{d.count ?? '—'}</span>
              </li>
            ))}
          </ul>
        ) : <p className="bos-caption">None — this application stands on its own data.</p>}
      </Card>

      <Card title="New application data">
        <ul className="space-y-1.5">
          {plan.newData.map((d) => (
            <li key={d.key} className="text-[13px] bos-text">
              <span className="bos-text-strong">+ {d.label}</span>
              <span className="bos-caption"> · {d.fields} fields{d.anchored ? ' · visible to the party it belongs to' : ''}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Who uses it">
        <ul className="space-y-1">
          {plan.surfaces.map((s) => (
            <li key={s.key} className="text-[13px] bos-text">
              ✓ {s.label} <span className="bos-caption">({s.audience}, {s.pages} screens)</span>
            </li>
          ))}
        </ul>
        <p className="bos-label mt-3 mb-1">Roles</p>
        <div className="flex flex-wrap gap-1">
          {plan.roles.map((r) => <span key={r.key} className="bos-chip">{r.label}</span>)}
        </div>
      </Card>

      <Card title="Workflow">
        {plan.workflows.length ? plan.workflows.map((w) => (
          <div key={w.key} className="mb-3">
            {/* Which records this governs. Two entities in one application
                routinely get workflows with the same label ("Progress"), and
                without the entity the plan reads as the same thing listed
                twice. */}
            <p className="bos-label mb-1">
              {w.label}
              <span className="bos-caption ml-1.5 font-normal normal-case tracking-normal">
                {plan.newData.find((d) => d.key === w.entity)?.label || w.entity}
              </span>
            </p>
            <p className="text-[12.5px] bos-text">{w.path.join(' → ')}</p>
            {w.approvals.length ? <p className="bos-caption mt-1">Needs approval: {w.approvals.join(', ')}</p> : null}
          </div>
        )) : <p className="bos-caption">No workflow — records are simply kept.</p>}
      </Card>

      <Card title="Screens">
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
          {plan.screens.map((s) => (
            <li key={s.key} className="truncate text-[12.5px] bos-text" title={`${s.title} (${s.kind})`}>
              {s.title} <span className="bos-caption">· {s.kind}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Measures and automation">
        <p className="bos-label mb-1">Measures</p>
        <div className="mb-3 flex flex-wrap gap-1">
          {plan.metrics.map((m) => <span key={m} className="bos-chip">{m}</span>)}
        </div>
        <p className="bos-label mb-1">Automation</p>
        <ul className="space-y-0.5">
          {plan.automations.map((a) => <li key={a} className="bos-caption">· {a}</li>)}
        </ul>
      </Card>
    </div>
  )
}

/**
 * The preview.
 *
 * Rendered with the deployed application's own block components over the
 * server's synthetic rows, so what a person approves is what they will get.
 */
function PreviewView({ spec, preview, pageKey, onPage }) {
  if (!preview) return <p className="bos-caption">Generating a preview…</p>
  const pages = spec.ui.pages
  const page = pages.find((p) => p.key === pageKey) || pages[0]
  if (!page) return <p className="bos-caption">This application has no screens.</p>

  const blocks = (page.layout || []).map((block, index) => previewBlock(spec, preview, page, block, index))

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1">
        {pages.map((p) => (
          <button key={p.key} type="button" onClick={() => onPage(p.key)}
            className={`bos-btn bos-btn--sm ${p.key === page.key ? 'bos-btn--primary' : 'bos-btn--ghost'}`}>
            {p.title}
          </button>
        ))}
      </div>
      <p className="bos-caption mb-3">
        Sample data, generated from the design. Nothing here has read your records — except a live monitor or twin, which shows your real records, read-only.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
        {blocks.map((b, i) => <Block key={`${b.type}-${i}`} block={b} record={b.__record} entity={b.__entity} />)}
      </div>
    </div>
  )
}

/**
 * Turn a specification block into the shape the runtime's renderer expects,
 * filled with sample data.
 *
 * Deliberately mirrors the server's page renderer rather than reimplementing
 * the components: the same Block dispatcher draws both, so a preview cannot
 * flatter a design the real screen would render differently.
 */
function previewBlock(spec, preview, page, block, index) {
  const entityKey = block.entity || page.entity
  const entity = spec.data.entities.find((e) => e.key === entityKey)
  const rows = preview.records?.[entityKey] || []
  const fieldsOf = (names) => {
    if (!entity) return []
    const all = [
      ...entity.fields.map((f) => ({ name: f.name, label: f.label, type: f.type, values: f.values || null, reference: f.target || null })),
      ...(entity.computed || []).map((c) => ({ name: c.name, label: c.label, type: c.result_type, computed: true })),
    ]
    return (names && names.length ? names : all.map((f) => f.name))
      .map((n) => all.find((f) => f.name === n)).filter(Boolean)
  }

  const base = { type: block.type, title: block.title, width: block.width, entity: entityKey, index }

  switch (block.type) {
    case 'metric': case 'metric_group': {
      const keys = block.metrics?.length ? block.metrics : [block.metric].filter(Boolean)
      return { ...base, metrics: (preview.metrics || []).filter((m) => keys.includes(m.key)) }
    }
    case 'chart_line': case 'chart_bar': case 'chart_area': case 'chart_pie':
    case 'chart_donut': case 'chart_scatter': case 'chart_stacked_bar': case 'stat_ranking':
      return { ...base, data: preview.queries?.[block.query] || { rows: [] } }
    case 'live_monitor':
      return { ...base, preview: true, live: (preview.live || preview.preview?.live || {})[block.canonical] || null }
    case 'table': case 'list': case 'related_list':
      return { ...base, fields: fieldsOf(block.fields), rows: rows.slice(0, block.limit || 10), total: rows.length }
    case 'kanban': {
      const wf = spec.workflows.find((w) => w.entity === entityKey)
      return {
        ...base, groupBy: block.group_by, fields: fieldsOf(block.fields), rows,
        columns: wf ? wf.states.map((s) => ({ key: s.key, label: s.label })) : [],
      }
    }
    case 'calendar': case 'timeline':
      return { ...base, dateField: block.date_field, titleField: entity?.display?.title_field, rows }
    case 'map':
      return {
        ...base, geoField: block.geo_field,
        points: rows.filter((r) => r[block.geo_field])
          .map((r) => ({ id: r.id, label: r[entity?.display?.title_field] || r.id, lat: r[block.geo_field].lat, lng: r[block.geo_field].lng })),
      }
    case 'detail_header':
      return { ...base, titleField: entity?.display?.title_field, subtitleField: entity?.display?.subtitle_field, __record: rows[0], __entity: entity }
    case 'field_group':
      return { ...base, fields: fieldsOf(block.fields), __record: rows[0] }
    case 'form':
      return { ...base, fields: fieldsOf(block.fields).filter((f) => !f.computed) }
    case 'workflow_bar': case 'approval_panel': {
      const wf = spec.workflows.find((w) => w.key === block.workflow)
      const current = rows[0]?.[wf?.state_field]
      return {
        ...base, workflow: block.workflow, states: wf?.states || [], current,
        transitions: (wf?.transitions || []).filter((t) => t.from === current)
          .map((t) => ({ key: t.key, label: t.label, to: t.to, allowed: true, blockedBy: [], requires: (t.requires || []).map((r) => r.type) })),
      }
    }
    case 'activity_feed':
      return {
        ...base,
        events: rows.slice(0, 4).map((r, i) => ({
          kind: i % 2 ? 'comment' : 'transition',
          summary: i % 2 ? 'Sample message on this record.' : `Moved to ${r.status || 'OPEN'}`,
          actor: { name: 'Sample user', kind: 'user' },
          at: r.created_at,
        })),
      }
    case 'comments':
      return {
        ...base, visibility: block.visibility, canWriteInternal: block.visibility !== 'shared',
        comments: [{ id: 'p1', body: 'Sample message. Real messages appear here once the application is deployed.', visibility: block.visibility || 'internal', author: { name: 'Sample user' }, at: new Date().toISOString() }],
      }
    case 'attachments':
      return { ...base, visibility: block.visibility, attachments: [] }
    case 'markdown':
      return { ...base, text: block.text }
    default:
      return base
  }
}

function SpecView({ spec }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title={`Entities (${spec.data.entities.length})`}>
        {spec.data.entities.map((e) => (
          <details key={e.key} className="mb-2">
            <summary className="cursor-pointer text-[13px] bos-text-strong">
              {e.label} <span className="bos-caption">· {e.fields.length} fields{e.anchor ? ` · anchored to a ${e.anchor.kind}` : ''}</span>
            </summary>
            <ul className="mt-1 space-y-0.5 pl-4">
              {e.fields.map((f) => (
                <li key={f.name} className="bos-caption">
                  {f.name} <span className="opacity-70">{f.type}</span>
                  {f.required ? ' · required' : ''}{f.sensitive ? ' · internal only' : ''}
                  {f.target ? ` → ${f.target.entity}` : ''}
                </li>
              ))}
              {(e.computed || []).map((c) => (
                <li key={c.name} className="bos-caption">{c.name} <span className="opacity-70">= {c.expression}</span></li>
              ))}
            </ul>
          </details>
        ))}
      </Card>

      <Card title="Security">
        {spec.security.roles.map((r) => (
          <details key={r.key} className="mb-2">
            <summary className="cursor-pointer text-[13px] bos-text-strong">
              {r.label} <span className="bos-caption">· {r.audience}</span>
            </summary>
            <ul className="mt-1 space-y-0.5 pl-4">
              {Object.entries(r.permissions).map(([entityKey, perms]) => (
                <li key={entityKey} className="bos-caption">
                  {entityKey}: {perms.join(', ')}
                  {r.record_scope?.[entityKey] === 'anchor' ? ' · own records only' : ''}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </Card>

      <Card title="Workflows">
        {spec.workflows.map((w) => (
          <div key={w.key} className="mb-3">
            <p className="text-[13px] bos-text-strong">{w.label}</p>
            <p className="bos-caption">{w.states.map((s) => s.key).join(' → ')}</p>
            <ul className="mt-1 space-y-0.5">
              {w.transitions.map((t) => (
                <li key={t.key} className="bos-caption">
                  {t.from} → {t.to}: {t.label}
                  {(t.requires || []).length ? ` (${t.requires.map((r) => r.type + (r.role ? `:${r.role}` : '')).join(', ')})` : ''}
                  {t.condition ? ` when ${t.condition}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {!spec.workflows.length ? <p className="bos-caption">None.</p> : null}
      </Card>

      <Card title="Automation and AI">
        <ul className="space-y-1">
          {spec.automations.map((a) => (
            <li key={a.key} className="bos-caption">
              {a.label} — on {a.trigger.kind.replace(/_/g, ' ')}
              {a.condition ? `, when ${a.condition}` : ''}
            </li>
          ))}
        </ul>
        {(spec.ai?.agents || []).map((a) => (
          <p key={a.key} className="bos-caption mt-2">{a.label} — {a.safety_class.replace(/_/g, ' ')}</p>
        ))}
      </Card>
    </div>
  )
}

function ValidationView({ report, onRun, busy }) {
  if (!report) {
    return (
      <div className="bos-panel p-6 text-center">
        <p className="bos-caption mb-3">Nothing checked yet.</p>
        <button type="button" className="bos-btn bos-btn--primary" onClick={onRun} disabled={busy}>
          {busy ? 'Checking…' : 'Run the checks'}
        </button>
      </div>
    )
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {Object.entries(report.sections).map(([key, section]) => (
        <Card key={key} title={`${section.label}${section.errors ? ` · ${section.errors} problem(s)` : ''}`}>
          <p className="bos-caption mb-2">{section.description}</p>
          {section.notes.map((n, i) => <p key={i} className="text-[12.5px] bos-text mb-1">{n}</p>)}
          {section.diagnostics.map((d, i) => (
            <p key={i} className={`text-[12.5px] mb-1 ${d.level === 'error' ? 'bos-accent-rose' : 'bos-text-muted'}`}>
              {d.level === 'error' ? '✕' : '!'} {d.message}
            </p>
          ))}
          {!section.notes.length && !section.diagnostics.length ? <p className="bos-caption">Nothing to report.</p> : null}
        </Card>
      ))}
    </div>
  )
}

function DeployView({ session, pending, busy, onDeploy, onOpen }) {
  const [acknowledged, setAcknowledged] = React.useState([])
  const destructive = pending?.summary?.destructive || []
  const review = pending?.summary?.review || []

  if (session?.deployed && !pending) {
    return (
      <div className="bos-panel p-6">
        <h3 className="bos-title text-[15px]">Deployed</h3>
        <p className="bos-caption mt-1">
          This application is live for your company, with its own tables and its own row-level isolation.
        </p>
        <button type="button" className="bos-btn bos-btn--primary mt-4" onClick={onOpen}>Open it</button>
      </div>
    )
  }

  if (!pending) {
    return (
      <div className="bos-panel p-6">
        <h3 className="bos-title text-[15px]">Ready to deploy</h3>
        <p className="bos-caption mt-1">
          Deploying creates this company&rsquo;s own physical tables for the application and makes it available
          to the roles it declares. It touches no other company.
        </p>
        <button type="button" className="bos-btn bos-btn--primary mt-4" onClick={() => onDeploy()} disabled={busy}>
          {busy ? 'Deploying…' : 'Deploy'}
        </button>
      </div>
    )
  }

  return (
    <div className="bos-panel p-6">
      <h3 className="bos-title text-[15px]">This change needs your approval</h3>
      <p className="bos-caption mt-1">
        The plan is classified &ldquo;{pending.safety}&rdquo;. Each step below has to be accepted before it runs.
      </p>

      {review.length ? (
        <>
          <p className="bos-label mt-4 mb-1">Behaviour changes</p>
          <ul className="space-y-1">{review.map((r, i) => <li key={i} className="bos-caption">· {r}</li>)}</ul>
        </>
      ) : null}

      {destructive.length ? (
        <>
          <p className="bos-label mt-4 mb-1">These destroy data</p>
          <ul className="space-y-2">
            {destructive.map((d) => (
              <li key={d} className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={acknowledged.includes(d)}
                  onChange={(e) => setAcknowledged((a) => (e.target.checked ? [...a, d] : a.filter((x) => x !== d)))} />
                <span className="text-[12.5px] bos-text">{d}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <button type="button" className="bos-btn bos-btn--primary mt-4"
        disabled={busy || destructive.some((d) => !acknowledged.includes(d))}
        onClick={() => onDeploy(acknowledged)}>
        {busy ? 'Deploying…' : 'Approve and deploy'}
      </button>
    </div>
  )
}

const firstPage = (spec) => spec?.ui?.pages?.[0]?.key || null
const lastPayload = (messages, kind) => {
  const found = [...messages].reverse().find((m) => m.kind === kind)
  return found?.payload || null
}
