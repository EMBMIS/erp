import React, { Suspense, lazy } from 'react'
import { Link, useLocation } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Bars3Icon, CheckIcon, ChevronDownIcon, ClipboardDocumentIcon, DocumentIcon, DocumentTextIcon,
  PhotoIcon, TableCellsIcon, CodeBracketIcon, PencilIcon, ArrowPathIcon, MicrophoneIcon,
  PaperClipIcon, MagnifyingGlassIcon, StopIcon, HandThumbDownIcon, HandThumbUpIcon, TrashIcon,
  UserIcon, XMarkIcon, PaperAirplaneIcon, PlusIcon, ViewColumnsIcon,
} from '@heroicons/react/20/solid'
import toast from 'react-hot-toast'
import api, { API_BASE_URL } from '../../services/api'
import { useI18n } from '../../contexts/I18nContext'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  Button, IconButton, Input, Select, Textarea, Field, Sheet, Dialog, InlineNotice, SimeliMark,
} from '../../components/ui'
import AgentLoop from '../../components/simeli/AgentLoop'
import { GatewayLine } from '../../components/ui/Gateway'
import ContextSurface from '../../components/simeli/ContextSurface'
import {
  ActionCard, FigureStrip, humanizeKey,
} from '../../components/simeli/ResultBlocks'
import DynamicChart from '../../components/ai/DynamicChart'
import SimeliChart from '../../components/simeli/SimeliChart'
import ArtifactBlock from '../../components/simeli/ArtifactBlock'
import TurnBoundary from '../../components/simeli/TurnBoundary'
import useDictation from '../../hooks/useDictation'

// The 3D symbiote is canvas-only but still a sizeable module; it loads after
// the workspace so the composer is usable first.
const QiraSymbiote = lazy(() => import('../../components/qira/QiraSymbiote'))

/**
 * One attached file as a modern chat chip: a cover thumbnail when the server
 * kept one (image uploads, scanned-PDF first pages), otherwise a file-type
 * icon. The preview bytes are fetched with the app's auth and shown as a
 * blob URL — an <img> tag alone cannot carry the Authorization header.
 */
function AttachmentChip({ file, sessionId, onRemove, compact }) {
  const [src, setSrc] = React.useState(null)
  React.useEffect(() => {
    if (!file.has_preview) return
    let alive = true
    api.get(`/ai-chat/attachments/${sessionId}/${file.id}/preview`, { responseType: 'blob' })
      .then((res) => { if (alive && res.data?.size) setSrc(URL.createObjectURL(res.data)) })
      .catch(() => { /* icon fallback */ })
    return () => { alive = false }
  }, [file.id, file.has_preview, sessionId])

  React.useEffect(() => () => { if (src) URL.revokeObjectURL(src) }, [src])

  const ext = String(file.name || '').split('.').pop()?.toLowerCase()
  let Icon = DocumentIcon
  if (['pdf'].includes(ext)) Icon = DocumentTextIcon
  else if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) Icon = PhotoIcon
  else if (['csv', 'tsv', 'xlsx', 'xls'].includes(ext)) Icon = TableCellsIcon
  else if (['json', 'xml', 'yml', 'yaml', 'sql', 'html', 'htm', 'log', 'md', 'markdown'].includes(ext)) Icon = CodeBracketIcon

  const thumbSize = compact ? 'h-7 w-7' : 'h-9 w-9'
  return (
    <span className="sim-ref flex items-center gap-1.5">
      {src ? (
        <img src={src} alt="" className={`${thumbSize} flex-none rounded border border-ink-200 object-cover`} />
      ) : (
        <span className={`${thumbSize} flex flex-none items-center justify-center rounded bg-ink-100`}>
          <Icon className={`${compact ? 'h-3 w-3' : 'h-4 w-4'} text-ink-500`} aria-hidden="true" />
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className={`max-w-[12rem] truncate ${compact ? 'text-2xs' : 'text-xs'}`}>{file.name}</span>
        {!compact && (
          <span className="text-2xs text-ink-500">
            {file.truncated ? 'truncated' : `${Math.max(1, Math.round(file.characters / 1000))}k chars`}
          </span>
        )}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
          className="ml-0.5 inline-flex h-6 w-6 items-center justify-center rounded text-ink-500 hover:bg-ink-100 hover:text-risk-600"
        >
          <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </span>
  )
}

/**
 * Simeli — the agent workspace.
 *
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * Not a chat window with an ERP behind it. The conversation is the reasoning
 * surface; around it sit the two things a person needs in order to trust an
 * agent that can act on their business: what it is doing right now, and what it
 * has touched.
 *
 *   left    the investigations themselves — each conversation is a durable
 *           piece of work you can come back to, not a disposable thread
 *   centre  the reasoning: the question, the loop, the answer, the objects the
 *           answer is made of
 *   right   the context surface — modules in play, records in view, actions
 *           awaiting a decision. Sections appear as the investigation reaches
 *           them and vanish when it does not; see ContextSurface.jsx.
 *
 * WHAT IT TALKS TO
 * ---------------------------------------------------------------------------
 * The real endpoints, which were already there and already working:
 *
 *   POST   /api/ai-chat/message/stream   { message, sessionId, mode }   SSE
 *   POST   /api/ai-agent/confirm/stream  { pauseId, decisions }         SSE
 *   GET    /api/ai-chat/history/:id
 *   GET    /api/ai-chat/conversations
 *   GET    /api/ai-chat/workspace/:id
 *   PATCH  /api/ai-chat/workspace/:id
 *
 * The previous version of this file posted to `/api/ai-chat` with `session_id`
 * and `agent_mode`. No such route exists and the server reads `sessionId` and
 * `mode`, so every request 404'd — and the catch block answered anyway, with
 * invented euro figures. That is the single worst thing a component in an ERP
 * can do, and it is why there is no fallback path in this file at all. A
 * request that fails says it failed.
 *
 * NOTHING HERE INVENTS A NUMBER
 * ---------------------------------------------------------------------------
 * Every figure rendered came off a tool result, digested server-side by
 * services/ai/agentNarration.js. Every stage in the loop is a tool that ran.
 * Where a measurement is absent the interface says which one and why.
 */

const LS_ACTIVE = 'simeli.workspace.active'
const LS_MODE = 'simeli.workspace.mode'
const LS_CONTEXT_OPEN = 'simeli.workspace.contextOpen'

// A subset of MODES in backend/services/ai/agent.js — how much Simeli may do
// before a person clicks approve. Only the two tiers that keep a person in the
// loop for anything that changes a record are offered here: Simeli proposes,
// a person approves, nothing runs on its own. ('auto' and 'bypass' still exist
// server-side; a browser that had one stored falls back to Accept edits.)
const MODES = [
  { value: 'manual', label: 'Ask before every step', hint: 'Confirm every tool call, read or write' },
  { value: 'accept_edits', label: 'Ask before changes', hint: 'Reads and drafts run; anything that changes a record waits for you' },
]
const safeMode = (m) => (MODES.some((x) => x.value === m) ? m : 'accept_edits')

const newSessionId = () => `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`

const readLs = (k, fallback) => {
  try { const v = localStorage.getItem(k); return v === null ? fallback : v } catch { return fallback }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

async function consumeSse(response, onEvent) {
  if (!response.ok) throw new Error(`Simeli returned ${response.status}`)
  if (!response.body) throw new Error('Simeli returned no stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const line = frame.startsWith('data: ') ? frame.slice(6) : frame
      if (!line || line === '[DONE]') continue
      try { onEvent(JSON.parse(line)) } catch { /* a malformed frame is skipped, not fatal */ }
    }
  }
}

// ---------------------------------------------------------------------------
// One turn's result: the prose, plus the objects the tools produced.
// ---------------------------------------------------------------------------

function ToolResultBlock({ call }) {
  if (call.status === 'error') {
    return (
      <div className="sim-block border-risk-200">
        <div className="sim-block-head text-risk-700">{call.meta?.verb || call.name} — failed</div>
        <p className="px-3.5 py-2.5 text-xs text-ink-600">
          {call.error || 'The tool returned an error.'}
        </p>
      </div>
    )
  }

  if (call.chart) {
    // A spec carrying layers was composed by Simeli (render_chart) and gets the
    // renderer that can draw what it composed. The older generate_chart specs —
    // chart_type plus x_key plus y_keys — keep the Recharts path, so nothing
    // that already worked stops working.
    return Array.isArray(call.chart.layers)
      ? <SimeliChart spec={call.chart} />
      : <DynamicChart chart_spec={call.chart} />
  }

  if (call.surfaced) return <SurfacedData data={call.surfaced} />

  return null
}

/**
 * Rows or figures the model decided the reader should see without opening
 * anything — the output of show_data.
 *
 * Marked with where it came from, because a table in the body of an answer
 * carries more authority than one in a dropdown and should be at least as
 * traceable.
 */
function SurfacedData({ data }) {
  if (data.kind === 'figures') {
    return (
      <div className="sim-block">
        {data.title && <div className="sim-block-head">{data.title}</div>}
        <FigureStrip figures={data.figures} />
        <SourceLine data={data} />
      </div>
    )
  }

  if (data.empty) {
    return (
      <div className="sim-block">
        {data.title && <div className="sim-block-head">{data.title}</div>}
        <p className="px-3.5 py-2.5 text-sm text-ink-600">
          Nothing matched.
        </p>
        <SourceLine data={data} />
      </div>
    )
  }

  // A surfaced table is a payload from the server, and payloads can arrive
  // malformed — an older trace, a tool that changed shape, a partially written
  // row. Say what is missing rather than throwing: the turn's answer is worth
  // more than the table that failed to come with it.
  const columns = Array.isArray(data.columns) ? data.columns : []
  const rows = Array.isArray(data.rows) ? data.rows : []
  if (columns.length === 0 || rows.length === 0) {
    return (
      <div className="sim-block">
        {data.title && <div className="sim-block-head">{data.title}</div>}
        <p className="px-3.5 py-2.5 text-sm text-ink-600">
          This table arrived without {columns.length === 0 ? 'any columns' : 'any rows'}, so there is
          nothing to show here. The full result is in the tool dropdown above.
        </p>
        <SourceLine data={data} />
      </div>
    )
  }

  return (
    <div className="sim-block">
      {data.title && <div className="sim-block-head">{data.title}</div>}
      <div className="sim-wide">
        <table className="w-full text-sm">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c}
                  className="label-mono border-b border-ink-200 px-3 py-1.5 text-left"
                >
                  {humanizeKey(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => {
                  const v = row[c]
                  const n = typeof v === 'number' ? v : null
                  return (
                    <td
                      key={c}
                      className={`border-b border-ink-100 px-3 py-1.5 ${n === null ? '' : 'text-right tabular-nums'}`}
                    >
                      {v === null || v === undefined || v === ''
                        ? <span className="text-ink-400">—</span>
                        : n === null ? String(v) : n.toLocaleString()}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SourceLine data={data} />
    </div>
  )
}

/** Where a surfaced table or figure came from: the tool that read it, and how much more there is. */
function SourceLine({ data }) {
  const more = data.total > (data.rows?.length || 0) ? data.total - data.rows.length : 0
  return (
    <div className="flex flex-col gap-0.5 border-t border-ink-100 px-3.5 py-2">
      {data.note && <span className="text-xs leading-snug text-ink-600">{data.note}</span>}
      <span className="text-2xs text-ink-500">
        Read from <span className="font-mono">{data.from_tool}</span>
        {more > 0 ? ` · ${more.toLocaleString()} more in the steps above` : ''}
      </span>
    </div>
  )
}

/**
 * A quiet icon button that only appears on hover or focus.
 *
 * Focus matters as much as hover here: an action reachable only by pointer is
 * an action a keyboard user does not have.
 */
function IconAction({ label, icon, onClick, disabled }) {
  return <IconButton icon={icon} label={label} onClick={onClick} disabled={disabled} size="sm" />
}

function AssistantTurn({ turn, onApprove, onDeny, busy, copied, onCopy, onRetry, onRegenerate, onContinue, rated, onRate }) {
  const steps = (turn.calls || []).map((c, i) => ({
    id: `${c.name}-${i}`,
    verb: c.meta?.verb || c.name,
    status: c.status,
    error: c.error,
    // The data goes into the dropdown with the step that fetched it, rather
    // than into the body of the answer. See StepData in AgentLoop.jsx.
    digest: c.digest,
    // Except when the step's whole output IS what the reader is looking at.
    producedOutput: !!(c.chart || c.surfaced),
    reading: c.warnings?.length
      ? `redrawn · ${c.warnings.length} issue${c.warnings.length === 1 ? '' : 's'}`
      : c.digest?.inconclusive
        ? 'inconclusive'
        : c.digest?.count !== undefined
          ? `${c.digest.count.toLocaleString()} ${c.digest.unit || ''}`.trim()
          : null,
  }))

  // What goes in the body of the answer.
  //
  // Charts the model drew, and rows or figures it explicitly promoted with
  // show_data. Not every tool result — those all live in the dropdown above,
  // attached to the step that fetched them. Printing them here as well was what
  // turned a one-sentence answer into a wall of panels.
  //
  // Only the last chart from any one tool survives: render_chart returns
  // warnings when a layer named a column that does not exist and the model
  // redraws, so both attempts are real calls. Rendering both would show a
  // broken chart above a good one and leave the reader to work out which is
  // which; the superseded attempt stays in the loop, where it reads as a
  // correction.
  const lastChartByTool = new Map()
  for (const [i, c] of (turn.calls || []).entries()) {
    if (c.status === 'done' && c.chart) lastChartByTool.set(c.name, i)
  }
  const blocks = (turn.calls || []).filter((c, i) => (
    c.status === 'done'
    && (
      (c.chart && lastChartByTool.get(c.name) === i)
      || c.surfaced
    )
  ))

  return (
    <div className="group flex gap-3">
      <SimeliMark className="mt-0.5 shrink-0" />

      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {steps.length > 0 && (
          <AgentLoop
            steps={steps}
            calls={turn.calls}
            thoughts={turn.thoughts}
            working={turn.working}
            blocked={!!turn.pending?.length}
            title={turn.title}
          />
        )}

        {/* Before the first token there is nothing to show but the fact that
            something is happening. Without this the screen sits empty for the
            length of a model call and reads as broken. */}
        {turn.working && !turn.content && !steps.length && (
          <p className="flex items-center gap-2 text-sm text-ink-500">
            <span className="sim-thinking" aria-hidden="true"><i /><i /><i /></span>
            Reading
          </p>
        )}

        {turn.content && (
          <div className="max-w-none text-sm leading-relaxed text-ink-800">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>
              {turn.content}
            </ReactMarkdown>
            {turn.working && !turn.pending?.length && <span className="sim-caret" />}
          </div>
        )}

        <GatewayLine stats={turn.gateway} />

        {turn.stopped && (
          <p className="text-xs text-ink-500">
            You stopped this. What arrived before the stop is above.
          </p>
        )}

        {/* Reached the step ceiling. Not an error, and not the end: the run is
            saved and picks up mid-investigation. */}
        {turn.continueId && !turn.working && onContinue && (
          <div className="flex flex-wrap items-center gap-2.5">
            <Button size="sm" icon={ArrowPathIcon} disabled={busy} onClick={() => onContinue(turn)}>
              Keep going
            </Button>
            <span className="text-xs text-ink-500">
              It stopped at its step limit. Nothing is lost — it will carry on from here.
            </span>
          </div>
        )}

        {blocks.map((c, i) => <ToolResultBlock key={`${c.name}-block-${i}`} call={c} />)}

        {turn.artifacts?.map((doc, i) => (
          <ArtifactBlock key={doc.document_id || `art-${i}`} document={doc} />
        ))}

        {turn.pending?.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-warn-700">
              Simeli has stopped and is waiting on you. Nothing below runs until you approve it.
            </p>
            {turn.pending.map((p) => {
              // A batch of several pending calls (e.g. one per CRM row) is one
              // paused run: the server resolves it in a single decisions array
              // covering every call. Deciding on one card locally records its
              // choice without submitting yet, so the rest stay clickable —
              // submitting early used to send `approve: false` for every card
              // nobody had clicked, which read as "denied" for rows the person
              // had not gotten to.
              const decision = turn.decisions?.[p.id]
              return (
                <ActionCard
                  key={p.id}
                  action={{
                    name: p.name,
                    verb: p.meta?.verb || p.name,
                    module: p.meta?.module || 'Data',
                    state: decision ? (decision.approve ? 'approved' : 'denied') : 'proposed',
                    gateway: p.gateway,
                    summary: p.args && Object.keys(p.args).length
                      ? Object.entries(p.args).slice(0, 4)
                          .map(([k, v]) => `${humanizeKey(k)}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60)}`)
                          .join(' · ')
                      : null,
                  }}
                  busy={busy}
                  onApprove={(_action, always) => onApprove(p, always)}
                  onDeny={() => onDeny(p)}
                />
              )
            })}
          </div>
        )}

        {turn.error && (
          <div className="sim-block border-risk-200">
            <div className="sim-block-head text-risk-700">Simeli could not answer</div>
            <p className="px-3.5 py-2.5 text-sm leading-relaxed text-ink-700">
              {turn.error}
            </p>
            <p className="px-3.5 pb-2.5 text-xs text-ink-500">
              Nothing was answered from cached or example data — if Simeli cannot
              reach the ERP, it says so rather than guessing.
            </p>
            {turn.retry && onRetry && (
              <div className="border-t border-ink-200 px-3.5 py-2.5">
                <Button size="sm" icon={ArrowPathIcon} disabled={busy} onClick={() => onRetry(turn)}>
                  Try again
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Actions on a finished turn. Hidden until hover or focus so a long
            transcript is not a column of buttons. */}
        {!turn.working && (turn.content || turn.error) && (
          <div className="flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {turn.content && onCopy && (
              <IconAction
                label={copied === turn.id ? 'Copied' : 'Copy answer'}
                icon={copied === turn.id ? CheckIcon : ClipboardDocumentIcon}
                onClick={() => onCopy(turn.content, turn.id)}
              />
            )}
            {onRegenerate && (
              <IconAction
                label="Ask again"
                icon={ArrowPathIcon}
                disabled={busy}
                onClick={() => onRegenerate(turn)}
              />
            )}
            {turn.content && onRate && (
              <>
                <IconAction
                  label={rated === 'up' ? 'Marked helpful' : 'Helpful'}
                  icon={HandThumbUpIcon}
                  disabled={!!rated}
                  onClick={() => onRate(turn, true)}
                />
                <IconAction
                  label={rated === 'down' ? 'Feedback sent' : 'Not right — tell Simeli why'}
                  icon={HandThumbDownIcon}
                  disabled={!!rated}
                  onClick={() => onRate(turn, false)}
                />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * A fenced code block, with its language and a copy button.
 *
 * Code you cannot copy is code you retype, and retyped code is code with a
 * typo in it. The button lives in the block's own header so it does not sit on
 * top of the first line.
 */
function CodeBlock({ language, children }) {
  const [done, setDone] = React.useState(false)
  const text = React.Children.toArray(children).join('')

  const copyIt = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setDone(true)
      setTimeout(() => setDone(false), 1600)
    } catch { /* blocked outside a secure context; the text is still selectable */ }
  }

  return (
    <div className="my-2.5 overflow-hidden rounded-md border border-ink-200 bg-sunken">
      <div className="flex items-center gap-2 border-b border-ink-200 px-2.5 py-1">
        <span className="label-mono">{language || 'code'}</span>
        <Button size="xs" variant="ghost" className="ml-auto" icon={done ? CheckIcon : ClipboardDocumentIcon} onClick={copyIt}>
          {done ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="sim-wide m-0 p-3 text-xs leading-relaxed">
        <code>{children}</code>
      </pre>
    </div>
  )
}

// Markdown that inherits the workspace's type rather than bringing its own.
const MD = {
  p: ({ children }) => <p className="mb-2.5 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2.5 ml-4 list-disc space-y-1 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2.5 ml-4 list-decimal space-y-1 last:mb-0">{children}</ol>,
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  code: ({ inline, className, children }) => (inline
    ? <code className="rounded bg-ink-100 px-1 py-0.5 text-xs text-ink-800">{children}</code>
    : <CodeBlock language={/language-(\w+)/.exec(className || '')?.[1]}>{children}</CodeBlock>),
  table: ({ children }) => (
    <div className="sim-wide my-2.5 rounded-md border border-ink-200">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="label-mono border-b border-ink-200 px-2.5 py-1.5 text-left">{children}</th>,
  td: ({ children }) => <td className="border-b border-ink-100 px-2.5 py-1.5">{children}</td>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-600 underline underline-offset-2">{children}</a>,
}

// ---------------------------------------------------------------------------

export default function AIChat() {
  const { t, locale } = useI18n()
  const location = useLocation()
  // Whether a language model is connected at all. Without one every question
  // fails, so the screen says so before anyone types. Optional: a role that
  // may not read AI settings simply gets no notice.
  const { data: aiSettings } = useResource(
    keys.aiSettings(),
    ({ signal }) => api.get('/ai-settings', { signal }),
    { retry: false },
  )
  const noModel = aiSettings && aiSettings.ai_enabled === false

  const [conversations, setConversations] = React.useState([])
  const [sessionId, setSessionId] = React.useState(() => readLs(LS_ACTIVE, null) || newSessionId())
  const [turns, setTurns] = React.useState([])
  const [input, setInput] = React.useState('')
  const [working, setWorking] = React.useState(false)
  const [mode, setMode] = React.useState(() => safeMode(readLs(LS_MODE, 'accept_edits')))
  const [workspace, setWorkspace] = React.useState(null)
  const [contextOpen, setContextOpen] = React.useState(() => readLs(LS_CONTEXT_OPEN, '1') !== '0')
  const [drawer, setDrawer] = React.useState(null) // 'context' | 'history' | null
  const [loadingHistory, setLoadingHistory] = React.useState(false)

  const endRef = React.useRef(null)
  const inputRef = React.useRef(null)
  const scrollRef = React.useRef(null)
  const abortRef = React.useRef(null)
  // False the moment the reader scrolls away from the bottom. Chats that
  // ignore this drag you back down mid-sentence every time a token arrives,
  // which makes reading an earlier answer while a new one streams impossible.
  const [pinned, setPinned] = React.useState(true)
  const [copied, setCopied] = React.useState(null)
  // The turn currently streaming. Held in a ref as well as state because the
  // SSE handler fires far faster than React commits, and reading the latest
  // turn out of `turns` inside the handler would read a stale copy.
  const liveRef = React.useRef(null)

  React.useEffect(() => { try { localStorage.setItem(LS_ACTIVE, sessionId) } catch { /* storage off */ } }, [sessionId])
  React.useEffect(() => { try { localStorage.setItem(LS_MODE, mode) } catch { /* storage off */ } }, [mode])
  React.useEffect(() => {
    try { localStorage.setItem(LS_CONTEXT_OPEN, contextOpen ? '1' : '0') } catch { /* storage off */ }
  }, [contextOpen])

  // --- loading -------------------------------------------------------------

  const loadConversations = React.useCallback(async () => {
    try {
      const res = await api.get('/ai-chat/conversations')
      setConversations((res.data?.data || []).map((c) => ({
        id: c.session_id,
        title: c.title || 'Untitled investigation',
        objective: c.objective,
        modules: c.modules || [],
        pinned: c.pinned,
        updatedAt: c.updated_at,
        messageCount: c.message_count,
      })))
    } catch {
      // A workspace that cannot list past investigations still works for this
      // one. No placeholder list — an empty list here means "could not load",
      // and the panel says so rather than showing invented rows.
      setConversations([])
    }
  }, [])

  const loadWorkspace = React.useCallback(async (id) => {
    try {
      const res = await api.get(`/ai-chat/workspace/${id}`)
      setWorkspace(res.data?.data || null)
    } catch {
      setWorkspace(null)
    }
  }, [])

  /** Rebuild the transcript from the server's record of it. */
  const loadHistory = React.useCallback(async (id) => {
    setLoadingHistory(true)
    try {
      const res = await api.get(`/ai-chat/history/${id}`)
      const rows = res.data?.history || []
      const rebuilt = []
      for (const row of rows) {
        if (row.role === 'user') {
          rebuilt.push({
            id: `u-${rebuilt.length}`,
            role: 'user',
            content: row.content,
            at: row.created_at,
            // Which files this message was sent with (server snapshot).
            attachments: Array.isArray(row.attachment_info) ? row.attachment_info : [],
          })
        } else if (row.role === 'assistant') {
          rebuilt.push({
            id: `a-${rebuilt.length}`,
            role: 'assistant',
            content: row.content,
            at: row.created_at,
            // tool_results is the trace the route persisted — the same shape
            // the live stream builds, so a reloaded turn renders identically to
            // one that just happened.
            calls: Array.isArray(row.tool_results) ? row.tool_results : [],
            artifacts: Array.isArray(row.artifacts) ? row.artifacts : [],
          })
        }
      }
      setTurns(rebuilt)
    } catch {
      setTurns([])
    } finally {
      setLoadingHistory(false)
    }
  }, [])

  // --- attachments ---------------------------------------------------------
  const [files, setFiles] = React.useState([])
  const [uploading, setUploading] = React.useState(false)
  const fileRef = React.useRef(null)

  const loadFiles = React.useCallback(async (id) => {
    try {
      const res = await api.get(`/ai-chat/attachments/${id}`)
      setFiles(res.data?.data || [])
    } catch {
      setFiles([])
    }
  }, [])

  const attach = React.useCallback(async (list) => {
    const chosen = Array.from(list || [])
    if (!chosen.length) return
    setUploading(true)
    for (const file of chosen) {
      const form = new FormData()
      form.append('file', file)
      try {
        // The shared api instance defaults to Content-Type: application/json,
        // which would send this FormData as a JSON blob and arrive on the
        // server with no file at all. Same override the CRM import and
        // knowledge-base uploads use; axios lets the browser set the boundary.
        const res = await api.post(`/ai-chat/attachments/${sessionId}`, form, {
          headers: { 'Content-Type': 'multipart/form-data' },
          // Scanned pages are OCR'd at upload time (vision model, seconds per
          // page) — the shared 30s axios default aborted those mid-flight.
          timeout: 180000,
        })
        setFiles((prev) => [...prev, res.data.data])
      } catch (err) {
        // The server says which file and why — a scanned PDF, an unsupported
        // type. Surfacing that verbatim is more use than "upload failed".
        toast.error(err?.response?.data?.error || `Could not attach ${file.name}.`)
      }
    }
    setUploading(false)
  }, [sessionId])

  const detach = React.useCallback(async (id) => {
    setFiles((prev) => prev.filter((f) => f.id !== id))
    try { await api.delete(`/ai-chat/attachments/${sessionId}/${id}`) } catch { /* already gone */ }
  }, [sessionId])

  React.useEffect(() => { loadConversations() }, [loadConversations])
  React.useEffect(() => {
    if (!sessionId) return
    loadHistory(sessionId)
    loadWorkspace(sessionId)
    loadFiles(sessionId)
  }, [sessionId, loadHistory, loadWorkspace, loadFiles])

  /**
   * Reattach to a turn that is still running.
   *
   * Reloading mid-answer used to show the question and nothing else, with no
   * sign anything was happening — so the obvious move was to ask again, which
   * started a second run and wasted the first. The run now survives the
   * reload; this is the half that tells you so, and pulls the answer in when
   * it lands.
   *
   * Polling rather than reconnecting to the stream: the tokens already
   * streamed are gone with the old connection, and the answer is saved whole
   * at the end anyway. Every 3s — this is a page someone is staring at, and
   * the alternative is them refreshing by hand.
   */
  const [resuming, setResuming] = React.useState(null)
  // Mirrored in a ref because the poll has to know whether it was previously
  // watching a run, and it cannot read that from state: `resuming` is
  // deliberately not a dependency (including it would restart the effect on
  // every tick and turn a 3s cadence into a tight loop), so the closure's copy
  // is stale by the second call. Reading the stale copy meant the "it just
  // finished" branch never fired and the answer never loaded — the banner
  // cleared and the reply simply never appeared.
  const wasResuming = React.useRef(false)

  React.useEffect(() => {
    if (!sessionId || working) return undefined
    let alive = true
    let timer = null

    const check = async () => {
      try {
        const res = await api.get(`/ai-chat/state/${sessionId}`)
        const state = res.data?.data
        if (!alive) return
        if (state?.running) {
          wasResuming.current = true
          setResuming(state)
          timer = setTimeout(check, 3000)
        } else if (wasResuming.current) {
          // It finished while we were away. Pull the saved answer in.
          wasResuming.current = false
          setResuming(null)
          loadHistory(sessionId)
          loadWorkspace(sessionId)
        } else {
          setResuming(null)
        }
      } catch {
        if (alive) setResuming(null)
      }
    }

    check()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [sessionId, working, loadHistory, loadWorkspace])

  // Follow the stream only while the reader is at the bottom.
  // (Not on an empty investigation: there is nothing to follow, and scrolling
  // would hide the top of the opening screen on a short phone.)
  React.useEffect(() => {
    if (!pinned || turns.length === 0) return
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns, working, pinned])

  // Re-pin when they scroll back down themselves. 48px of slack, because
  // smooth-scroll and sub-pixel heights mean "at the bottom" is never exact.
  const onScroll = React.useCallback((e) => {
    const el = e.currentTarget
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
  }, [])

  const jumpToLatest = React.useCallback(() => {
    setPinned(true)
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [])

  // --- sending -------------------------------------------------------------

  const applyEvent = React.useCallback((event) => {
    const live = liveRef.current
    if (!live) return

    if (event.type === 'delta') {
      live.content = (live.content || '') + (event.content || '')
      // Tracked separately so a step that turns out to be reasoning can be
      // lifted back out cleanly, without guessing where it started.
      live.stepText = (live.stepText || '') + (event.content || '')
    } else if (event.type === 'step_end') {
      // Text from a step that went on to call a tool was reasoning, not the
      // answer.
      //
      // There is no way to know in advance which it will be — the model writes
      // before it decides whether to call anything — so it streams into the
      // bubble and is pulled back out here, the moment step_end says the step
      // was not final. It lands in the dropdown with the steps it was
      // reasoning about, where it explains them, instead of sitting in the
      // answer making it read like a monologue.
      //
      // The previous version of this assigned a marker and never removed
      // anything, so every intermediate thought stayed in the reply.
      if (!event.final && live.stepText?.trim()) {
        const text = live.stepText
        if (live.content?.endsWith(text)) {
          live.content = live.content.slice(0, live.content.length - text.length)
        }
        live.thoughts = [...(live.thoughts || []), { step: event.step, text: text.trim() }]
      }
      live.stepText = ''
    } else if (event.type === 'tool_call') {
      live.calls = [...(live.calls || []), {
        name: event.name, meta: event.meta, args: event.args, status: 'running',
      }]
      if (event.meta?.module) live.modules = [...new Set([...(live.modules || []), event.meta.module])]
      // A write tool that reached tool_call has cleared whatever gate its mode
      // required, so it is executing now. Recorded on the turn as well as
      // server-side, because the context surface should show it the moment it
      // happens rather than after the workspace refetch that follows the run.
      if (['draft', 'act', 'build'].includes(event.meta?.kind)) {
        live.actions = [...(live.actions || []), {
          name: event.name,
          verb: event.meta.verb,
          module: event.meta.module,
          state: 'executing',
          at: new Date().toISOString(),
        }]
      }
    } else if (event.type === 'tool_result') {
      const calls = [...(live.calls || [])]
      for (let i = calls.length - 1; i >= 0; i -= 1) {
        if (calls[i].name === event.name && calls[i].status === 'running') {
          // The matching action moves off 'executing' the moment its result
          // lands — the one transition it would be worst to get wrong.
          if (['draft', 'act', 'build'].includes(calls[i].meta?.kind)) {
            live.actions = (live.actions || []).map((a) => (
              a.name === event.name && a.state === 'executing'
                ? { ...a, state: event.ok ? 'executed' : 'denied' }
                : a
            ))
          }
          calls[i] = {
            ...calls[i],
            status: event.ok ? 'done' : 'error',
            error: event.error,
            digest: event.digest,
            chart: event.chart,
            surfaced: event.surfaced,
            // A chart that came back with warnings was not what the model
            // intended. It gets to redraw on the next step; showing the
            // warnings on the superseded attempt is how that reads as one
            // correction rather than two different charts.
            warnings: event.warnings,
            document: event.document,
          }
          break
        }
      }
      live.calls = calls
      if (event.document) live.artifacts = [...(live.artifacts || []), event.document]
      for (const r of event.digest?.records || []) {
        live.entities = [...(live.entities || []), {
          type: event.digest.area, module: event.digest.module, label: r.label, id: r.id,
        }]
      }
    } else if (event.type === 'tool_denied') {
      live.calls = [...(live.calls || []), {
        name: event.name, meta: event.meta, status: 'denied',
      }]
    } else if (event.type === 'gateway') {
      // EMBMIS Gateway checked a tool call. Counted as they arrive; the server's own
      // totals replace this when the turn ends.
      const g = { allowed: 0, blocked: 0, escalated: 0, unchecked: 0, ...(live.gateway || {}) }
      if (event.decision === 'deny') g.blocked += 1
      else if (event.decision === 'escalate') g.escalated += 1
      else g.allowed += 1
      if (event.origin === 'fallback') g.unchecked += 1
      live.gateway = g
    } else if (event.type === 'tool_blocked') {
      live.calls = [...(live.calls || []), {
        name: event.name, meta: event.meta, args: event.args, status: 'error',
        error: `Blocked by EMBMIS Gateway: ${event.reason}`,
      }]
    } else if (event.type === 'awaiting_confirmation') {
      live.pending = event.pending || []
    } else if (event.type === 'step_limit') {
      live.continueId = event.continueId
    } else if (event.type === 'done') {
      if (event.gateway) live.gateway = event.gateway
      if (event.success === false) live.error = event.response || 'The request failed.'
      else if (event.response) live.content = event.response
      if (event.continueId) live.continueId = event.continueId
      if (event.status === 'awaiting_confirmation') {
        live.pending = event.pending || []
        live.pauseId = event.pauseId
      } else {
        live.pending = []
      }
    }

    setTurns((prev) => prev.map((tn) => (tn.id === live.id ? { ...live } : tn)))
  }, [])

  const run = React.useCallback(async (url, body, turn) => {
    liveRef.current = turn
    // A run you cannot stop is a run that owns your screen. The controller is
    // held in a ref rather than state because stop() must reach the CURRENT
    // request, and a stale closure would abort nothing.
    const controller = new AbortController()
    abortRef.current = controller
    setWorking(true)
    try {
      const token = localStorage.getItem('token')
      // Raw fetch, not the axios client: SSE needs the streamed response
      // unfiltered by the interceptor. The URL must carry the API base —
      // in production the app lives at /platform, and a bare '/api/...'
      // fetch resolves to the landing site's territory and 404s. But
      // API_BASE_URL (services/api.js) already ends in '/api' itself (it's
      // the same base axios uses, e.g. '/platform/api'), and every call
      // site here still passes its path with a leading '/api/...' from
      // before this fix — concatenating the two verbatim produced
      // '/platform/api/api/ai-chat/...', a second 404 of exactly the same
      // shape as the one this comment describes fixing. Strip the
      // leading /api from the call site's path so it isn't doubled.
      const target = /^https?:\/\//.test(url) ? url : `${API_BASE_URL}${url.replace(/^\/api(?=\/|$)/, '')}`
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      await consumeSse(response, applyEvent)
    } catch (err) {
      const live = liveRef.current
      if (live) {
        if (err?.name === 'AbortError') {
          // Stopping is not failing. Whatever streamed before the stop is kept
          // and marked, rather than being replaced by an error the user caused
          // on purpose.
          live.stopped = true
        } else {
          // No fabricated answer, ever. The turn says what went wrong, and
          // carries what it would take to try again.
          live.error = err?.message || 'Could not reach Simeli.'
          live.retry = body
          live.retryUrl = url
        }
        setTurns((prev) => prev.map((tn) => (tn.id === live.id ? { ...live } : tn)))
      }
    } finally {
      abortRef.current = null
      const live = liveRef.current
      if (live) {
        live.working = false
        setTurns((prev) => prev.map((tn) => (tn.id === live.id ? { ...live } : tn)))
      }
      setWorking(false)
      loadWorkspace(sessionId)
      loadConversations()
    }
  }, [applyEvent, sessionId, loadWorkspace, loadConversations])

  /**
   * Stop the run in flight. The partial answer stays on screen.
   *
   * The server is told FIRST, and only then is the stream dropped. Closing the
   * connection is not a decision any more — reloading does that too, and the
   * run has to survive a reload — so an explicit stop needs to say so out
   * loud. If the request fails the abort still happens: the reader gets their
   * screen back either way, and the run ends on its own step limit.
   */
  const stop = React.useCallback(async () => {
    try {
      await api.post(`/ai-chat/stop/${sessionId}`)
    } catch {
      // Best effort. Worst case the run finishes and is saved, which is the
      // same thing that happens on a reload.
    }
    abortRef.current?.abort()
  }, [sessionId])

  const send = React.useCallback(async (text) => {
    const message = String(text ?? input).trim()
    if (!message || working) return
    setInput('')

    const userTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: message,
      at: new Date().toISOString(),
      // The chips currently in the composer are the files this message carries.
      attachments: files.map((f) => ({ id: f.id, name: f.name, format: f.format, has_preview: !!f.has_preview })),
    }
    // The files just rode along on this message's bubble (captured above) and
    // stay attached to the conversation for later turns to read — only the
    // composer's own chip tray empties, the same way the text input does.
    setFiles([])
    const agentTurn = {
      id: `a-${Date.now()}`,
      role: 'assistant',
      title: message.length > 54 ? `${message.slice(0, 54)}…` : message,
      content: '',
      calls: [],
      working: true,
      at: new Date().toISOString(),
    }
    setTurns((prev) => [...prev, userTurn, agentTurn])

    await run('/api/ai-chat/message/stream', { message, sessionId, mode }, agentTurn)
  }, [input, working, sessionId, mode, run, files])

  /**
   * Re-run a turn that failed or was stopped.
   *
   * Drops the failed assistant turn and re-sends the exact body that produced
   * it, so a retry is a retry rather than a new question with different
   * wording. The user turn above it stays where it is.
   */
  const retry = React.useCallback(async (turn) => {
    if (working) return
    const url = turn.retryUrl || '/api/ai-chat/message/stream'
    const body = turn.retry
    if (!body) return
    const fresh = {
      id: `a-${Date.now()}`,
      role: 'assistant',
      title: turn.title,
      content: '',
      calls: [],
      working: true,
      at: new Date().toISOString(),
    }
    setTurns((prev) => prev.map((tn) => (tn.id === turn.id ? fresh : tn)))
    setPinned(true)
    await run(url, body, fresh)
  }, [working, run])

  /**
   * Ask the same question again, from scratch.
   *
   * Different from retry: this is for an answer that arrived fine and was not
   * good enough. The old exchange is dropped so the transcript does not fill
   * with near-duplicates.
   */
  const regenerate = React.useCallback(async (assistantTurn) => {
    if (working) return
    const i = turns.findIndex((tn) => tn.id === assistantTurn.id)
    const userTurn = i > 0 ? turns[i - 1] : null
    if (!userTurn || userTurn.role !== 'user') return
    setTurns((prev) => prev.slice(0, i))
    await send(userTurn.content)
  }, [working, turns, send])

  /**
   * Carry on a turn that stopped on its step ceiling.
   *
   * Resumes the saved run rather than asking the question again, so everything
   * it had already found is still in context. This is what "unlimited steps"
   * actually looks like when you want it to be safe: unbounded work, with a
   * person deciding each extension.
   */
  const keepGoing = React.useCallback(async (turn) => {
    if (working || !turn.continueId) return
    const resumed = {
      ...turn,
      continueId: null,
      working: true,
      calls: [...(turn.calls || [])],
    }
    setTurns((prev) => prev.map((tn) => (tn.id === turn.id ? resumed : tn)))
    setPinned(true)
    await run('/api/ai-agent/confirm/stream', { pauseId: turn.continueId, decisions: [] }, resumed)
  }, [working, run])

  /** Put a user turn back in the composer to reword, dropping what followed. */
  const editTurn = React.useCallback((turn) => {
    if (working) return
    const i = turns.findIndex((tn) => tn.id === turn.id)
    if (i < 0) return
    setTurns((prev) => prev.slice(0, i))
    setInput(turn.content)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 180)}px`
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }, [working, turns])

  /** Grow the composer with its content, to a ceiling. */
  const grow = React.useCallback((el) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [])

  /**
   * Dictation.
   *
   * Spoken words land in the composer, not in the conversation: you still read
   * the question and press send. Speech recognition mishears, and a misheard
   * question aimed at an agent that can draft a purchase order is not something
   * to send unseen.
   */
  const dictation = useDictation({
    locale,
    onText: React.useCallback((text) => {
      setInput(text)
      // The box has to grow as the words arrive, and the ref is set by then.
      requestAnimationFrame(() => grow(inputRef.current))
    }, [grow]),
    onError: React.useCallback((message) => toast.error(message), []),
  })

  /**
   * Send, and collapse the box back to one line.
   *
   * Without the reset the composer keeps the height of the longest thing you
   * ever typed, eating the transcript for the rest of the session.
   */
  const submit = React.useCallback(() => {
    if (!input.trim() || working) return
    setPinned(true)
    const el = inputRef.current
    send()
    requestAnimationFrame(() => { if (el) el.style.height = 'auto' })
  }, [input, working, send])

  /**
   * Tell Simeli it got something wrong.
   *
   * A thumbs-down asks what was wrong, and the note becomes a company-level
   * preference fed into every later system prompt. A bare thumbs-up records
   * nothing — "good answer" is not a preference, and writing one per approval
   * would drown the signal that matters.
   */
  const [rated, setRated] = React.useState({})
  // The turn a thumbs-down is being written for; the note is asked for in a
  // dialog rather than window.prompt, so it can be read, edited and cancelled.
  const [feedbackFor, setFeedbackFor] = React.useState(null)
  const [feedbackNote, setFeedbackNote] = React.useState('')
  const sendFeedback = React.useCallback(async (turn, helpful, note) => {
    setRated((r) => ({ ...r, [turn.id]: helpful ? 'up' : 'down' }))
    try {
      await api.post('/ai-chat/feedback', { sessionId, helpful, note, about: 'chat_answer' })
      if (note) toast.success('Noted — Simeli will remember that.')
    } catch {
      // Feedback must never be the thing that breaks a conversation.
    }
  }, [sessionId])
  const rate = React.useCallback((turn, helpful) => {
    if (helpful) { sendFeedback(turn, true, null); return }
    setFeedbackNote('')
    setFeedbackFor(turn)
  }, [sendFeedback])

  const copy = React.useCallback(async (text, id) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1600)
    } catch {
      // Clipboard is blocked outside a secure context and on some mobile
      // browsers. Silent rather than a toast: the button simply does not
      // confirm, and the text is still selectable.
    }
  }, [])

  const decide = React.useCallback(async (pending, approve, always) => {
    const live = turns.find((tn) => tn.pauseId && tn.pending?.length)
    if (!live?.pauseId) return

    // One paused run can carry several pending calls at once — a CRM import
    // pauses once with one card per row. The server resolves them all
    // together in a single decisions array, so a click here only records
    // this card's choice; the rest stay live until every card has one.
    // Submitting after the first click used to send `approve: false` for
    // every card nobody had reached yet, i.e. it silently denied them.
    const decisions = { ...(live.decisions || {}), [pending.id]: { approve, always } }

    if (Object.keys(decisions).length < live.pending.length) {
      setTurns((prev) => prev.map((tn) => (tn.id === live.id ? { ...tn, decisions } : tn)))
      return
    }

    const resumeTurn = {
      ...live,
      pending: [],
      decisions: {},
      working: true,
      calls: [...(live.calls || [])],
    }
    setTurns((prev) => prev.map((tn) => (tn.id === live.id ? resumeTurn : tn)))

    await run('/api/ai-agent/confirm/stream', {
      pauseId: live.pauseId,
      decisions: live.pending.map((p) => ({
        tool_call_id: p.id,
        approve: !!decisions[p.id]?.approve,
        // The server has always accepted this and nothing ever sent it, so a
        // high-impact tool asked every single time — which is how people learn
        // to click through without reading. Remembered per tool, revocable
        // from the tool library.
        always: decisions[p.id]?.always || undefined,
      })),
    }, resumeTurn)
  }, [turns, run])

  // --- conversation management --------------------------------------------

  const startNew = () => {
    const id = newSessionId()
    setSessionId(id)
    setTurns([])
    setWorkspace(null)
    setDrawer(null)
    inputRef.current?.focus()
  }

  /**
   * Search past investigations.
   *
   * Titles, objectives and message text, server-side — the transcripts are not
   * in the browser, so filtering the sidebar list would only ever match titles
   * and would quietly miss the conversation you actually remember by something
   * said in it.
   */
  const [query, setQuery] = React.useState('')
  const [found, setFound] = React.useState(null)

  React.useEffect(() => {
    const q = query.trim()
    if (!q) { setFound(null); return undefined }
    // Debounced: a request per keystroke against a text search over every
    // message is a good way to make your own database the bottleneck.
    const timer = setTimeout(async () => {
      try {
        const res = await api.get('/ai-chat/conversations/search', { params: { q } })
        setFound((res.data?.data || []).map((c) => ({
          id: c.session_id, title: c.title || 'Untitled investigation',
          modules: c.modules || [], updatedAt: c.updated_at,
        })))
      } catch {
        setFound([])
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  const [renaming, setRenaming] = React.useState(null)
  const [renameText, setRenameText] = React.useState('')
  const renameRef = React.useRef(null)
  // Focus the rename box when it opens (instead of autoFocus, which also
  // fires on unrelated re-mounts and moves a screen reader without warning).
  React.useEffect(() => {
    if (renaming) renameRef.current?.select()
  }, [renaming])

  const rename = async (id, title) => {
    const clean = title.trim()
    setRenaming(null)
    if (!clean) return
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: clean } : c)))
    try {
      await api.patch(`/ai-chat/workspace/${id}`, { title: clean })
    } catch {
      toast.error('Could not rename that investigation.')
      loadConversations()
    }
  }

  // Deleting an investigation removes its transcript for good, so it is
  // confirmed first.
  const [removing, setRemoving] = React.useState(null)
  const remove = async (id, e) => {
    e?.stopPropagation()
    setRemoving(null)
    try { await api.delete(`/ai-chat/history/${id}`) } catch { /* best-effort */ }
    setConversations((prev) => prev.filter((c) => c.id !== id))
    if (id === sessionId) startNew()
  }

  const saveObjective = async (objective) => {
    try {
      await api.patch(`/ai-chat/workspace/${sessionId}`, { objective })
      setWorkspace((w) => (w ? { ...w, objective } : { objective, modules: [], entities: [], actions: [], artifacts: [] }))
    } catch (err) {
      // The server says when the reason is a pending migration rather than a
      // fault; repeating its words beats a generic failure the person cannot act on.
      toast.error(err?.response?.data?.error || 'Could not save the objective.')
    }
  }

  /**
   * Keyboard.
   *
   * Escape stops a run — the shortcut people already reach for. Cmd/Ctrl+K
   * starts a new investigation. Neither fires while you are typing in another
   * field, and Escape inside the composer clears it first, because that is what
   * Escape means in a text box.
   */
  React.useEffect(() => {
    const onKey = (e) => {
      const inComposer = e.target === inputRef.current
      const typingElsewhere = !inComposer
        && (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA' || e.target?.isContentEditable)

      if (e.key === 'Escape') {
        if (dictation.listening) { dictation.stop(); return }
        if (drawer) { setDrawer(null); return }
        if (working) { e.preventDefault(); stop(); return }
        if (inComposer && input) { setInput(''); grow(inputRef.current) }
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !typingElsewhere) {
        e.preventDefault()
        startNew()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /**
   * The on-screen keyboard.
   *
   * On iOS the visual viewport shrinks when the keyboard opens but the layout
   * viewport does not, so a composer pinned to the bottom of the layout ends up
   * underneath the keyboard. Tracking visualViewport and lifting by the
   * difference keeps it visible; browsers without the API are unaffected because
   * they resize the layout viewport instead.
   */
  React.useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return undefined
    const apply = () => {
      const lift = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      document.documentElement.style.setProperty('--sim-keyboard', `${Math.round(lift)}px`)
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      document.documentElement.style.removeProperty('--sim-keyboard')
    }
  }, [])

  // A question passed in the URL (from the module overviews' ask box) runs once.
  const asked = React.useRef(false)
  React.useEffect(() => {
    if (asked.current) return
    const q = new URLSearchParams(location.search).get('q')
    if (q) { asked.current = true; send(q) }
  }, [location.search, send])

  // --- derived -------------------------------------------------------------

  const liveTurn = turns.find((tn) => tn.working) || null
  const blocked = turns.some((tn) => tn.pending?.length)
  const live = React.useMemo(() => {
    const modules = new Set()
    const entities = []
    const actions = []
    for (const tn of turns) {
      for (const m of tn.modules || []) modules.add(m)
      for (const e of tn.entities || []) entities.push(e)
      for (const a of tn.actions || []) actions.push(a)
      // Anything still waiting on this person belongs in the context surface
      // too, so the decision is reachable from either side of the screen.
      for (const p of tn.pending || []) {
        actions.push({
          id: p.id,
          name: p.name,
          verb: p.meta?.verb || p.name,
          module: p.meta?.module || 'Data',
          state: 'proposed',
        })
      }
    }
    return { modules: [...modules], entities, actions }
  }, [turns])

  const activeCalls = liveTurn?.calls || turns[turns.length - 1]?.calls || []

  // --- render --------------------------------------------------------------

  const contextPanel = (
    <ContextSurface
      workspace={workspace}
      live={live}
      busy={working}
      onObjective={saveObjective}
      // The second argument is "always allow". Dropping it here — while the
      // copy of this card in the message body forwarded it — meant the same
      // button did different things depending on which side of the screen you
      // clicked it on.
      onApproveAction={(a, always) => decide(a, true, always)}
      onDenyAction={(a) => decide(a, false)}
    />
  )

  const historyPanel = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 p-3">
        <Button variant="secondary" block icon={PlusIcon} onClick={startNew} kbd="⌘K">
          New investigation
        </Button>
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search investigations"
          aria-label="Search investigations"
          prefix={<MagnifyingGlassIcon className="h-3.5 w-3.5" aria-hidden="true" />}
        />
      </div>

      <div className="sim-scroll min-h-0 flex-1 px-2 pb-2">
        {found !== null && found.length === 0 ? (
          <p className="px-2 py-3 text-sm text-ink-500">Nothing matches “{query.trim()}”.</p>
        ) : conversations.length === 0 && found === null ? (
          <p className="px-2 py-3 text-sm leading-relaxed text-ink-500">
            No past investigations. Ask Simeli something and this becomes the record of it.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {(found ?? conversations).map((c) => (
              <li key={c.id} className="group relative">
                {renaming === c.id ? (
                  <form className="p-1" onSubmit={(e) => { e.preventDefault(); rename(c.id, renameText) }}>
                    <Input
                      ref={renameRef}
                      value={renameText}
                      aria-label="Investigation name"
                      onChange={(e) => setRenameText(e.target.value)}
                      onBlur={() => rename(c.id, renameText)}
                      onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(null) }}
                    />
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setSessionId(c.id); setDrawer(null) }}
                    onDoubleClick={() => { setRenameText(c.title); setRenaming(c.id) }}
                    aria-current={c.id === sessionId ? 'true' : undefined}
                    className={`block min-h-[44px] w-full rounded-md px-2.5 py-2 text-left lg:min-h-0 ${c.id === sessionId ? 'bg-ink-100' : 'hover:bg-ink-50'}`}
                  >
                    <span className="block truncate pr-14 text-sm font-medium text-fg">{c.title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-2xs text-ink-500">
                      {c.modules?.length > 0 && <span className="truncate">{c.modules.slice(0, 3).join(' · ')}</span>}
                      {c.messageCount > 0 && <span className="flex-none">{c.messageCount} turns</span>}
                    </span>
                  </button>
                )}
                {renaming !== c.id && (
                  <div className="absolute right-1 top-1.5 flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <IconButton size="xs" icon={PencilIcon} label="Rename" onClick={() => { setRenameText(c.title); setRenaming(c.id) }} />
                    <IconButton size="xs" icon={TrashIcon} label="Delete this investigation" onClick={(e) => { e.stopPropagation(); setRemoving(c) }} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )

  const runningVerb = activeCalls.find((c) => c.status === 'running')?.meta?.verb
  const statusLine = blocked ? 'Waiting for your decision'
    : working ? (runningVerb || 'Reading')
      : 'Reads your records, shows its working, asks before it changes anything'

  // The workspace fills exactly the room the shell leaves (top bar, page
  // padding, and the phone's bottom bar), in dynamic viewport units so the
  // composer stays on screen when a phone's URL bar collapses. The shell's
  // page wrapper has no definite height, so h-full would grow with the
  // transcript and push the composer off the bottom.
  return (
    <div className="simeli flex h-[calc(100dvh_-_var(--topbar-h)_-_40px_-_var(--bottomnav-h)_-_env(safe-area-inset-bottom))] min-h-[420px] flex-col lg:h-[calc(100dvh_-_var(--topbar-h)_-_48px)]">
      {/* ---- header ---- */}
      <header className="flex flex-none items-center gap-2 pb-3">
        <IconButton
          icon={Bars3Icon}
          label="Investigations"
          variant="secondary"
          className="lg:hidden"
          onClick={() => setDrawer('history')}
        />

        {/* The symbiote, small and calm: it is Simeli's presence on the page,
            and its motion follows what Simeli is actually doing. */}
        <span className="relative hidden h-10 w-10 flex-none sm:block" aria-hidden="true">
          <Suspense fallback={<SimeliMark className="m-2.5" />}>
            <QiraSymbiote state={blocked ? 'listening' : working ? 'thinking' : 'idle'} intensity={0.8} />
          </Suspense>
        </span>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-fg sm:text-lg">{workspace?.title || 'Simeli'}</h1>
          <p className="truncate text-xs text-ink-500" role="status">{statusLine}</p>
        </div>

        {/* Permission mode. Visible rather than buried in settings: it decides
            what Simeli may run before a person approves. */}
        <label className="hidden items-center gap-2 text-xs text-ink-600 sm:flex">
          <span className="sr-only">Permission mode</span>
          <Select
            size="md"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            title={MODES.find((m) => m.value === mode)?.hint}
            className="w-48"
          >
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
        </label>

        <IconButton
          icon={ViewColumnsIcon}
          variant="secondary"
          label={contextOpen ? 'Hide context' : 'Show context'}
          aria-pressed={contextOpen}
          onClick={() => (window.innerWidth >= 1280 ? setContextOpen((v) => !v) : setDrawer('context'))}
        />
      </header>

      {/* ---- body ---- */}
      <div className="flex min-h-0 flex-1 gap-3">
        <aside className="sim-panel hidden w-[240px] flex-none lg:flex lg:flex-col" aria-label="Investigations">
          {historyPanel}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div className="relative min-h-0 flex-1">
            <div ref={scrollRef} onScroll={onScroll} className="sim-scroll h-full">
              {/* polite, not assertive: an assertive region interrupts a screen
                  reader on every token, which makes streaming unusable. */}
              <div className="mx-auto flex max-w-3xl flex-col gap-5 px-1 pb-4" aria-live="polite" aria-busy={working}>
                {loadingHistory && (
                  <div role="status" className="space-y-2 py-6">
                    <span className="sr-only">Loading this investigation</span>
                    <span className="skeleton block h-3 w-2/3" />
                    <span className="skeleton block h-3 w-1/2" />
                  </div>
                )}

                {!loadingHistory && turns.length === 0 && !resuming && <Opening onAsk={send} noModel={noModel} />}

                {/* A turn that outlived the page it was started on. */}
                {resuming && !working && !turns[turns.length - 1]?.error && (
                  <InlineNotice
                    tone="brand"
                    title="Simeli is still working on this"
                    action={<Button size="sm" icon={StopIcon} onClick={stop}>Stop it</Button>}
                  >
                    It kept going after you left. The answer will appear here when it lands.
                  </InlineNotice>
                )}

                {turns.map((tn) => (tn.role === 'user' ? (
                  <div key={tn.id} className="group flex justify-end gap-3">
                    <div className="flex min-w-0 flex-col items-end gap-1">
                      <div className="max-w-full whitespace-pre-wrap break-words rounded-lg border border-ink-200 bg-sunken px-3.5 py-2.5 text-sm leading-relaxed text-fg">
                        {tn.content}
                      </div>
                      {Array.isArray(tn.attachments) && tn.attachments.length > 0 && (
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {tn.attachments.map((a) => (
                            <AttachmentChip key={a.id} file={a} sessionId={sessionId} compact />
                          ))}
                        </div>
                      )}
                      <div className="flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <IconAction
                          label={copied === tn.id ? 'Copied' : 'Copy'}
                          onClick={() => copy(tn.content, tn.id)}
                          icon={copied === tn.id ? CheckIcon : ClipboardDocumentIcon}
                        />
                        <IconAction label="Edit and resend" onClick={() => editTurn(tn)} icon={PencilIcon} disabled={working} />
                      </div>
                    </div>
                    <span className="mt-0.5 hidden h-7 w-7 flex-none items-center justify-center rounded-full border border-ink-200 bg-surface sm:flex" aria-hidden="true">
                      <UserIcon className="h-3.5 w-3.5 text-ink-500" />
                    </span>
                  </div>
                ) : (
                  <TurnBoundary key={tn.id} turn={tn}>
                    <AssistantTurn
                      turn={tn}
                      busy={working}
                      copied={copied}
                      onApprove={(p, always) => decide(p, true, always)}
                      onDeny={(p) => decide(p, false)}
                      onCopy={copy}
                      onRetry={retry}
                      onRegenerate={regenerate}
                      onContinue={keepGoing}
                      rated={rated[tn.id]}
                      onRate={rate}
                    />
                  </TurnBoundary>
                )))}

                <div ref={endRef} />
              </div>
            </div>

            {/* Only while there is something below to jump to. */}
            {!pinned && turns.length > 0 && (
              <button type="button" onClick={jumpToLatest} className="sim-jump">
                <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
                {working ? 'Simeli is still writing' : 'Jump to latest'}
              </button>
            )}
          </div>

          <div className="mx-auto w-full max-w-3xl flex-none">
            {noModel && turns.length > 0 && <NoModelNotice compact className="mb-2" />}
            <form
              className="rounded-lg border border-ink-300 bg-surface p-2 focus-within:border-brand-600 focus-within:ring-[3px] focus-within:ring-brand-500/20"
              onSubmit={(e) => { e.preventDefault(); submit() }}
              onDragOver={(e) => { e.preventDefault() }}
              onDrop={(e) => { e.preventDefault(); attach(e.dataTransfer.files) }}
            >
              {files.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {files.map((f) => (
                    <AttachmentChip key={f.id} file={f} sessionId={sessionId} onRemove={() => detach(f.id)} />
                  ))}
                </div>
              )}

              <Textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={(e) => { setInput(e.target.value); grow(e.target) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
                }}
                placeholder={working ? 'Simeli is working — Esc to stop' : 'Ask Simeli about your business…'}
                aria-label="Message Simeli"
                aria-describedby="simeli-composer-help"
                className="max-h-[180px] min-h-[40px] resize-none !border-0 !bg-transparent px-1.5 !text-base !ring-0 sm:!text-sm"
              />

              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  className="hidden"
                  accept=".pdf,.txt,.md,.markdown,.csv,.tsv,.json,.xml,.yml,.yaml,.html,.htm,.log,.sql,.png,.jpg,.jpeg,.webp,.bmp"
                  onChange={(e) => { attach(e.target.files); e.target.value = '' }}
                />
                <IconButton
                  icon={PaperClipIcon}
                  label="Attach a file (or drop one here)"
                  size="lg"
                  disabled={uploading}
                  aria-busy={uploading || undefined}
                  onClick={() => fileRef.current?.click()}
                />
                {/* No microphone where the browser has no recogniser. */}
                {dictation.supported && (
                  <IconButton
                    icon={MicrophoneIcon}
                    size="lg"
                    label={dictation.listening ? 'Stop dictating' : 'Dictate your question'}
                    aria-pressed={dictation.listening}
                    className={dictation.listening ? 'sim-listening' : ''}
                    onClick={() => dictation.toggle(input)}
                  />
                )}
                <span id="simeli-composer-help" className="hidden min-w-0 flex-1 truncate text-2xs text-ink-500 sm:block">
                  Enter to send · Shift+Enter for a new line
                </span>
                <span className="flex-1 sm:hidden" />
                {/* Stop replaces Send while a run is live: they are never both
                    the thing you want. */}
                {working ? (
                  <Button size="lg" icon={StopIcon} onClick={stop} title="Stop (Esc)">Stop</Button>
                ) : (
                  <Button type="submit" variant="primary" size="lg" icon={PaperAirplaneIcon} disabled={!input.trim()}>
                    Send
                  </Button>
                )}
              </div>
            </form>
            <p className="mt-1.5 text-center text-2xs text-ink-500">
              Simeli reads only records your role can see, and can be wrong. Every figure it shows comes from a record you can open.
            </p>
          </div>
        </main>

        {contextOpen && (
          <aside className="sim-panel hidden w-[320px] flex-none xl:flex xl:flex-col" aria-label="Context">
            {contextPanel}
          </aside>
        )}
      </div>

      {/* ---- phone and tablet: the side columns become sheets ---- */}
      <Sheet
        open={!!drawer}
        onClose={() => setDrawer(null)}
        title={drawer === 'history' ? 'Investigations' : 'Context'}
        width="sm"
      >
        {drawer === 'history' ? (
          <div className="flex h-full flex-col">
            <div className="px-3 pt-3 sm:hidden">
              <Field label="Permission mode" help={MODES.find((m) => m.value === mode)?.hint}>
                <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                  {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </Select>
              </Field>
            </div>
            {historyPanel}
          </div>
        ) : contextPanel}
      </Sheet>

      <Dialog
        open={!!feedbackFor}
        onClose={() => setFeedbackFor(null)}
        title="What was wrong with that answer?"
        description="Simeli keeps this as a company preference and reads it before later answers."
        size="sm"
        footer={(
          <>
            <Button onClick={() => setFeedbackFor(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => { const tn = feedbackFor; setFeedbackFor(null); sendFeedback(tn, false, feedbackNote.trim() || null) }}
            >
              Send feedback
            </Button>
          </>
        )}
      >
        <Field label="What should it have done?" optional>
          <Textarea rows={3} value={feedbackNote} onChange={(e) => setFeedbackNote(e.target.value)} data-autofocus />
        </Field>
      </Dialog>

      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Delete this investigation?"
        size="sm"
        footer={(
          <>
            <Button onClick={() => setRemoving(null)}>Keep it</Button>
            <Button variant="danger" onClick={() => remove(removing.id)}>Delete investigation</Button>
          </>
        )}
      >
        <p className="text-sm text-ink-800">
          “{removing?.title}” and its whole transcript are removed. Records Simeli read or drafts it prepared are not affected.
        </p>
        <p className="mt-2 text-xs font-medium text-risk-600">This cannot be undone.</p>
      </Dialog>
    </div>
  )
}

/** No language model is connected, so Simeli cannot answer. Said plainly. */
function NoModelNotice({ className, compact = false }) {
  if (compact) {
    return (
      <p role="status" className={`flex items-center gap-2 rounded-md border border-warn-200 bg-warn-50 px-3 py-1.5 text-xs text-warn-800 ${className || ''}`}>
        <span className="min-w-0 flex-1">No language model is connected, so Simeli cannot answer yet.</span>
        <Link to="/ai/settings" className="shrink-0 font-medium underline underline-offset-2">AI settings</Link>
      </p>
    )
  }
  return (
    <InlineNotice
      tone="warn"
      className={className}
      title="No language model is connected"
      action={<Button size="sm" to="/ai/settings">AI settings</Button>}
    >
      Simeli needs an OpenAI, Anthropic or OpenRouter key on the server before it can answer.
      Questions sent now will fail rather than be answered from guesses.
    </InlineNotice>
  )
}

/**
 * The empty state.
 *
 * The prompts are questions Simeli can genuinely answer with the tools it has:
 * each maps onto real read tools (AR aging, cash forecast, low stock, findings
 * scan). A suggested question that produces "I do not have a tool for that"
 * teaches people the product does not work.
 */
function Opening({ onAsk, noModel }) {
  const prompts = [
    'What is outstanding on receivables right now?',
    'Which stock items are below their reorder point?',
    'Show me the open findings by severity',
    'Forecast cash flow from the ledger history',
  ]

  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center sm:py-10">
      <div className="relative h-28 w-full max-w-[260px] sm:h-44" aria-hidden="true">
        <Suspense fallback={null}>
          <QiraSymbiote state="idle" />
        </Suspense>
      </div>
      <div>
        <h2 className="text-xl font-semibold text-fg">What should Simeli look into?</h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-ink-600">
          It reads across Finance, Sales, Procurement, Inventory, Manufacturing, HR, Projects and CRM,
          shows every record it opened, and asks before it changes anything.
        </p>
      </div>

      {noModel && <NoModelNotice className="w-full max-w-xl text-left" />}

      <ul className="grid w-full max-w-xl gap-2 sm:grid-cols-2">
        {prompts.map((p) => (
          <li key={p}>
            <button
              type="button"
              onClick={() => onAsk(p)}
              className="flex min-h-[48px] w-full items-center rounded-lg border border-ink-200 bg-surface px-3.5 py-3 text-left text-sm leading-snug text-ink-800 transition-colors hover:border-ink-300 hover:bg-ink-50"
            >
              {p}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-ink-500">
        Or open <Link to="/ai/overview" className="text-brand-600 underline-offset-2 hover:underline">what Simeli has found</Link>.
      </p>
    </div>
  )
}
