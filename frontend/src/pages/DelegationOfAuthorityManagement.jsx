import { useMemo, useState } from 'react'
import { PlusIcon, PencilSquareIcon, UserPlusIcon, PauseCircleIcon, PlayCircleIcon, TrashIcon, ScaleIcon } from '@heroicons/react/20/solid'
import api from '../services/api'
import { useResource, useResourceMutation } from '../hooks/useResource'
import { keys } from '../services/queryKeys'
import { useAuth } from '../contexts/AuthContext'
import {
  PageHeader, Button, DataTable, RowAction, Badge, Money, DateText, ConfirmDialog, Dialog, Segmented, Stat,
  Field, Input, Select, Checkbox, FormSection, ErrorSummary, InlineNotice, DescriptionList, describeError, notify, formatNumber,
} from '../components/ui'

/**
 * Delegation of authority — who may approve what, up to which amount.
 *
 * Every rule needs a distinct second approver (four-eyes): the server refuses
 * a create or substantive edit without one, and the person making the change
 * cannot countersign it, so they are left out of that picker.
 */
const TYPE_LABEL = {
  ALL: 'All transactions',
  SALES: 'All sales transactions',
  SALES_QUOTATION: 'Sales quotations',
  SALES_CONTRACT: 'Sales contracts',
  SALES_ORDER: 'Sales orders',
  SALES_RFQ: 'Sales RFQs to suppliers',
  SUPPLIERS: 'Supplier management',
  PURCHASE_REQUISITIONS: 'Purchase requisitions',
  PURCHASE_ORDERS: 'Purchase orders',
  CONTRACTS: 'Purchase contracts',
}
const typeLabel = (v) => TYPE_LABEL[v] || v || '—'
const list = (d) => (Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.users) ? d.users : [])
const userLabel = (u) => `${[u.first_name, u.last_name].filter(Boolean).join(' ') || u.email}${u.role ? ` (${u.role})` : ''}`
const today = () => new Date().toISOString().slice(0, 10)

/** Where a rule stands today: inactive, not yet in force, expired, or in force. */
function ruleState(r) {
  if (!r.is_active) return { label: 'Inactive', tone: 'ink', glyph: 'ring' }
  const now = new Date()
  if (r.effective_from && now < new Date(r.effective_from)) return { label: 'Not yet in force', tone: 'warn', glyph: 'dot' }
  if (r.effective_until && now > new Date(r.effective_until)) return { label: 'Expired', tone: 'risk', glyph: 'triangle' }
  return { label: 'In force', tone: 'ok', glyph: 'dot' }
}

const QUICK = [
  { value: '', label: 'All' },
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
]

export default function DelegationOfAuthorityManagement() {
  const { user: currentUser } = useAuth()
  const [isActive, setIsActive] = useState('')
  const [editing, setEditing] = useState(null) // { mode: 'create' } | { mode: 'edit', rule }
  const [cosign, setCosign] = useState(null) // rule whose second approver is being changed
  const [removing, setRemoving] = useState(null)

  // Same three server filters as before; cost centre and type are column filters on the table.
  const filters = { cost_center: '', applies_to: '', is_active: isActive }
  const { data: rulesData, loading, error, refetch } = useResource(keys.delegationOfAuthority(filters), ({ signal }) => api.get('/delegation-of-authority', { params: filters, signal }))
  const rules = useMemo(() => list(rulesData), [rulesData])
  const { data: stats, loading: statsLoading } = useResource(keys.delegationOfAuthorityStats(), ({ signal }) => api.get('/delegation-of-authority/stats', { signal }))
  const { data: usersData } = useResource(['users'], ({ signal }) => api.get('/users', { signal }))
  const users = useMemo(() => list(usersData), [usersData])
  const { data: configData } = useResource(['delegation-of-authority', 'config'], ({ signal }) => api.get('/delegation-of-authority/config', { signal }))
  const config = configData || { transaction_types: [], currencies: [], cost_centers: [] }
  const cosigners = users.filter((u) => String(u.id) !== String(currentUser?.id))

  const invalidates = [['delegation-of-authority'], ['delegation-of-authority-stats']]
  const create = useResourceMutation((payload) => api.post('/delegation-of-authority', payload), { invalidates, silent: true })
  const update = useResourceMutation(({ id, payload }) => api.put(`/delegation-of-authority/${id}`, payload), { invalidates, silent: true })
  const remove = useResourceMutation((id) => api.delete(`/delegation-of-authority/${id}`), { invalidates, silent: true })

  const toggle = async (r) => {
    try {
      await update.mutateAsync({ id: r.id, payload: { is_active: !r.is_active } })
      notify.success(`Rule for ${r.user_name} ${r.is_active ? 'deactivated' : 'activated'}`)
    } catch (e) {
      notify.error(describeError(e).message)
    }
  }

  const doRemove = async () => {
    try {
      await remove.mutateAsync(removing.id)
      notify.success(`Rule for ${removing.user_name} deleted`)
    } catch (e) {
      notify.error(describeError(e).message)
    }
    setRemoving(null)
  }

  const columns = useMemo(() => [
    { id: 'user', header: 'Approver', accessor: 'user_name', filter: 'text', mobile: 'title', minWidth: 180 },
    { id: 'cost', header: 'Cost centre', accessor: (r) => r.cost_center || 'Any', filter: 'select', width: 140, mobile: 'subtitle', cell: (r) => r.cost_center || <span className="text-ink-500">Any</span> },
    { id: 'type', header: 'Applies to', accessor: (r) => typeLabel(r.applies_to), filter: 'select', minWidth: 180 },
    { id: 'min', header: 'From', accessor: (r) => Number(r.min_amount) || 0, align: 'right', width: 130, cell: (r) => <Money amount={r.min_amount ?? 0} currency={r.currency} /> },
    { id: 'max', header: 'Up to', accessor: (r) => (r.max_amount == null ? Infinity : Number(r.max_amount)), align: 'right', width: 140, mobile: 'trailing', cell: (r) => (r.max_amount == null ? <span className="text-ink-600">No limit</span> : <Money amount={r.max_amount} currency={r.currency} />) },
    { id: 'state', header: 'Status', accessor: (r) => ruleState(r).label, filter: 'select', width: 150, mobile: 'meta', cell: (r) => { const s = ruleState(r); return <Badge tone={s.tone} glyph={s.glyph}>{s.label}</Badge> } },
    { id: 'from', header: 'Effective', accessor: 'effective_from', width: 120, cell: (r) => <DateText value={r.effective_from} /> },
    { id: 'until', header: 'Until', accessor: 'effective_until', width: 120, cell: (r) => (r.effective_until ? <DateText value={r.effective_until} /> : <span className="text-ink-500">Open-ended</span>) },
    { id: 'cosigner', header: 'Second approver', accessor: 'second_approver_name', width: 170, cell: (r) => r.second_approver_name || <span className="text-warn-700">None — required</span> },
    { id: 'currency', header: 'Currency', accessor: 'currency', width: 90, defaultHidden: true },
  ], [])

  const n = (v) => (v == null ? '—' : formatNumber(Number(v)))

  return (
    <>
      <PageHeader
        title="Delegation of authority"
        description="Who may approve which transactions, up to which amount, for which cost centre."
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setEditing({ mode: 'create' })}>New rule</Button>}
        secondary={<Button to="/approvals/simulate">Simulate an approval</Button>}
      />

      <section aria-label="Rule figures" className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Rules" value={n(stats?.total)} loading={statsLoading} />
        <Stat label="Active" value={n(stats?.active)} loading={statsLoading} />
        <Stat label="Approvers" value={n(stats?.unique_users)} loading={statsLoading} />
        <Stat label="Cost centres" value={n(stats?.unique_cost_centers)} loading={statsLoading} />
      </section>

      <DataTable
        viewKey="governance.doa-rules"
        caption="Approval rules"
        noun="rule"
        rows={rules}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        onRowClick={(r) => setEditing({ mode: 'edit', rule: r })}
        searchPlaceholder="Search approver, cost centre"
        toolbarStart={<Segmented label="Show" value={isActive} onChange={setIsActive} options={QUICK} />}
        rowActions={(r) => (
          <>
            <RowAction icon={PencilSquareIcon} label={`Edit rule for ${r.user_name}`} onClick={() => setEditing({ mode: 'edit', rule: r })} />
            <RowAction icon={UserPlusIcon} label="Change second approver" onClick={() => setCosign(r)} />
            <RowAction icon={r.is_active ? PauseCircleIcon : PlayCircleIcon} label={r.is_active ? 'Deactivate' : 'Activate'} onClick={() => toggle(r)} disabled={update.isPending} />
            <RowAction icon={TrashIcon} tone="risk" label={`Delete rule for ${r.user_name}`} onClick={() => setRemoving(r)} />
          </>
        )}
        empty={{
          icon: ScaleIcon,
          title: isActive ? 'No rules match this filter' : 'No approval rules yet',
          description: 'Without a rule, requests have no approver. Add one for each person who approves, with the amount range and the transactions it covers.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setEditing({ mode: 'create' })}>New rule</Button>,
        }}
      />

      {editing && (
        <RuleDialog
          key={editing.rule?.id || 'new'}
          rule={editing.rule}
          users={users}
          cosigners={cosigners}
          config={config}
          currentUserId={currentUser?.id}
          busy={create.isPending || update.isPending}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            if (editing.mode === 'create') await create.mutateAsync(payload)
            else {
              const { is_active: _ignored, ...rest } = payload
              await update.mutateAsync({ id: editing.rule.id, payload: rest })
            }
            notify.success(editing.mode === 'create' ? 'Rule created' : 'Rule updated')
            setEditing(null)
          }}
        />
      )}

      {cosign && (
        <CosignDialog
          rule={cosign}
          cosigners={cosigners}
          currentUserId={currentUser?.id}
          busy={update.isPending}
          onClose={() => setCosign(null)}
          onSave={async (id) => {
            await update.mutateAsync({ id: cosign.id, payload: { second_approver_id: id } })
            notify.success('Second approver updated')
            setCosign(null)
          }}
        />
      )}

      {removing && (
        <ConfirmDialog
          open
          onClose={() => setRemoving(null)}
          onConfirm={doRemove}
          title={`Delete the rule for ${removing.user_name}?`}
          consequence={`${removing.user_name} will no longer approve ${typeLabel(removing.applies_to).toLowerCase()} for ${removing.cost_center || 'any cost centre'}. Requests it covered go to the next matching rule, or to nobody. To pause it instead, deactivate it.`}
          confirmLabel="Delete rule"
          busy={remove.isPending}
        />
      )}
    </>
  )
}

/* ---------------------------------------------------------------- forms */

function validate(f, currentUserId) {
  const e = {}
  if (!f.cost_center) e.cost_center = 'Choose the cost centre this rule covers.'
  if (!f.user_id) e.user_id = 'Choose who approves.'
  if (!f.applies_to) e.applies_to = 'Choose which transactions this rule covers.'
  if (!f.second_approver_id) e.second_approver_id = 'Choose a second approver. Every rule needs one.'
  else if (String(f.second_approver_id) === String(currentUserId)) e.second_approver_id = 'You cannot countersign your own change.'
  if (f.min_amount && f.max_amount && parseFloat(f.min_amount) > parseFloat(f.max_amount)) e.max_amount = 'The upper limit must be at least the lower limit.'
  if (!f.effective_from) e.effective_from = 'Set when the rule takes effect.'
  if (f.effective_until && f.effective_until <= f.effective_from) e.effective_until = 'The end date must be after the start date.'
  return e
}

function RuleDialog({ rule, users, cosigners, config, currentUserId, busy, onClose, onSave }) {
  const [f, setF] = useState(() => ({
    cost_center: rule?.cost_center || '',
    user_id: rule?.user_id != null ? String(rule.user_id) : '',
    applies_to: rule?.applies_to || '',
    min_amount: rule?.min_amount ?? '',
    max_amount: rule?.max_amount ?? '',
    currency: rule?.currency || 'USD',
    effective_from: rule?.effective_from ? String(rule.effective_from).slice(0, 10) : today(),
    effective_until: rule?.effective_until ? String(rule.effective_until).slice(0, 10) : '',
    second_approver_id: rule?.second_approver_id != null ? String(rule.second_approver_id) : '',
    is_active: true,
  }))
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)
  const all = validate(f, currentUserId)
  const errors = submitted ? all : Object.fromEntries(Object.entries(all).filter(([k]) => touched[k]))
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const grouped = (config.transaction_types || []).reduce((acc, t) => { (acc[t.category || 'Other'] ||= []).push(t); return acc }, {})
  const currencies = config.currencies?.length ? config.currencies : [{ value: 'USD', label: 'USD' }]

  const submit = async (e) => {
    e?.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(all).length) return
    try {
      await onSave({
        user_id: f.user_id,
        cost_center: f.cost_center,
        min_amount: f.min_amount ? parseFloat(f.min_amount) : 0,
        max_amount: f.max_amount ? parseFloat(f.max_amount) : null,
        applies_to: f.applies_to,
        currency: f.currency,
        effective_from: f.effective_from,
        effective_until: f.effective_until || null,
        second_approver_id: f.second_approver_id,
        is_active: f.is_active,
      })
    } catch (err) {
      setServerError(describeError(err))
    }
  }

  return (
    <Dialog
      open
      onClose={busy ? undefined : onClose}
      size="lg"
      title={rule ? `Edit rule for ${rule.user_name}` : 'New approval rule'}
      description={rule ? 'Changing who, what or how much is a governance change and needs a second approver.' : 'The rule takes effect on its start date.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy}>{rule ? 'Save changes' : 'Create rule'}</Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        {serverError && <InlineNotice tone="risk" title={rule ? 'The rule was not saved' : 'The rule was not created'}>{serverError.message}</InlineNotice>}
        <ErrorSummary errors={submitted ? Object.entries(all).map(([id, message]) => ({ id: `doa-${id}`, message })) : []} />
        <FormSection title="Who and what">
          <Field label="Approver" required error={errors.user_id} id="doa-user_id">
            <Select value={f.user_id} onChange={set('user_id')} onBlur={blur('user_id')}>
              <option value="">Choose a person…</option>
              {users.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
            </Select>
          </Field>
          <Field label="Cost centre" required error={errors.cost_center} id="doa-cost_center">
            <Select value={f.cost_center} onChange={set('cost_center')} onBlur={blur('cost_center')}>
              <option value="">Choose a cost centre…</option>
              {(config.cost_centers || []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </Select>
          </Field>
          <Field label="Applies to" required error={errors.applies_to} className="sm:col-span-2" id="doa-applies_to">
            <Select value={f.applies_to} onChange={set('applies_to')} onBlur={blur('applies_to')}>
              <option value="">Choose transactions…</option>
              {Object.entries(grouped).map(([cat, types]) => (
                <optgroup key={cat} label={cat}>
                  {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label="Second approver" required error={errors.second_approver_id} help="Countersigns this rule. You are not listed — you cannot countersign your own change." className="sm:col-span-2" id="doa-second_approver_id">
            <Select value={f.second_approver_id} onChange={set('second_approver_id')} onBlur={blur('second_approver_id')}>
              <option value="">Choose a second approver…</option>
              {cosigners.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
            </Select>
          </Field>
        </FormSection>
        <FormSection title="Amount range" columns={3}>
          <Field label="Currency" id="doa-currency">
            <Select value={f.currency} onChange={set('currency')}>
              {currencies.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </Select>
          </Field>
          <Field label="From" optional help="Leave empty for zero." id="doa-min_amount">
            <Input type="number" step="0.01" min="0" numeric value={f.min_amount} onChange={set('min_amount')} placeholder="0.00" />
          </Field>
          <Field label="Up to" optional error={errors.max_amount} help="Leave empty for no limit." id="doa-max_amount">
            <Input type="number" step="0.01" min="0" numeric value={f.max_amount} onChange={set('max_amount')} onBlur={blur('max_amount')} placeholder="No limit" />
          </Field>
        </FormSection>
        <FormSection title="When">
          <Field label="Effective from" required error={errors.effective_from} id="doa-effective_from">
            <Input type="date" value={f.effective_from} onChange={set('effective_from')} onBlur={blur('effective_from')} />
          </Field>
          <Field label="Effective until" optional error={errors.effective_until} help="Leave empty for open-ended." id="doa-effective_until">
            <Input type="date" value={f.effective_until} onChange={set('effective_until')} onBlur={blur('effective_until')} />
          </Field>
          {!rule && (
            <Checkbox className="sm:col-span-2" label="Active" description="An active rule routes approvals from its start date." checked={f.is_active} onChange={set('is_active')} />
          )}
        </FormSection>
      </form>
    </Dialog>
  )
}

function CosignDialog({ rule, cosigners, currentUserId, busy, onClose, onSave }) {
  const [value, setValue] = useState(rule.second_approver_id != null ? String(rule.second_approver_id) : '')
  const [error, setError] = useState(null)
  const submit = async (e) => {
    e?.preventDefault()
    if (!value) return setError('Choose a second approver.')
    if (String(value) === String(currentUserId)) return setError('You cannot countersign your own change.')
    setError(null)
    try { await onSave(value) } catch (err) { setError(describeError(err).message) }
    return undefined
  }
  return (
    <Dialog
      open
      onClose={busy ? undefined : onClose}
      size="sm"
      title="Change second approver"
      description="The second approver countersigns this rule (four-eyes)."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy}>Save second approver</Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <DescriptionList
          columns={1}
          items={[
            { label: 'Approver', value: rule.user_name },
            { label: 'Cost centre', value: rule.cost_center || 'Any' },
            { label: 'Range', value: <><Money amount={rule.min_amount ?? 0} currency={rule.currency} /> – {rule.max_amount == null ? 'no limit' : <Money amount={rule.max_amount} currency={rule.currency} />}</> },
          ]}
        />
        <Field label="Second approver" required error={error} id="edit-second-approver">
          <Select value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">Choose a second approver…</option>
            {cosigners.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
          </Select>
        </Field>
      </form>
    </Dialog>
  )
}
