import { useEffect, useMemo, useState } from 'react'
import { PlusIcon, TrashIcon, EyeIcon, UserGroupIcon, ArrowUpTrayIcon, DocumentArrowDownIcon } from '@heroicons/react/20/solid'
import { crmAPI, customersAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useCompany } from '../../contexts/CompanyContext'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Money, DateText, Dialog, Sheet, ConfirmDialog, Field, Input, Select,
  Textarea, FormSection, InlineNotice, DescriptionList, SkeletonRows, ErrorState, exportCsv, notify,
} from '../../components/ui'

/**
 * Contacts — the people behind the customers.
 *
 * The duplicate check runs as the name and email are typed and warns rather
 * than blocks: only the person filling the form can tell a genuine duplicate
 * from two people who happen to share a name, and a hard block would simply
 * push them to type a slightly different spelling.
 */
const LIMIT = 500
const KEY = ['contacts']
const fullName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ')
const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const STAGE = { NEW: 'New', QUALIFIED: 'Qualified', PROPOSAL: 'Proposal', NEGOTIATION: 'Negotiation', WON: 'Won', LOST: 'Lost' }

export default function Contacts() {
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState(null)
  const [removing, setRemoving] = useState(null)

  const { data, loading, error, refetch } = useResource([...KEY, { limit: LIMIT }], () => crmAPI.listContacts({ limit: LIMIT }))
  const contacts = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const remove = useResourceMutation((c) => crmAPI.deleteContact(c.id), { invalidates: [KEY], silent: true })

  const doRemove = async () => {
    const c = removing
    try {
      await remove.mutateAsync(c)
      notify.success(`${fullName(c)} removed`)
      setRemoving(null)
      if (openId === c.id) setOpenId(null)
    } catch (err) {
      notify.error(err?.response?.data?.error || 'Could not remove that contact.')
    }
  }

  const columns = useMemo(() => [
    {
      id: 'name', header: 'Name', accessor: fullName, filter: 'text', minWidth: 200, mobile: 'title',
      cell: (c) => (
        <span className="block min-w-0">
          <span className="block truncate">{fullName(c)}</span>
          {c.job_title && <span className="block truncate text-2xs text-ink-500">{c.job_title}</span>}
        </span>
      ),
    },
    { id: 'company', header: 'Company', accessor: (c) => c.customer_name || 'Prospect', filter: 'select', width: 200, mobile: 'subtitle', cell: (c) => c.customer_name || <span className="text-ink-500">Prospect</span> },
    { id: 'email', header: 'Email', accessor: 'email', width: 220, cell: (c) => (c.email ? <a href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()} className="truncate text-ink-800 hover:text-brand-600 hover:underline">{c.email}</a> : <span className="text-ink-400">—</span>) },
    { id: 'phone', header: 'Phone', accessor: 'phone', width: 150, cell: (c) => (c.phone ? <span className="tabular-nums">{c.phone}</span> : <span className="text-ink-400">—</span>) },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 110, mobile: 'meta', cell: (c) => <StatusBadge status={c.status} /> },
    { id: 'added', header: 'Added', accessor: 'created_at', width: 120, cell: (c) => <DateText value={c.created_at} /> },
  ], [])

  return (
    <>
      <PageHeader
        title="Contacts"
        description="People at your customers and prospects."
        secondary={
          <>
            <Button icon={ArrowUpTrayIcon} to="/crm/import">Import</Button>
            <Button icon={DocumentArrowDownIcon} onClick={() => exportCsv(contacts, columns, 'contacts.csv')} disabled={!contacts.length}>Export</Button>
          </>
        }
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setCreating(true)}>New contact</Button>}
      />

      {contacts.length >= LIMIT && (
        <InlineNotice tone="warn" className="mb-3" title={`Showing the ${LIMIT} most recent contacts`}>
          Older contacts are still in the system. Search narrows this list only.
        </InlineNotice>
      )}

      <DataTable
        viewKey="crm.contacts"
        caption="Contacts"
        noun="contact"
        rows={contacts}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        onRowClick={(c) => setOpenId(c.id)}
        defaultSort={{ id: 'added', dir: 'desc' }}
        searchPlaceholder="Search name, company, email"
        rowActions={(c) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${fullName(c)}`} onClick={() => setOpenId(c.id)} />
            <RowAction icon={TrashIcon} tone="risk" label={`Remove ${fullName(c)}`} onClick={() => setRemoving(c)} />
          </>
        )}
        empty={{
          icon: UserGroupIcon,
          title: 'No contacts yet',
          description: 'Add the people you actually deal with, or import a list, an email or a business card.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setCreating(true)}>New contact</Button>,
        }}
      />

      {creating && <ContactDialog onClose={() => setCreating(false)} />}
      {openId && <ContactSheet id={openId} onClose={() => setOpenId(null)} onRemove={(c) => setRemoving(c)} />}
      {removing && (
        <ConfirmDialog
          open
          onClose={() => setRemoving(null)}
          onConfirm={doRemove}
          title={`Remove ${fullName(removing)}?`}
          consequence="The contact leaves the list. Deals and activities linked to them keep their history."
          reversible={false}
          confirmLabel={`Remove ${fullName(removing)}`}
          busy={remove.isPending}
        />
      )}
    </>
  )
}

function ContactDialog({ onClose }) {
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', job_title: '', customer_id: '', notes: '' })
  const [touched, setTouched] = useState(false)
  const [serverError, setServerError] = useState(null)
  const [dupQuery, setDupQuery] = useState(null)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  // A missing customer list should not stop someone recording a contact —
  // customer_id is optional precisely because leads come first.
  const { data: customerData } = useResource(['customers', { limit: 500 }], () => customersAPI.getAll({ limit: 500 }))
  const customers = Array.isArray(customerData) ? customerData : customerData?.customers || []

  // "Do we already know this person?" — asked once the identifying fields
  // settle. A warning is a help, not a precondition for saving, so a failure
  // here says nothing.
  useEffect(() => {
    const handle = setTimeout(() => {
      setDupQuery(form.email || form.last_name ? { email: form.email || undefined, first_name: form.first_name || undefined, last_name: form.last_name || undefined } : null)
    }, 400)
    return () => clearTimeout(handle)
  }, [form.email, form.first_name, form.last_name])
  const { data: dupData } = useResource(['contacts', 'duplicates', dupQuery], () => crmAPI.checkDuplicate(dupQuery), { enabled: Boolean(dupQuery), retry: false })
  const duplicates = dupQuery && Array.isArray(dupData) ? dupData : []

  const create = useResourceMutation((payload) => crmAPI.createContact(payload), { invalidates: [KEY], silent: true })
  const nameError = !form.first_name.trim() ? 'A contact needs at least a first name.' : null

  const submit = async () => {
    setTouched(true)
    if (nameError) return
    setServerError(null)
    try {
      await create.mutateAsync({
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim() || undefined,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        job_title: form.job_title.trim() || undefined,
        customer_id: form.customer_id || undefined,
        notes: form.notes.trim() || undefined,
      })
      notify.success('Contact added')
      onClose()
    } catch (err) {
      setServerError(err?.response?.data?.error || 'Could not save that contact.')
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="New contact"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>{duplicates.length ? 'Save anyway' : 'Save contact'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {serverError && <InlineNotice tone="risk" title="The contact was not saved">{serverError}</InlineNotice>}
        <FormSection title="Person">
          <Field label="First name" required id="contact-first" error={touched ? nameError : null}>
            <Input value={form.first_name} onChange={set('first_name')} onBlur={() => setTouched(true)} autoComplete="off" />
          </Field>
          <Field label="Last name" optional id="contact-last">
            <Input value={form.last_name} onChange={set('last_name')} autoComplete="off" />
          </Field>
          {duplicates.length > 0 && (
            <InlineNotice tone="warn" title="This may already be someone you know" className="sm:col-span-2">
              <ul className="mt-1 space-y-0.5">
                {duplicates.map((d) => <li key={d.id}>{fullName(d)}{d.email ? ` · ${d.email}` : ''}</li>)}
              </ul>
              <p className="mt-1">Saving anyway is fine if these are genuinely different people.</p>
            </InlineNotice>
          )}
          <Field label="Email" optional id="contact-email">
            <Input type="email" value={form.email} onChange={set('email')} autoComplete="off" />
          </Field>
          <Field label="Phone" optional id="contact-phone">
            <Input type="tel" value={form.phone} onChange={set('phone')} autoComplete="off" />
          </Field>
          <Field label="Job title" optional id="contact-title">
            <Input value={form.job_title} onChange={set('job_title')} />
          </Field>
          <Field label="Customer" optional help="Leave blank for a prospect." id="contact-customer">
            <Select value={form.customer_id} onChange={set('customer_id')}>
              <option value="">Prospect — no customer yet</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name || c.name}</option>)}
            </Select>
          </Field>
          <Field label="Notes" optional id="contact-notes" className="sm:col-span-2">
            <Textarea rows={3} value={form.notes} onChange={set('notes')} />
          </Field>
        </FormSection>
      </div>
    </Dialog>
  )
}

function ContactSheet({ id, onClose, onRemove }) {
  const { currency } = useCompany()
  const { data: contact, loading, error, refetch } = useResource([...KEY, id], () => crmAPI.getContact(id))
  const [note, setNote] = useState('')
  const logNote = useResourceMutation((subject) => crmAPI.createActivity({ activity_type: 'NOTE', subject, contact_id: id }), {
    invalidates: [KEY, ['crm-activities']],
    successMessage: 'Note logged',
    onSuccess: () => setNote(''),
  })
  const deals = contact?.deals || []
  const activities = contact?.activities || []

  return (
    <Sheet
      open
      onClose={onClose}
      width="lg"
      title={contact ? fullName(contact) : 'Contact'}
      description={contact ? [contact.job_title, contact.customer_name || 'Prospect'].filter(Boolean).join(' · ') : undefined}
      footer={contact ? <Button variant="ghost" icon={TrashIcon} onClick={() => onRemove(contact)}>Remove</Button> : null}
    >
      {loading ? <SkeletonRows rows={5} columns={2} className="p-4" /> : error ? <ErrorState compact what="This contact" error={error} onRetry={refetch} className="p-4" /> : (
        <div className="space-y-6 p-4">
          <DescriptionList
            items={[
              { label: 'Company', value: contact.customer_name || 'Prospect' },
              { label: 'Job title', value: contact.job_title },
              { label: 'Email', value: contact.email ? <a href={`mailto:${contact.email}`} className="text-brand-600 hover:underline">{contact.email}</a> : null },
              { label: 'Phone', value: contact.phone },
              { label: 'Notes', value: contact.notes ? <span className="whitespace-pre-line">{contact.notes}</span> : null, wide: true },
            ]}
          />

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-fg">Deals</h3>
            {deals.length ? (
              <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
                {deals.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate text-ink-900">{d.title}</span>
                      <span className="block font-mono text-2xs text-ink-500">{d.deal_number}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <Money amount={d.value} currency={d.currency || currency} digits={0} className="font-medium" />
                      <span className="block text-xs text-ink-500">{STAGE[d.stage] || humanize(d.stage)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-500">No deals with this contact yet.</p>}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-fg">Activities</h3>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => { e.preventDefault(); if (note.trim()) logNote.mutate(note.trim()) }}
            >
              <Field label="Log a note" className="flex-1" id="contact-note" help="Something that already happened — filed as complete.">
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened?" />
              </Field>
              <Button type="submit" loading={logNote.isPending} disabled={!note.trim()} className="mb-5">Log</Button>
            </form>
            {activities.length ? (
              <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
                {activities.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate text-ink-900">{a.subject}</span>
                      <span className="block text-xs text-ink-500">{humanize(a.activity_type)}</span>
                    </span>
                    <span className="shrink-0 text-xs text-ink-500">
                      {a.completed_at ? <DateText value={a.completed_at} /> : <>Due <DateText value={a.due_date} /></>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-500">Nothing logged against this contact yet.</p>}
          </section>
        </div>
      )}
    </Sheet>
  )
}
