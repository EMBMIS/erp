import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import { useResource, useResourceMutation } from '../hooks/useResource'
import { keys } from '../services/queryKeys'
import {
  PageHeader, Button, Field, Input, Select, Checkbox, FormSection, ErrorSummary, InlineNotice, useDraft, notify,
} from '../components/ui'

/**
 * New ledger account. Account types, subtypes and balance-sheet sections mirror
 * the finance master data seeded in
 * database/migrations/202608120500_seed_gl_default_company.sql.
 */
const ACCOUNT_TYPES = [['ASSET', 'Asset'], ['LIABILITY', 'Liability'], ['EQUITY', 'Equity'], ['REVENUE', 'Revenue'], ['EXPENSE', 'Expense']]

const SUBTYPES_BY_TYPE = {
  ASSET: [['HEADER', 'Header'], ['CURRENT_ASSET', 'Current asset'], ['CASH', 'Cash'], ['ACCOUNTS_RECEIVABLE', 'Accounts receivable'], ['INVENTORY', 'Inventory'], ['PREPAID', 'Prepaid'], ['FIXED_ASSET', 'Fixed asset'], ['ACCUMULATED_DEPRECIATION', 'Accumulated depreciation'], ['OTHER_ASSET', 'Other asset']],
  LIABILITY: [['HEADER', 'Header'], ['ACCOUNTS_PAYABLE', 'Accounts payable'], ['ACCRUED_EXPENSES', 'Accrued expenses'], ['SHORT_TERM_DEBT', 'Short-term debt'], ['LONG_TERM_DEBT', 'Long-term debt'], ['TAX_PAYABLE', 'Tax payable'], ['OTHER_LIABILITY', 'Other liability']],
  EQUITY: [['HEADER', 'Header'], ['SHARE_CAPITAL', 'Share capital'], ['RETAINED_EARNINGS', 'Retained earnings'], ['DRAWINGS', 'Drawings'], ['OTHER_EQUITY', 'Other equity']],
  REVENUE: [['HEADER', 'Header'], ['SALES', 'Sales'], ['SALES_RETURNS', 'Sales returns'], ['OTHER_INCOME', 'Other income']],
  EXPENSE: [['HEADER', 'Header'], ['COST_OF_GOODS_SOLD', 'Cost of goods sold'], ['OPERATING_EXPENSES', 'Operating expenses'], ['OTHER_EXPENSES', 'Other expenses'], ['TAX_EXPENSE', 'Tax expense']],
}

const BALANCE_SHEET_SECTIONS = [
  ['ASSETS', 'Assets'], ['CURRENT_ASSETS', 'Current assets'], ['NON_CURRENT_ASSETS', 'Non-current assets'],
  ['LIABILITIES', 'Liabilities'], ['CURRENT_LIABILITIES', 'Current liabilities'], ['NON_CURRENT_LIABILITIES', 'Non-current liabilities'],
  ['EQUITY', 'Equity'],
]

// The side each account type conventionally carries — proposed, still editable.
const DEFAULT_NORMAL_BALANCE = { ASSET: 'DEBIT', LIABILITY: 'CREDIT', EQUITY: 'CREDIT', REVENUE: 'CREDIT', EXPENSE: 'DEBIT' }

const INITIAL = {
  account_code: '', account_name: '', account_type: '', account_subtype: '', account_level: 1, normal_balance: '',
  is_header: false, allow_manual_posting: true, balance_sheet_section: '', parent_account_id: '',
}

const RULES = {
  account_code: (v) => (!String(v || '').trim() ? 'Enter the account code, e.g. 1210.' : null),
  account_name: (v) => (!String(v || '').trim() ? 'Name the account as it should read on statements.' : null),
  account_type: (v) => (!v ? 'Choose what kind of account this is.' : null),
  normal_balance: (v) => (!v ? 'Choose the side this account normally carries.' : null),
  account_level: (v) => (v !== '' && v != null && (!Number.isInteger(Number(v)) || Number(v) < 1) ? 'Level is a whole number, 1 or more.' : null),
}

export default function ChartOfAccountsCreate() {
  const navigate = useNavigate()
  const { value: form, setValue, restored, savedAt, clear, discard } = useDraft('chart-of-accounts:new', INITIAL)
  const set = (patch) => setValue((v) => ({ ...v, ...patch }))
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  // Parent picker — the backend only accepts a header account as a parent.
  const { data: headerData } = useResource(
    keys.chartOfAccounts({ is_header: true, limit: 200 }),
    ({ signal }) => api.get('/chart-of-accounts', { params: { is_header: true, limit: 200 }, signal })
  )
  const headerAccounts = useMemo(() => (Array.isArray(headerData) ? headerData : []), [headerData])

  const createAccount = useResourceMutation((payload) => api.post('/chart-of-accounts', payload), {
    // A new account changes the ledger structure the reports derive from.
    invalidates: [['chart-of-accounts'], ['trial-balance'], ['balance-sheet'], ['income-statement']],
    silent: true,
  })

  const errors = useMemo(() => Object.fromEntries(Object.entries(RULES).map(([k, r]) => [k, r(form[k], form)]).filter(([, m]) => m)), [form])
  const shown = submitted ? errors : Object.fromEntries(Object.entries(errors).filter(([k]) => touched[k]))

  const onType = (accountType) => set({
    account_type: accountType,
    // A new type resets the subtype and proposes the conventional normal balance.
    account_subtype: '',
    normal_balance: DEFAULT_NORMAL_BALANCE[accountType] || form.normal_balance,
  })

  const onParent = (parentId) => {
    const parent = headerAccounts.find((a) => String(a.id) === String(parentId))
    set({
      parent_account_id: parentId,
      // A child of a level-N header sits at N+1 unless a level was picked.
      account_level: parent && (form.account_level == null || form.account_level === '' || Number(form.account_level) === 1)
        ? (Number(parent.account_level) || 1) + 1
        : form.account_level,
    })
  }

  const submit = async (e) => {
    e.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(errors).length) return
    const payload = {
      account_code: form.account_code.trim(),
      account_name: form.account_name.trim(),
      account_type: form.account_type,
      account_subtype: form.account_subtype || undefined,
      account_level: form.account_level === '' || form.account_level == null ? 1 : Number(form.account_level),
      is_header: Boolean(form.is_header),
      allow_manual_posting: Boolean(form.allow_manual_posting),
      normal_balance: form.normal_balance,
      balance_sheet_section: form.balance_sheet_section || undefined,
      ...(form.parent_account_id ? { parent_account_id: form.parent_account_id } : {}),
    }
    try {
      await createAccount.mutateAsync(payload)
      clear()
      notify.success(`Account ${payload.account_code} created — it waits for approval before it takes postings`)
      navigate('/finance/chart-of-accounts')
    } catch (err) {
      const d = err?.response?.data || {}
      setServerError({ message: d.error || err.message, reference: d.error_id })
    }
  }

  const summary = submitted ? Object.entries(errors).map(([id, message]) => ({ id, message })) : []

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="New account"
        description="Add an account to the general ledger. New accounts are approved and activated before they take postings."
        meta={savedAt ? <span aria-live="polite">Draft saved in this browser {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
      />
      {restored && (
        <InlineNotice tone="ink" title="Picked up where you left off" action={<Button size="sm" variant="ghost" onClick={discard}>Start over</Button>}>
          This account was restored from a draft saved in this browser.
        </InlineNotice>
      )}
      {serverError && (
        <InlineNotice tone="risk" title="The account was not created">
          {serverError.message}{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={summary} />

      <FormSection title="Account">
        <Field label="Account code" required error={shown.account_code} id="account_code" help="The number journal lines post to.">
          <Input value={form.account_code} onChange={(e) => set({ account_code: e.target.value })} onBlur={blur('account_code')} className="font-mono" placeholder="1210" autoComplete="off" />
        </Field>
        <Field label="Account name" required error={shown.account_name} id="account_name">
          <Input value={form.account_name} onChange={(e) => set({ account_name: e.target.value })} onBlur={blur('account_name')} />
        </Field>
        <Field label="Type" required error={shown.account_type} id="account_type">
          <Select value={form.account_type} onChange={(e) => onType(e.target.value)} onBlur={blur('account_type')}>
            <option value="">Choose a type</option>
            {ACCOUNT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Subtype" optional id="account_subtype" help={form.account_type ? null : 'Choose a type first.'}>
          <Select value={form.account_subtype} onChange={(e) => set({ account_subtype: e.target.value })} disabled={!form.account_type}>
            <option value="">None</option>
            {(SUBTYPES_BY_TYPE[form.account_type] || []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Normal balance" required error={shown.normal_balance} id="normal_balance" help="Proposed from the type; change it only for contra accounts.">
          <Select value={form.normal_balance} onChange={(e) => set({ normal_balance: e.target.value })} onBlur={blur('normal_balance')}>
            <option value="">Choose a side</option>
            <option value="DEBIT">Debit</option>
            <option value="CREDIT">Credit</option>
          </Select>
        </Field>
      </FormSection>

      <FormSection title="Structure and posting" description="Where the account sits and how it is used." advanced defaultOpen={Boolean(form.parent_account_id || form.is_header || form.balance_sheet_section)}>
        <Field label="Parent account" optional id="parent_account_id" help="Only header accounts can be parents.">
          <Select value={form.parent_account_id} onChange={(e) => onParent(e.target.value)}>
            <option value="">No parent</option>
            {headerAccounts.map((a) => <option key={a.id} value={a.id}>{a.account_code} — {a.account_name}</option>)}
          </Select>
        </Field>
        <Field label="Level" error={shown.account_level} id="account_level" help="1 is the top of the chart.">
          <Input type="number" min="1" numeric value={form.account_level} onChange={(e) => set({ account_level: e.target.value })} onBlur={blur('account_level')} />
        </Field>
        <Field label="Balance sheet section" optional id="balance_sheet_section">
          <Select value={form.balance_sheet_section} onChange={(e) => set({ balance_sheet_section: e.target.value })}>
            <option value="">None</option>
            {BALANCE_SHEET_SECTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <div className="space-y-3 sm:col-span-2">
          <Checkbox id="is_header" label="Header account" description="Groups detail accounts underneath it." checked={form.is_header} onChange={(e) => set({ is_header: e.target.checked })} />
          <Checkbox id="allow_manual_posting" label="Allow manual posting" description="Journal entries can post directly to this account." checked={form.allow_manual_posting} onChange={(e) => set({ allow_manual_posting: e.target.checked })} />
        </div>
      </FormSection>

      <div className="flex justify-end gap-2 border-t border-ink-200 pt-4">
        <Button variant="ghost" to="/finance/chart-of-accounts">Cancel</Button>
        <Button type="submit" variant="primary" loading={createAccount.isPending}>Create account</Button>
      </div>
    </form>
  )
}
