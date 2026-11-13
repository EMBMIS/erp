import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowDownTrayIcon, BanknotesIcon } from '@heroicons/react/20/solid'
import { supplierPaymentsAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { useI18n } from '../../contexts/I18nContext'
import {
  PageHeader, Button, DataTable, BulkAction, StatusBadge, Money, Num, Code, DateText, Stat, InlineNotice, DocumentLink, exportCsv,
} from '../../components/ui'

/**
 * Supplier payments — money out to vendors, each applied to one or more
 * bills. Payments are made from the bill they settle (Supplier invoices →
 * Pay), so this screen is the read-only register.
 */
const humanize = (v) => String(v || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())

export default function SupplierPayments() {
  const { t } = useI18n()
  const [searchParams, setSearchParams] = useSearchParams()
  const focusId = searchParams.get('payment')
  const { data, loading, error, refetch } = useResource(['supplier-payments', 'all'], () => supplierPaymentsAPI.list())
  const payments = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const totals = useMemo(() => {
    const live = payments.filter((p) => p.status !== 'CANCELLED' && p.status !== 'BOUNCED')
    const cur = [...new Set(live.map((p) => p.currency || 'USD'))]
    return { count: payments.length, amount: live.reduce((s, p) => s + (Number(p.payment_amount) || 0), 0), currency: cur.length === 1 ? cur[0] : null }
  }, [payments])
  const focused = focusId ? payments.find((p) => String(p.id) === focusId) : null

  const columns = useMemo(() => [
    { id: 'payment', header: 'Payment', accessor: 'payment_number', cell: (p) => <Code>{p.payment_number}</Code>, width: 150, mobile: 'title' },
    { id: 'supplier', header: 'Supplier', accessor: 'supplier_name', filter: 'text', minWidth: 180, maxWidth: 280, mobile: 'subtitle', cell: (p) => <span className="block truncate">{p.supplier_name || '—'}</span> },
    { id: 'date', header: 'Paid', accessor: 'payment_date', width: 120, mobile: 'meta', cell: (p) => <DateText value={p.payment_date} /> },
    { id: 'method', header: 'Method', accessor: (p) => humanize(p.payment_method), filter: 'select', width: 140 },
    { id: 'reference', header: 'Reference', accessor: 'reference_number', width: 150, cell: (p) => (p.reference_number ? <Code className="text-ink-600">{p.reference_number}</Code> : <span className="text-ink-400">—</span>) },
    {
      id: 'amount', header: 'Amount', accessor: (p) => Number(p.payment_amount), align: 'right', filter: 'number', width: 140, mobile: 'trailing',
      cell: (p) => <Money amount={p.payment_amount} currency={p.currency} className="font-medium" />, exportValue: (p) => p.payment_amount,
      footer: (rows) => {
        const cur = [...new Set(rows.map((r) => r.currency || 'USD'))]
        if (cur.length !== 1) return <span className="text-xs font-normal text-ink-500">Mixed currencies</span>
        return <Money amount={rows.reduce((s, r) => s + (Number(r.payment_amount) || 0), 0)} currency={cur[0]} />
      },
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 130, cell: (p) => <StatusBadge status={p.status} /> },
    { id: 'journal', header: 'Journal', accessor: 'journal_number', width: 150, cell: (p) => (p.journal_entry_id ? <DocumentLink type="journal_entry" id={p.journal_entry_id}>{p.journal_number || 'Journal'}</DocumentLink> : <span className="text-ink-400">—</span>) },
    { id: 'currency', header: 'Currency', accessor: 'currency', width: 90, filter: 'select', defaultHidden: true },
  ], [])

  return (
    <>
      <PageHeader
        title={t('ui.supplierPayments')}
        description="Payments to suppliers, each applied to the bills it settles. Pay a bill from Supplier invoices."
        secondary={<Button icon={ArrowDownTrayIcon} disabled={!payments.length} onClick={() => exportCsv(payments, columns, 'supplier-payments.csv')}>Export</Button>}
        primary={<Button variant="primary" icon={BanknotesIcon} to="/finance/supplier-invoices">Pay a bill</Button>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3">
        <Stat label="Total paid" value={totals.currency ? <Money amount={totals.amount} currency={totals.currency} digits={0} /> : payments.length ? 'Mixed currencies' : <Money amount={0} digits={0} />} loading={loading} footnote="Excludes bounced and cancelled payments" />
        <Stat label="Payments recorded" value={<Num value={totals.count} />} loading={loading} />
      </div>

      {focusId && (
        <InlineNotice className="mb-3" title={focused ? `Showing payment ${focused.payment_number}` : 'Showing one payment'} action={<Button size="sm" onClick={() => setSearchParams({})}>Show all payments</Button>}>
          {!loading && !focused && 'That payment is not in this list. It may have been removed.'}
        </InlineNotice>
      )}

      <DataTable
        viewKey="finance.supplier-payments"
        caption={t('ui.supplierPayments')}
        noun="payment"
        rows={payments}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        externalFilter={focusId ? (p) => String(p.id) === focusId : undefined}
        defaultSort={{ id: 'date', dir: 'desc' }}
        searchPlaceholder="Search payment, supplier, reference"
        selectable
        bulkActions={(sel) => <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'supplier-payments-selected.csv')}>Export {sel.length}</BulkAction>}
        empty={{
          icon: BanknotesIcon,
          title: 'No supplier payments yet',
          description: 'A payment is made against the bill it settles. Open Supplier invoices and choose Pay on an approved bill.',
          action: <Button variant="primary" to="/finance/supplier-invoices">Open supplier invoices</Button>,
        }}
      />
    </>
  )
}
