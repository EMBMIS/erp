import { useMemo, useState } from 'react'
import { PlusIcon, SparklesIcon, ArrowRightCircleIcon, EyeIcon, UserPlusIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Money, Num, DateText, Dialog, Sheet, ConfirmDialog, Segmented,
  Field, Input, Select, Textarea, InlineNotice, DescriptionList, notify,
} from '../../components/ui'

/**
 * Leads — people and companies who might buy, qualified into customers.
 *
 * A qualified lead converts into a customer (and is marked WON). The AI score
 * is a ranking aid the user recomputes on demand; it never moves a lead.
 */
const STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL_SENT', 'WON', 'LOST']
// Lead stages onto the shared status vocabulary (tone and glyph only; the label stays the module's own word).
const TONE = { NEW: 'NEW', CONTACTED: 'IN_PROGRESS', QUALIFIED: 'IN_PROGRESS', PROPOSAL_SENT: 'PENDING', WON: 'DONE', LOST: 'CANCELLED' }
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const badge = (s) => <StatusBadge status={TONE[s] || s} label={humanize(s)} />
const SOURCES = ['WEBSITE', 'REFERRAL', 'TRADE_SHOW', 'COLD_CALL']
const EMPTY_FORM = { contact_name: '', company_name: '', email: '', phone: '', source: '', potential_value: '', notes: '' }

const QUICK = {
  all: { label: 'All', test: () => true },
  open: { label: 'Open', test: (l) => !['WON', 'LOST'].includes(l.status) },
  QUALIFIED: { label: 'Qualified', test: (l) => l.status === 'QUALIFIED' },
  WON: { label: 'Won', test: (l) => l.status === 'WON' },
  LOST: { label: 'Lost', test: (l) => l.status === 'LOST' },
}

export default function LeadsList() {
  const [quick, setQuick] = useState('open')
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState(null)
  const [converting, setConverting] = useState(null)

  const { data, loading, error, refetch } = useResource(keys.leads(''), ({ signal }) => api.get('/leads', { signal }))
  const leads = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, leads.filter(q.test).length])), [leads])
  const open = leads.find((l) => l.id === openId)

  // Every mutation invalidates every filtered view of the list.
  const invalidates = [['leads']]
  const updateStatus = useResourceMutation(({ id, status }) => api.patch(`/leads/${id}`, { status }), { invalidates, successMessage: 'Lead updated' })
  const convertLead = useResourceMutation((id) => api.post(`/leads/${id}/convert`), {
    invalidates,
    onSuccess: (result) => { notify.success(`Converted to a customer${result?.customer_id ? ` (customer ${String(result.customer_id).slice(0, 8)})` : ''}`); setConverting(null) },
  })
  const scoreLead = useResourceMutation((id) => api.post(`/leads/${id}/score`), {
    invalidates,
    onSuccess: (result) => notify.success(`AI score: ${result?.ai_score ?? '—'}`),
  })

  const columns = useMemo(() => [
    {
      id: 'contact', header: 'Lead', accessor: 'contact_name', filter: 'text', minWidth: 200, mobile: 'title',
      cell: (l) => (
        <span className="block min-w-0">
          <span className="block truncate">{l.contact_name}</span>
          {l.company_name && <span className="block truncate text-2xs text-ink-500">{l.company_name}</span>}
        </span>
      ),
    },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 140, mobile: 'meta', cell: (l) => badge(l.status) },
    { id: 'source', header: 'Source', accessor: 'source', filter: 'select', width: 130, cell: (l) => (l.source ? humanize(l.source) : <span className="text-ink-400">—</span>) },
    { id: 'value', header: 'Potential', accessor: (l) => (l.potential_value != null ? Number(l.potential_value) : null), align: 'right', filter: 'number', width: 130, mobile: 'trailing', cell: (l) => <Money amount={l.potential_value} digits={0} />, footer: (rows) => <Money amount={rows.reduce((s, r) => s + (Number(r.potential_value) || 0), 0)} digits={0} /> },
    { id: 'score', header: 'AI score', accessor: (l) => (l.ai_score != null ? Number(l.ai_score) : null), align: 'right', width: 100, cell: (l) => <Num value={l.ai_score} /> },
    { id: 'followup', header: 'Follow-up', accessor: 'next_follow_up', width: 120, cell: (l) => <DateText value={l.next_follow_up} /> },
    { id: 'email', header: 'Email', accessor: 'email', width: 200, defaultHidden: true },
    { id: 'created', header: 'Created', accessor: 'created_at', width: 120, cell: (l) => <DateText value={l.created_at} /> },
  ], [])

  return (
    <>
      <PageHeader
        title="Leads"
        description="Prospects to qualify. A qualified lead converts into a customer you can quote."
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setCreating(true)}>New lead</Button>}
      />

      <DataTable
        viewKey="crm.leads"
        caption="Leads"
        noun="lead"
        rows={leads}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        onRowClick={(l) => setOpenId(l.id)}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'created', dir: 'desc' }}
        searchPlaceholder="Search name, company, email"
        toolbarStart={
          <Segmented
            label="Show"
            value={quick}
            onChange={setQuick}
            options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
            className="max-w-full overflow-x-auto"
          />
        }
        rowActions={(l) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${l.contact_name}`} onClick={() => setOpenId(l.id)} />
            <RowAction icon={SparklesIcon} label={`Recompute AI score for ${l.contact_name}`} onClick={() => scoreLead.mutate(l.id)} disabled={scoreLead.isPending} />
            {l.status === 'QUALIFIED' && <RowAction icon={ArrowRightCircleIcon} label={`Convert ${l.contact_name} to a customer`} onClick={() => setConverting(l)} />}
          </>
        )}
        empty={{
          icon: UserPlusIcon,
          title: quick === 'all' ? 'No leads yet' : 'No leads in this view',
          description: 'Record a prospect when they first get in touch. Move them through contacted and qualified, then convert them to a customer.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setCreating(true)}>New lead</Button>,
        }}
      />

      {creating && <LeadDialog onClose={() => setCreating(false)} />}
      {open && (
        <Sheet
          open
          onClose={() => setOpenId(null)}
          title={open.contact_name}
          description={open.company_name || undefined}
          footer={
            <>
              <Button icon={SparklesIcon} onClick={() => scoreLead.mutate(open.id)} loading={scoreLead.isPending}>Recompute score</Button>
              {open.status === 'QUALIFIED' && <Button variant="primary" icon={ArrowRightCircleIcon} onClick={() => setConverting(open)}>Convert to customer</Button>}
            </>
          }
        >
          <div className="space-y-5 p-4">
            <DescriptionList
              items={[
                { label: 'Status', value: badge(open.status) },
                { label: 'AI score', value: open.ai_score != null ? <Num value={open.ai_score} /> : null },
                { label: 'Potential value', value: <Money amount={open.potential_value} digits={0} /> },
                { label: 'Source', value: open.source ? humanize(open.source) : null },
                { label: 'Email', value: open.email ? <a href={`mailto:${open.email}`} className="text-brand-600 hover:underline">{open.email}</a> : null },
                { label: 'Phone', value: open.phone },
                { label: 'Follow-up', value: open.next_follow_up ? <DateText value={open.next_follow_up} /> : null },
                { label: 'Created', value: <DateText value={open.created_at} /> },
                { label: 'Notes', value: open.notes, wide: true },
              ]}
            />
            {!['WON', 'LOST'].includes(open.status) ? (
              <Field label="Move to" help="Won and lost are final. Converting a qualified lead marks it won." id="lead-move">
                <Select value="" onChange={(e) => e.target.value && updateStatus.mutate({ id: open.id, status: e.target.value })} disabled={updateStatus.isPending}>
                  <option value="">Choose a stage…</option>
                  {STATUSES.filter((s) => s !== 'NEW' && s !== open.status).map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                </Select>
              </Field>
            ) : (
              <InlineNotice tone="ink">This lead is {humanize(open.status).toLowerCase()} and can no longer move.</InlineNotice>
            )}
          </div>
        </Sheet>
      )}
      {converting && (
        <ConfirmDialog
          open
          onClose={() => setConverting(null)}
          onConfirm={() => convertLead.mutate(converting.id)}
          title={`Convert ${converting.contact_name} to a customer?`}
          consequence={`A customer record is created${converting.company_name ? ` for ${converting.company_name}` : ''} and the lead is marked won.`}
          reversible={false}
          tone="primary"
          confirmLabel="Convert to customer"
          busy={convertLead.isPending}
        />
      )}
    </>
  )
}

function LeadDialog({ onClose }) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [touched, setTouched] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const createLead = useResourceMutation((payload) => api.post('/leads', payload), { invalidates: [['leads']], successMessage: 'Lead created', onSuccess: onClose })
  const nameError = !form.contact_name.trim() ? 'Enter who you are talking to.' : null

  const submit = (e) => {
    e?.preventDefault()
    setTouched(true)
    if (nameError) return
    createLead.mutate({ ...form, potential_value: Number(form.potential_value) || null })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="New lead"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={createLead.isPending}>Create lead</Button>
        </>
      }
    >
      <form onSubmit={submit} className="grid grid-cols-1 gap-4 sm:grid-cols-2" noValidate>
        <Field label="Contact name" required id="lead-contact" error={touched ? nameError : null}>
          <Input value={form.contact_name} onChange={set('contact_name')} onBlur={() => setTouched(true)} autoComplete="off" />
        </Field>
        <Field label="Company" optional id="lead-company">
          <Input value={form.company_name} onChange={set('company_name')} autoComplete="off" />
        </Field>
        <Field label="Email" optional id="lead-email">
          <Input type="email" value={form.email} onChange={set('email')} autoComplete="off" />
        </Field>
        <Field label="Phone" optional id="lead-phone">
          <Input type="tel" value={form.phone} onChange={set('phone')} autoComplete="off" />
        </Field>
        <Field label="Source" optional id="lead-source">
          <Select value={form.source} onChange={set('source')}>
            <option value="">Not recorded</option>
            {SOURCES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </Select>
        </Field>
        <Field label="Potential value" optional id="lead-value" help="What this could be worth if it closes.">
          <Input type="number" min="0" step="1" numeric prefix="$" value={form.potential_value} onChange={set('potential_value')} />
        </Field>
        <Field label="Notes" optional id="lead-notes" className="sm:col-span-2">
          <Textarea rows={3} value={form.notes} onChange={set('notes')} />
        </Field>
      </form>
    </Dialog>
  )
}
