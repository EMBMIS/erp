import { useEffect, useId, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronUpDownIcon, CheckIcon } from '@heroicons/react/20/solid'

/**
 * Combobox — type to filter, arrows to move, Enter to pick. WAI-ARIA 1.2
 * combobox with a listbox popup and aria-activedescendant.
 *
 * options: [{ value, label, description, meta }]  value: the selected value
 * onChange(value, option). `loadOptions(query)` for async search (debounced).
 */
export default function Combobox({
  options = [],
  value,
  onChange,
  placeholder = 'Search…',
  loadOptions,
  emptyText = 'No matches',
  disabled,
  id: forcedId,
  className,
  size = 'md',
  renderOption,
  'aria-invalid': ariaInvalid,
  'aria-describedby': describedBy,
  'aria-label': ariaLabel,
  'aria-required': ariaRequired,
}) {
  const auto = useId().replace(/:/g, '')
  const id = forcedId || `cb${auto}`
  const listId = `${id}-list`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [remote, setRemote] = useState(null)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef(null)
  const wrapRef = useRef(null)
  const selected = useMemo(() => [...options, ...(remote || [])].find((o) => String(o.value) === String(value)), [options, remote, value])

  useEffect(() => {
    if (!loadOptions || !open) return undefined
    setLoading(true)
    const t = setTimeout(async () => {
      try { setRemote(await loadOptions(query)) } catch { setRemote([]) } finally { setLoading(false) }
    }, 200)
    return () => clearTimeout(t)
  }, [query, open, loadOptions])

  const list = useMemo(() => {
    const src = remote || options
    const q = query.trim().toLowerCase()
    if (!q || loadOptions) return src.slice(0, 200)
    return src.filter((o) => `${o.label} ${o.description || ''} ${o.meta || ''}`.toLowerCase().includes(q)).slice(0, 200)
  }, [options, remote, query, loadOptions])

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => { if (!wrapRef.current?.contains(e.target)) { setOpen(false); setQuery('') } }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const pick = (o) => {
    onChange?.(o.value, o)
    setOpen(false)
    setQuery('')
    inputRef.current?.focus()
  }
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else setActive((a) => Math.min(list.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { if (open && list[active]) { e.preventDefault(); pick(list[active]) } }
    else if (e.key === 'Escape') { if (open) { e.preventDefault(); setOpen(false); setQuery('') } }
    else if (e.key === 'Tab') { setOpen(false); setQuery('') }
  }

  return (
    <div ref={wrapRef} className={clsx('relative', className)}>
      <input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && list[active] ? `${id}-opt-${active}` : undefined}
        aria-invalid={ariaInvalid}
        aria-describedby={describedBy}
        aria-label={ariaLabel}
        aria-required={ariaRequired}
        disabled={disabled}
        value={open ? query : selected?.label ?? ''}
        placeholder={selected ? selected.label : placeholder}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={onKey}
        autoComplete="off"
        className={clsx('w-full !pr-8', size === 'lg' ? 'h-10 text-base' : size === 'sm' ? 'h-7 text-xs' : 'h-8')}
      />
      <ChevronUpDownIcon className={clsx('pointer-events-none absolute right-2 h-4 w-4 text-ink-400', size === 'lg' ? 'top-3' : size === 'sm' ? 'top-1.5' : 'top-2')} aria-hidden="true" />
      {open && (
        <ul id={listId} role="listbox" className="absolute z-50 mt-1 max-h-72 w-full min-w-[220px] overflow-y-auto rounded-lg border border-ink-200 bg-overlay p-1 shadow-overlay ui-scroll">
          {loading && <li className="px-2 py-1.5 text-sm text-ink-500">Searching…</li>}
          {!loading && !list.length && <li className="px-2 py-1.5 text-sm text-ink-500">{emptyText}</li>}
          {list.map((o, i) => {
            const isSel = String(o.value) === String(value)
            return (
              <li
                key={o.value}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={isSel}
                onMouseDown={(e) => { e.preventDefault(); pick(o) }}
                onMouseEnter={() => setActive(i)}
                className={clsx('flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm', i === active && 'bg-ink-100')}
              >
                <CheckIcon className={clsx('mt-0.5 h-4 w-4 shrink-0', isSel ? 'text-brand-600' : 'invisible')} aria-hidden="true" />
                {renderOption ? renderOption(o) : (
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-fg">{o.label}</span>
                      {o.meta && <span className="shrink-0 font-mono text-2xs text-ink-500">{o.meta}</span>}
                    </span>
                    {o.description && <span className="block truncate text-xs text-ink-500">{o.description}</span>}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
