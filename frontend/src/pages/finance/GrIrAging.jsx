import { useMemo, useState } from 'react'
import { ArrowDownTrayIcon, BookOpenIcon, CheckCircleIcon, ScaleIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useI18n } from '../../contexts/I18nContext'
import {
  PageHeader, Button, DataTable, RowAction, Badge, Money, Code, DateText, Stat, Segmented, ConfirmDialog, InlineNotice, exportCsv, notify, formatMoney,
} from '../../components/ui'
import { JournalLinesSheet } from './FinanceParts'

/**
 * GR/IR clearing workbench — goods received but not yet invoiced (or
 * invoiced but not received) still sitting on account 2115. Each line can be
 * cleared manually, which posts a journal entry.
 */
const BUCKETS = ['0-30', '31-60', '61-90', '90+']
const age = (d) => (d > 60 ? { tone: 'risk', glyph: 'triangle' } : d > 30 ? { tone: 'warn', glyph: 'triangle' } : { tone: 'ink', glyph: 'clock' })

const QUICK = {
  all: { label: 'All', test: () => true },
  over30: { label: 'Over 30 days', test: (r) => r.days_outstanding > 30 },
  over60: { label: 'Over 60 days', test: (r) => r.days_outstanding > 60 },
}

export default function GrIrAging() {
  const { t } = useI18n()
  const [quick, setQuick] = useState('all')
  const [clearFor, setClearFor] = useState(null)
  const [journalFor, setJournalFor] = useState(null)

  // staleTime: 0 — GR/IR balances move whenever a receipt, bill or clearing
  // entry posts. The endpoint answers flat (no `data` key), so the body is
  // re-wrapped before useResource unwraps it.
  const { data, loading, error, refetch } = useResource(
    keys.grIrAging(),
    async ({ signal }) => ({ data: { success: true, data: (await api.get('/financial-reports/gr-ir-aging', { signal })).data } }),
    { staleTime: 0 }
  )
  const items = useMemo(() => (Array.isArray(data?.items) ? data.items : []), [data])
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, items.filter(q.test).length])), [items])

  const clearBalance = useResourceMutation(
    (item) => api.post('/financial-reports/gr-ir-clear', {
      receiptId: item.receipt_id,
      poId: item.po_id,
      amount: item.balance,
      reason: `Manual GR/IR Clearing Workbench — PO ${item.po_number}`,
    }),
    {
      // Clearing GR/IR posts a journal entry, so every ledger-derived report
      // must be invalidated, not just this workbench's own resource.
      invalidates: [['gr-ir-aging'], ['trial-balance'], ['balance-sheet'], ['income-statement'], ['journal-entries']],
    }
  )

  const columns = useMemo(() => [
    { id: 'po', header: 'PO', accessor: 'po_number', cell: (r) => <Code>{r.po_number}</Code>, width: 150, mobile: 'title' },
    { id: 'supplier', header: 'Supplier', accessor: 'supplier', filter: 'text', minWidth: 180, maxWidth: 260, mobile: 'subtitle', cell: (r) => <span className="block truncate">{r.supplier}</span> },
    { id: 'description', header: 'Description', accessor: 'description', minWidth: 200, maxWidth: 360, cell: (r) => <span className="block truncate text-ink-600">{r.description || '—'}</span> },
    {
      id: 'days', header: 'Days', accessor: (r) => Number(r.days_outstanding) || 0, align: 'right', filter: 'number', width: 100, mobile: 'meta',
      cell: (r) => { const a = age(r.days_outstanding); return <Badge tone={a.tone} glyph={a.glyph}>{r.days_outstanding}d</Badge> },
    },
    { id: 'since', header: 'Since', accessor: 'first_date', width: 120, defaultHidden: true, cell: (r) => <DateText value={r.first_date} /> },
    {
      id: 'balance', header: 'Uncleared', accessor: (r) => Number(r.balance), align: 'right', filter: 'number', width: 140, mobile: 'trailing',
      cell: (r) => <Money amount={r.balance} className="font-medium" />, exportValue: (r) => r.balance,
      footer: (rows) => <Money amount={rows.reduce((s, r) => s + (Number(r.balance) || 0), 0)} />,
    },
  ], [])

  return (
    <>
      <PageHeader
        title={t('ui.grIrClearingWorkbench')}
        description="Goods received but not yet invoiced, still open on the GR/IR clearing account."
        meta={data?.account ? <span>Account <Code>{data.account}</Code></span> : undefined}
        secondary={<Button icon={ArrowDownTrayIcon} disabled={!items.length} onClick={() => exportCsv(items.filter(QUICK[quick].test), columns, 'gr-ir-aging.csv')}>Export</Button>}
      />

      {data?.note && <InlineNotice tone="warn" className="mb-4" title="GR/IR aging is not available">{data.note}</InlineNotice>}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Uncleared" value={<Money amount={data?.total_uncleared} digits={0} />} loading={loading} footnote={data ? `${items.length} receipt${items.length === 1 ? '' : 's'}` : undefined} />
        {BUCKETS.map((b) => (
          <Stat key={b} label={`${b} days`} value={<Money amount={data?.aging?.[b]} digits={0} />} loading={loading} />
        ))}
      </div>

      <DataTable
        viewKey="finance.gr-ir-aging"
        caption="GR/IR open balances"
        noun="receipt"
        rowKey={(r) => r.receipt_id || r.po_number}
        rows={items}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'days', dir: 'desc' }}
        searchPlaceholder="Search PO, supplier, description"
        toolbarStart={<Segmented label="Show" value={quick} onChange={setQuick} options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))} />}
        rowHref={(r) => (r.po_id ? `/procurement/purchase-orders/${r.po_id}` : undefined)}
        rowActions={(r) => (
          <>
            <RowAction icon={BookOpenIcon} label={`Show journal lines for ${r.po_number}`} disabled={!r.journal_entry_ids?.length} reason="No journal entry linked" onClick={() => setJournalFor(r)} />
            <RowAction icon={CheckCircleIcon} label={`Clear the GR/IR balance for ${r.po_number}`} onClick={() => setClearFor(r)} />
          </>
        )}
        empty={{
          icon: ScaleIcon,
          title: 'No uncleared GR/IR balances',
          description: 'Every goods receipt has been matched to its supplier bill. New receipts appear here until their bill is recorded.',
        }}
      />

      {clearFor && (
        <ConfirmDialog
          open
          tone="primary"
          onClose={() => setClearFor(null)}
          title={`Clear ${formatMoney(clearFor.balance)} for ${clearFor.po_number}?`}
          consequence="A journal entry is posted that moves this balance off the GR/IR clearing account. Reverse it with another journal entry if it was wrong."
          confirmLabel="Clear balance"
          busy={clearBalance.isPending}
          onConfirm={async () => {
            try {
              await clearBalance.mutateAsync(clearFor)
              notify.success(`Cleared ${formatMoney(clearFor.balance)} for ${clearFor.po_number}`)
              setClearFor(null)
            } catch { /* useResourceMutation surfaced the error */ }
          }}
        />
      )}

      <JournalLinesSheet
        open={Boolean(journalFor)}
        onClose={() => setJournalFor(null)}
        title={journalFor ? `Journal lines for ${journalFor.po_number}` : ''}
        description={journalFor?.supplier}
        journalEntryIds={journalFor?.journal_entry_ids || []}
      />
    </>
  )
}
