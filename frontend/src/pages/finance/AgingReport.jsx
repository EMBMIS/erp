import { useMemo, useState } from 'react'
import { ArrowDownTrayIcon, BookOpenIcon, ClockIcon } from '@heroicons/react/20/solid'
import { financialReportsAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { useI18n } from '../../contexts/I18nContext'
import {
  PageHeader, Button, DataTable, RowAction, Badge, Money, Code, DateText, Card, Segmented, InlineNotice, StatusBadge, exportCsv,
} from '../../components/ui'
import { AgingBar, JournalLinesSheet } from './FinanceParts'

/**
 * Aging — every open invoice (receivables) or bill (payables) by how far past
 * its due date it is, with the journal entry behind each one a click away.
 */

// The aging endpoints answer flat ({ success, summary, detail, note }) with
// no `data` key; re-wrap so useResource's unwrap hands over the whole body.
const wrap = (call) => async () => ({ data: { success: true, data: (await call()).data } })

const bucket = (d) => (d <= 0 ? null : d <= 30 ? { label: '1–30', tone: 'ink' } : d <= 60 ? { label: '31–60', tone: 'warn' } : d <= 90 ? { label: '61–90', tone: 'warn' } : { label: '90+', tone: 'risk' })

const QUICK = {
  all: { label: 'All', test: () => true },
  current: { label: 'Current', test: (r) => !(Number(r.days_overdue) > 0) },
  overdue: { label: 'Overdue', test: (r) => Number(r.days_overdue) > 0 },
  over60: { label: 'Over 60 days', test: (r) => Number(r.days_overdue) > 60 },
}

export default function AgingReport() {
  const { t } = useI18n()
  const [mode, setMode] = useState('ar') // 'ar' | 'ap'
  const [quick, setQuick] = useState('all')
  const [journalFor, setJournalFor] = useState(null)
  const isAR = mode === 'ar'

  const { data, loading, error, refetch } = useResource(
    ['financial-reports', isAR ? 'ar-aging' : 'ap-aging'],
    wrap(isAR ? financialReportsAPI.getArAging : financialReportsAPI.getApAging),
  )
  const summary = data?.summary
  const detail = useMemo(() => (Array.isArray(data?.detail) ? data.detail : []), [data])
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, detail.filter(q.test).length])), [detail])
  const number = (r) => r.invoice_number || r.bill_number

  const columns = useMemo(() => [
    { id: 'number', header: isAR ? 'Invoice' : 'Bill', accessor: number, cell: (r) => <Code>{number(r)}</Code>, width: 150, mobile: 'title' },
    { id: 'party', header: isAR ? 'Customer' : 'Supplier', accessor: (r) => r.customer_name || r.supplier_name, filter: 'text', minWidth: 180, maxWidth: 280, mobile: 'subtitle', cell: (r) => <span className="block truncate">{r.customer_name || r.supplier_name || '—'}</span> },
    { id: 'due', header: 'Due', accessor: 'due_date', width: 120, cell: (r) => <DateText value={r.due_date} /> },
    {
      id: 'days', header: 'Days overdue', accessor: (r) => Number(r.days_overdue) || 0, align: 'right', filter: 'number', width: 150, mobile: 'meta',
      cell: (r) => {
        const b = bucket(Number(r.days_overdue) || 0)
        return b ? <span className="inline-flex items-center gap-2"><span className="tabular-nums">{r.days_overdue}</span><Badge tone={b.tone} glyph={b.tone === 'ink' ? 'clock' : 'triangle'}>{b.label}</Badge></span> : <span className="text-ink-500">Current</span>
      },
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 150, cell: (r) => <StatusBadge status={r.status} /> },
    { id: 'total', header: 'Total', accessor: (r) => Number(r.total_amount), align: 'right', width: 130, defaultHidden: true, cell: (r) => <Money amount={r.total_amount} />, exportValue: (r) => r.total_amount },
    {
      id: 'outstanding', header: 'Outstanding', accessor: (r) => Number(r.outstanding_amount), align: 'right', filter: 'number', width: 140, mobile: 'trailing',
      cell: (r) => <Money amount={r.outstanding_amount} className="font-medium" />, exportValue: (r) => r.outstanding_amount,
      footer: (rows) => <Money amount={rows.reduce((s, r) => s + (Number(r.outstanding_amount) || 0), 0)} />,
    },
  ], [isAR])

  return (
    <>
      <PageHeader
        title={t('ui.agingReport')}
        description={isAR ? 'What customers owe you, by days past the due date.' : 'What you owe suppliers, by days past the due date.'}
        secondary={
          <>
            <Segmented label="Ledger" size="md" value={mode} onChange={(m) => { setMode(m); setQuick('all') }} options={[{ value: 'ar', label: 'Receivables' }, { value: 'ap', label: 'Payables' }]} />
            <Button icon={ArrowDownTrayIcon} disabled={!detail.length} onClick={() => exportCsv(detail.filter(QUICK[quick].test), columns, `${mode}-aging.csv`)}>Export</Button>
          </>
        }
      />

      {data?.note && <InlineNotice tone="warn" className="mb-4" title="Aging is not available">{data.note}</InlineNotice>}

      <Card
        className="mb-4"
        title={isAR ? 'Receivables by age' : 'Payables by age'}
        actions={<span className="text-sm text-ink-600">Total outstanding <Money amount={summary?.total_outstanding} className="ml-1 font-semibold text-fg" /></span>}
      >
        {loading ? <span className="skeleton block h-16" /> : (
          <AgingBar summary={summary} note={data?.note} empty={isAR ? 'Nothing is outstanding. Every customer invoice is paid.' : 'Nothing is outstanding. Every supplier bill is paid.'} />
        )}
      </Card>

      <DataTable
        viewKey={`finance.aging.${mode}`}
        caption={isAR ? 'Receivables aging' : 'Payables aging'}
        noun={isAR ? 'invoice' : 'bill'}
        rowKey={(r) => r.id || number(r)}
        rows={detail}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'days', dir: 'desc' }}
        searchPlaceholder={isAR ? 'Search invoice, customer' : 'Search bill, supplier'}
        toolbarStart={<Segmented label="Show" value={quick} onChange={setQuick} options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))} className="max-w-full overflow-x-auto" />}
        rowHref={(r) => (r.id ? `/finance/${isAR ? 'customer' : 'supplier'}-invoices?invoice=${r.id}` : undefined)}
        rowActions={(r) => <RowAction icon={BookOpenIcon} label={`Show journal lines for ${number(r)}`} onClick={() => setJournalFor(r)} />}
        empty={{
          icon: ClockIcon,
          title: 'Nothing outstanding',
          description: isAR ? 'Every approved customer invoice has been paid in full.' : 'Every approved supplier bill has been paid in full.',
        }}
      />

      <JournalLinesSheet
        open={Boolean(journalFor)}
        onClose={() => setJournalFor(null)}
        title={journalFor ? `Journal lines for ${number(journalFor)}` : ''}
        description={journalFor ? (journalFor.customer_name || journalFor.supplier_name) : undefined}
        journalEntryIds={journalFor ? [journalFor.journal_entry_id] : []}
      />
    </>
  )
}
