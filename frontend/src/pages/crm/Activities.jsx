import { useMemo, useState } from 'react'
import { PlusIcon, CheckIcon, ClipboardDocumentCheckIcon } from '@heroicons/react/20/solid'
import { crmAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useI18n } from '../../contexts/I18nContext'
import {
  PageHeader, Button, DataTable, RowAction, Dialog, Field, Input, Select, Textarea, FormSection, InlineNotice,
  Segmented, Stat, Code, DateText, ErrorSummary, notify,
} from '../../components/ui'

const TYPES = ['CALL', 'EMAIL', 'MEETING', 'TASK', 'NOTE']
const TYPE_LABEL = { CALL: 'Call', EMAIL: 'Email', MEETING: 'Meeting', TASK: 'Task', NOTE: 'Note' }
const KEY = ['crm-activities']

const FILTERS = [
  { value: 'open', label: 'Open' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'all', label: 'All' },
]

const dayOf = (d) => new Date(d).setHours(0, 0, 0, 0)
const startOfToday = () => new Date().setHours(0, 0, 0, 0)
const contactName = (a) => [a.contact_first_name, a.contact_last_name].filter(Boolean).join(' ')
const isOverdue = (a, today) => !a.completed_at && a.due_date && dayOf(a.due_date) < today

/**
 * Activities — the follow-up list.
 *
 * Defaults to open items rather than everything, because the question this
 * screen answers is "what do I still owe someone", not "what has happened".
 * Completed work is one click away but is not the landing state.
 */
export default function Activities() {
  const { t } = useI18n()
  const [filter, setFilter] = useState('open')
  const [showCreate, setShowCreate] = useState(false)

  const params = filter === 'open' ? { open_only: true } : filter === 'overdue' ? { overdue_only: true } : {}
  const { data, loading, error, refetch } = useResource([...KEY, params], () => crmAPI.listActivities(params))
  // Counters come from their own open-only fetch rather than from whatever the
  // view is currently showing. Deriving them from the filtered list would make
  // "Overdue: 0" mean "none overdue" on one view and "none in this view" on
  // another — the same number quietly answering two different questions.
  const openQuery = useResource([...KEY, { open_only: true }], () => crmAPI.listActivities({ open_only: true }))
  const activities = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const openItems = useMemo(() => (Array.isArray(openQuery.data) ? openQuery.data : []).filter((a) => !a.completed_at), [openQuery.data])

  const complete = useResourceMutation((a) => crmAPI.completeActivity(a.id), {
    invalidates: [KEY],
    onSuccess: (_d, a) => notify.success(`${a.subject} done`),
  })

  const today = startOfToday()
  const overdue = openItems.filter((a) => isOverdue(a, today))
  const dueToday = openItems.filter((a) => a.due_date && dayOf(a.due_date) === today)
  const countsKnown = !openQuery.loading && !openQuery.error

  const columns = useMemo(() => [
    {
      id: 'subject', header: 'Subject', accessor: 'subject', filter: 'text', minWidth: 240, mobile: 'title',
      cell: (a) => (
        <span className="block min-w-0">
          <span className={a.completed_at ? 'block truncate text-ink-500 line-through' : 'block truncate'}>{a.subject}</span>
          {a.notes && <span className="block truncate text-2xs text-ink-500">{a.notes}</span>}
        </span>
      ),
    },
    {
      id: 'type', header: 'Type', accessor: 'activity_type', filter: 'select', width: 110, mobile: 'meta',
      options: TYPES.map((v) => ({ value: v, label: TYPE_LABEL[v] })),
      cell: (a) => TYPE_LABEL[a.activity_type] || a.activity_type,
    },
    {
      id: 'link', header: 'Linked to', accessor: (a) => a.deal_title || contactName(a) || '', filter: 'text', minWidth: 200, mobile: 'subtitle',
      cell: (a) => (a.deal_title || contactName(a) ? (
        <span className="block min-w-0 truncate">
          {a.deal_number && <Code className="me-1.5">{a.deal_number}</Code>}
          {a.deal_title}
          {a.deal_title && contactName(a) ? ' · ' : ''}
          {contactName(a)}
        </span>
      ) : <span className="text-ink-400">—</span>),
    },
    {
      id: 'due', header: 'Due', accessor: 'due_date', width: 150, mobile: 'trailing',
      cell: (a) => (a.completed_at ? <span className="text-ink-500">Done <DateText value={a.completed_at} /></span> : a.due_date ? (
        <span className="flex items-center gap-1.5">
          <DateText value={a.due_date} />
          {isOverdue(a, today) && <span className="font-mono text-2xs text-risk-600" title="Past its due date">▲ overdue</span>}
        </span>
      ) : <span className="text-ink-400">No date</span>),
    },
  ], [today])

  return (
    <>
      <PageHeader
        title={t('crm.activities')}
        description="Calls, emails, meetings and follow-ups still owed to someone."
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setShowCreate(true)}>New activity</Button>}
      />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Open" value={countsKnown ? openItems.length : '—'} loading={openQuery.loading} reason="Still to do" onClick={() => setFilter('open')} />
        <Stat label="Due today" value={countsKnown ? dueToday.length : '—'} loading={openQuery.loading} />
        <Stat
          label="Overdue"
          value={countsKnown ? overdue.length : '—'}
          loading={openQuery.loading}
          reason={countsKnown ? (overdue.length ? 'Past their due date' : 'Nothing is late') : undefined}
          onClick={() => setFilter('overdue')}
        />
      </div>

      <DataTable
        viewKey="crm.activities"
        caption="Activities"
        noun="activity"
        rows={activities}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        defaultSort={{ id: 'due', dir: 'asc' }}
        searchPlaceholder="Search subject, deal, contact"
        toolbarStart={<Segmented label="Show" value={filter} onChange={setFilter} options={FILTERS} />}
        rowActions={(a) => (!a.completed_at ? (
          <RowAction icon={CheckIcon} label={`Mark ${a.subject} done`} onClick={() => complete.mutate(a)} />
        ) : null)}
        empty={{
          icon: ClipboardDocumentCheckIcon,
          title: filter === 'overdue' ? 'Nothing is overdue' : filter === 'open' ? 'Nothing open' : 'No activities yet',
          description: filter === 'overdue' ? 'Every open follow-up is still within its due date.' : 'Schedule a call, meeting or task, or log a note about something that already happened.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setShowCreate(true)}>New activity</Button>,
        }}
      />

      {showCreate && <ActivityDialog onClose={() => setShowCreate(false)} />}
    </>
  )
}

function ActivityDialog({ onClose }) {
  const [form, setForm] = useState({ activity_type: 'CALL', subject: '', notes: '', due_date: '', deal_id: '', contact_id: '' })
  const [touched, setTouched] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  // The links are optional — an activity with neither is still valid, so a
  // failed lookup leaves the selects empty rather than blocking the form.
  const { data: dealData } = useResource(['deals', 'pipeline', 'open'], () => crmAPI.listDeals({ open_only: true }), { retry: false })
  const { data: contactData } = useResource(['contacts', { limit: 200 }], () => crmAPI.listContacts({ limit: 200 }), { retry: false })
  const deals = Array.isArray(dealData) ? dealData : []
  const contacts = Array.isArray(contactData) ? contactData : []

  // A NOTE records something that already happened, so the backend marks it
  // complete on arrival. Asking for a due date would imply otherwise.
  const isNote = form.activity_type === 'NOTE'
  const subjectError = !form.subject.trim() ? 'An activity needs a subject.' : null

  const create = useResourceMutation((payload) => crmAPI.createActivity(payload), { invalidates: [KEY], silent: true })

  const submit = async () => {
    setTouched(true)
    setSubmitted(true)
    if (subjectError) return
    setServerError(null)
    try {
      await create.mutateAsync({
        activity_type: form.activity_type,
        subject: form.subject.trim(),
        notes: form.notes.trim() || undefined,
        due_date: isNote ? undefined : (form.due_date || undefined),
        deal_id: form.deal_id || undefined,
        contact_id: form.contact_id || undefined,
      })
      notify.success(isNote ? 'Note logged' : 'Activity scheduled')
      onClose()
    } catch (err) {
      setServerError(err?.response?.data?.error || 'Could not save that activity.')
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="New activity"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>{isNote ? 'Log note' : 'Schedule activity'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {submitted && subjectError && <ErrorSummary errors={{ 'activity-subject': subjectError }} />}
        {serverError && <InlineNotice tone="risk" title="The activity was not saved">{serverError}</InlineNotice>}
        <FormSection>
          <div className="min-w-0">
            <p className="mb-1 text-sm font-medium text-ink-800">Type</p>
            <Segmented
              label="Activity type"
              size="md"
              value={form.activity_type}
              onChange={(v) => setForm((f) => ({ ...f, activity_type: v }))}
              options={TYPES.map((v) => ({ value: v, label: TYPE_LABEL[v] }))}
              className="max-w-full overflow-x-auto"
            />
          </div>
          {isNote ? (
            <InlineNotice title="A note is filed as done">It records something that already happened, so it has no due date.</InlineNotice>
          ) : (
            <Field label="Due date" optional help="Leave blank if there is no deadline." id="activity-due">
              <Input type="date" value={form.due_date} onChange={set('due_date')} />
            </Field>
          )}
          <Field label="Subject" required id="activity-subject" error={touched ? subjectError : null} className="sm:col-span-2">
            <Input value={form.subject} onChange={set('subject')} onBlur={() => setTouched(true)} placeholder={isNote ? 'What happened?' : 'What needs doing?'} />
          </Field>
          <Field label="Deal" optional id="activity-deal">
            <Select value={form.deal_id} onChange={set('deal_id')}>
              <option value="">None</option>
              {deals.map((d) => <option key={d.id} value={d.id}>{d.deal_number} · {d.title}</option>)}
            </Select>
          </Field>
          <Field label="Contact" optional id="activity-contact">
            <Select value={form.contact_id} onChange={set('contact_id')}>
              <option value="">None</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{[c.first_name, c.last_name].filter(Boolean).join(' ')}</option>)}
            </Select>
          </Field>
          <Field label="Notes" optional id="activity-notes" className="sm:col-span-2">
            <Textarea rows={3} value={form.notes} onChange={set('notes')} />
          </Field>
        </FormSection>
      </div>
    </Dialog>
  )
}
