import { useCallback, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { PlusIcon, TrashIcon } from '@heroicons/react/20/solid'

/**
 * LineItemEditor — PO lines, journal lines, BOM lines. Works like a sheet.
 *
 * columns: [{
 *   key, header, type: 'text' | 'number' | 'money' | 'select' | 'readonly',
 *   width, options: [{ value, label }], placeholder, required,
 *   compute: (row) => value     (readonly derived cells, e.g. line total)
 *   validate: (value, row) => message | null
 *   total: true | (rows) => node   (footer total for this column)
 *   align
 * }]
 * rows / onChange(rows) — controlled. newRow() makes an empty line.
 *
 * Keyboard
 *   Tab / Shift+Tab   move across cells; Tab from the last cell adds a line
 *   Enter             move down a row (adds a line at the bottom)
 *   ↑ / ↓             move between rows in the same column
 *   Ctrl/⌘+Enter      add a line below
 *   Ctrl/⌘+Backspace  remove the current line
 *   Paste             paste a block from Excel or Sheets: tab-separated
 *                     columns and newline-separated rows fill from the
 *                     focused cell, adding lines as needed.
 */
export default function LineItemEditor({
  columns = [],
  rows = [],
  onChange,
  newRow = () => ({}),
  minRows = 1,
  label = 'Lines',
  errors = {},
  readOnly = false,
  currency = 'USD',
  footer,
  className,
  addLabel = 'Add line',
  transform,
}) {
  const gridRef = useRef(null)
  const [focus, setFocus] = useState(null) // { r, c }
  const editable = columns.map((c, i) => (c.type !== 'readonly' && !c.compute ? i : null)).filter((i) => i !== null)

  const parse = (col, raw) => {
    if (col.type === 'number' || col.type === 'money') {
      const cleaned = String(raw).replace(/[^\d.,-]/g, '').replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.')
      return cleaned === '' ? '' : cleaned
    }
    return raw
  }

  const update = useCallback(
    (r, key, value) => {
      const next = rows.map((row, i) => {
        if (i !== r) return row
        const changed = { ...row, [key]: value }
        return transform ? transform(changed, key, value) : changed
      })
      onChange?.(next)
    },
    [rows, onChange, transform]
  )

  const addRow = (at = rows.length) => {
    const next = [...rows]
    next.splice(at, 0, newRow())
    onChange?.(next)
    return at
  }

  const removeRow = (r) => {
    if (rows.length <= minRows) {
      onChange?.(rows.map((row, i) => (i === r ? newRow() : row)))
      return
    }
    onChange?.(rows.filter((_, i) => i !== r))
  }

  const focusCell = (r, c) => {
    requestAnimationFrame(() => {
      const el = gridRef.current?.querySelector(`[data-cell="${r}:${c}"]`)
      el?.focus()
      el?.select?.()
    })
  }

  const onKeyDown = (e, r, c) => {
    const pos = editable.indexOf(c)
    if (e.key === 'Tab' && !e.shiftKey && pos === editable.length - 1 && r === rows.length - 1) {
      e.preventDefault()
      addRow()
      focusCell(r + 1, editable[0])
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      addRow(r + 1)
      focusCell(r + 1, editable[0])
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace') {
      e.preventDefault()
      removeRow(r)
      focusCell(Math.max(0, r - 1), c)
      return
    }
    if (e.key === 'Enter' && e.target.tagName !== 'SELECT') {
      e.preventDefault()
      if (r === rows.length - 1) addRow()
      focusCell(r + 1, c)
      return
    }
    if (e.key === 'ArrowDown' && e.target.tagName !== 'SELECT') {
      if (r < rows.length - 1) { e.preventDefault(); focusCell(r + 1, c) }
      return
    }
    if (e.key === 'ArrowUp' && e.target.tagName !== 'SELECT') {
      if (r > 0) { e.preventDefault(); focusCell(r - 1, c) }
    }
  }

  const onPaste = (e, r, c) => {
    const text = e.clipboardData?.getData('text/plain')
    if (!text || (!text.includes('\t') && !text.includes('\n'))) return
    e.preventDefault()
    const lines = text.replace(/\r/g, '').split('\n').filter((l, i, a) => l.length || i < a.length - 1)
    const startPos = editable.indexOf(c)
    const next = [...rows]
    lines.forEach((line, li) => {
      const cells = line.split('\t')
      const ri = r + li
      while (next.length <= ri) next.push(newRow())
      const row = { ...next[ri] }
      cells.forEach((val, ci) => {
        const colIndex = editable[startPos + ci]
        if (colIndex == null) return
        const col = columns[colIndex]
        if (col.type === 'select') {
          const v = val.trim().toLowerCase()
          const match = (col.options || []).find((o) => {
            const l = String(o.label).toLowerCase()
            // Exact label, exact value, or a code at the start of the label ("4000" → "4000 · Revenue").
            return l === v || String(o.value).toLowerCase() === v || l.startsWith(`${v} `)
          })
          if (match) row[col.key] = match.value
        } else {
          row[col.key] = parse(col, val.trim())
        }
      })
      next[ri] = row
    })
    onChange?.(next)
  }

  const valueOf = (row, col) => (col.compute ? col.compute(row) : row[col.key])
  const fmt = useMemo(() => new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }), [currency])
  const totals = columns.map((col) => {
    if (!col.total) return null
    if (typeof col.total === 'function') return col.total(rows)
    const sum = rows.reduce((s, row) => s + (Number(valueOf(row, col)) || 0), 0)
    return col.type === 'money' || col.compute ? fmt.format(sum) : sum.toLocaleString()
  })

  return (
    <div className={clsx('min-w-0 overflow-hidden rounded-lg border border-ink-200 bg-surface', className)}>
      <div className="overflow-x-auto ui-scroll">
        <table ref={gridRef} className="w-full border-separate border-spacing-0 text-sm" aria-label={label}>
          <thead className="bg-sunken">
            <tr>
              <th scope="col" className="w-8 border-b border-ink-200 px-2 text-right">#</th>
              {columns.map((col) => (
                <th key={col.key} scope="col" style={{ width: col.width, minWidth: col.minWidth }} className={clsx('h-8 border-b border-ink-200 px-2 text-left', (col.type === 'number' || col.type === 'money' || col.align === 'right' || col.compute) && 'text-right')}>
                  {col.header}
                  {col.required && <span className="sr-only"> (required)</span>}
                </th>
              ))}
              {!readOnly && <th scope="col" className="w-9 border-b border-ink-200"><span className="sr-only">Remove</span></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={row._key || row.id || r} className="group">
                <td className="border-b border-ink-100 px-2 text-right font-mono text-2xs text-ink-400 tabular-nums">{r + 1}</td>
                {columns.map((col, c) => {
                  const value = valueOf(row, col)
                  const err = errors?.[r]?.[col.key] || (col.validate && value !== undefined && value !== '' ? col.validate(value, row) : null)
                  const num = col.type === 'number' || col.type === 'money'
                  const isFocus = focus?.r === r && focus?.c === c
                  const cellLabel = `${typeof col.header === 'string' ? col.header : col.key}, line ${r + 1}`
                  if (col.compute || col.type === 'readonly' || readOnly) {
                    const shown = col.compute && (col.type === 'money' || col.money) ? fmt.format(Number(value) || 0) : value
                    return (
                      <td key={col.key} className={clsx('border-b border-ink-100 px-2 py-1.5 text-ink-700', (num || col.compute) && 'text-right tabular-nums')}>
                        {shown ?? <span className="text-ink-400">—</span>}
                      </td>
                    )
                  }
                  const common = {
                    'data-cell': `${r}:${c}`,
                    'aria-label': cellLabel,
                    'aria-invalid': err ? true : undefined,
                    value: value ?? '',
                    onFocus: () => setFocus({ r, c }),
                    onBlur: () => setFocus(null),
                    onKeyDown: (e) => onKeyDown(e, r, c),
                    onPaste: (e) => onPaste(e, r, c),
                    className: clsx(
                      '!min-h-0 h-8 w-full !rounded-none !border-0 !bg-transparent !px-2 !shadow-none focus:!ring-0',
                      num && 'text-right tabular-nums',
                      err && 'text-risk-700'
                    ),
                  }
                  return (
                    <td
                      key={col.key}
                      className={clsx(
                        'relative border-b border-ink-100 p-0',
                        isFocus && 'outline outline-2 -outline-offset-2 outline-brand-600',
                        err && !isFocus && 'bg-risk-50'
                      )}
                      title={err || undefined}
                    >
                      {col.type === 'select' ? (
                        <select {...common} onChange={(e) => update(r, col.key, e.target.value)}>
                          <option value="">{col.placeholder || 'Select…'}</option>
                          {(col.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      ) : (
                        <input
                          {...common}
                          type={col.type === 'date' ? 'date' : 'text'}
                          inputMode={num ? 'decimal' : undefined}
                          placeholder={col.placeholder}
                          onChange={(e) => update(r, col.key, num ? parse(col, e.target.value) : e.target.value)}
                        />
                      )}
                      {err && isFocus && (
                        <span role="alert" className="absolute left-0 top-full z-10 mt-0.5 whitespace-nowrap rounded bg-risk-600 px-1.5 py-0.5 text-2xs text-white">{err}</span>
                      )}
                    </td>
                  )
                })}
                {!readOnly && (
                  <td className="border-b border-ink-100 px-1 text-center">
                    <button type="button" onClick={() => removeRow(r)} aria-label={`Remove line ${r + 1}`} title="Remove line (Ctrl+Backspace)" className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-400 opacity-0 hover:bg-risk-50 hover:text-risk-600 focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                      <TrashIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          {totals.some((t) => t != null) && (
            <tfoot className="bg-sunken">
              <tr>
                <td className="px-2" />
                {columns.map((col, c) => (
                  <td key={col.key} className={clsx('px-2 py-2 text-sm font-semibold tabular-nums text-fg', totals[c] != null && 'text-right')} aria-live={totals[c] != null ? 'polite' : undefined}>
                    {c === 0 && totals[0] == null ? <span className="label-mono">Total</span> : totals[c]}
                  </td>
                ))}
                {!readOnly && <td />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {!readOnly && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-200 px-2 py-1.5">
          <button type="button" onClick={() => { const at = addRow(); focusCell(at, editable[0]) }} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-sm font-medium text-ink-700 hover:bg-ink-100">
            <PlusIcon className="h-4 w-4" aria-hidden="true" />
            {addLabel}
          </button>
          <p className="hidden text-2xs text-ink-500 md:block">
            Tab moves across · Enter moves down · paste rows from Excel · <kbd className="font-mono">Ctrl+Enter</kbd> adds a line
          </p>
          {footer}
        </div>
      )}
    </div>
  )
}
