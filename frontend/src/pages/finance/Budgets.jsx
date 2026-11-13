import { useMemo, useState } from 'react'
import { PlusIcon, ChartPieIcon } from '@heroicons/react/20/solid'
import api, { budgetsAPI } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, DataTable, Dialog, Field, Input, Select, Combobox, InlineNotice, EmptyState, Money, Code,
  Provenance, formatMoney, notify,
} from '../../components/ui'
import { StatementFigures } from './StatementParts'

/**
 * Budgets — annual budgets by account (and optionally cost center), read
 * against posted actuals. Variance is budget minus actual: positive is room
 * left, negative is overspend.
 */
const list = (d) => (Array.isArray(d) ? d : [])

function Utilization({ pct }) {
  if (pct == null) return <span className="text-ink-400">—</span>
  const n = Number(pct)
  const over = n > 100
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-100" aria-hidden="true">
        <span className={over ? 'block h-full bg-risk-500' : 'block h-full bg-ink-700'} style={{ width: `${Math.min(Math.abs(n), 100)}%` }} />
      </span>
      <span className={over ? 'w-12 text-right font-medium tabular-nums text-risk-600' : 'w-12 text-right tabular-nums text-ink-700'}>{n}%</span>
    </span>
  )
}

export default function Budgets() {
  const { user } = useAuth()
  // Creating budgets and lines is manager/admin only on the server.
  const canManage = ['ADMIN', 'MANAGER'].includes(user?.role)
  const [picked, setPicked] = useState(null)
  const [dialog, setDialog] = useState(null) // 'budget' | 'line'

  const { data: budgetsData, loading: budgetsLoading, error: budgetsError, refetch: refetchBudgets } = useResource(keys.budgets(), ({ signal }) => api.get('/budgets', { signal }))
  const budgets = list(budgetsData)
  const selected = picked ?? budgets[0]?.id ?? null
  const budget = budgets.find((b) => String(b.id) === String(selected))

  const { data: report, loading: reportLoading, error: reportError, refetch: refetchReport } = useResource(
    ['budgets', selected, 'vs-actual'],
    ({ signal }) => api.get(`/budgets/${selected}/vs-actual`, { signal }),
    { enabled: Boolean(selected), staleTime: 0 }
  )
  const lines = list(report?.lines)
  const totals = report?.totals

  const columns = useMemo(() => [
    {
      id: 'account', header: 'Account', accessor: (l) => `${l.account_code} ${l.account_name}`, minWidth: 220, mobile: 'title',
      cell: (l) => <span className="flex min-w-0 items-baseline gap-2"><Code className="text-ink-500">{l.account_code}</Code><span className="truncate">{l.account_name}</span></span>,
    },
    { id: 'center', header: 'Cost center', accessor: 'cost_center_name', filter: 'select', cell: (l) => l.cost_center_name || <span className="text-ink-400">All</span>, width: 170, mobile: 'subtitle' },
    { id: 'budgeted', header: 'Budgeted', accessor: (l) => Number(l.budgeted), align: 'right', width: 140, cell: (l) => <Money amount={l.budgeted} />, exportValue: (l) => l.budgeted, footer: (rows) => <Money amount={rows.reduce((s, r) => s + (Number(r.budgeted) || 0), 0)} /> },
    { id: 'actual', header: 'Actual', accessor: (l) => Number(l.actual), align: 'right', width: 140, cell: (l) => <Money amount={l.actual} />, exportValue: (l) => l.actual, footer: (rows) => <Money amount={rows.reduce((s, r) => s + (Number(r.actual) || 0), 0)} /> },
    { id: 'variance', header: 'Variance', accessor: (l) => Number(l.variance), align: 'right', filter: 'number', width: 140, mobile: 'trailing', cell: (l) => <Money amount={l.variance} signed />, exportValue: (l) => l.variance, footer: (rows) => <Money amount={rows.reduce((s, r) => s + (Number(r.variance) || 0), 0)} signed /> },
    { id: 'used', header: 'Used', accessor: (l) => (l.utilization_pct == null ? null : Number(l.utilization_pct)), align: 'right', width: 150, cell: (l) => <Utilization pct={l.utilization_pct} /> },
  ], [])

  const newBudget = <Button variant={budgets.length ? 'secondary' : 'primary'} icon={PlusIcon} onClick={() => setDialog('budget')} disabled={!canManage} title={canManage ? undefined : 'Creating a budget needs a Manager or Admin role'}>New budget</Button>
  const addLine = <Button variant="primary" icon={PlusIcon} onClick={() => setDialog('line')} disabled={!canManage || !selected} title={!canManage ? 'Adding budget lines needs a Manager or Admin role' : undefined}>Add line</Button>

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Budgets"
        description="Annual budgets by account, read against posted actuals."
        secondary={budgets.length ? newBudget : null}
        primary={budgets.length ? addLine : newBudget}
      />

      {budgetsError ? (
        <ErrorStateInline error={budgetsError} onRetry={refetchBudgets} />
      ) : !budgetsLoading && !budgets.length ? (
        <div className="rounded-lg border border-ink-200 bg-surface">
          <EmptyState icon={ChartPieIcon} title="No budgets yet" description="A budget sets an annual amount for each account. Create one for the fiscal year, then add a line per account." action={newBudget} />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Budget" className="w-72 max-w-full">
              <Select value={selected || ''} onChange={(e) => setPicked(e.target.value)} disabled={budgetsLoading}>
                {budgets.map((b) => <option key={b.id} value={b.id}>{b.name} (FY{b.fiscal_year})</option>)}
              </Select>
            </Field>
          </div>

          {totals && (
            <StatementFigures
              items={[
                { label: 'Budgeted', value: <Money amount={totals.budgeted} />, hint: budget ? `FY${budget.fiscal_year}` : null },
                { label: 'Actual', value: <Money amount={totals.actual} />, hint: 'Posted to these accounts' },
                {
                  label: 'Variance',
                  value: <Provenance method="Budgeted minus actual across every line. Positive is room left; negative is overspend." sources={[{ label: 'Budgeted', value: formatMoney(totals.budgeted) }, { label: 'Actual', value: formatMoney(totals.actual) }]}><Money amount={totals.variance} signed /></Provenance>,
                  hint: Number(totals.variance) >= 0 ? 'Within budget' : 'Over budget',
                },
              ]}
            />
          )}

          <DataTable
            viewKey="finance.budget-lines"
            caption={budget ? `${budget.name} — budget against actual` : 'Budget lines'}
            noun="line"
            rowKey={(l, i) => `${l.account_code}-${l.cost_center_name || 'all'}-${i}`}
            rows={lines}
            columns={columns}
            loading={budgetsLoading || reportLoading}
            error={reportError}
            onRetry={refetchReport}
            search={lines.length > 8}
            empty={{
              icon: ChartPieIcon,
              title: 'No lines in this budget',
              description: 'Add a line for each account you want to budget, with its annual amount.',
              action: addLine,
            }}
          />
        </div>
      )}

      {dialog === 'budget' && <CreateBudget onClose={() => setDialog(null)} onCreated={(b) => b?.id && setPicked(b.id)} />}
      {dialog === 'line' && selected && <AddLine budgetId={selected} onClose={() => setDialog(null)} />}
    </div>
  )
}

function ErrorStateInline({ error, onRetry }) {
  return <InlineNotice tone="risk" title="Budgets did not load" action={<Button size="sm" onClick={onRetry}>Try again</Button>}>{error?.response?.data?.error || error?.message}</InlineNotice>
}

function CreateBudget({ onClose, onCreated }) {
  const thisYear = new Date().getFullYear()
  const [form, setForm] = useState({ name: '', fiscal_year: String(thisYear) })
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)
  const create = useResourceMutation((payload) => budgetsAPI.create(payload), { invalidates: [['budgets']], silent: true })
  const errors = {
    name: !form.name.trim() ? 'Name the budget, e.g. Operating budget 2026.' : null,
    fiscal_year: !/^\d{4}$/.test(String(form.fiscal_year)) ? 'Enter a four-digit year.' : null,
  }
  const show = (k) => ((submitted || touched[k]) ? errors[k] : null)

  const submit = async (e) => {
    e?.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (errors.name || errors.fiscal_year) return
    try {
      const created = await create.mutateAsync({ name: form.name, fiscal_year: Number(form.fiscal_year) })
      notify.success(`Budget ${form.name} created`)
      onCreated?.(created)
      onClose()
    } catch (err) {
      setServerError(err?.response?.data?.error || err.message)
    }
  }

  return (
    <Dialog open onClose={onClose} title="New budget" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} loading={create.isPending}>Create budget</Button></>}>
      <form onSubmit={submit} noValidate className="space-y-4">
        {serverError && <InlineNotice tone="risk" title="Not created">{serverError}</InlineNotice>}
        <Field label="Name" required error={show('name')}>
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} onBlur={() => setTouched((t) => ({ ...t, name: true }))} placeholder="Operating budget 2026" data-autofocus />
        </Field>
        <Field label="Fiscal year" required error={show('fiscal_year')}>
          <Input type="number" numeric value={form.fiscal_year} onChange={(e) => setForm((f) => ({ ...f, fiscal_year: e.target.value }))} onBlur={() => setTouched((t) => ({ ...t, fiscal_year: true }))} className="w-32" />
        </Field>
      </form>
    </Dialog>
  )
}

function AddLine({ budgetId, onClose }) {
  const [form, setForm] = useState({ account_id: '', annual_amount: '', cost_center_id: '' })
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)
  const { data: accountsData } = useResource(keys.chartOfAccounts({}), ({ signal }) => api.get('/chart-of-accounts', { signal }))
  const { data: centersData } = useResource(['cost-centers'], ({ signal }) => api.get('/cost-centers', { signal }))
  const accountOptions = useMemo(() => list(accountsData).filter((a) => !a.is_header).map((a) => ({ value: a.id, label: `${a.account_code} · ${a.account_name}` })), [accountsData])
  const centers = list(centersData)
  const add = useResourceMutation((payload) => budgetsAPI.addLine(budgetId, payload), { invalidates: [['budgets']], silent: true })

  const errors = {
    account_id: !form.account_id ? 'Choose the account to budget.' : null,
    annual_amount: !form.annual_amount || !(Number(form.annual_amount) > 0) ? 'Enter the annual amount, more than zero.' : null,
  }
  const show = (k) => ((submitted || touched[k]) ? errors[k] : null)

  const submit = async (e) => {
    e?.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (errors.account_id || errors.annual_amount) return
    try {
      await add.mutateAsync({ account_id: form.account_id, annual_amount: Number(form.annual_amount), cost_center_id: form.cost_center_id || undefined })
      notify.success('Budget line added')
      onClose()
    } catch (err) {
      setServerError(err?.response?.data?.error || err.message)
    }
  }

  return (
    <Dialog open onClose={onClose} title="Add budget line" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} loading={add.isPending}>Add line</Button></>}>
      <form onSubmit={submit} noValidate className="space-y-4">
        {serverError && <InlineNotice tone="risk" title="Not added">{serverError}</InlineNotice>}
        <Field label="Account" required error={show('account_id')} help="Detail accounts only; header accounts cannot be budgeted.">
          <Combobox options={accountOptions} value={form.account_id} onChange={(v) => { setForm((f) => ({ ...f, account_id: v || '' })); setTouched((t) => ({ ...t, account_id: true })) }} placeholder="Search code or name" />
        </Field>
        <Field label="Cost center" optional help="Leave as All to budget the whole account.">
          <Select value={form.cost_center_id} onChange={(e) => setForm((f) => ({ ...f, cost_center_id: e.target.value }))}>
            <option value="">All (account level)</option>
            {centers.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
          </Select>
        </Field>
        <Field label="Annual amount" required error={show('annual_amount')}>
          <Input type="number" step="0.01" numeric value={form.annual_amount} onChange={(e) => setForm((f) => ({ ...f, annual_amount: e.target.value }))} onBlur={() => setTouched((t) => ({ ...t, annual_amount: true }))} className="w-48" />
        </Field>
      </form>
    </Dialog>
  )
}
