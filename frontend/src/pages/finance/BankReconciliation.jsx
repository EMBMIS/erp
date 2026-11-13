import { useMemo, useState } from 'react'
import { PlusIcon, BuildingLibraryIcon, CheckCircleIcon, ArrowUturnLeftIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import { bankAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useI18n } from '../../contexts/I18nContext'
import {
  PageHeader, Button, DataTable, BulkAction, RowAction, Money, Code, DateText, Badge, Segmented, Select, Card,
  Dialog, Field, Input, ErrorSummary, InlineNotice, EmptyState, ErrorState, SkeletonRows, Stat, exportCsv, notify,
} from '../../components/ui'

/**
 * Bank reconciliation — match each bank statement line against the books.
 * The difference between the book balance (GL) and the cleared balance is
 * what is left to explain; at zero the account is reconciled.
 */
const QUICK = {
  all: { label: 'All', test: () => true },
  open: { label: 'Unreconciled', test: (t) => !t.is_reconciled },
  done: { label: 'Reconciled', test: (t) => Boolean(t.is_reconciled) },
}

export default function BankReconciliation() {
  const { t } = useI18n()
  const [picked, setPicked] = useState(null)
  const [quick, setQuick] = useState('open')
  const [acctOpen, setAcctOpen] = useState(false)
  const [txnOpen, setTxnOpen] = useState(false)

  const { data: accountsData, loading: accountsLoading, error: accountsError, refetch: refetchAccounts } = useResource(keys.bankAccounts(), () => bankAPI.listAccounts())
  const accounts = useMemo(() => (Array.isArray(accountsData) ? accountsData : []), [accountsData])
  const selected = picked && accounts.some((a) => String(a.id) === String(picked)) ? picked : accounts[0]?.id
  const account = accounts.find((a) => String(a.id) === String(selected))

  const { data: summary, loading: summaryLoading } = useResource(['bank-accounts', selected, 'summary'], () => bankAPI.getSummary(selected), { enabled: Boolean(selected) })
  const { data: txnData, loading: txnLoading, error: txnError, refetch: refetchTxns } = useResource(['bank-accounts', selected, 'transactions'], () => bankAPI.listTransactions(selected), { enabled: Boolean(selected) })
  const txns = useMemo(() => (Array.isArray(txnData) ? txnData : []), [txnData])
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, txns.filter(q.test).length])), [txns])

  const reconcile = useResourceMutation(({ id, reconciled }) => bankAPI.reconcile(id, { reconciled }), { invalidates: [['bank-accounts']], silent: true })
  const toggle = async (txn, reconciled = !txn.is_reconciled) => {
    try {
      await reconcile.mutateAsync({ id: txn.id, reconciled })
    } catch (e) {
      notify.error(`Not updated: ${e?.response?.data?.error || e.message}`)
    }
  }
  const bulk = async (rows, reconciled) => {
    for (const r of rows) await toggle(r, reconciled)
  }

  const difference = summary ? Number(summary.difference || 0) : null
  const reconciled = difference != null && Math.abs(difference) < 0.01
  const currency = account?.currency || 'USD'

  const columns = useMemo(() => [
    { id: 'date', header: 'Date', accessor: 'transaction_date', width: 120, mobile: 'meta', cell: (r) => <DateText value={r.transaction_date} /> },
    { id: 'description', header: 'Description', accessor: 'description', minWidth: 220, maxWidth: 380, mobile: 'title', cell: (r) => <span className="block truncate">{r.description || '—'}</span> },
    { id: 'reference', header: 'Reference', accessor: 'reference', width: 160, mobile: 'subtitle', cell: (r) => (r.reference ? <Code className="text-ink-600">{r.reference}</Code> : <span className="text-ink-400">—</span>) },
    {
      id: 'amount', header: 'Amount', accessor: (r) => Number(r.amount), align: 'right', filter: 'number', width: 150, mobile: 'trailing',
      cell: (r) => <Money amount={r.amount} currency={currency} signed />, exportValue: (r) => r.amount,
      footer: (rows) => <Money amount={rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)} currency={currency} signed />,
    },
    {
      id: 'reconciled', header: 'Reconciled', accessor: (r) => (r.is_reconciled ? 'Reconciled' : 'Open'), filter: 'select', width: 130,
      cell: (r) => (
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 rounded border-ink-300 accent-brand-600" checked={Boolean(r.is_reconciled)} onChange={() => toggle(r)} aria-label={`${r.is_reconciled ? 'Unmark' : 'Mark'} ${r.description || 'this line'} as reconciled`} />
          {r.is_reconciled ? <span className="text-ink-700">Yes</span> : <span className="text-ink-500">No</span>}
        </label>
      ),
    },
  ], [currency, toggle])

  return (
    <>
      <PageHeader
        title={t('ui.bankReconciliation')}
        description="Match bank statement lines against the books until the difference is zero."
        status={summary ? (reconciled ? <Badge tone="ok" glyph="check">Reconciled</Badge> : <Badge tone="warn" glyph="triangle">Not reconciled</Badge>) : null}
        secondary={
          <>
            {accounts.length > 1 && (
              <Select aria-label="Bank account" value={selected || ''} onChange={(e) => setPicked(e.target.value)} className="w-56">
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_name}{a.bank_name ? ` · ${a.bank_name}` : ''}</option>)}
              </Select>
            )}
            <Button icon={PlusIcon} onClick={() => setAcctOpen(true)}>{t('ui.addBankAccount')}</Button>
          </>
        }
        primary={selected ? <Button variant="primary" icon={PlusIcon} onClick={() => setTxnOpen(true)}>{t('ui.addStatementLine')}</Button> : undefined}
      />

      {accountsLoading ? <SkeletonRows rows={4} /> : accountsError ? (
        <ErrorState error={accountsError} what="Bank accounts" onRetry={refetchAccounts} />
      ) : !accounts.length ? (
        <Card>
          <EmptyState
            icon={BuildingLibraryIcon}
            title="No bank accounts yet"
            description="Add the bank account you want to reconcile, with its opening balance. Then add statement lines and tick them off against the books."
            action={<Button variant="primary" icon={PlusIcon} onClick={() => setAcctOpen(true)}>{t('ui.addBankAccount')}</Button>}
          />
        </Card>
      ) : (
        <>
          {account && accounts.length === 1 && (
            <p className="-mt-3 mb-4 text-sm text-ink-600">{account.account_name}{account.bank_name ? ` · ${account.bank_name}` : ''}{account.account_number && <Code className="ml-2 text-ink-500">{account.account_number}</Code>}</p>
          )}

          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Book balance (GL)" value={<Money amount={summary?.book_balance} currency={currency} />} loading={summaryLoading} />
            <Stat label="Cleared balance" value={<Money amount={summary?.cleared_balance} currency={currency} />} loading={summaryLoading} />
            <Stat
              label="Unreconciled"
              value={<Money amount={summary?.unreconciled_amount} currency={currency} />}
              loading={summaryLoading}
              onClick={() => setQuick('open')}
              footnote={summary ? `${summary.unreconciled_count ?? '—'} line${Number(summary.unreconciled_count) === 1 ? '' : 's'}` : undefined}
            />
            <Stat
              label="Difference"
              value={<Money amount={difference} currency={currency} signed />}
              loading={summaryLoading}
              delta={summary ? (reconciled ? <Badge tone="ok" glyph="check">Agrees</Badge> : <Badge tone="warn" glyph="triangle">To explain</Badge>) : null}
              footnote="Book balance less cleared balance"
            />
          </div>

          <DataTable
            viewKey="finance.bank-transactions"
            caption="Statement lines"
            noun="statement line"
            rows={txns}
            columns={columns}
            loading={txnLoading}
            error={txnError}
            onRetry={refetchTxns}
            externalFilter={QUICK[quick].test}
            defaultSort={{ id: 'date', dir: 'desc' }}
            searchPlaceholder="Search description, reference"
            toolbarStart={<Segmented label="Show" value={quick} onChange={setQuick} options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))} />}
            selectable
            bulkActions={(sel, clear) => {
              const open = sel.filter((r) => !r.is_reconciled)
              const done = sel.filter((r) => r.is_reconciled)
              return (
                <>
                  {open.length > 0 && <BulkAction tone="primary" icon={CheckCircleIcon} onClick={async () => { await bulk(open, true); clear() }}>Mark {open.length} reconciled</BulkAction>}
                  {done.length > 0 && <BulkAction icon={ArrowUturnLeftIcon} onClick={async () => { await bulk(done, false); clear() }}>Unmark {done.length}</BulkAction>}
                  <BulkAction icon={ArrowDownTrayIcon} onClick={() => exportCsv(sel, columns, 'bank-statement-lines.csv')}>Export</BulkAction>
                </>
              )
            }}
            rowActions={(r) => (r.is_reconciled
              ? <RowAction icon={ArrowUturnLeftIcon} label="Unmark as reconciled" onClick={() => toggle(r, false)} />
              : <RowAction icon={CheckCircleIcon} label="Mark as reconciled" onClick={() => toggle(r, true)} />)}
            empty={{
              icon: BuildingLibraryIcon,
              title: 'No statement lines yet',
              description: 'Add each line from the bank statement, then tick it once it matches an entry in the books.',
              action: <Button variant="primary" icon={PlusIcon} onClick={() => setTxnOpen(true)}>{t('ui.addStatementLine')}</Button>,
            }}
          />
        </>
      )}

      {acctOpen && <AddAccountDialog onClose={() => setAcctOpen(false)} onCreated={(a) => a?.id && setPicked(a.id)} />}
      {txnOpen && selected && <AddTxnDialog accountId={selected} currency={currency} onClose={() => setTxnOpen(false)} />}
    </>
  )
}

function AddAccountDialog({ onClose, onCreated }) {
  const [form, setForm] = useState({ account_name: '', bank_name: '', account_number: '', opening_balance: '0' })
  const [touched, setTouched] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [failure, setFailure] = useState(null)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const create = useResourceMutation((payload) => bankAPI.createAccount(payload), { invalidates: [['bank-accounts'], ['bank']], silent: true })
  const nameError = !form.account_name.trim() ? 'Give the account a name, e.g. Operating account.' : null

  const submit = async (e) => {
    e?.preventDefault()
    setSubmitted(true)
    if (nameError) return
    setFailure(null)
    try {
      const account = await create.mutateAsync({
        account_name: form.account_name,
        bank_name: form.bank_name || undefined,
        account_number: form.account_number || undefined,
        opening_balance: Number(form.opening_balance || 0),
      })
      onCreated?.(account)
      onClose()
    } catch (err) {
      setFailure(err?.response?.data?.error || err.message)
    }
  }

  return (
    <Dialog
      open
      onClose={create.isPending ? undefined : onClose}
      title="Add bank account"
      footer={<><Button onClick={onClose} disabled={create.isPending}>Cancel</Button><Button variant="primary" onClick={submit} loading={create.isPending}>Add account</Button></>}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {submitted && <ErrorSummary errors={{ 'bank-account-name': nameError }} />}
        {failure && <InlineNotice tone="risk" title="The account was not added">{failure}</InlineNotice>}
        <Field label="Account name" required error={touched || submitted ? nameError : null}>
          <Input id="bank-account-name" value={form.account_name} onChange={set('account_name')} onBlur={() => setTouched(true)} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Bank" optional><Input value={form.bank_name} onChange={set('bank_name')} /></Field>
          <Field label="Account number" optional><Input value={form.account_number} onChange={set('account_number')} /></Field>
        </div>
        <Field label="Opening balance" help="The statement balance on the day you start reconciling.">
          <Input type="number" step="0.01" numeric value={form.opening_balance} onChange={set('opening_balance')} />
        </Field>
      </form>
    </Dialog>
  )
}

function AddTxnDialog({ accountId, currency, onClose }) {
  const [form, setForm] = useState({ transaction_date: '', description: '', reference: '', direction: 'deposit', amount: '' })
  const [touched, setTouched] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [failure, setFailure] = useState(null)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const add = useResourceMutation((payload) => bankAPI.addTransaction(accountId, payload), { invalidates: [['bank-accounts']], silent: true })
  const amt = Number(form.amount)
  const amountError = !amt || amt <= 0 ? 'Enter an amount greater than zero. Choose money in or out above.' : null

  const submit = async (e) => {
    e?.preventDefault()
    setSubmitted(true)
    if (amountError) return
    setFailure(null)
    try {
      await add.mutateAsync({
        transaction_date: form.transaction_date || undefined,
        description: form.description || undefined,
        reference: form.reference || undefined,
        amount: form.direction === 'withdrawal' ? -amt : amt,
      })
      onClose()
    } catch (err) {
      setFailure(err?.response?.data?.error || err.message)
    }
  }

  return (
    <Dialog
      open
      onClose={add.isPending ? undefined : onClose}
      title="Add statement line"
      description="One line from the bank statement, as the bank shows it."
      footer={<><Button onClick={onClose} disabled={add.isPending}>Cancel</Button><Button variant="primary" onClick={submit} loading={add.isPending}>Add line</Button></>}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {submitted && <ErrorSummary errors={{ 'bank-txn-amount': amountError }} />}
        {failure && <InlineNotice tone="risk" title="The line was not added">{failure}</InlineNotice>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Date" optional><Input type="date" value={form.transaction_date} onChange={set('transaction_date')} /></Field>
          <Field label="Type" required>
            <Select value={form.direction} onChange={set('direction')}>
              <option value="deposit">Deposit (money in)</option>
              <option value="withdrawal">Withdrawal (money out)</option>
            </Select>
          </Field>
        </div>
        <Field label="Amount" required error={touched || submitted ? amountError : null}>
          <Input id="bank-txn-amount" type="number" step="0.01" min="0" numeric suffix={currency} value={form.amount} onChange={set('amount')} onBlur={() => setTouched(true)} />
        </Field>
        <Field label="Description" optional><Input value={form.description} onChange={set('description')} /></Field>
        <Field label="Reference" optional><Input value={form.reference} onChange={set('reference')} /></Field>
      </form>
    </Dialog>
  )
}
