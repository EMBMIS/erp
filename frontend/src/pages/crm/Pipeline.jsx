import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { PlusIcon, EllipsisHorizontalIcon, CheckCircleIcon, XCircleIcon, ArrowRightIcon } from '@heroicons/react/20/solid'
import { crmAPI, customersAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useCompany } from '../../contexts/CompanyContext'
import {
  PageHeader, Button, IconButton, Menu, Stat, Money, DateText, Dialog, ConfirmDialog, Field, Input, Select, InlineNotice,
  SkeletonRows, ErrorState, EmptyState, formatMoney, formatNumber, notify,
} from '../../components/ui'

/**
 * The sales pipeline board.
 *
 * Deals are dragged between stages, or moved from each card's menu (the
 * keyboard and touch path). Two behaviours are deliberate:
 *
 *   Won and Lost are drop targets but not columns. Closing a deal is a one-way
 *   door in the model — reopening would corrupt every win-rate and cycle-time
 *   figure — so showing them as ordinary columns would invite dragging back
 *   out of them and then explaining the refusal.
 *
 *   Marking a deal lost asks for a reason and will not proceed without one.
 *   The server enforces this too; asking here makes it a question rather than
 *   an error.
 */
const STAGES = ['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION']
const LABEL = { NEW: 'New', QUALIFIED: 'Qualified', PROPOSAL: 'Proposal', NEGOTIATION: 'Negotiation', WON: 'Won', LOST: 'Lost' }
const KEY = ['deals', 'pipeline']

export default function Pipeline() {
  const { currency } = useCompany()
  const [dragging, setDragging] = useState(null)
  const [over, setOver] = useState(null)
  const [creating, setCreating] = useState(false)
  const [lostFor, setLostFor] = useState(null)

  const { data: dealData, loading, error, refetch } = useResource([...KEY, 'open'], () => crmAPI.listDeals({ open_only: true }))
  const { data: summary } = useResource([...KEY, 'summary'], () => crmAPI.pipeline())
  const deals = useMemo(() => (Array.isArray(dealData) ? dealData : []), [dealData])

  const moveStage = useResourceMutation(({ deal, stage, lostReason }) => crmAPI.moveStage(deal.id, { stage, lost_reason: lostReason }), {
    invalidates: [KEY, ['crm']],
    silent: true,
  })

  const move = async (deal, stage, lostReason) => {
    if (deal.stage === stage) return
    try {
      await moveStage.mutateAsync({ deal, stage, lostReason })
      notify.success(`${deal.title} → ${LABEL[stage]}`)
      setLostFor(null)
    } catch (err) {
      notify.error(err?.response?.data?.error || 'Could not move that deal.')
    }
  }

  const request = (deal, stage) => (stage === 'LOST' ? setLostFor(deal) : move(deal, stage))

  const dropProps = (stage) => ({
    onDragOver: (e) => { e.preventDefault(); setOver(stage) },
    onDragLeave: () => setOver((o) => (o === stage ? null : o)),
    onDrop: (e) => {
      e.preventDefault()
      const deal = dragging
      setDragging(null)
      setOver(null)
      if (deal) request(deal, stage)
    },
  })

  const last = summary?.last_90_days || {}

  return (
    <>
      <PageHeader
        title="Pipeline"
        description="Open deals by stage. Drag a card to move it, or use its menu. Drop on Won or Lost to close it."
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setCreating(true)}>New deal</Button>}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Weighted value" loading={!summary} value={<Money amount={summary?.weighted_total} currency={currency} digits={0} />} reason="Each open deal's value × its probability." />
        <Stat label="Open pipeline" loading={!summary} value={<Money amount={summary?.open_total} currency={currency} digits={0} />} reason={`${formatNumber(deals.length)} open deal${deals.length === 1 ? '' : 's'}.`} />
        <Stat label="Won, last 90 days" loading={!summary} value={<Money amount={last.won_value} currency={currency} digits={0} />} reason={`${formatNumber(last.won_count)} deal${Number(last.won_count) === 1 ? '' : 's'} won.`} />
        <Stat
          label="Win rate, last 90 days"
          loading={!summary}
          // "0%" and "nothing has closed yet" mean different things; the model
          // returns null for the latter and it is shown as such.
          value={last.win_rate == null ? '—' : `${last.win_rate}%`}
          reason={last.note || `${formatNumber(last.lost_count)} lost.`}
        />
      </div>

      {error ? <ErrorState what="The pipeline" error={error} onRetry={refetch} /> : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {STAGES.map((stage) => {
              const inStage = deals.filter((d) => d.stage === stage)
              const stageSummary = summary?.stages?.find((s) => s.stage === stage)
              return (
                <section
                  key={stage}
                  aria-label={`${LABEL[stage]} — ${inStage.length} deals`}
                  {...dropProps(stage)}
                  className={clsx('flex min-h-[14rem] flex-col rounded-lg border bg-sunken', over === stage ? 'border-ink-500' : 'border-ink-200')}
                >
                  <header className="flex items-baseline justify-between gap-2 border-b border-ink-200 px-3 py-2">
                    <h2 className="text-sm font-semibold text-fg">{LABEL[stage]} <span className="ml-1 font-normal tabular-nums text-ink-500">{inStage.length}</span></h2>
                    <span className="text-xs tabular-nums text-ink-600">{formatMoney(stageSummary?.total_value ?? null, currency, 0)}</span>
                  </header>
                  <div className="flex-1 space-y-2 p-2">
                    {loading ? <SkeletonRows rows={2} columns={1} /> : inStage.map((deal) => (
                      <article
                        key={deal.id}
                        draggable
                        onDragStart={() => setDragging(deal)}
                        onDragEnd={() => { setDragging(null); setOver(null) }}
                        className={clsx('cursor-grab rounded-md border border-ink-200 bg-surface p-3 active:cursor-grabbing hover:border-ink-300', dragging?.id === deal.id && 'opacity-50')}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-fg">{deal.title}</p>
                            <p className="truncate text-xs text-ink-500">{deal.customer_name || 'No customer'}</p>
                          </div>
                          <Menu
                            label={`Move ${deal.title}`}
                            trigger={<IconButton icon={EllipsisHorizontalIcon} label={`Move ${deal.title}`} size="xs" className="-mr-1 -mt-1 shrink-0" />}
                            items={[
                              ...STAGES.filter((s) => s !== stage).map((s) => ({ label: `Move to ${LABEL[s]}`, icon: ArrowRightIcon, onSelect: () => move(deal, s) })),
                              { divider: true },
                              { label: 'Mark won', icon: CheckCircleIcon, onSelect: () => move(deal, 'WON') },
                              { label: 'Mark lost…', icon: XCircleIcon, tone: 'risk', onSelect: () => setLostFor(deal) },
                            ]}
                          />
                        </div>
                        <div className="mt-2 flex items-baseline justify-between gap-2">
                          <Money amount={deal.value} currency={deal.currency || currency} digits={0} className="text-sm font-semibold" />
                          <span className="text-xs tabular-nums text-ink-500">{deal.probability != null ? `${deal.probability}%` : '—'}</span>
                        </div>
                        {deal.expected_close_date && <p className="mt-1 text-xs text-ink-500">Expected close <DateText value={deal.expected_close_date} /></p>}
                      </article>
                    ))}
                    {!loading && !inStage.length && <p className="py-6 text-center text-xs text-ink-400">No deals</p>}
                  </div>
                </section>
              )
            })}
          </div>

          {!loading && !deals.length && (
            <EmptyState
              compact
              className="mt-4"
              title="No open deals"
              description="Create a deal for each opportunity you are working. It starts in New; move it along as it firms up."
              action={<Button variant="primary" icon={PlusIcon} onClick={() => setCreating(true)}>New deal</Button>}
            />
          )}

          {/* Closing targets, kept off the board itself — see the note above. */}
          <div className="mt-3 grid grid-cols-2 gap-3" aria-hidden={!dragging}>
            <div {...dropProps('WON')} className={clsx('flex items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-sm', over === 'WON' ? 'border-ok-500 bg-ok-50 text-ok-800' : 'border-ink-300 text-ink-600')}>
              <CheckCircleIcon className="h-4 w-4" aria-hidden="true" /> Drop here to mark won
            </div>
            <div {...dropProps('LOST')} className={clsx('flex items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-sm', over === 'LOST' ? 'border-risk-500 bg-risk-50 text-risk-800' : 'border-ink-300 text-ink-600')}>
              <XCircleIcon className="h-4 w-4" aria-hidden="true" /> Drop here to mark lost
            </div>
          </div>
        </>
      )}

      {creating && <DealDialog onClose={() => setCreating(false)} />}
      {lostFor && (
        <ConfirmDialog
          open
          onClose={() => setLostFor(null)}
          onConfirm={(reason) => move(lostFor, 'LOST', reason)}
          title={`Mark ${lostFor.title} lost?`}
          consequence="A lost deal leaves the pipeline and counts against the win rate. A lost deal with no reason is a lost lesson."
          reversible={false}
          requireReason
          reasonLabel="What happened?"
          reasonHelp="Price, timing, competitor… Reported with the win rate."
          confirmLabel="Mark lost"
          busy={moveStage.isPending}
        />
      )}
    </>
  )
}

function DealDialog({ onClose }) {
  const { currency } = useCompany()
  const [form, setForm] = useState({ title: '', customer_id: '', value: '', expected_close_date: '' })
  const [touched, setTouched] = useState(false)
  const [serverError, setServerError] = useState(null)
  const { data: customerData } = useResource(['customers', { limit: 200 }], () => customersAPI.getAll({ limit: 200 }))
  const customers = Array.isArray(customerData) ? customerData : customerData?.customers || []
  const create = useResourceMutation((payload) => crmAPI.createDeal(payload), { invalidates: [KEY, ['crm']], silent: true })
  const titleError = !form.title.trim() ? 'Name the deal — what is being sold, to whom.' : null

  const submit = async (e) => {
    e?.preventDefault()
    setTouched(true)
    if (titleError) return
    setServerError(null)
    try {
      await create.mutateAsync({
        ...form,
        customer_id: form.customer_id || null,
        value: Number(form.value) || 0,
        expected_close_date: form.expected_close_date || null,
      })
      notify.success('Deal created.')
      onClose()
    } catch (err) {
      setServerError(err?.response?.data?.error || 'Could not create that deal.')
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="New deal"
      description="Starts in the New stage."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>Create deal</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {serverError && <InlineNotice tone="risk" title="The deal was not created">{serverError}</InlineNotice>}
        <Field label="Deal" required id="deal-title" error={touched ? titleError : null}>
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} onBlur={() => setTouched(true)} autoComplete="off" />
        </Field>
        <Field label="Customer" optional id="deal-customer">
          <Select value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })}>
            <option value="">No customer yet</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Deal value" optional id="deal-value">
            <Input type="number" min="0" step="0.01" numeric suffix={currency} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
          </Field>
          <Field label="Expected close" optional id="deal-close">
            <Input type="date" value={form.expected_close_date} onChange={(e) => setForm({ ...form, expected_close_date: e.target.value })} />
          </Field>
        </div>
      </form>
    </Dialog>
  )
}
