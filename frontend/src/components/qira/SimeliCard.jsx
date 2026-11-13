import { Suspense, lazy, useState } from 'react'
import { SparklesIcon } from '@heroicons/react/20/solid'
import { useShell } from '../shell/ShellContext'
import { Button } from '../ui/Button'

const QiraSymbiote = lazy(() => import('./QiraSymbiote'))

const STATUS = { idle: 'Standing by', thinking: 'Reading your business', listening: 'Listening', speaking: 'Briefing you' }

/**
 * SimeliCard — Simeli, present on the screen: the 3D symbiote, what it is
 * doing in words, and what it has noticed. "Ask Simeli" opens the side panel
 * about the page you are on.
 *
 * notes: short sentences of what is worth attention (each already counted by
 * the page — the card never invents them). busy: data is still loading.
 */
export default function SimeliCard({ notes = [], busy = false, question = 'What needs my attention today?', className = '', size = 'md' }) {
  const { openSimeli } = useShell()
  const [hover, setHover] = useState(false)
  const state = busy ? 'thinking' : hover ? 'listening' : notes.length ? 'speaking' : 'idle'
  const stage = size === 'sm' ? 'h-[150px]' : 'h-[210px] sm:h-[230px]'
  return (
    <section
      aria-label="Simeli"
      className={`flex flex-col overflow-hidden rounded-lg border border-ink-200 bg-surface ${className}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <header className="flex items-center gap-2 px-4 pt-4">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-brand-600 text-white" aria-hidden="true">
          <SparklesIcon className="h-3 w-3" />
        </span>
        <h2 className="text-sm font-semibold text-fg">Simeli</h2>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-ink-500" role="status">
          <span className={`h-1.5 w-1.5 rounded-full ${busy ? 'animate-pulse bg-brand-500' : 'bg-ok-500'}`} aria-hidden="true" />
          {STATUS[state]}
        </span>
      </header>
      <div className={`relative mx-auto w-full max-w-[320px] ${stage}`} aria-hidden="true">
        <Suspense fallback={null}>
          <QiraSymbiote state={state} />
        </Suspense>
      </div>
      <div className="mt-auto space-y-3 px-4 pb-4">
        {notes.length > 0 ? (
          <ul className="space-y-1.5 text-sm text-ink-700">
            {notes.slice(0, 3).map((n, i) => (
              <li key={i} className="flex gap-2"><span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-brand-500" />{n}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-600">{busy ? 'Reading the ledger, orders and stock…' : 'Nothing is flagged. Ask about any number on this page.'}</p>
        )}
        <Button variant="secondary" size="sm" className="w-full" icon={SparklesIcon} onClick={() => openSimeli({ question })}>Ask Simeli</Button>
      </div>
    </section>
  )
}
