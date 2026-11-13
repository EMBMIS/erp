import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { useNavigate } from 'react-router-dom'
import {
  AdjustmentsHorizontalIcon,
  FunnelIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  BookmarkIcon,
  ArrowUturnLeftIcon,
  SparklesIcon,
} from '@heroicons/react/20/solid'
import { EmptyState, ErrorState, SkeletonRows } from './Feedback'

/**
 * DataTable — tables are the product.
 *
 * columns: [{
 *   id | key          stable id (also the saved-view key)
 *   header            label
 *   accessor          (row) => value, or a property name. Used to sort, filter, search.
 *   cell | render     (row, value) => node. Defaults to the value.
 *   align             'left' | 'right' (numbers, money) | 'center'
 *   width, minWidth   px
 *   sortable          default true when there is an accessor
 *   filter            'text' | 'select' | 'number' | false   (column-level filter)
 *   options           [{ value, label }] for select filters
 *   hideable          default true; the first column cannot be hidden
 *   defaultHidden
 *   mobile            'title' | 'subtitle' | 'meta' | 'trailing' — the three or four
 *                     fields a phone card shows. Unassigned columns are not shown on
 *                     the card; the record opens for the rest.
 *   editable          { type: 'text' | 'number' | 'select', options, validate } — inline edit
 *   footer            (visibleRows) => node, for totals
 * }]
 *
 * Behaviour
 *   - Sticky header and first column; resizable and reorderable columns.
 *   - Saved views (localStorage, per `viewKey`): columns, order, widths, sort,
 *     filters and search. Named views can be saved, switched and deleted.
 *   - Keyboard: ↑/↓ or j/k move, Enter opens, x or Space selects, Shift+↑/↓
 *     extends the selection, / focuses search, Esc clears the selection.
 *   - Rows reveal actions on hover and focus; selecting rows shows a bulk bar.
 *   - Inline editing commits optimistically and rolls back with the reason.
 *   - Long lists render only what is on screen (fixed-height rows), so 10,000
 *     rows scroll as smoothly as 10.
 *   - Below 640px it renders as cards with the columns marked `mobile`.
 */

const VIEW_PREFIX = 'embmis.view.'

const colId = (c, i) => c.id ?? c.key ?? `col${i}`
const getValue = (row, col) => {
  if (typeof col.accessor === 'function') return col.accessor(row)
  if (typeof col.accessor === 'string') return row?.[col.accessor]
  if (col.key && row && col.key in row) return row[col.key]
  return undefined
}
const toText = (v) => (v == null ? '' : typeof v === 'object' ? (v instanceof Date ? v.toISOString() : '') : String(v))

function compare(a, b) {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  const na = Number(a)
  const nb = Number(b)
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  const da = Date.parse(a)
  const db = Date.parse(b)
  if (typeof a === 'string' && /^\d{4}-\d{2}-\d{2}/.test(a) && Number.isFinite(da) && Number.isFinite(db)) return da - db
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/** Number filter syntax: "5000", ">5000", "<=10", "100..500". */
export function matchNumber(value, expr) {
  const n = Number(value)
  const e = String(expr).replace(/[\s,]/g, '')
  if (!e) return true
  if (!Number.isFinite(n)) return false
  const range = e.match(/^(-?[\d.]+)\.\.(-?[\d.]+)$/)
  if (range) return n >= Number(range[1]) && n <= Number(range[2])
  const op = e.match(/^(>=|<=|>|<|=)?(-?[\d.]+)$/)
  if (!op) return true
  const t = Number(op[2])
  switch (op[1]) {
    case '>': return n > t
    case '<': return n < t
    case '>=': return n >= t
    case '<=': return n <= t
    default: return n === t
  }
}

function loadViews(viewKey) {
  if (!viewKey) return null
  try { return JSON.parse(localStorage.getItem(VIEW_PREFIX + viewKey) || 'null') } catch { return null }
}
function saveViews(viewKey, data) {
  if (!viewKey) return
  try { localStorage.setItem(VIEW_PREFIX + viewKey, JSON.stringify(data)) } catch { /* storage unavailable */ }
}

function useIsPhone() {
  const q = '(max-width: 639px)'
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = (e) => setM(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return m
}

/* --------------------------------------------------------------- Popover */
function Popover({ open, onClose, anchorRef, children, align = 'right', label }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => { if (!ref.current?.contains(e.target) && !anchorRef.current?.contains(e.target)) onClose() }
    const onKey = (e) => { if (e.key === 'Escape') { onClose(); anchorRef.current?.focus() } }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    requestAnimationFrame(() => ref.current?.querySelector('input,button,select')?.focus())
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open, onClose, anchorRef])
  if (!open) return null
  return (
    <div ref={ref} role="dialog" aria-label={label} className={clsx('absolute top-full z-40 mt-1 w-72 rounded-lg border border-ink-200 bg-overlay p-2 shadow-overlay animate-pop', align === 'right' ? 'right-0' : 'left-0')}>
      {children}
    </div>
  )
}

/* ------------------------------------------------------------ Edit cell */
function EditableCell({ row, col, value, display, onCommit }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef(null)
  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])
  const cfg = col.editable === true ? { type: 'text' } : col.editable
  const commit = async () => {
    const next = cfg.type === 'number' ? (draft === '' ? null : Number(draft)) : draft
    const invalid = cfg.validate?.(next, row)
    if (invalid) { setError(invalid); return }
    if (next === value) { setEditing(false); return }
    setSaving(true)
    setError(null)
    try {
      await onCommit(row, col, next)
      setEditing(false)
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || 'Not saved')
    } finally {
      setSaving(false)
    }
  }
  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setDraft(value ?? ''); setEditing(true) }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation() } }}
        className="-mx-1 block w-[calc(100%+0.5rem)] rounded px-1 text-inherit hover:bg-ink-100 hover:outline hover:outline-1 hover:outline-ink-300"
        title={`Edit ${typeof col.header === 'string' ? col.header : ''}`}
      >
        {display}
      </button>
    )
  }
  const common = {
    ref: inputRef,
    value: draft ?? '',
    disabled: saving,
    'aria-invalid': error ? true : undefined,
    'aria-label': typeof col.header === 'string' ? col.header : 'Value',
    onClick: (e) => e.stopPropagation(),
    onChange: (e) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); commit() }
      if (e.key === 'Escape') { setEditing(false); setError(null) }
    },
    className: clsx('h-7 w-full !min-h-0 !py-0 !text-sm', col.align === 'right' && 'text-right tabular-nums'),
  }
  return (
    <div className="relative">
      {cfg.type === 'select' ? (
        <select {...common}>{(cfg.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      ) : (
        <input {...common} type="text" inputMode={cfg.type === 'number' ? 'decimal' : undefined} />
      )}
      {error && <p role="alert" className="absolute left-0 top-full z-10 mt-0.5 whitespace-nowrap rounded bg-risk-600 px-1.5 py-0.5 text-2xs text-white">{error}</p>}
    </div>
  )
}

/* ------------------------------------------------------------- DataTable */
export default function DataTable(props) {
  const {
    columns: rawColumns = [],
    rows: rowsProp,
    data,
    rowKey,
    keyField = 'id',
    loading = false,
    error,
    onRetry,
    empty,
    emptyFiltered,
    onRowClick,
    onOpen,
    rowHref,
    rowActions,
    selectable = false,
    isRowSelectable,
    bulkActions,
    onSelectionChange,
    search = true,
    searchPlaceholder = 'Search this list',
    toolbar,
    toolbarStart,
    viewKey,
    defaultSort,
    externalFilter,
    onCellEdit,
    caption,
    ariaLabel,
    rowClassName,
    height,
    density: densityProp,
    pageSize,
    className,
    showCount = true,
    noun = 'record',
  } = props

  const rows = rowsProp ?? data ?? []
  const navigate = useNavigate()
  const phone = useIsPhone()
  const getKey = useCallback((row, i) => (typeof rowKey === 'function' ? rowKey(row) : row?.[rowKey || keyField] ?? i), [rowKey, keyField])

  // Normalise column definitions once.
  const columns = useMemo(
    () =>
      rawColumns.filter(Boolean).map((c, i) => ({
        ...c,
        id: colId(c, i),
        cell: c.cell || c.render,
        sortable: c.sortable ?? (c.accessor != null || (c.key != null && !c.render && !c.cell) || c.sortValue != null),
        hideable: i === 0 ? false : c.hideable ?? true,
      })),
    [rawColumns]
  )

  /* ---- view state (persisted) ---- */
  const stored = useMemo(() => loadViews(viewKey), [viewKey])
  const initial = stored?.current || {}
  const [order, setOrder] = useState(() => initial.order || columns.map((c) => c.id))
  const [hidden, setHidden] = useState(() => new Set(initial.hidden || columns.filter((c) => c.defaultHidden).map((c) => c.id)))
  const [widths, setWidths] = useState(() => initial.widths || {})
  const [sort, setSort] = useState(() => initial.sort || defaultSort || null)
  const [filters, setFilters] = useState(() => initial.filters || {})
  const [query, setQuery] = useState(() => initial.query || '')
  // A question rather than a keyword ("orders from Nordic over 5,000 that are
  // late") is handed to Simeli, which answers with the records it used. The
  // shell listens for this event; there is no natural-language filter endpoint.
  const sentenceLike = query.trim().split(/\s+/).length >= 3
  const askSimeli = () => window.dispatchEvent(new CustomEvent('embmis:ask-simeli', { detail: { question: `About the ${noun} list on this page: ${query.trim()}` } }))
  const [density, setDensity] = useState(() => densityProp || initial.density || 'comfortable')
  const [namedViews, setNamedViews] = useState(() => stored?.named || {})
  const [activeView, setActiveView] = useState(() => stored?.active || null)

  // Keep order in sync when columns are added by the page later.
  useEffect(() => {
    setOrder((prev) => {
      const ids = columns.map((c) => c.id)
      const kept = prev.filter((id) => ids.includes(id))
      const added = ids.filter((id) => !kept.includes(id))
      return added.length || kept.length !== prev.length ? [...kept, ...added] : prev
    })
  }, [columns])

  useEffect(() => {
    if (!viewKey) return
    saveViews(viewKey, {
      current: { order, hidden: [...hidden], widths, sort, filters, query, density },
      named: namedViews,
      active: activeView,
    })
  }, [viewKey, order, hidden, widths, sort, filters, query, density, namedViews, activeView])

  const byId = useMemo(() => Object.fromEntries(columns.map((c) => [c.id, c])), [columns])
  const visibleColumns = useMemo(() => order.map((id) => byId[id]).filter((c) => c && !hidden.has(c.id)), [order, byId, hidden])

  /* ---- data pipeline: external filter → search → column filters → sort ---- */
  const [overrides, setOverrides] = useState({})
  const effectiveRows = useMemo(() => {
    if (!Object.keys(overrides).length) return rows
    return rows.map((r, i) => {
      const o = overrides[getKey(r, i)]
      return o ? { ...r, ...o } : r
    })
  }, [rows, overrides, getKey])

  const processed = useMemo(() => {
    let out = effectiveRows
    if (externalFilter) out = out.filter(externalFilter)
    const q = query.trim().toLowerCase()
    if (q) {
      const terms = q.split(/\s+/)
      out = out.filter((row) => {
        const hay = columns.map((c) => toText(getValue(row, c))).join(' ').toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
    }
    const active = Object.entries(filters).filter(([, v]) => v !== '' && v != null)
    if (active.length) {
      out = out.filter((row) =>
        active.every(([id, v]) => {
          const col = byId[id]
          if (!col) return true
          const val = getValue(row, col)
          if (col.filter === 'number') return matchNumber(val, v)
          if (col.filter === 'select') return String(val ?? '') === String(v)
          return toText(val).toLowerCase().includes(String(v).toLowerCase())
        })
      )
    }
    if (sort?.id && byId[sort.id]) {
      const col = byId[sort.id]
      const get = col.sortValue || ((r) => getValue(r, col))
      out = [...out].sort((a, b) => (sort.dir === 'desc' ? -1 : 1) * compare(get(a), get(b)))
    }
    return out
  }, [effectiveRows, externalFilter, query, filters, sort, columns, byId])

  /* ---- paging / virtualisation ---- */
  const [page, setPage] = useState(0)
  useEffect(() => { setPage(0) }, [query, filters, sort])
  const paged = pageSize ? processed.slice(page * pageSize, (page + 1) * pageSize) : processed
  const rowH = density === 'compact' ? 32 : 40
  const virtual = !pageSize && !phone && paged.length > 120
  const scrollRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight || 600))
    ro.observe(el)
    return () => ro.disconnect()
  }, [virtual])
  const overscan = 12
  const start = virtual ? Math.max(0, Math.floor(scrollTop / rowH) - overscan) : 0
  const end = virtual ? Math.min(paged.length, Math.ceil((scrollTop + viewportH) / rowH) + overscan) : paged.length
  const windowRows = paged.slice(start, end)

  /* ---- selection ---- */
  const [selected, setSelected] = useState(() => new Set())
  const [anchor, setAnchor] = useState(null)
  const selectableRows = useMemo(() => processed.filter((r) => !isRowSelectable || isRowSelectable(r)), [processed, isRowSelectable])
  const selectedRows = useMemo(() => effectiveRows.filter((r, i) => selected.has(getKey(r, i))), [effectiveRows, selected, getKey])
  useEffect(() => { onSelectionChange?.(selectedRows) }, [selectedRows])
  // Drop selections that are no longer in the data (after an approve, say).
  useEffect(() => {
    setSelected((prev) => {
      if (!prev.size) return prev
      const keys = new Set(rows.map((r, i) => getKey(r, i)))
      const next = new Set([...prev].filter((k) => keys.has(k)))
      return next.size === prev.size ? prev : next
    })
  }, [rows, getKey])
  const toggle = (key) => setSelected((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selected.has(getKey(r)))
  const someSelected = selected.size > 0 && !allSelected
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectableRows.map((r) => getKey(r))))
  const clearSelection = () => setSelected(new Set())

  /* ---- keyboard ---- */
  const [cursor, setCursor] = useState(-1)
  const rowRefs = useRef({})
  const searchRef = useRef(null)
  const open = useCallback(
    (row, e) => {
      if (onOpen) return onOpen(row, e)
      if (onRowClick) return onRowClick(row, e)
      if (rowHref) {
        const href = rowHref(row)
        if (!href) return undefined
        if (e && (e.metaKey || e.ctrlKey)) window.open(href, '_blank', 'noopener')
        else navigate(href)
      }
      return undefined
    },
    [onOpen, onRowClick, rowHref, navigate]
  )
  const openable = Boolean(onOpen || onRowClick || rowHref)
  const focusRow = (i) => {
    const clamped = Math.max(0, Math.min(paged.length - 1, i))
    setCursor(clamped)
    if (virtual && scrollRef.current) {
      const top = clamped * rowH
      const el = scrollRef.current
      const headerH = 36
      if (top < el.scrollTop) el.scrollTop = top
      else if (top + rowH > el.scrollTop + el.clientHeight - headerH) el.scrollTop = top + rowH - el.clientHeight + headerH
    }
    requestAnimationFrame(() => rowRefs.current[clamped]?.focus({ preventScroll: !virtual ? false : true }))
  }
  const onRowKey = (e, row, i) => {
    const key = getKey(row, i)
    if (e.target !== e.currentTarget) return
    switch (e.key) {
      case 'ArrowDown': case 'j':
        e.preventDefault()
        if (e.shiftKey && selectable) { const nxt = paged[i + 1]; if (nxt) { setSelected((p) => new Set(p).add(key).add(getKey(nxt, i + 1))) } }
        focusRow(i + 1); break
      case 'ArrowUp': case 'k':
        e.preventDefault()
        if (e.shiftKey && selectable) { const prv = paged[i - 1]; if (prv) { setSelected((p) => new Set(p).add(key).add(getKey(prv, i - 1))) } }
        focusRow(i - 1); break
      case 'Home': e.preventDefault(); focusRow(0); break
      case 'End': e.preventDefault(); focusRow(paged.length - 1); break
      case 'PageDown': e.preventDefault(); focusRow(i + 10); break
      case 'PageUp': e.preventDefault(); focusRow(i - 10); break
      case 'Enter': if (openable) { e.preventDefault(); open(row, e) } break
      case ' ': case 'x':
        if (selectable && (!isRowSelectable || isRowSelectable(row))) { e.preventDefault(); toggle(key); setAnchor(i) }
        break
      case 'Escape': if (selected.size) { e.preventDefault(); clearSelection() } break
      default:
    }
  }
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t.closest?.('input,textarea,select,[contenteditable="true"],[role="dialog"],[data-datatable]')) return
      const own = scrollRef.current?.closest('[data-datatable]')
      if (!own?.isConnected) return
      if (e.key === '/' && search) { e.preventDefault(); searchRef.current?.focus(); return }
      // j / k from anywhere on the page start driving the first list on it.
      if ((e.key === 'j' || e.key === 'k') && document.querySelector('[data-datatable]') === own && paged.length) {
        e.preventDefault()
        focusRow(cursor >= 0 ? cursor : 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [search, paged, cursor]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- column resize & reorder ---- */
  const startResize = (e, id) => {
    e.preventDefault()
    e.stopPropagation()
    const th = e.currentTarget.parentElement
    const startX = e.clientX
    const startW = th.getBoundingClientRect().width
    const min = byId[id]?.minWidth || 60
    const move = (ev) => setWidths((w) => ({ ...w, [id]: Math.max(min, Math.round(startW + ev.clientX - startX)) }))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const resizeKey = (e, id) => {
    const th = e.currentTarget.parentElement
    const cur = widths[id] || th.getBoundingClientRect().width
    if (e.key === 'ArrowLeft') { e.preventDefault(); setWidths((w) => ({ ...w, [id]: Math.max(60, cur - 16) })) }
    if (e.key === 'ArrowRight') { e.preventDefault(); setWidths((w) => ({ ...w, [id]: cur + 16 })) }
  }
  const [dragId, setDragId] = useState(null)
  const moveColumn = (id, delta) => setOrder((prev) => {
    const i = prev.indexOf(id)
    const j = i + delta
    if (i < 1 || j < 1 || j >= prev.length) return prev // first column stays first
    const next = [...prev]
    ;[next[i], next[j]] = [next[j], next[i]]
    return next
  })
  const dropOn = (targetId) => {
    if (!dragId || dragId === targetId) return
    setOrder((prev) => {
      const next = prev.filter((x) => x !== dragId)
      const at = Math.max(1, next.indexOf(targetId))
      next.splice(at, 0, dragId)
      return next
    })
    setDragId(null)
  }

  /* ---- sort ---- */
  const cycleSort = (col) => {
    if (!col.sortable) return
    setSort((s) => (s?.id !== col.id ? { id: col.id, dir: 'asc' } : s.dir === 'asc' ? { id: col.id, dir: 'desc' } : null))
  }

  /* ---- views ---- */
  const [colsOpen, setColsOpen] = useState(false)
  const [viewsOpen, setViewsOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(() => Object.values(initial.filters || {}).some(Boolean))
  const colsBtn = useRef(null)
  const viewsBtn = useRef(null)
  const [newViewName, setNewViewName] = useState('')
  const snapshot = () => ({ order, hidden: [...hidden], widths, sort, filters, query, density })
  const applyView = (name) => {
    const v = namedViews[name]
    if (!v) return
    setOrder(v.order); setHidden(new Set(v.hidden)); setWidths(v.widths || {}); setSort(v.sort || null)
    setFilters(v.filters || {}); setQuery(v.query || ''); setDensity(v.density || 'comfortable'); setActiveView(name)
    setViewsOpen(false)
  }
  const resetView = () => {
    setOrder(columns.map((c) => c.id)); setHidden(new Set(columns.filter((c) => c.defaultHidden).map((c) => c.id)))
    setWidths({}); setSort(defaultSort || null); setFilters({}); setQuery(''); setActiveView(null)
  }
  const activeFilterCount = Object.values(filters).filter((v) => v !== '' && v != null).length
  const filterable = columns.some((c) => c.filter)

  /* ---- inline edit ---- */
  const commitEdit = async (row, col, value) => {
    const key = getKey(row)
    const field = typeof col.accessor === 'string' ? col.accessor : col.key || col.id
    const prev = overrides[key]
    setOverrides((o) => ({ ...o, [key]: { ...(o[key] || {}), [field]: value } }))
    try {
      await onCellEdit(row, col.id, value)
    } catch (e) {
      setOverrides((o) => {
        const n = { ...o }
        if (prev) n[key] = prev
        else delete n[key]
        return n
      })
      throw e
    }
  }

  const hasActions = Boolean(rowActions)
  const label = ariaLabel || caption || 'Records'
  const total = rows.length
  const shown = processed.length

  /* ------------------------------------------------------------ render */
  const toolbarNode = (search || toolbar || toolbarStart || viewKey || filterable) && (
    <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 px-3 py-2">
      {toolbarStart}
      {search && (
        <label className="relative flex min-w-[180px] flex-1 items-center sm:max-w-xs">
          <span className="sr-only">{searchPlaceholder}</span>
          <MagnifyingGlassIcon className="pointer-events-none absolute left-2 h-4 w-4 text-ink-400" aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-8 w-full !pl-7 !pr-8"
          />
          {!query && <kbd className="pointer-events-none absolute right-2 hidden rounded border border-ink-200 px-1 font-mono text-2xs text-ink-400 sm:inline">/</kbd>}
        </label>
      )}
      {search && sentenceLike && (
        <button type="button" onClick={askSimeli} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-brand-700 hover:bg-brand-50" title="Search matches words exactly. Simeli reads the question and answers with the records it used.">
          <SparklesIcon className="h-4 w-4" aria-hidden="true" />
          Ask Simeli
        </button>
      )}
      <div className="ml-auto flex items-center gap-1">
        {toolbar}
        {filterable && (
          <button type="button" onClick={() => setFiltersOpen((o) => !o)} aria-pressed={filtersOpen} className={clsx('inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm', filtersOpen || activeFilterCount ? 'bg-ink-100 text-fg' : 'text-ink-600 hover:bg-ink-100')}>
            <FunnelIcon className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Filter</span>
            {activeFilterCount > 0 && <span className="rounded bg-ink-900 px-1 font-mono text-2xs text-white">{activeFilterCount}</span>}
          </button>
        )}
        {viewKey && !phone && (
          <div className="relative">
            <button ref={viewsBtn} type="button" onClick={() => setViewsOpen((o) => !o)} aria-expanded={viewsOpen} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-ink-600 hover:bg-ink-100">
              <BookmarkIcon className="h-4 w-4" aria-hidden="true" />
              <span className="max-w-[120px] truncate">{activeView || 'Views'}</span>
            </button>
            <Popover open={viewsOpen} onClose={() => setViewsOpen(false)} anchorRef={viewsBtn} label="Saved views">
              <p className="label-mono px-2 pb-1 pt-0.5">Saved views</p>
              {Object.keys(namedViews).length === 0 && <p className="px-2 py-1 text-xs text-ink-500">Save the current columns, filters and sort to come back to them.</p>}
              <ul>
                {Object.keys(namedViews).map((n) => (
                  <li key={n} className="flex items-center gap-1">
                    <button type="button" onClick={() => applyView(n)} className={clsx('flex-1 truncate rounded px-2 py-1.5 text-left text-sm hover:bg-ink-100', activeView === n && 'font-semibold')}>{n}</button>
                    <button type="button" aria-label={`Delete view ${n}`} onClick={() => { const c = { ...namedViews }; delete c[n]; setNamedViews(c); if (activeView === n) setActiveView(null) }} className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-risk-600"><XMarkIcon className="h-3.5 w-3.5" /></button>
                  </li>
                ))}
              </ul>
              <form className="mt-1 flex gap-1 border-t border-ink-200 pt-2" onSubmit={(e) => { e.preventDefault(); const n = newViewName.trim(); if (!n) return; setNamedViews((v) => ({ ...v, [n]: snapshot() })); setActiveView(n); setNewViewName('') }}>
                <input value={newViewName} onChange={(e) => setNewViewName(e.target.value)} placeholder="Name this view" aria-label="View name" className="h-7 flex-1 !min-h-0 !py-0 text-xs" />
                <button type="submit" className="h-7 rounded-md bg-ink-900 px-2 text-xs font-medium text-white">Save</button>
              </form>
              <button type="button" onClick={() => { resetView(); setViewsOpen(false) }} className="mt-1 flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-ink-600 hover:bg-ink-100"><ArrowUturnLeftIcon className="h-3.5 w-3.5" />Reset to default</button>
            </Popover>
          </div>
        )}
        {!phone && (
          <div className="relative">
            <button ref={colsBtn} type="button" onClick={() => setColsOpen((o) => !o)} aria-expanded={colsOpen} aria-label="Columns and density" title="Columns and density" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-600 hover:bg-ink-100">
              <AdjustmentsHorizontalIcon className="h-4 w-4" aria-hidden="true" />
            </button>
            <Popover open={colsOpen} onClose={() => setColsOpen(false)} anchorRef={colsBtn} label="Columns">
              <p className="label-mono px-2 pb-1 pt-0.5">Columns</p>
              <ul className="max-h-72 overflow-y-auto ui-scroll">
                {order.map((id, idx) => {
                  const c = byId[id]
                  if (!c) return null
                  const name = typeof c.header === 'string' ? c.header : c.label || id
                  return (
                    <li key={id} className="flex items-center gap-1 rounded px-1 hover:bg-ink-50">
                      <label className="flex flex-1 items-center gap-2 py-1 text-sm">
                        <input type="checkbox" checked={!hidden.has(id)} disabled={!c.hideable} onChange={() => setHidden((h) => { const n = new Set(h); n.has(id) ? n.delete(id) : n.add(id); return n })} />
                        <span className="truncate">{name}</span>
                      </label>
                      {idx > 0 && (
                        <>
                          <button type="button" aria-label={`Move ${name} left`} disabled={idx <= 1} onClick={() => moveColumn(id, -1)} className="rounded p-0.5 text-ink-500 hover:bg-ink-100 disabled:opacity-30"><ChevronUpIcon className="h-4 w-4" /></button>
                          <button type="button" aria-label={`Move ${name} right`} disabled={idx >= order.length - 1} onClick={() => moveColumn(id, 1)} className="rounded p-0.5 text-ink-500 hover:bg-ink-100 disabled:opacity-30"><ChevronDownIcon className="h-4 w-4" /></button>
                        </>
                      )}
                    </li>
                  )
                })}
              </ul>
              <div className="mt-1 flex items-center justify-between border-t border-ink-200 px-2 pt-2">
                <span className="text-xs text-ink-600">Row height</span>
                <div className="inline-flex rounded-md border border-ink-200 p-0.5">
                  {['comfortable', 'compact'].map((d) => (
                    <button key={d} type="button" aria-pressed={density === d} onClick={() => setDensity(d)} className={clsx('rounded px-1.5 py-0.5 text-xs capitalize', density === d ? 'bg-ink-900 text-white' : 'text-ink-600')}>{d}</button>
                  ))}
                </div>
              </div>
            </Popover>
          </div>
        )}
      </div>
    </div>
  )

  const filterRow = filtersOpen && filterable && (
    <div className="flex flex-wrap items-end gap-2 border-b border-ink-200 bg-sunken px-3 py-2">
      {visibleColumns.filter((c) => c.filter).map((c) => {
        const name = typeof c.header === 'string' ? c.header : c.id
        const v = filters[c.id] ?? ''
        const set = (val) => setFilters((f) => ({ ...f, [c.id]: val }))
        return (
          <label key={c.id} className="flex min-w-[140px] flex-col gap-0.5">
            <span className="label-mono">{name}</span>
            {c.filter === 'select' ? (
              <select value={v} onChange={(e) => set(e.target.value)} className="h-7 !min-h-0 !py-0 text-xs">
                <option value="">Any</option>
                {(c.options || [...new Set(rows.map((r) => getValue(r, c)).filter((x) => x != null && x !== ''))].sort().map((x) => ({ value: x, label: String(x).replace(/_/g, ' ').toLowerCase().replace(/^./, (s) => s.toUpperCase()) }))).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : (
              <input value={v} onChange={(e) => set(e.target.value)} placeholder={c.filter === 'number' ? '>5000, 10..50' : 'Contains'} className={clsx('h-7 !min-h-0 !py-0 text-xs', c.filter === 'number' && 'font-mono')} />
            )}
          </label>
        )
      })}
      {activeFilterCount > 0 && (
        <button type="button" onClick={() => setFilters({})} className="h-7 rounded-md px-2 text-xs text-ink-600 hover:bg-ink-100">Clear filters</button>
      )}
    </div>
  )

  const emptyNode = (() => {
    const filtered = total > 0 && shown === 0
    if (filtered) {
      return emptyFiltered || (
        <EmptyState compact title={`No ${noun}s match`} description="Nothing in this list matches the search and filters you have set." action={<span className="inline-flex flex-wrap justify-center gap-3"><button type="button" onClick={() => { setQuery(''); setFilters({}) }} className="text-sm font-medium text-fg underline-offset-2 hover:underline">Clear search and filters</button>{sentenceLike && <button type="button" onClick={askSimeli} className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline">Ask Simeli: “{query.trim()}”</button>}</span>} />
      )
    }
    if (React.isValidElement(empty)) return empty
    return <EmptyState {...(empty || { title: `No ${noun}s yet` })} />
  })()

  const bulkBar = selectable && selected.size > 0 && (
    <div role="region" aria-label="Bulk actions" className="sticky bottom-3 z-20 mx-3 mb-3 mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-tooltip px-3 py-2 text-sm text-white shadow-overlay animate-pop">
      <span className="font-medium tabular-nums">{selected.size} selected</span>
      <span className="mx-1 h-4 w-px bg-white/20" aria-hidden="true" />
      <div className="flex flex-wrap items-center gap-1.5">{bulkActions?.(selectedRows, clearSelection)}</div>
      <button type="button" onClick={clearSelection} className="ml-auto rounded px-2 py-1 text-xs text-white/80 hover:bg-white/10 hover:text-white">Clear <kbd className="ml-1 font-mono text-2xs opacity-70">Esc</kbd></button>
    </div>
  )

  const countLine = showCount && !loading && !error && total > 0 && (
    <div className="flex items-center justify-between border-t border-ink-200 px-3 py-2 text-xs text-ink-500" aria-live="polite">
      <span className="tabular-nums">
        {shown === total ? `${total.toLocaleString()} ${noun}${total === 1 ? '' : 's'}` : `${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}s`}
        {pageSize && shown > pageSize && ` · page ${page + 1} of ${Math.ceil(shown / pageSize)}`}
      </span>
      {pageSize && shown > pageSize && (
        <span className="flex gap-1">
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="rounded border border-ink-200 px-2 py-0.5 disabled:opacity-40">Previous</button>
          <button type="button" disabled={(page + 1) * pageSize >= shown} onClick={() => setPage((p) => p + 1)} className="rounded border border-ink-200 px-2 py-0.5 disabled:opacity-40">Next</button>
        </span>
      )}
      {!pageSize && openable && !phone && <span className="hidden md:inline">↑↓ to move · Enter to open{selectable ? ' · x to select' : ''}</span>}
    </div>
  )

  /* ---- phone: cards ---- */
  if (phone) {
    const pick = (slot) => visibleColumns.find((c) => c.mobile === slot)
    const titleCol = pick('title') || visibleColumns[0]
    const subCol = pick('subtitle')
    const metaCol = pick('meta')
    const trailCol = pick('trailing')
    const render = (c, row) => (c ? (c.cell ? c.cell(row, getValue(row, c)) : toText(getValue(row, c)) || '—') : null)
    return (
      <div data-datatable className={clsx('overflow-hidden rounded-lg border border-ink-200 bg-surface', className)} ref={scrollRef}>
        {toolbarNode}
        {filterRow}
        {loading ? <SkeletonRows rows={6} columns={2} /> : error ? <ErrorState error={error} onRetry={onRetry} compact /> : !paged.length ? emptyNode : (
          <ul aria-label={label} className="divide-y divide-ink-100">
            {paged.map((row, i) => {
              const key = getKey(row, i)
              return (
                <li key={key} className={clsx('flex items-start gap-3 px-3 py-3', selected.has(key) && 'bg-brand-50')}>
                  {selectable && (!isRowSelectable || isRowSelectable(row)) && (
                    <input type="checkbox" aria-label="Select" checked={selected.has(key)} onChange={() => toggle(key)} className="mt-1 !h-5 !w-5" />
                  )}
                  <button type="button" disabled={!openable} onClick={(e) => open(row, e)} className="flex min-h-[44px] min-w-0 flex-1 items-start justify-between gap-3 text-left">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-fg">{render(titleCol, row)}</span>
                      {subCol && <span className="mt-0.5 block truncate text-sm text-ink-600">{render(subCol, row)}</span>}
                      {metaCol && <span className="mt-1 block text-xs text-ink-500">{render(metaCol, row)}</span>}
                    </span>
                    {trailCol && <span className="shrink-0 text-right text-sm tabular-nums">{render(trailCol, row)}</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {countLine}
        {bulkBar}
      </div>
    )
  }

  /* ---- desktop: table ---- */
  const cellPad = density === 'compact' ? 'px-3 py-1' : 'px-3 py-2'
  const stickyFirst = 'sticky left-0 z-[1] bg-inherit'
  return (
    <div data-datatable className={clsx('relative min-w-0 overflow-hidden rounded-lg border border-ink-200 bg-surface', className)}>
      {toolbarNode}
      {filterRow}
      {loading ? (
        <SkeletonRows rows={8} columns={Math.min(visibleColumns.length, 6)} />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} what={caption || 'This list'} compact />
      ) : !paged.length ? (
        emptyNode
      ) : (
        <div
          ref={scrollRef}
          onScroll={virtual ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
          className="overflow-auto ui-scroll"
          style={{ maxHeight: height || (virtual ? 'calc(100vh - 260px)' : undefined) }}
        >
          <table className="min-w-full border-separate border-spacing-0 text-sm" aria-label={label} aria-rowcount={virtual ? paged.length + 1 : undefined}>
            {caption && <caption className="sr-only">{caption}</caption>}
            <colgroup>
              {selectable && <col style={{ width: 40 }} />}
              {visibleColumns.map((c) => <col key={c.id} style={{ width: widths[c.id] || c.width }} />)}
              {hasActions && <col style={{ width: 1 }} />}
            </colgroup>
            <thead className="sticky top-0 z-[2] bg-sunken">
              <tr>
                {selectable && (
                  <th scope="col" className={clsx('border-b border-ink-200 bg-sunken px-3', stickyFirst)}>
                    <input
                      type="checkbox"
                      aria-label={allSelected ? 'Clear selection' : 'Select all'}
                      checked={allSelected}
                      ref={(el) => { if (el) el.indeterminate = someSelected }}
                      onChange={toggleAll}
                    />
                  </th>
                )}
                {visibleColumns.map((c, ci) => {
                  const sorted = sort?.id === c.id ? sort.dir : null
                  const first = ci === 0
                  return (
                    <th
                      key={c.id}
                      scope="col"
                      aria-sort={c.sortable ? (sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none') : undefined}
                      draggable={!first}
                      onDragStart={() => setDragId(c.id)}
                      onDragOver={(e) => { if (dragId && !first) e.preventDefault() }}
                      onDrop={() => dropOn(c.id)}
                      style={{ minWidth: widths[c.id] || c.minWidth || c.width, maxWidth: widths[c.id] || c.maxWidth }}
                      className={clsx(
                        'group relative h-9 border-b border-ink-200 bg-sunken px-3 text-left align-middle',
                        c.align === 'right' && 'text-right',
                        c.align === 'center' && 'text-center',
                        first && !selectable && stickyFirst,
                        first && selectable && 'sticky left-10 z-[1]',
                        dragId === c.id && 'opacity-50'
                      )}
                    >
                      {c.srOnly ? (
                        <span className="sr-only">{c.header}</span>
                      ) : c.sortable ? (
                        <button type="button" onClick={() => cycleSort(c)} className={clsx('inline-flex max-w-full items-center gap-1 uppercase', c.align === 'right' && 'flex-row-reverse', sorted ? 'text-ink-900' : 'hover:text-ink-900')} style={{ font: 'inherit', letterSpacing: 'inherit' }}>
                          <span className="truncate">{c.header}</span>
                          <span aria-hidden="true" className={clsx('font-sans text-[10px]', !sorted && 'opacity-0 group-hover:opacity-50')}>{sorted === 'desc' ? '↓' : '↑'}</span>
                        </button>
                      ) : (
                        <span className="truncate">{c.header}</span>
                      )}
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${typeof c.header === 'string' ? c.header : 'column'}`}
                        tabIndex={0}
                        onPointerDown={(e) => startResize(e, c.id)}
                        onKeyDown={(e) => resizeKey(e, c.id)}
                        className="absolute right-0 top-1/2 h-5 w-1.5 -translate-y-1/2 cursor-col-resize rounded bg-transparent hover:bg-ink-300 focus-visible:bg-brand-500"
                      />
                    </th>
                  )
                })}
                {hasActions && <th scope="col" className="border-b border-ink-200 bg-sunken px-2"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {virtual && start > 0 && <tr aria-hidden="true" style={{ height: start * rowH }} />}
              {windowRows.map((row, wi) => {
                const i = start + wi
                const key = getKey(row, i)
                const isSel = selected.has(key)
                const canSel = selectable && (!isRowSelectable || isRowSelectable(row))
                return (
                  <tr
                    key={key}
                    ref={(el) => { rowRefs.current[i] = el }}
                    tabIndex={cursor === i || (cursor === -1 && i === 0) ? 0 : -1}
                    aria-rowindex={virtual ? i + 2 : undefined}
                    onFocus={() => setCursor(i)}
                    onKeyDown={(e) => onRowKey(e, row, i)}
                    onClick={(e) => {
                      if (e.target.closest('button,a,input,select,textarea,label')) return
                      if (e.shiftKey && selectable && anchor != null) {
                        const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)]
                        setSelected((p) => { const n = new Set(p); paged.slice(a, b + 1).forEach((r, k) => n.add(getKey(r, a + k))); return n })
                        return
                      }
                      if (openable) open(row, e)
                    }}
                    style={{ height: rowH }}
                    className={clsx(
                      'group/row bg-surface outline-none transition-colors duration-fast',
                      openable && 'cursor-pointer',
                      isSel ? 'bg-brand-50' : 'hover:bg-ink-50',
                      'focus-visible:bg-ink-50 focus-visible:shadow-[inset_2px_0_0_0_rgb(var(--c-brand-600))]',
                      typeof rowClassName === 'function' ? rowClassName(row) : rowClassName
                    )}
                  >
                    {selectable && (
                      <td className={clsx('border-b border-ink-100 px-3', stickyFirst)} onClick={(e) => e.stopPropagation()}>
                        {canSel && (
                          <input type="checkbox" aria-label={`Select ${toText(getValue(row, visibleColumns[0])) || 'row'}`} checked={isSel} tabIndex={-1} onChange={() => { toggle(key); setAnchor(i) }} />
                        )}
                      </td>
                    )}
                    {visibleColumns.map((c, ci) => {
                      const value = getValue(row, c)
                      const display = c.cell ? c.cell(row, value) : value == null || value === '' ? <span className="text-ink-400">—</span> : String(value)
                      const first = ci === 0
                      return (
                        <td
                          key={c.id}
                          className={clsx(
                            'border-b border-ink-100 align-middle text-ink-800',
                            cellPad,
                            c.align === 'right' && 'text-right tabular-nums',
                            c.align === 'center' && 'text-center',
                            first && !selectable && stickyFirst,
                            first && selectable && 'sticky left-10 z-[1] bg-inherit',
                            first && 'font-medium text-fg',
                            c.wrap ? 'whitespace-normal' : 'whitespace-nowrap',
                            (widths[c.id] || c.maxWidth) && 'truncate',
                            c.className
                          )}
                          style={{ maxWidth: widths[c.id] || c.maxWidth }}
                        >
                          {c.editable && onCellEdit ? <EditableCell row={row} col={c} value={value} display={display} onCommit={commitEdit} /> : display}
                        </td>
                      )
                    })}
                    {hasActions && (
                      <td className="sticky right-0 border-b border-ink-100 px-2 text-right group-hover/row:bg-inherit group-focus-within/row:bg-inherit [@media(hover:none)]:bg-inherit" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity duration-fast focus-within:opacity-100 group-hover/row:opacity-100 group-focus/row:opacity-100 [@media(hover:none)]:opacity-100">
                          {rowActions(row)}
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
              {virtual && end < paged.length && <tr aria-hidden="true" style={{ height: (paged.length - end) * rowH }} />}
            </tbody>
            {visibleColumns.some((c) => c.footer) && (
              <tfoot className="sticky bottom-0 z-[2] bg-sunken">
                <tr>
                  {selectable && <td className="border-t border-ink-200 bg-sunken" />}
                  {visibleColumns.map((c) => (
                    <td key={c.id} className={clsx('border-t border-ink-200 bg-sunken px-3 py-2 text-sm font-semibold text-fg', c.align === 'right' && 'text-right tabular-nums')}>
                      {c.footer ? c.footer(processed) : null}
                    </td>
                  ))}
                  {hasActions && <td className="border-t border-ink-200 bg-sunken" />}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {countLine}
      {bulkBar}
    </div>
  )
}

/** Row action button — icon + required label. */
export function RowAction({ icon: Icon, label, onClick, tone, to, disabled, reason }) {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      aria-label={label}
      title={disabled && reason ? reason : label}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); if (to) navigate(to); else onClick?.(e) }}
      className={clsx('inline-flex h-7 w-7 items-center justify-center rounded-md disabled:opacity-30', tone === 'risk' ? 'text-ink-500 hover:bg-risk-50 hover:text-risk-600' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-900')}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  )
}

/** Bulk-bar button styled for the dark selection bar. */
export function BulkAction({ children, onClick, tone, disabled, icon: Icon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx('inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium disabled:opacity-40', tone === 'risk' ? 'text-[#ffa39a] hover:bg-white/10' : tone === 'primary' ? 'bg-white text-[#18181b] hover:bg-white/90' : 'text-white hover:bg-white/10')}
      style={tone === 'primary' ? { background: '#fff' } : undefined}
    >
      {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
      {children}
    </button>
  )
}
