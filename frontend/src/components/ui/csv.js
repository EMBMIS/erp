/**
 * exportCsv — download the rows on screen as CSV, using the same columns the
 * table shows. Values come from each column's `exportValue(row)`, else its
 * accessor. Runs entirely in the browser; nothing is sent anywhere.
 */
export function exportCsv(rows, columns, filename = 'export.csv') {
  const cols = columns.filter((c) => c && c.export !== false && (c.exportValue || c.accessor))
  const esc = (v) => {
    if (v == null) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = cols.map((c) => esc(typeof c.header === 'string' ? c.header : c.id || c.key)).join(',')
  const body = rows.map((r) => cols.map((c) => {
    const v = c.exportValue ? c.exportValue(r) : typeof c.accessor === 'function' ? c.accessor(r) : r[c.accessor]
    return esc(v)
  }).join(',')).join('\n')
  const blob = new Blob([`${header}\n${body}\n`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default exportCsv
