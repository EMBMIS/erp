import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  PlusIcon, BanknotesIcon, PaperAirplaneIcon, XCircleIcon, ArrowDownTrayIcon, DocumentTextIcon, CodeBracketIcon,
} from '@heroicons/react/20/solid'
import { customerInvoicesAPI, customerPaymentsAPI, salesOrdersAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useI18n } from '../../contexts/I18nContext'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, StatusBadge, Money, Code, DateText, Stat, Segmented,
  ConfirmDialog, Dialog, Field, Select, InlineNotice, DocumentLink, EmptyState, SkeletonRows, ErrorState,
  exportCsv, daysFrom, notify, formatMoney,
} from '../../components/ui'
import { RecordPaymentDialog } from './FinanceParts'

/**
 * Customer invoices — the receivables ledger, as one working list.
 *
 * The list endpoint caps a page at 200 rows, so the ledger is read page by
 * page (up to LIMIT) and sorted, filtered and searched across the whole set.
 * When the cap is reached the page says so instead of showing a partial list
 * as if it were everything.
 */
const PAGE = 200
const LIMIT = 1000
const OPEN = new Set(['APPROVED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE'])

async function fetchAll() {
  const rows = []
  let total = 0
  for (let offset = 0; offset < LIMIT; offset += PAGE) {
    const res = await customerInvoicesAPI.list({ limit: PAGE, offset, sort_by: 'created_at', sort_dir: 'desc' })
    const page = res.data?.data || []
    total = Number.isFinite(res.data?.total) ? res.data.total : rows.length + page.length
    rows.push(...page)
    if (page.length < PAGE || rows.length >= total) break
  }
  return { data: { success: true, data: { rows, total } } }
}

const isOverdue = (inv) => inv.status === 'OVERDUE' || (OPEN.has(inv.status) && inv.due_date && daysFrom(inv.due_date) < 0)
const canPay = (inv) => inv.status !== 'PAID' && inv.status !== 'CANCELLED'
const canCancel = (inv) => inv.status !== 'PAID' && inv.status !== 'CANCELLED' && Number(inv.paid_amount || 0) === 0

const QUICK = {
  all: { label: 'All', test: () => true },
  toSend: { label: 'To send', test: (i) => i.status === 'DRAFT' || i.status === 'APPROVED' },
  open: { label: 'Open', test: (i) => OPEN.has(i.status) },
  overdue: { label: 'Overdue', test: isOverdue },
  paid: { label: 'Paid', test: (i) => i.status === 'PAID' },
}

export default function CustomerInvoices() {
  const { t } = useI18n()
  const [searchParams, setSearchParams] = useSearchParams()
  const focusId = searchParams.get('invoice')
  const [quick, setQuick] = useState('all')
  const [genOpen, setGenOpen] = useState(false)
  const [payFor, setPayFor] = useState(null)
  const [cancelFor, setCancelFor] = useState(null)
  const [sendFor, setSendFor] = useState(null)

  const { data, loading, error, refetch } = useResource(keys.customerInvoices({ all: true, limit: LIMIT }), fetchAll)
  const invoices = useMemo(() => data?.rows || [], [data])
  const total = data?.total || 0
  const { data: stats, loading: statsLoading } = useResource(keys.customerInvoices('stats'), () => customerInvoicesAPI.stats())

  const invalidates = [['customer-invoices'], ['customer-payments'], ['financial-reports']]
  const setStatus = useResourceMutation(({ id, status, reason }) => customerInvoicesAPI.updateStatus(id, status, reason), { invalidates, silent: true })
  const pay = useResourceMutation((payload) => customerPaymentsAPI.create(payload), { invalidates, silent: true })

  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, invoices.filter(q.test).length])), [invoices])
  const filter = focusId ? (i) => String(i.id) === focusId : QUICK[quick].test
  const focused = focusId ? invoices.find((i) => String(i.id) === focusId) : null

  const downloadEInvoice = async (inv) => {
    try {
      const res = await customerInvoicesAPI.downloadEInvoice(inv.id)
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = `e-invoice-${inv.invoice_number}.xml`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      // The export answers 422 with a plain-English list of missing fields
      // (seller/buyer tax number, address…) as JSON inside the blob.
      let message = err.response?.data?.error || 'The e-invoice could not be generated.'
      if (err.response?.status === 422 && err.response.data instanceof Blob) {
        try { message = JSON.parse(await err.response.data.text()).error } catch { message = t('ui.invoiceMissingPeppolData') }
      }
      notify.error(`${inv.invoice_number}: ${message}`)
    }
  }

  const columns = useMemo(() => [
    { id: 'invoice', header: 'Invoice', accessor: 'invoice_number', cell: (i) => <Code>{i.invoice_number}</Code>, width: 150, mobile: 'title' },
    {
      id: 'customer', header: 'Customer', accessor: 'customer_name', filter: 'text', mobile: 'subtitle', minWidth: 180, maxWidth: 280,
      cell: (i) => <span className="block truncate">{i.customer_name || '—'}</span>,
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 150, mobile: 'meta', cell: (i) => <StatusBadge status={i.status} /> },
    { id: 'issued', header: 'Issued', accessor: 'invoice_date', width: 120, cell: (i) => <DateText value={i.invoice_date} /> },
    {
      id: 'due', header: 'Due', accessor: 'due_date', width: 150,
      cell: (i) => (
        <span className="flex items-center gap-1.5">
          <DateText value={i.due_date} />
          {isOverdue(i) && i.due_date && <span className="font-mono text-2xs text-risk-600" title="Past its due date">▲ {Math.abs(daysFrom(i.due_date))}d</span>}
        </span>
      ),
    },
    {
      id: 'total', header: 'Total', accessor: (i) => Number(i.total_amount), align: 'right', filter: 'number', width: 130,
      cell: (i) => <Money amount={i.total_amount} currency={i.currency} />, exportValue: (i) => i.total_amount,
    },
    {
      id: 'outstanding', header: 'Outstanding', accessor: (i) => Number(i.outstanding_amount), align: 'right', filter: 'number', width: 140, mobile: 'trailing',
      cell: (i) => <Money amount={i.outstanding_amount} currency={i.currency} className="font-medium" />,
      exportValue: (i) => i.outstanding_amount,
      footer: (rows) => {
        const cur = [...new Set(rows.map((r) => r.currency || 'USD'))]
        if (cur.length !== 1) return <span className="text-xs font-normal text-ink-500">Mixed currencies</span>
        return <Money amount={rows.reduce((s, r) => s + (Number(r.outstanding_amount) || 0), 0)} currency={cur[0]} />
      },
    },
    { id: 'currency', header: 'Currency', accessor: 'currency', width: 90, filter: 'select', defaultHidden: true },
    {
      // The paper trail: which sales order raised the invoice and which
      // journal entry carries its revenue.
      id: 'source', header: 'Source', accessor: (i) => i.so_number || i.journal_number || '', width: 200,
      cell: (i) => (
        <span className="flex gap-3">
          {i.sales_order_id && <DocumentLink type="sales_order" id={i.sales_order_id}>{i.so_number || 'Order'}</DocumentLink>}
          {i.journal_entry_id && <DocumentLink type="journal_entry" id={i.journal_entry_id}>{i.journal_number || 'Journal'}</DocumentLink>}
          {!i.sales_order_id && !i.journal_entry_id && <span className="text-ink-400">—</span>}
        </span>
      ),
    },
    { id: 'createdBy', header: 'Raised by', accessor: 'created_by_name', width: 140, defaultHidden: true },
  ], [])

  const recordPayment = async ({ amount, method, reference }) => {
    const inv = payFor
    try {
      await pay.mutateAsync({
        customer_id: inv.customer_id,
        payment_method: method,
        reference_number: reference || undefined,
        payment_amount: amount,
        description: `Payment for ${inv.invoice_number}`,
        allocations: [{ invoice_id: inv.id, allocation_amount: amount }],
      })
      notify.success(`Payment of ${formatMoney(amount, inv.currency || 'USD')} recorded against ${inv.invoice_number}`)
      setPayFor(null)
    } catch (e) {
      notify.error(`Payment not recorded: ${e?.response?.data?.error || e.message}`)
    }
  }

  const changeStatus = async (inv, status, reason, after) => {
    try {
      await setStatus.mutateAsync({ id: inv.id, status, reason })
      after?.()
    } catch (e) {
      notify.error(`${inv.invoice_number} was not updated: ${e?.response?.data?.error || e.message}`)
    }
  }

  return (
    <>
      <PageHeader
        title={t('ui.customerInvoices')}
        description="What each customer has been billed, what they still owe, and when it is due."
        secondary={<Button icon={ArrowDownTrayIcon} disabled={!invoices.length} onClick={() => exportCsv(invoices.filter(filter), columns, 'customer-invoices.csv')}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setGenOpen(true)}>{t('ui.generateInvoice')}</Button>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Invoiced" value={<Money amount={stats?.total_invoiced} digits={0} />} loading={statsLoading} onClick={() => setQuick('all')} />
        <Stat label="Collected" value={<Money amount={stats?.total_collected} digits={0} />} loading={statsLoading} onClick={() => setQuick('paid')} />
        <Stat label="Outstanding" value={<Money amount={stats?.total_outstanding} digits={0} />} loading={statsLoading} onClick={() => setQuick('open')} />
        <Stat
          label="Overdue"
          value={<Money amount={stats?.overdue_amount} digits={0} />}
          loading={statsLoading}
          onClick={() => setQuick('overdue')}
          reason={Number(stats?.overdue_count) ? `${stats.overdue_count} invoice${Number(stats.overdue_count) === 1 ? '' : 's'} past due` : undefined}
        />
      </div>

      {focusId && (
        <InlineNotice className="mb-3" title={focused ? `Showing invoice ${focused.invoice_number}` : 'Showing one invoice'} action={<Button size="sm" onClick={() => setSearchParams({})}>Show all invoices</Button>}>
          {!loading && !focused && 'That invoice is not in this list. It may be older than the newest 1,000, or it was removed.'}
        </InlineNotice>
      )}
      {total > invoices.length && (
        <InlineNotice tone="warn" className="mb-3" title={`Showing the newest ${invoices.length.toLocaleString()} of ${total.toLocaleString()} invoices`}>
          Search and filters apply to these. Older invoices are still in the ledger and in the aging report.
        </InlineNotice>
      )}

      <DataTable
        viewKey="finance.customer-invoices"
        caption={t('ui.customerInvoices')}
        noun="invoice"
        rows={invoices}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        externalFilter={filter}
        defaultSort={{ id: 'due', dir: 'asc' }}
        searchPlaceholder="Search invoice, customer, order"
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
        bulkActions={(sel) => <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'customer-invoices-selected.csv')}>Export {sel.length}</BulkAction>}
        rowActions={(i) => (
          <>
            {(i.status === 'APPROVED' || i.status === 'DRAFT') && <RowAction icon={PaperAirplaneIcon} label={`Mark ${i.invoice_number} as sent`} onClick={() => setSendFor(i)} />}
            {canPay(i) && <RowAction icon={BanknotesIcon} label={`Record a payment against ${i.invoice_number}`} onClick={() => setPayFor(i)} />}
            {i.status !== 'DRAFT' && i.status !== 'CANCELLED' && <RowAction icon={CodeBracketIcon} label={`Download the e-invoice (Peppol UBL XML) for ${i.invoice_number}`} onClick={() => downloadEInvoice(i)} />}
            {canCancel(i) && <RowAction icon={XCircleIcon} tone="risk" label={`Cancel ${i.invoice_number}`} onClick={() => setCancelFor(i)} />}
          </>
        )}
        empty={{
          icon: DocumentTextIcon,
          title: 'No customer invoices yet',
          description: 'Invoices are generated from completed sales orders. Generate one when an order has been delivered.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setGenOpen(true)}>{t('ui.generateInvoice')}</Button>,
        }}
      />

      {genOpen && <GenerateInvoiceDialog onClose={() => setGenOpen(false)} />}

      {payFor && (
        <RecordPaymentDialog
          open
          onClose={() => setPayFor(null)}
          title={`Record payment for ${payFor.invoice_number}`}
          description={payFor.customer_name}
          outstanding={Number(payFor.outstanding_amount ?? payFor.total_amount ?? 0)}
          currency={payFor.currency || 'USD'}
          busy={pay.isPending}
          onSubmit={recordPayment}
        />
      )}

      {sendFor && (
        <ConfirmDialog
          open
          tone="primary"
          onClose={() => setSendFor(null)}
          title={`Mark ${sendFor.invoice_number} as sent?`}
          consequence="Records that the customer has received the invoice. Its due date starts counting toward the aging report."
          confirmLabel="Mark as sent"
          busy={setStatus.isPending}
          onConfirm={() => changeStatus(sendFor, 'SENT', 'Sent to customer', () => setSendFor(null))}
        />
      )}

      {cancelFor && (
        <ConfirmDialog
          open
          onClose={() => setCancelFor(null)}
          title={`Cancel ${cancelFor.invoice_number}?`}
          consequence={`The invoice is voided and its revenue posting is reversed with a credit entry${Number(cancelFor.total_amount) ? ` of ${formatMoney(cancelFor.total_amount, cancelFor.currency || 'USD')}` : ''}. This cannot be undone.`}
          confirmLabel="Cancel invoice"
          requireReason
          reasonLabel="Why is it being cancelled?"
          busy={setStatus.isPending}
          onConfirm={(reason) => changeStatus(cancelFor, 'CANCELLED', reason || 'Cancelled', () => {
            notify.success(`${cancelFor.invoice_number} cancelled, revenue reversed`)
            setCancelFor(null)
          })}
        />
      )}
    </>
  )
}

/** Generate an invoice from a completed sales order. */
function GenerateInvoiceDialog({ onClose }) {
  const [selected, setSelected] = useState('')
  const [touched, setTouched] = useState(false)
  const { data, loading, error, refetch } = useResource(keys.salesOrders({ status: 'COMPLETED' }), () => salesOrdersAPI.list({ status: 'COMPLETED' }))
  const orders = Array.isArray(data) ? data : []
  const create = useResourceMutation((id) => customerInvoicesAPI.createFromSalesOrder(id), { invalidates: [['customer-invoices'], ['sales-orders']], silent: true })
  const [failure, setFailure] = useState(null)

  const submit = async () => {
    setTouched(true)
    if (!selected) return
    setFailure(null)
    try {
      const inv = await create.mutateAsync(selected)
      notify.success(inv?.invoice_number ? `Invoice ${inv.invoice_number} generated` : 'Invoice generated')
      onClose()
    } catch (e) {
      setFailure(e?.response?.data?.error || e.message)
    }
  }

  return (
    <Dialog
      open
      onClose={create.isPending ? undefined : onClose}
      title="Generate invoice from a sales order"
      description="The invoice copies the order's lines, prices and tax, and posts revenue to the ledger."
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!orders.length}>Generate invoice</Button>
        </>
      }
    >
      {loading ? <SkeletonRows rows={2} columns={2} /> : error ? (
        <ErrorState compact error={error} what="Completed sales orders" onRetry={refetch} />
      ) : orders.length === 0 ? (
        <EmptyState compact title="No completed sales orders" description="An order can be invoiced once it is delivered and marked complete in Sales." />
      ) : (
        <div className="space-y-3">
          {failure && <InlineNotice tone="risk" title="The invoice was not generated">{failure}</InlineNotice>}
          <Field label="Completed sales order" required error={touched && !selected ? 'Choose the order to invoice.' : null}>
            <Select value={selected} onChange={(e) => setSelected(e.target.value)} onBlur={() => setTouched(true)}>
              <option value="">Choose an order…</option>
              {orders.map((so) => (
                <option key={so.id} value={so.id}>
                  {so.so_number} · {so.customer_name || 'Customer'} · {formatMoney(so.total_amount, so.currency || 'USD')}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </Dialog>
  )
}
