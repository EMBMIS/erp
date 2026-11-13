import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PlusIcon, BanknotesIcon, ArrowDownTrayIcon, DocumentTextIcon } from '@heroicons/react/20/solid'
import { supplierInvoicesAPI, supplierPaymentsAPI, purchaseOrdersAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useI18n } from '../../contexts/I18nContext'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, StatusBadge, Money, Code, DateText, Stat, Segmented,
  Dialog, Field, Select, Input, InlineNotice, DocumentLink, EmptyState, SkeletonRows, ErrorState,
  exportCsv, daysFrom, notify, formatMoney,
} from '../../components/ui'
import { RecordPaymentDialog } from './FinanceParts'
import BilledTwice from '../../components/finance/BilledTwice'

/**
 * Supplier invoices — the payables ledger: every vendor bill, what is still
 * owed on it and when it falls due.
 *
 * The list endpoint caps a page at 200 rows, so bills are read page by page
 * (up to LIMIT) and sorted, filtered and searched across the whole set.
 */
const PAGE = 200
const LIMIT = 1000
const OPEN = new Set(['APPROVED', 'PARTIALLY_PAID', 'OVERDUE'])

async function fetchAll() {
  const rows = []
  let total = 0
  for (let offset = 0; offset < LIMIT; offset += PAGE) {
    const res = await supplierInvoicesAPI.list({ limit: PAGE, offset, sort_by: 'created_at', sort_dir: 'desc' })
    const page = res.data?.data || []
    total = Number.isFinite(res.data?.total) ? res.data.total : rows.length + page.length
    rows.push(...page)
    if (page.length < PAGE || rows.length >= total) break
  }
  return { data: { success: true, data: { rows, total } } }
}

const isOverdue = (b) => b.status === 'OVERDUE' || (OPEN.has(b.status) && b.due_date && daysFrom(b.due_date) < 0)
const canPay = (b) => b.status !== 'PAID' && b.status !== 'CANCELLED' && !b.payment_hold

const QUICK = {
  all: { label: 'All', test: () => true },
  approval: { label: 'Awaiting approval', test: (b) => b.status === 'DRAFT' || b.status === 'PENDING_APPROVAL' },
  open: { label: 'To pay', test: (b) => OPEN.has(b.status) },
  overdue: { label: 'Overdue', test: isOverdue },
  paid: { label: 'Paid', test: (b) => b.status === 'PAID' },
}

export default function SupplierInvoices() {
  const { t } = useI18n()
  const [searchParams, setSearchParams] = useSearchParams()
  const focusId = searchParams.get('invoice')
  const [quick, setQuick] = useState('all')
  const [genOpen, setGenOpen] = useState(false)
  const [payFor, setPayFor] = useState(null)

  const { data, loading, error, refetch } = useResource(keys.supplierInvoices({ all: true, limit: LIMIT }), fetchAll)
  const bills = useMemo(() => data?.rows || [], [data])
  const total = data?.total || 0
  const { data: stats, loading: statsLoading } = useResource(keys.supplierInvoices('stats'), () => supplierInvoicesAPI.stats())

  const pay = useResourceMutation((payload) => supplierPaymentsAPI.create(payload), { invalidates: [['supplier-invoices'], ['supplier-payments'], ['financial-reports']], silent: true })

  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, bills.filter(q.test).length])), [bills])
  const filter = focusId ? (b) => String(b.id) === focusId : QUICK[quick].test
  const focused = focusId ? bills.find((b) => String(b.id) === focusId) : null

  const columns = useMemo(() => [
    { id: 'bill', header: 'Bill', accessor: 'bill_number', cell: (b) => <Code>{b.bill_number}</Code>, width: 150, mobile: 'title' },
    { id: 'supplier', header: 'Supplier', accessor: 'supplier_name', filter: 'text', mobile: 'subtitle', minWidth: 180, maxWidth: 280, cell: (b) => <span className="block truncate">{b.supplier_name || '—'}</span> },
    { id: 'vendorRef', header: 'Vendor ref', accessor: 'supplier_invoice_number', width: 140, cell: (b) => (b.supplier_invoice_number ? <Code className="text-ink-600">{b.supplier_invoice_number}</Code> : <span className="text-ink-400">—</span>) },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 160, mobile: 'meta', cell: (b) => (
        <span className="flex items-center gap-1.5">
          <StatusBadge status={b.status} />
          {b.payment_hold && <span className="font-mono text-2xs text-warn-700" title={b.payment_hold_reason || 'Payment on hold'}>HOLD</span>}
        </span>
      ) },
    {
      id: 'due', header: 'Due', accessor: 'due_date', width: 150,
      cell: (b) => (
        <span className="flex items-center gap-1.5">
          <DateText value={b.due_date} />
          {isOverdue(b) && b.due_date && <span className="font-mono text-2xs text-risk-600" title="Past its due date">▲ {Math.abs(daysFrom(b.due_date))}d</span>}
        </span>
      ),
    },
    { id: 'total', header: 'Total', accessor: (b) => Number(b.total_amount), align: 'right', filter: 'number', width: 130, cell: (b) => <Money amount={b.total_amount} currency={b.currency} />, exportValue: (b) => b.total_amount },
    {
      id: 'outstanding', header: 'Outstanding', accessor: (b) => Number(b.outstanding_amount), align: 'right', filter: 'number', width: 140, mobile: 'trailing',
      cell: (b) => <Money amount={b.outstanding_amount} currency={b.currency} className="font-medium" />,
      exportValue: (b) => b.outstanding_amount,
      footer: (rows) => {
        const cur = [...new Set(rows.map((r) => r.currency || 'USD'))]
        if (cur.length !== 1) return <span className="text-xs font-normal text-ink-500">Mixed currencies</span>
        return <Money amount={rows.reduce((s, r) => s + (Number(r.outstanding_amount) || 0), 0)} currency={cur[0]} />
      },
    },
    {
      id: 'source', header: 'Source', accessor: (b) => b.po_number || b.journal_number || '', width: 200,
      cell: (b) => (
        <span className="flex gap-3">
          {b.purchase_order_id && <DocumentLink type="purchase_order" id={b.purchase_order_id}>{b.po_number || 'PO'}</DocumentLink>}
          {b.journal_entry_id && <DocumentLink type="journal_entry" id={b.journal_entry_id}>{b.journal_number || 'Journal'}</DocumentLink>}
          {!b.purchase_order_id && !b.journal_entry_id && <span className="text-ink-400">—</span>}
        </span>
      ),
    },
    { id: 'currency', header: 'Currency', accessor: 'currency', width: 90, filter: 'select', defaultHidden: true },
    { id: 'createdBy', header: 'Recorded by', accessor: 'created_by_name', width: 140, defaultHidden: true },
  ], [])

  const recordPayment = async ({ amount, method, reference }) => {
    const bill = payFor
    try {
      await pay.mutateAsync({
        supplier_id: bill.supplier_id,
        payment_method: method,
        reference_number: reference || undefined,
        payment_amount: amount,
        description: `Payment for ${bill.bill_number}`,
        allocations: [{ bill_id: bill.id, allocation_amount: amount }],
      })
      notify.success(`Payment of ${formatMoney(amount, bill.currency || 'USD')} recorded against ${bill.bill_number}`)
      setPayFor(null)
    } catch (e) {
      notify.error(`Payment not recorded: ${e?.response?.data?.error || e.message}`)
    }
  }

  return (
    <>
      <PageHeader
        title={t('ui.supplierInvoices')}
        description="Vendor bills, what is still owed on each, and when it falls due."
        secondary={<Button icon={ArrowDownTrayIcon} disabled={!bills.length} onClick={() => exportCsv(bills.filter(filter), columns, 'supplier-invoices.csv')}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setGenOpen(true)}>{t('ui.recordBill')}</Button>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Billed" value={<Money amount={stats?.total_billed} digits={0} />} loading={statsLoading} onClick={() => setQuick('all')} />
        <Stat label="Paid" value={<Money amount={stats?.total_paid} digits={0} />} loading={statsLoading} onClick={() => setQuick('paid')} />
        <Stat label="Outstanding" value={<Money amount={stats?.total_outstanding} digits={0} />} loading={statsLoading} onClick={() => setQuick('open')} />
        <Stat
          label="Overdue"
          value={<Money amount={stats?.overdue_amount} digits={0} />}
          loading={statsLoading}
          onClick={() => setQuick('overdue')}
          reason={Number(stats?.overdue_count) ? `${stats.overdue_count} bill${Number(stats.overdue_count) === 1 ? '' : 's'} past due` : undefined}
        />
      </div>

      {focusId && (
        <InlineNotice className="mb-3" title={focused ? `Showing bill ${focused.bill_number}` : 'Showing one bill'} action={<Button size="sm" onClick={() => setSearchParams({})}>Show all bills</Button>}>
          {!loading && !focused && 'That bill is not in this list. It may be older than the newest 1,000, or it was removed.'}
        </InlineNotice>
      )}
      <BilledTwice key={focusId || 'all'} focusId={focusId} onChanged={refetch} />

      {total > bills.length && (
        <InlineNotice tone="warn" className="mb-3" title={`Showing the newest ${bills.length.toLocaleString()} of ${total.toLocaleString()} bills`}>
          Search and filters apply to these. Older bills are still in the ledger and in the aging report.
        </InlineNotice>
      )}

      <DataTable
        viewKey="finance.supplier-invoices"
        caption={t('ui.supplierInvoices')}
        noun="bill"
        rows={bills}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        externalFilter={filter}
        defaultSort={{ id: 'due', dir: 'asc' }}
        searchPlaceholder="Search bill, supplier, vendor ref"
        toolbarStart={!focusId && (
          <Segmented
            label="Show"
            value={quick}
            onChange={setQuick}
            options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
            className="max-w-full overflow-x-auto"
          />
        )}
        selectable
        bulkActions={(sel) => <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'supplier-invoices-selected.csv')}>Export {sel.length}</BulkAction>}
        rowActions={(b) => canPay(b) && <RowAction icon={BanknotesIcon} label={`Pay ${b.bill_number}`} onClick={() => setPayFor(b)} />}
        empty={{
          icon: DocumentTextIcon,
          title: 'No supplier bills yet',
          description: 'A bill is recorded against a completed purchase order, so the amounts match what was ordered and received.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setGenOpen(true)}>{t('ui.recordBill')}</Button>,
        }}
      />

      {genOpen && <RecordBillDialog onClose={() => setGenOpen(false)} />}

      {payFor && (
        <RecordPaymentDialog
          open
          onClose={() => setPayFor(null)}
          title={`Pay ${payFor.bill_number}`}
          description={payFor.supplier_name}
          outstanding={Number(payFor.outstanding_amount ?? payFor.total_amount ?? 0)}
          currency={payFor.currency || 'USD'}
          busy={pay.isPending}
          submitLabel="Record payment"
          onSubmit={recordPayment}
        />
      )}
    </>
  )
}

/** Record a supplier bill against a completed purchase order. */
function RecordBillDialog({ onClose }) {
  const [selected, setSelected] = useState('')
  const [vendorRef, setVendorRef] = useState('')
  const [touched, setTouched] = useState(false)
  const [failure, setFailure] = useState(null)
  const { data, loading, error, refetch } = useResource(keys.purchaseOrders({ status: 'COMPLETED' }), () => purchaseOrdersAPI.list({ status: 'COMPLETED' }))
  const orders = Array.isArray(data) ? data : []
  const create = useResourceMutation(({ id, payload }) => supplierInvoicesAPI.createFromPurchaseOrder(id, payload), { invalidates: [['supplier-invoices'], ['purchase-orders']], silent: true })

  const submit = async () => {
    setTouched(true)
    if (!selected) return
    setFailure(null)
    try {
      const bill = await create.mutateAsync({ id: selected, payload: { supplier_invoice_number: vendorRef || undefined } })
      notify.success(bill?.bill_number ? `Bill ${bill.bill_number} recorded` : 'Bill recorded')
      onClose()
    } catch (e) {
      setFailure(e?.response?.data?.error || e.message)
    }
  }

  return (
    <Dialog
      open
      onClose={create.isPending ? undefined : onClose}
      title="Record a bill from a purchase order"
      description="The bill copies the order's lines and totals and posts the liability to the ledger."
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!orders.length}>Record bill</Button>
        </>
      }
    >
      {loading ? <SkeletonRows rows={2} columns={2} /> : error ? (
        <ErrorState compact error={error} what="Completed purchase orders" onRetry={refetch} />
      ) : orders.length === 0 ? (
        <EmptyState compact title="No completed purchase orders" description="A bill can be recorded once its purchase order is complete." />
      ) : (
        <div className="space-y-4">
          {failure && <InlineNotice tone="risk" title="The bill was not recorded">{failure}</InlineNotice>}
          <Field label="Completed purchase order" required error={touched && !selected ? 'Choose the order this bill is for.' : null}>
            <Select value={selected} onChange={(e) => setSelected(e.target.value)} onBlur={() => setTouched(true)}>
              <option value="">Choose an order…</option>
              {orders.map((po) => (
                <option key={po.id} value={po.id}>
                  {po.po_number} · {po.supplier_name || po.legal_name || 'Supplier'} · {formatMoney(po.total_amount, po.currency || 'USD')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Supplier's invoice number" optional help="The vendor's own reference, as printed on their invoice.">
            <Input value={vendorRef} onChange={(e) => setVendorRef(e.target.value)} />
          </Field>
        </div>
      )}
    </Dialog>
  )
}
