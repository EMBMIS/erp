import { useMemo, useState } from 'react'
import { PlusIcon, ClockIcon, BanknotesIcon, DocumentTextIcon, EyeIcon, BriefcaseIcon } from '@heroicons/react/20/solid'
import { projectsAPI, customersAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useI18n } from '../../contexts/I18nContext'
import { useCompany } from '../../contexts/CompanyContext'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Money, Num, Code, DateText, Dialog, Field, Input, Select, Checkbox,
  FormSection, InlineNotice, ErrorSummary, ErrorState, SkeletonRows, DescriptionList, exportCsv, notify, formatNumber,
} from '../../components/ui'

/**
 * Projects list, with time logging and the billing run.
 *
 * The billing flow is deliberately two steps — preview, then confirm. Billing
 * turns hours into an invoice the customer sees and posts revenue to the
 * ledger; it is the least reversible thing in this module, and the preview is
 * the only realistic moment at which a mis-logged hour gets caught.
 */
const PROJECTS_KEY = ['projects']
const BILLING = { TIME_AND_MATERIALS: 'Time and materials', FIXED_PRICE: 'Fixed price', INTERNAL: 'Internal' }

export default function Projects() {
  const { t } = useI18n()
  const [showCreate, setShowCreate] = useState(false)
  const [logFor, setLogFor] = useState(null)
  const [billFor, setBillFor] = useState(null)
  const [pnlFor, setPnlFor] = useState(null)

  const { data, loading, error, refetch } = useResource([...PROJECTS_KEY, 'list'], () => projectsAPI.list())
  const projects = useMemo(() => (Array.isArray(data) ? data : []), [data])

  const columns = useMemo(() => [
    { id: 'code', header: 'Code', accessor: 'project_code', width: 130, mobile: 'meta', cell: (p) => <Code>{p.project_code}</Code> },
    {
      id: 'name', header: 'Project', accessor: 'name', filter: 'text', minWidth: 220, mobile: 'title',
      cell: (p) => (
        <span className="block min-w-0">
          <span className="block truncate">{p.name}</span>
          <span className="block truncate text-2xs text-ink-500">{p.customer_name || 'No customer'}</span>
        </span>
      ),
    },
    { id: 'customer', header: 'Customer', accessor: 'customer_name', filter: 'select', defaultHidden: true, mobile: 'subtitle' },
    { id: 'billing', header: 'Billing', accessor: (p) => BILLING[p.billing_type] || p.billing_type, filter: 'select', width: 160 },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 130, cell: (p) => <StatusBadge status={p.status} /> },
    {
      id: 'hours', header: 'Hours', accessor: (p) => Number(p.hours_logged) || 0, align: 'right', width: 130,
      cell: (p) => (
        <span className="tabular-nums">
          <Num value={p.hours_logged} digits={Number(p.hours_logged) % 1 ? 2 : 0} />
          {p.budget_hours ? <span className="text-ink-500"> / {formatNumber(p.budget_hours)}</span> : null}
        </span>
      ),
    },
    {
      id: 'unbilled', header: 'Unbilled hours', accessor: (p) => Number(p.hours_unbilled) || 0, align: 'right', filter: 'number', width: 130, mobile: 'trailing',
      cell: (p) => (Number(p.hours_unbilled) > 0 ? <Num value={p.hours_unbilled} digits={Number(p.hours_unbilled) % 1 ? 2 : 0} className="font-medium" /> : <span className="text-ink-400">—</span>),
    },
    { id: 'created', header: 'Created', accessor: 'created_at', width: 120, defaultHidden: true, cell: (p) => <DateText value={p.created_at} /> },
  ], [])

  return (
    <>
      <PageHeader
        title={t('projects.projects')}
        description="Client and internal work: time logged against it, and what is still to bill."
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setShowCreate(true)}>New project</Button>}
      />

      <DataTable
        viewKey="projects.list"
        caption="Projects"
        noun="project"
        rows={projects}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(p) => `/projects/${p.id}`}
        defaultSort={{ id: 'created', dir: 'desc' }}
        searchPlaceholder="Search code, project, customer"
        toolbar={<Button size="sm" icon={DocumentTextIcon} onClick={() => exportCsv(projects, columns, 'projects.csv')} disabled={!projects.length}>Export</Button>}
        rowActions={(p) => (
          <>
            <RowAction icon={EyeIcon} label={`Open ${p.project_code}`} to={`/projects/${p.id}`} />
            <RowAction icon={ClockIcon} label={`Log time on ${p.project_code}`} onClick={() => setLogFor(p)} />
            <RowAction icon={BanknotesIcon} label={`Profit and loss for ${p.project_code}`} onClick={() => setPnlFor(p)} />
            {Number(p.hours_unbilled) > 0 && <RowAction icon={DocumentTextIcon} label={`Bill ${p.project_code}`} onClick={() => setBillFor(p)} />}
          </>
        )}
        empty={{
          icon: BriefcaseIcon,
          title: 'No projects yet',
          description: 'A project collects the time logged against a piece of work and turns it into an invoice.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setShowCreate(true)}>New project</Button>,
        }}
      />

      {showCreate && <ProjectDialog onClose={() => setShowCreate(false)} />}
      {logFor && <LogTimeDialog project={logFor} onClose={() => setLogFor(null)} />}
      {billFor && <BillDialog project={billFor} onClose={() => setBillFor(null)} />}
      {pnlFor && <PnlDialog project={pnlFor} onClose={() => setPnlFor(null)} />}
    </>
  )
}

/**
 * Billing: preview first, then confirm.
 *
 * The preview surfaces the server's own warning about zero-rate entries rather
 * than inventing its own — those hours would bill at nothing, and finding out
 * after the invoice has gone is much worse than a warning here.
 */
export function BillDialog({ project, onClose }) {
  const { currency } = useCompany()
  const c = project.currency || currency
  const { data: preview, loading, error, refetch } = useResource([...PROJECTS_KEY, project.id, 'billing-preview'], () => projectsAPI.billingPreview(project.id), { retry: false })
  const bill = useResourceMutation(() => projectsAPI.bill(project.id, {}), {
    invalidates: [PROJECTS_KEY, ['project-time']],
    onSuccess: (d) => { notify.success(`Invoice ${d?.invoice?.invoice_number || ''} raised for ${formatNumber(d?.hours_billed, 2)} hours`); onClose() },
  })
  const entries = preview?.entries || []

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Bill ${project.name}`}
      description="Raises a customer invoice for the unbilled time below and posts the revenue. This cannot be undone from here."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => bill.mutate()} loading={bill.isPending} disabled={!entries.length}>
            {preview ? `Raise invoice for ${formatNumber(preview.hours, 2)} h` : 'Raise invoice'}
          </Button>
        </>
      }
    >
      {loading ? <SkeletonRows rows={4} columns={4} /> : error ? <ErrorState compact what="The billing preview" error={error} onRetry={refetch} /> : (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between rounded-md border border-ink-200 bg-sunken px-4 py-3">
            <span className="text-sm text-ink-600"><Num value={preview.hours} digits={2} /> hours</span>
            <Money amount={preview.amount} currency={c} className="text-lg font-semibold" />
          </div>
          {preview.warning && <InlineNotice tone="warn" title="Check before billing">{preview.warning}</InlineNotice>}
          <div className="max-h-64 overflow-auto rounded-md border border-ink-200 ui-scroll">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-sunken text-left text-xs text-ink-600">
                <tr>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Work</th>
                  <th className="px-3 py-2 text-right font-medium">Hours</th>
                  <th className="px-3 py-2 text-right font-medium">Rate</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-t border-ink-100">
                    <td className="px-3 py-1.5 text-ink-600"><DateText value={e.entry_date} /></td>
                    <td className="px-3 py-1.5">{e.description || e.task_name || '—'}</td>
                    <td className="px-3 py-1.5 text-right"><Num value={e.hours} digits={2} /></td>
                    <td className="px-3 py-1.5 text-right">
                      {Number(e.hourly_rate) ? <Money amount={e.hourly_rate} currency={c} /> : <span className="font-medium text-warn-700" title="This entry would bill at nothing">0 — no rate</span>}
                    </td>
                  </tr>
                ))}
                {!entries.length && <tr><td colSpan={4} className="px-3 py-4 text-center text-ink-500">No unbilled time on this project.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Dialog>
  )
}

export function PnlDialog({ project, onClose }) {
  const { currency } = useCompany()
  const { data: pnl, loading, error, refetch } = useResource([...PROJECTS_KEY, project.id, 'pnl'], () => projectsAPI.pnl(project.id), { retry: false })
  const c = pnl?.project?.currency || project.currency || currency

  return (
    <Dialog open onClose={onClose} title={`Profit and loss — ${project.name}`} footer={<Button onClick={onClose}>Close</Button>}>
      {loading ? <SkeletonRows rows={5} columns={2} /> : error ? <ErrorState compact what="These figures" error={error} onRetry={refetch} /> : (
        <div className="space-y-3">
          <DescriptionList
            items={[
              { label: 'Revenue invoiced', value: <Money amount={pnl.revenue?.invoiced} currency={c} /> },
              Number(pnl.revenue?.unbilled_wip) > 0 && { label: 'Unbilled work in progress', value: <Money amount={pnl.revenue.unbilled_wip} currency={c} /> },
              { label: 'Labour cost', value: <Money amount={pnl.cost?.labour} currency={c} /> },
              { label: 'Other cost', value: <Money amount={pnl.cost?.other} currency={c} /> },
              { label: 'Margin', value: <span className="font-semibold"><Money amount={pnl.margin} currency={c} className={Number(pnl.margin) < 0 ? 'text-risk-700' : ''} />{pnl.margin_pct != null ? <span className="ml-1 text-ink-500">({pnl.margin_pct}%)</span> : null}</span> },
              { label: 'Hours logged', value: <Num value={pnl.hours?.logged} digits={2} /> },
              pnl.hours?.budget && { label: 'Budget hours', value: <span><Num value={pnl.hours.budget} /> <span className="text-ink-500">({pnl.hours.budget_used_pct}% used)</span></span> },
            ]}
          />
          {/* Zero labour cost almost always means cost rates were never set, not
              that the work was free — the server says so and it is shown. */}
          {pnl.cost?.note && <InlineNotice tone="warn">{pnl.cost.note}</InlineNotice>}
        </div>
      )}
    </Dialog>
  )
}

export function LogTimeDialog({ project, onClose, invalidates = [] }) {
  const [form, setForm] = useState({ entry_date: new Date().toISOString().split('T')[0], hours: '', description: '', billable: true })
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const log = useResourceMutation((payload) => projectsAPI.logTime(payload), {
    invalidates: [PROJECTS_KEY, ['project-time'], ...invalidates],
    onSuccess: () => { notify.success('Time logged'); onClose() },
  })

  const h = Number(form.hours)
  const errors = {
    'log-date': !form.entry_date ? 'Pick the day the work was done.' : null,
    'log-hours': !form.hours ? 'Enter the hours worked.' : !(h >= 0.25 && h <= 24) ? 'Between 0.25 and 24 hours.' : null,
  }
  const blocking = Object.values(errors).some(Boolean)

  const submit = (e) => {
    e?.preventDefault()
    setSubmitted(true)
    if (blocking) return
    log.mutate({ ...form, project_id: project.id, hours: h })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Log time — ${project.name}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} loading={log.isPending}>Log time</Button></>}
    >
      <form onSubmit={submit} className="space-y-4">
        {submitted && blocking && <ErrorSummary errors={errors} />}
        <FormSection>
          <Field label="Date" required id="log-date" error={(touched.date || submitted) ? errors['log-date'] : null}>
            <Input type="date" value={form.entry_date} onChange={set('entry_date')} onBlur={() => setTouched((t) => ({ ...t, date: true }))} />
          </Field>
          <Field label="Hours" required id="log-hours" help="In quarter hours, up to 24." error={(touched.hours || submitted) ? errors['log-hours'] : null}>
            <Input type="number" min="0.25" max="24" step="0.25" inputMode="decimal" value={form.hours} onChange={set('hours')} onBlur={() => setTouched((t) => ({ ...t, hours: true }))} />
          </Field>
          <Field label="What was done" optional id="log-desc" className="sm:col-span-2">
            <Input value={form.description} onChange={set('description')} />
          </Field>
          <Checkbox className="sm:col-span-2" label="Billable" description="Billable time appears on the next invoice for this project." checked={form.billable} onChange={(e) => setForm((f) => ({ ...f, billable: e.target.checked }))} />
        </FormSection>
        <button type="submit" className="sr-only" tabIndex={-1}>Log time</button>
      </form>
    </Dialog>
  )
}

function ProjectDialog({ onClose }) {
  const [form, setForm] = useState({ name: '', customer_id: '', billing_type: 'TIME_AND_MATERIALS', default_hourly_rate: '', fixed_price: '', budget_hours: '' })
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const touch = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const { data: customerData } = useResource(['customers', { limit: 200 }], () => customersAPI.getAll({ limit: 200 }), { retry: false })
  const customers = Array.isArray(customerData) ? customerData : customerData?.customers || []

  const create = useResourceMutation((payload) => projectsAPI.create(payload), {
    invalidates: [PROJECTS_KEY],
    onSuccess: () => { notify.success('Project created'); onClose() },
  })

  const isFixed = form.billing_type === 'FIXED_PRICE'
  const isInternal = form.billing_type === 'INTERNAL'
  // Mirrors the server-side rule in models/Project.js: a T&M project billed
  // to a real customer needs a rate to bill against, or invoicing it later
  // silently produces nothing to invoice.
  const needsHourlyRate = form.billing_type === 'TIME_AND_MATERIALS' && !!form.customer_id

  const errors = {
    'project-name': !form.name.trim() ? 'Give the project a name.' : null,
    'project-fixed': isFixed && form.fixed_price === '' ? 'A fixed-price project needs its price.' : null,
    'project-rate': needsHourlyRate && !(Number(form.default_hourly_rate) > 0) ? 'A time-and-materials project needs a default hourly rate to bill against.' : null,
  }
  const blocking = Object.values(errors).some(Boolean)
  const show = (k, id) => ((touched[k] || submitted) ? errors[id] : null)

  const submit = () => {
    setSubmitted(true)
    if (blocking) return
    create.mutate({
      ...form,
      customer_id: form.customer_id || null,
      default_hourly_rate: form.default_hourly_rate ? Number(form.default_hourly_rate) : null,
      fixed_price: form.fixed_price ? Number(form.fixed_price) : null,
      budget_hours: form.budget_hours ? Number(form.budget_hours) : null,
    })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="New project"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} loading={create.isPending}>Create project</Button></>}
    >
      <div className="space-y-4">
        {submitted && blocking && <ErrorSummary errors={errors} />}
        <FormSection>
          <Field label="Name" required id="project-name" error={show('name', 'project-name')} className="sm:col-span-2">
            <Input value={form.name} onChange={set('name')} onBlur={touch('name')} />
          </Field>
          <Field label="Billing" id="project-billing">
            <Select value={form.billing_type} onChange={set('billing_type')}>
              <option value="TIME_AND_MATERIALS">Time and materials</option>
              <option value="FIXED_PRICE">Fixed price</option>
              <option value="INTERNAL">Internal — never billed</option>
            </Select>
          </Field>
          {!isInternal && (
            <Field label="Customer" optional id="project-customer">
              <Select value={form.customer_id} onChange={set('customer_id')}>
                <option value="">None</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name || c.name}</option>)}
              </Select>
            </Field>
          )}
          {isFixed ? (
            <Field label="Fixed price" required id="project-fixed" error={show('fixed', 'project-fixed')}>
              <Input type="number" min="0" step="0.01" inputMode="decimal" value={form.fixed_price} onChange={set('fixed_price')} onBlur={touch('fixed')} />
            </Field>
          ) : !isInternal && (
            <Field label="Default hourly rate" required={needsHourlyRate} optional={!needsHourlyRate} id="project-rate" help={needsHourlyRate ? 'Required to bill this customer for time.' : undefined} error={show('rate', 'project-rate')}>
              <Input type="number" min="0" step="0.01" inputMode="decimal" value={form.default_hourly_rate} onChange={set('default_hourly_rate')} onBlur={touch('rate')} />
            </Field>
          )}
          <Field label="Budget hours" optional id="project-budget">
            <Input type="number" min="0" step="0.5" inputMode="decimal" value={form.budget_hours} onChange={set('budget_hours')} />
          </Field>
        </FormSection>
      </div>
    </Dialog>
  )
}
