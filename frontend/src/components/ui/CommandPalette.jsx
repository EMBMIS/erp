import React, { useEffect, useMemo, useRef, useState, useId } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { MagnifyingGlassIcon, SparklesIcon, ArrowRightIcon } from '@heroicons/react/20/solid'
import { useFocusTrap } from './Dialog'

/**
 * CommandPalette — jump to any page, record or action, or ask Simeli.
 *
 * items:        [{ id, title, subtitle, group, keywords, icon, hint, run() }]
 * searchRemote: async (query) => items   (records; debounced, optional)
 * onAsk(query): fallback "Ask Simeli: <query>"
 *
 * Ranking is plain and predictable: prefix match on the title first, then a
 * word-start match, then anywhere; ties keep their group order. Nothing
 * fuzzy enough to surprise someone moving fast.
 */
function score(item, q) {
  if (!q) return 1
  const t = item.title.toLowerCase()
  const hay = `${t} ${(item.subtitle || '').toLowerCase()} ${(item.keywords || '').toLowerCase()} ${(item.group || '').toLowerCase()}`
  if (t.startsWith(q)) return 100
  if (t.split(/[\s/·-]+/).some((w) => w.startsWith(q))) return 60
  const words = q.split(/\s+/)
  if (words.every((w) => hay.includes(w))) return 30
  return 0
}

export default function CommandPalette({ open, onClose, items = [], searchRemote, onAsk, placeholder = 'Search pages, records and actions…', recentIds = [] }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [remote, setRemote] = useState([])
  const [loading, setLoading] = useState(false)
  const panelRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const id = useId().replace(/:/g, '')
  useFocusTrap(panelRef, open, { initialFocus: inputRef })

  useEffect(() => { if (open) { setQuery(''); setActive(0); setRemote([]) } }, [open])
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    const q = query.trim()
    if (!searchRemote || q.length < 2) { setRemote([]); setLoading(false); return undefined }
    setLoading(true)
    let live = true
    const t = setTimeout(async () => {
      try { const r = await searchRemote(q); if (live) setRemote(r || []) } catch { if (live) setRemote([]) } finally { if (live) setLoading(false) }
    }, 180)
    return () => { live = false; clearTimeout(t) }
  }, [query, searchRemote])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    let local
    if (!q) {
      const recent = recentIds.map((rid) => items.find((i) => i.id === rid)).filter(Boolean).map((i) => ({ ...i, group: 'Recent' }))
      const rest = items.filter((i) => i.pinnedInPalette || i.group === 'Actions')
      local = [...recent, ...rest.filter((i) => !recentIds.includes(i.id))].slice(0, 14)
    } else {
      local = items
        .map((i) => ({ i, s: score(i, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 30)
        .map((x) => x.i)
    }
    const out = [...remote.map((r) => ({ ...r, group: r.group || 'Records' })), ...local]
    if (q && onAsk) out.push({ id: '__ask', title: `Ask Simeli: “${query.trim()}”`, group: 'Simeli', icon: SparklesIcon, run: () => onAsk(query.trim()), ask: true })
    return out
  }, [query, items, remote, onAsk, recentIds])

  useEffect(() => { setActive(0) }, [query, remote.length])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = (item) => {
    if (!item) return
    onClose()
    requestAnimationFrame(() => item.run?.())
  }
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); run(results[active]) }
  }

  if (!open) return null
  let lastGroup = null
  return createPortal(
    <div className="fixed inset-0 z-palette flex items-start justify-center px-3 pt-[12vh]">
      <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Command palette" className="relative w-full max-w-xl overflow-hidden rounded-xl border border-ink-200 bg-overlay shadow-overlay animate-pop">
        <div className="flex items-center gap-2 border-b border-ink-200 px-3">
          <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={results[active] ? `${id}-${active}` : undefined}
            aria-autocomplete="list"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder={placeholder}
            className="h-12 flex-1 !border-0 !bg-transparent !px-0 text-base !shadow-none focus:!ring-0"
          />
          {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-300 border-t-transparent" aria-hidden="true" />}
          <kbd className="rounded border border-ink-200 px-1 font-mono text-2xs text-ink-500">Esc</kbd>
        </div>
        <ul id={`${id}-list`} ref={listRef} role="listbox" aria-label="Results" className="max-h-[56vh] overflow-y-auto p-1.5 ui-scroll">
          {!results.length && (
            <li className="px-3 py-6 text-center text-sm text-ink-500">
              {query.trim().length < 2 ? 'Type to search pages, records and actions.' : 'Nothing found.'}
            </li>
          )}
          {results.map((item, idx) => {
            const header = item.group !== lastGroup ? item.group : null
            lastGroup = item.group
            const Icon = item.icon || ArrowRightIcon
            return (
              <React.Fragment key={`${item.group}-${item.id}`}>
                {header && <li role="presentation" className="label-mono px-2 pb-1 pt-2.5">{header}</li>}
                <li
                  id={`${id}-${idx}`}
                  data-idx={idx}
                  role="option"
                  aria-selected={idx === active}
                  onMouseMove={() => setActive(idx)}
                  onClick={() => run(item)}
                  onKeyDown={(e) => { if (e.key === 'Enter') run(item) }}
                  className={clsx('flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2', idx === active ? 'bg-ink-100' : '')}
                >
                  <Icon className={clsx('h-4 w-4 shrink-0', item.ask ? 'text-brand-600' : 'text-ink-400')} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">{item.title}</span>
                    {item.subtitle && <span className="block truncate text-xs text-ink-500">{item.subtitle}</span>}
                  </span>
                  {item.badge}
                  {item.hint && <span className="shrink-0 font-mono text-2xs text-ink-500">{item.hint}</span>}
                </li>
              </React.Fragment>
            )
          })}
        </ul>
        <div className="flex items-center gap-3 border-t border-ink-200 px-3 py-2 text-2xs text-ink-500">
          <span><kbd className="font-mono">↑↓</kbd> move</span>
          <span><kbd className="font-mono">Enter</kbd> open</span>
          <span><kbd className="font-mono">?</kbd> all shortcuts</span>
          <span className="ml-auto">Results respect your permissions</span>
        </div>
      </div>
    </div>,
    document.body
  )
}
