import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { Sheet } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Textarea } from '../ui/Field'
import { AiAnswer } from '../ui/Simeli'
import { GatewayReason } from '../ui/Gateway'
import { InlineNotice } from '../ui/Feedback'
import { useShell } from './ShellContext'

const QiraSymbiote = lazy(() => import('../qira/QiraSymbiote'))

/**
 * SimeliPanel — ask about the screen you are on without leaving it.
 *
 * Opened from ⌘K ("Ask Simeli: …") or useShell().openSimeli({ question }).
 * The question goes to POST /ai-agent/message in "manual" mode: Simeli may
 * read, and anything that would change a record comes back as a proposal the
 * person approves or declines here (POST /ai-agent/confirm). Nothing runs on
 * its own.
 *
 * The page the person is on (its path and the record named in the
 * breadcrumbs) travels with the question, so "is this late?" means this PO.
 * The full conversation, with history, files and artifacts, is /ai/chat.
 */
const labelOf = (t) => t?.meta?.label || String(t?.name || '').replace(/_/g, ' ')

function describeTurn(turn) {
  const result = turn.result || {}
  const read = (result.tools_used || []).map((t, i) => ({ label: labelOf(t), detail: t.args ? JSON.stringify(t.args) : undefined, key: i }))
  const concluded = result.response ? [<p key="r" className="whitespace-pre-wrap">{result.response}</p>] : []
  return { read, concluded }
}

export default function SimeliPanel() {
  const { simeli, closeSimeli, recordTitle } = useShell()
  const location = useLocation()
  const open = !!simeli?.open
  const [question, setQuestion] = useState('')
  const [turns, setTurns] = useState([])
  const [busy, setBusy] = useState(false)
  const asked = useRef(null)

  const context = recordTitle?.path === location.pathname && recordTitle?.title
    ? `${recordTitle.title}${recordTitle.subtitle ? ` (${recordTitle.subtitle})` : ''}`
    : null

  const send = async (text) => {
    const q = String(text || '').trim()
    if (!q || busy) return
    setQuestion('')
    const id = Date.now()
    setTurns((t) => [...t, { id, question: q, loading: true }])
    setBusy(true)
    const where = `[The person is on the page ${location.pathname}${context ? `, looking at ${context}` : ''}.]`
    const history = turns.flatMap((t) => (t.result?.response ? [{ role: 'user', content: t.question }, { role: 'assistant', content: t.result.response }] : []))
    try {
      const res = await api.post('/ai-agent/message', { message: `${where}\n${q}`, history, mode: 'manual' }, { timeout: 120000 })
      const body = res.data || {}
      setTurns((all) => all.map((t) => (t.id === id
        ? body.success === false
          ? { ...t, loading: false, unavailable: body.response || body.error || 'Simeli is not available.' }
          : { ...t, loading: false, result: body }
        : t)))
    } catch (e) {
      const data = e?.response?.data || {}
      setTurns((all) => all.map((t) => (t.id === id ? { ...t, loading: false, error: data.error || e.message || 'Simeli did not answer.' } : t)))
    } finally {
      setBusy(false)
    }
  }

  const decide = async (turnId, pauseId, pending, approve) => {
    setBusy(true)
    try {
      const res = await api.post('/ai-agent/confirm', { pauseId, decisions: pending.map((p) => ({ tool_call_id: p.id, approve })) }, { timeout: 120000 })
      setTurns((all) => all.map((t) => (t.id === turnId ? { ...t, result: res.data } : t)))
    } catch (e) {
      setTurns((all) => all.map((t) => (t.id === turnId ? { ...t, error: e?.response?.data?.error || 'Could not record that decision.' } : t)))
    } finally {
      setBusy(false)
    }
  }

  // A question handed over by the palette is sent once, when the panel opens.
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    const q = simeli?.context?.question
    if (open && q && asked.current !== simeli) {
      asked.current = simeli
      sendRef.current(q)
    }
  }, [open, simeli])

  return (
    <Sheet
      open={open}
      onClose={closeSimeli}
      title="Ask Simeli"
      description={context ? `About ${context}` : 'About this page'}
      width="lg"
      footer={
        <form
          className="w-full space-y-2"
          onSubmit={(e) => { e.preventDefault(); send(question) }}
        >
          <Textarea
            rows={2}
            aria-label="Your question"
            placeholder="Ask about this page, a record, or a number"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(question) } }}
          />
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" to={`/ai/chat${question ? `?q=${encodeURIComponent(question)}` : ''}`} icon={ArrowTopRightOnSquareIcon} onClick={closeSimeli}>
              Full conversation
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!question.trim()}>Ask</Button>
          </div>
        </form>
      }
    >
      <div className="space-y-4 p-4" aria-live="polite">
        <div className={turns.length ? 'relative mx-auto h-24 w-40' : 'relative mx-auto h-48 w-64'} aria-hidden="true">
          <Suspense fallback={null}>
            <QiraSymbiote state={busy ? 'thinking' : turns.some((t) => t.result?.response) ? 'speaking' : question ? 'listening' : 'idle'} />
          </Suspense>
        </div>
        {!turns.length && (
          <p className="text-sm text-ink-600">
            Simeli reads what your role can see and answers with its sources. Anything that would change a record comes back as a proposal for you to approve.
          </p>
        )}
        {turns.map((t) => {
          const { read, concluded } = describeTurn(t)
          const pending = t.result?.status === 'awaiting_confirmation' ? t.result.pending || [] : []
          return (
            <div key={t.id} className="space-y-2">
              <p className="rounded-md bg-sunken px-3 py-2 text-sm text-fg">{t.question}</p>
              {t.unavailable ? (
                <InlineNotice tone="warn" title="Simeli is not configured on this server">
                  {t.unavailable} An administrator connects a language model in AI settings.
                </InlineNotice>
              ) : (
                <AiAnswer
                  compact
                  loading={t.loading}
                  error={t.error}
                  onRetry={t.error ? () => send(t.question) : undefined}
                  read={read}
                  concluded={concluded}
                  gateway={t.result?.gateway}
                  proposes={pending.map((p) => ({
                    id: p.id,
                    note: <GatewayReason gateway={p.gateway} className="mt-1.5" />,
                    title: p.meta?.label || labelOf(p),
                    detail: p.meta?.description || (p.args ? JSON.stringify(p.args) : undefined),
                    actionLabel: 'Approve',
                    onApprove: () => decide(t.id, t.result.pauseId, [p], true),
                    onDecline: () => decide(t.id, t.result.pauseId, [p], false),
                    approvedText: 'Approved. Simeli ran it; the result is above.',
                    risk: 'high',
                  }))}
                  footnote="Simeli read only what your role can see. Nothing changes unless you approve it."
                />
              )}
            </div>
          )
        })}
      </div>
    </Sheet>
  )
}
