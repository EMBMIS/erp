
import clsx from 'clsx'
import { Link } from 'react-router-dom'
import { useI18n } from '../../contexts/I18nContext'
import { Button } from './Button'
import { EmptyState, ErrorState, SkeletonRows } from './Feedback'

/**
 * Pre-system APIs kept so older pages keep working while they migrate.
 * New code: DataTable instead of Table; Breadcrumbs/RelatedPanel instead of
 * RelatedDocuments.
 */
export function Table({ columns, rows, caption, keyField = 'id', loading, error, onRetry, empty, onRowClick, className, sort, onSortChange }) {
  const { t } = useI18n()
  if (loading) return <SkeletonRows rows={5} columns={Math.min(columns?.length || 4, 6)} />
  if (error) return <ErrorState error={error} onRetry={onRetry} compact />
  if (!rows?.length) return empty || <EmptyState title={t('ui.nothingHereYet')} description="No records match this view." compact />
  return (
    <div className={clsx('overflow-x-auto ui-scroll', className)}>
      <table className="min-w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-sunken">
          <tr>
            {columns.map((col) => {
              const sortable = Boolean(col.sortKey && onSortChange)
              const active = sortable && sort?.key === col.sortKey
              const direction = active ? sort.direction : null
              return (
                <th key={col.key} scope="col" aria-sort={sortable ? (active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none') : undefined} className={clsx('h-9 border-b border-ink-200 px-3', col.align === 'right' ? 'text-right' : 'text-left', col.className)}>
                  {col.srOnly ? <span className="sr-only">{col.header}</span> : sortable ? (
                    <button type="button" onClick={() => onSortChange({ key: col.sortKey, direction: active && direction === 'asc' ? 'desc' : 'asc' })} className={clsx('inline-flex items-center gap-1 uppercase', col.align === 'right' && 'flex-row-reverse', active && 'text-ink-900')} style={{ font: 'inherit', letterSpacing: 'inherit' }}>
                      {col.header}
                      <span aria-hidden="true" className={clsx('font-sans text-[10px]', !active && 'opacity-30')}>{direction === 'desc' ? '↓' : '↑'}</span>
                    </button>
                  ) : col.header}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row[keyField]}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') { e.preventDefault(); onRowClick(row) } } : undefined}
              className={clsx('bg-surface', onRowClick && 'cursor-pointer hover:bg-ink-50 focus-visible:bg-ink-50')}
            >
              {columns.map((col) => (
                <td key={col.key} className={clsx('h-10 whitespace-nowrap border-b border-ink-100 px-3 text-ink-800', col.align === 'right' && 'text-right tabular-nums')}>
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const DOCUMENT_ROUTES = {
  sales_order: (id) => `/sales/sales-orders/${id}`,
  sales_quotation: (id) => `/sales/quotations/${id}`,
  customer_invoice: (id) => `/finance/customer-invoices?invoice=${id}`,
  customer_payment: (id) => `/finance/customer-payments?payment=${id}`,
  delivery_schedule: (id) => `/sales/delivery-schedules?schedule=${id}`,
  purchase_order: (id) => `/procurement/purchase-orders/${id}`,
  goods_receipt: (id) => `/procurement/goods-receipts?receipt=${id}`,
  supplier_invoice: (id) => `/finance/supplier-invoices?invoice=${id}`,
  journal_entry: (id) => `/finance/journal-entries?entry=${id}`,
  customer: (id) => `/sales/customers/${id}`,
  supplier: (id) => `/procurement/suppliers/${id}`,
  item: (id) => `/items/${id}/view`,
  inventory_item: (id) => `/inventory/items/${id}`,
}

export function documentHref(type, id) {
  const build = DOCUMENT_ROUTES[type]
  return build && id ? build(id) : null
}

/** A link to a record, in mono, client-side (no full page reload). */
export function DocumentLink({ type, id, children, className }) {
  const href = documentHref(type, id)
  const label = children ?? id
  if (!href) return <span className={clsx('text-ink-500', className)}>{label || '—'}</span>
  return <Link to={href} className={clsx('font-mono text-[0.92em] text-brand-600 underline-offset-2 hover:underline', className)}>{label}</Link>
}

export function RelatedDocuments({ links = [], title, className }) {
  const { t } = useI18n()
  const present = links.filter((link) => link && link.id)
  if (!present.length) return null
  return (
    <section className={clsx('rounded-lg border border-ink-200 bg-surface', className)} aria-label={title || t('ui.relatedDocuments')}>
      <h2 className="label-mono border-b border-ink-200 px-4 py-2.5">{title || t('ui.relatedDocuments')}</h2>
      <ul className="divide-y divide-ink-100">
        {present.map((link) => (
          <li key={`${link.type}-${link.id}`} className="flex items-center justify-between gap-4 px-4 py-2 text-sm">
            <span className="text-ink-500">{link.caption || link.type.replace(/_/g, ' ')}</span>
            <DocumentLink type={link.type} id={link.id}>{link.label || link.id}</DocumentLink>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function Pagination({ page, pageSize, total, onPageChange }) {
  const { t } = useI18n()
  const from = total === 0 ? 0 : page * pageSize + 1
  const to = Math.min((page + 1) * pageSize, total)
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1)
  return (
    <nav className="flex items-center justify-between border-t border-ink-200 px-3 py-2" aria-label={t('ui.pagination')}>
      <p className="text-xs text-ink-500 tabular-nums" aria-live="polite">
        {total === 0 ? 'No results' : <>{t('ui.showing')} {from}–{to} {t('ui.of')} {total}</>}
      </p>
      <div className="flex gap-1.5">
        <Button variant="secondary" size="sm" disabled={page <= 0} onClick={() => onPageChange(page - 1)}>{t('ui.previous')}</Button>
        <Button variant="secondary" size="sm" disabled={page >= lastPage} onClick={() => onPageChange(page + 1)}>{t('ui.next')}</Button>
      </div>
    </nav>
  )
}
