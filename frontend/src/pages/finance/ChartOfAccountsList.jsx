import { useMemo, useState } from 'react'
import { PlusIcon, EyeIcon, TrashIcon, CheckCircleIcon, XCircleIcon, PowerIcon, BookOpenIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Badge, Money, Code, Segmented, Select, ConfirmDialog, Sheet,
  DescriptionList, Stat, Num, notify, exportCsv, formatMoney,
} from '../../components/ui'

/**
 * Chart of accounts — the ledger's structure. Accounts are proposed, approved,
 * activated; only active accounts take postings and appear on statements.
 */
const TYPES = [['ASSET', 'Asset'], ['LIABILITY', 'Liability'], ['EQUITY', 'Equity'], ['REVENUE', 'Revenue'], ['EXPENSE', 'Expense']]
const STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'INACTIVE', 'CLOSED', 'REJECTED']
// Every account mutation here can change an account's balance/status, which
// the financial reports derive from.
const COA_INVALIDATES = [['chart-of-accounts'], ['trial-balance'], ['balance-sheet'], ['income-statement']]

const QUICK = {
  all: { label: 'All', test: () => true },
  pending: { label: 'Pending approval', test: (a) => a.status === 'PENDING_APPROVAL' },
  approved: { label: 'Approved', test: (a) => a.status === 'APPROVED' },
  active: { label: 'Active', test: (a) => a.status === 'ACTIVE' },
  inactive: { label: 'Inactive', test: (a) => a.status === 'INACTIVE' || a.status === 'CLOSED' },
}
const humanize = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

export default function ChartOfAccountsList() {
  const [quick, setQuick] = useState('all')
  const [type, setType] = useState('')
  const [confirm, setConfirm] = useState(null) // { kind, account }
  const [viewing, setViewing] = useState(null)

  // The server filters by type; status, search and the rest happen in the table
  // so saved views and column filters work across the whole chart.
  const params = type ? { account_type: type } : {}
  const { data, loading, error, refetch } = useResource(
    keys.chartOfAccounts(params),
    ({ signal }) => api.get('/chart-of-accounts', { params, signal })
  )
  const accounts = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const { data: stats, loading: statsLoading } = useResource(keys.chartOfAccountsStats(), ({ signal }) => api.get('/chart-of-accounts/stats', { signal }))

  const statusUpdate = useResourceMutation(
    ({ accountId, newStatus, reason }) => api.put(`/chart-of-accounts/${accountId}/status`, { status: newStatus, reason }),
    { invalidates: COA_INVALIDATES, silent: true }
  )
  const deleteAccount = useResourceMutation((id) => api.delete(`/chart-of-accounts/${id}`), { invalidates: COA_INVALIDATES, silent: true })

  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, accounts.filter(q.test).length])), [accounts])

  const columns = useMemo(() => [
    { id: 'code', header: 'Code', accessor: 'account_code', cell: (a) => <Code>{a.account_code}</Code>, width: 100, mobile: 'title' },
    {
      id: 'name', header: 'Account', accessor: 'account_name', filter: 'text', minWidth: 220, mobile: 'subtitle',
      cell: (a) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{a.account_name}</span>
          {a.is_header && <Badge mono>Header</Badge>}
        </span>
      ),
    },
    { id: 'type', header: 'Type', accessor: 'account_type', filter: 'select', cell: (a) => humanize(a.account_type), width: 110 },
    { id: 'subtype', header: 'Subtype', accessor: 'account_subtype', filter: 'select', cell: (a) => (a.account_subtype ? humanize(a.account_subtype) : <span className="text-ink-400">—</span>), width: 170, defaultHidden: true },
    { id: 'normal', header: 'Normal', accessor: 'normal_balance', cell: (a) => humanize(a.normal_balance), width: 90 },
    { id: 'parent', header: 'Parent', accessor: (a) => a.parent_account_code, cell: (a) => (a.parent_account_code ? <span className="text-ink-600"><Code>{a.parent_account_code}</Code> {a.parent_account_name}</span> : <span className="text-ink-400">—</span>), width: 200, defaultHidden: true },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', cell: (a) => <StatusBadge status={a.status} />, width: 160, mobile: 'meta' },
    { id: 'opening', header: 'Opening', accessor: (a) => Number(a.beginning_balance), align: 'right', width: 130, defaultHidden: true, cell: (a) => <Money amount={a.beginning_balance} currency={a.currency || 'USD'} />, exportValue: (a) => a.beginning_balance },
    { id: 'balance', header: 'Balance', accessor: (a) => Number(a.current_balance), align: 'right', filter: 'number', width: 140, mobile: 'trailing', cell: (a) => <Money amount={a.current_balance} currency={a.currency || 'USD'} />, exportValue: (a) => a.current_balance },
  ], [])

  const run = async (reason) => {
    const { kind, account } = confirm
    try {
      if (kind === 'delete') {
        await deleteAccount.mutateAsync(account.id)
        notify.success(`Account ${account.account_code} deleted`)
      } else {
        const newStatus = { approve: 'APPROVED', reject: 'REJECTED', activate: 'ACTIVE', deactivate: 'INACTIVE' }[kind]
        await statusUpdate.mutateAsync({ accountId: account.id, newStatus, reason: reason || '' })
        notify.success(`Account ${account.account_code} is now ${humanize(newStatus).toLowerCase()}`)
      }
      setConfirm(null)
    } catch (e) {
      setConfirm(null)
      notify.error(`${account.account_code} not changed — ${e?.response?.data?.error || e.message}`)
    }
  }

  const copy = confirm && (() => {
    const { kind, account: a } = confirm
    const what = `${a.account_code} ${a.account_name}`
    return {
      approve: { title: `Approve ${what}?`, consequence: 'The account can then be activated for postings.', reversible: true, label: 'Approve', tone: 'primary' },
      reject: { title: `Reject ${what}?`, consequence: 'The proposed account will not be used. You can delete it afterwards.', reversible: false, label: 'Reject', tone: 'danger', requireReason: true },
      activate: { title: `Activate ${what}?`, consequence: 'Journal entries can post to it, and it appears on the statements.', reversible: true, label: 'Activate', tone: 'primary' },
      deactivate: { title: `Deactivate ${what}?`, consequence: 'No new postings are accepted, and it drops off the statements. Its history is kept.', reversible: true, label: 'Deactivate', tone: 'danger' },
      delete: { title: `Delete ${what}?`, consequence: 'The account is removed from the chart. It has not been used for postings.', reversible: false, label: 'Delete account', tone: 'danger', confirmText: a.account_code },
    }[kind]
  })()

  return (
    <>
      <PageHeader
        title="Chart of accounts"
        description="The general ledger's account structure. Only active accounts take postings and appear on statements."
        secondary={<Button icon={ArrowDownTrayIcon} onClick={() => exportCsv(accounts.filter(QUICK[quick].test), columns, 'chart-of-accounts.csv')} disabled={!accounts.length}>Export</Button>}
        primary={<Button variant="primary" icon={PlusIcon} to="/finance/chart-of-accounts/create">New account</Button>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Accounts" value={<Num value={stats?.total_accounts} />} loading={statsLoading} />
        <Stat label="Active" value={<Num value={stats?.active_accounts} />} loading={statsLoading} onClick={() => setQuick('active')} />
        <Stat label="Pending approval" value={<Num value={stats?.pending_approval} />} loading={statsLoading} onClick={() => setQuick('pending')} />
        <Stat label="Total assets" value={<Money amount={stats?.total_assets} />} loading={statsLoading} to="/finance/reports/balance-sheet" />
      </div>

      <DataTable
        viewKey="finance.chart-of-accounts"
        caption="Chart of accounts"
        noun="account"
        rows={accounts}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        onRowClick={(a) => setViewing(a)}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'code', dir: 'asc' }}
        searchPlaceholder="Search code or name"
        toolbarStart={
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <Segmented
              label="Show"
              value={quick}
              onChange={setQuick}
              options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
              className="max-w-full overflow-x-auto"
            />
            <div className="w-36 shrink-0">
              <Select size="sm" aria-label="Account type" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">All types</option>
                {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </div>
          </div>
        }
        rowActions={(a) => (
          <>
            <RowAction icon={EyeIcon} label={`View ${a.account_code}`} onClick={() => setViewing(a)} />
            {a.status === 'PENDING_APPROVAL' && <RowAction icon={CheckCircleIcon} label={`Approve ${a.account_code}`} onClick={() => setConfirm({ kind: 'approve', account: a })} />}
            {a.status === 'PENDING_APPROVAL' && <RowAction icon={XCircleIcon} tone="risk" label={`Reject ${a.account_code}`} onClick={() => setConfirm({ kind: 'reject', account: a })} />}
            {(a.status === 'APPROVED' || a.status === 'INACTIVE') && <RowAction icon={PowerIcon} label={`${a.status === 'INACTIVE' ? 'Reactivate' : 'Activate'} ${a.account_code}`} onClick={() => setConfirm({ kind: 'activate', account: a })} />}
            {a.status === 'ACTIVE' && <RowAction icon={PowerIcon} label={`Deactivate ${a.account_code}`} onClick={() => setConfirm({ kind: 'deactivate', account: a })} />}
            {['DRAFT', 'PENDING_APPROVAL', 'REJECTED'].includes(a.status) && <RowAction icon={TrashIcon} tone="risk" label={`Delete ${a.account_code}`} onClick={() => setConfirm({ kind: 'delete', account: a })} />}
          </>
        )}
        empty={{
          icon: BookOpenIcon,
          title: 'No accounts yet',
          description: 'The chart of accounts is the list every journal line posts to. Add your first account, starting with cash and receivables.',
          action: <Button variant="primary" icon={PlusIcon} to="/finance/chart-of-accounts/create">New account</Button>,
        }}
      />

      <Sheet
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        title={viewing ? `${viewing.account_code} · ${viewing.account_name}` : ''}
        description={viewing ? `${humanize(viewing.account_type)} account` : ''}
      >
        {viewing && (
          <div className="space-y-4 p-4">
            <StatusBadge status={viewing.status} />
            <DescriptionList
              items={[
                { label: 'Current balance', value: <Money amount={viewing.current_balance} currency={viewing.currency || 'USD'} /> },
                { label: 'Opening balance', value: <Money amount={viewing.beginning_balance} currency={viewing.currency || 'USD'} /> },
                { label: 'Type', value: humanize(viewing.account_type) },
                { label: 'Subtype', value: viewing.account_subtype ? humanize(viewing.account_subtype) : null },
                { label: 'Normal balance', value: humanize(viewing.normal_balance) },
                { label: 'Level', value: viewing.account_level },
                { label: 'Parent', value: viewing.parent_account_code ? `${viewing.parent_account_code} · ${viewing.parent_account_name || ''}` : null },
                { label: 'Header account', value: viewing.is_header ? 'Yes — groups other accounts' : 'No' },
                { label: 'Manual posting', value: viewing.allow_manual_posting ? 'Allowed' : 'Not allowed' },
                { label: 'Balance sheet section', value: viewing.balance_sheet_section ? humanize(viewing.balance_sheet_section) : null },
                { label: 'Currency', value: viewing.currency },
                { label: 'Description', value: viewing.description, wide: true },
              ]}
            />
            <p className="text-xs text-ink-500">
              Editing an account is not available on this screen yet. Balance {formatMoney(viewing.current_balance)} is the account's running balance; the trial balance shows the postings behind it.
            </p>
            <Button to="/finance/reports/trial-balance">Open trial balance</Button>
          </div>
        )}
      </Sheet>

      {copy && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={run}
          title={copy.title}
          consequence={copy.consequence}
          reversible={copy.reversible}
          confirmLabel={copy.label}
          tone={copy.tone}
          requireReason={copy.requireReason}
          reasonHelp="Recorded on the account's history."
          confirmText={copy.confirmText}
          busy={statusUpdate.isPending || deleteAccount.isPending}
        />
      )}
    </>
  )
}
