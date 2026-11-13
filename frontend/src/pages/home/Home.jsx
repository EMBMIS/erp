import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRightIcon, InboxArrowDownIcon, SparklesIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useCompany } from '../../contexts/CompanyContext'
import { useResource } from '../../hooks/useResource'
import { canSeeArea } from '../../constants/permissions'
import { useDecisionsHeldOpen } from '../../components/approvals/DecisionsHeldOpen'
import {
  PageHeader, Segmented, Card, Stat, Money, Num, Variance, Code, DateText, Badge, StatusBadge, Button, InlineNotice,
  SkeletonRows, Provenance, formatMoney, daysFrom,
} from '../../components/ui'
import { LineChart, BarChart, Distribution } from '../../components/ui/Chart'
import SimeliCard from '../../components/qira/SimeliCard'
import WhatMatters, { useWhatMatters } from '../../components/home/WhatMatters'
import BusinessMap from '../../components/home/BusinessMap'

/**
 * Home — a role-aware answer to "what needs me, and is anything wrong?"
 *
 * Four views of the same company: Executive (five numbers, each with a trend,
 * a reason and a link to the cause), Finance, Procurement and Warehouse. The
 * default follows the person's role; the choice is remembered. Every figure
 * links to the records behind it. Nothing is invented: a reading the server
 * cannot give is shown as "—" with the reason, never as a zero.
 */
const VIEW_KEY = 'embmis.home.view'
const OPEN_PO = new Set(['APPROVED', 'SENT_TO_SUPPLIER', 'CONFIRMED', 'PREPARING_DELIVERY', 'IN_TRANSIT', 'DELIVERED', 'GOODS_READY_FOR_RECEIPT', 'PARTIALLY_RECEIVED'])
const DONE_PO = new Set(['FULLY_RECEIVED', 'CUSTOMER_CONFIRMED', 'DELIVERED_TO_CUSTOMER', 'CANCELLED', 'CLOSED', 'REJECTED'])
const get = (path, params) => ({ signal }) => api.get(path, { params, signal })
// Endpoints that answer without the { success, data } envelope: hand the whole body over.
const raw = (path, params) => async ({ signal }) => ({ data: { success: true, data: (await api.get(path, { params, signal })).data } })
const list = (d) => (Array.isArray(d) ? d : d?.data || d?.rows || [])
const today = () => new Date().toISOString().slice(0, 10)

function defaultView(role) {
  if (role === 'FINANCE_MANAGER' || role === 'FINANCE_USER') return 'finance'
  if (role === 'ADMIN' || role === 'MANAGER') return 'executive'
  return 'procurement'
}

/** Last full month vs the month before, from a kpi-series row. */
function monthChange(series, field = 'value') {
  if (!series || series.length < 2) return null
  const a = Number(series[series.length - 2][field]) || 0
  const b = Number(series[series.length - 1][field]) || 0
  if (!a) return null
  return ((b - a) / a) * 100
}

function Row({ to, children, aside }) {
  return (
    <li>
      <Link to={to} className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-50">
        <span className="min-w-0 flex-1">{children}</span>
        {aside}
        <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
      </Link>
    </li>
  )
}

function ListCard({ title, description, loading, empty, children, action }) {
  return (
    <Card title={title} description={description} padded={false} actions={action}>
      {loading ? <SkeletonRows rows={3} columns={2} /> : children ? <ul className="divide-y divide-ink-100">{children}</ul> : <p className="px-4 py-4 text-sm text-ink-600">{empty}</p>}
    </Card>
  )
}

export default function Home() {
  const { user } = useAuth()
  const { current: company } = useCompany()
  const role = user?.role
  const finance = canSeeArea(role, 'finance')
  const [view, setViewState] = useState(() => { try { return localStorage.getItem(VIEW_KEY) || defaultView(role) } catch { return defaultView(role) } })
  const setView = (v) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v) } catch { /* ignore */ } }

  const held = useDecisionsHeldOpen()
  const { data: brief, loading: briefLoading } = useWhatMatters()
  const { data: cash, loading: cashLoading } = useResource(['home', 'cash'], raw('/financial-reports/cashflow-forecast'), { enabled: finance })
  const { data: ar, loading: arLoading } = useResource(['home', 'ar'], get('/customer-invoices/stats'), { enabled: finance })
  const { data: ap, loading: apLoading } = useResource(['home', 'ap'], get('/supplier-invoices/stats'), { enabled: finance })
  const { data: fin } = useResource(['home', 'fin'], raw('/finance/dashboard'), { enabled: finance })
  const { data: periods, loading: periodsLoading } = useResource(['home', 'periods'], get('/accounting-periods'), { enabled: finance })
  const { data: findings, loading: findingsLoading } = useResource(['home', 'findings'], get('/ai-findings', { status: 'OPEN' }))
  const { data: inv, loading: invLoading } = useResource(['inventory-items', 'stats'], get('/inventory-items/stats'))
  const { data: rawItems } = useResource(['inventory-items', { limit: 2000 }], get('/inventory-items', { limit: 2000 }))
  const { data: rawPos, loading: posLoading } = useResource(['purchase-orders', { limit: 1000, offset: 0 }], get('/purchase-orders', { limit: 1000, offset: 0 }))
  const { data: schedules } = useResource(['home', 'schedules'], get('/delivery-schedules', { status: 'SCHEDULED' }))
  const { data: seriesData } = useResource(['home', 'series'], get('/kpi-series', { entities: 'purchase_orders,customer_invoices,sales_orders', months: 6 }))

  const pos = list(rawPos)
  const items = list(rawItems)
  const series = seriesData || {}
  const decisions = held.data?.decisions || []
  const yours = decisions.filter((d) => d.yours_to_decide)
  const openFindings = list(findings)

  const po = useMemo(() => {
    const open = pos.filter((p) => OPEN_PO.has(p.status))
    const late = pos.filter((p) => p.delivery_date && !DONE_PO.has(p.status) && p.status !== 'DRAFT' && daysFrom(p.delivery_date) < 0)
    const waiting = pos.filter((p) => p.status === 'PENDING_APPROVAL')
    const arriving = open.filter((p) => p.delivery_date && daysFrom(p.delivery_date) >= -1 && daysFrom(p.delivery_date) <= 1)
    const ready = pos.filter((p) => p.status === 'GOODS_READY_FOR_RECEIPT')
    const drafts = pos.filter((p) => p.status === 'DRAFT')
    const sum = (arr) => arr.reduce((s, p) => s + (Number(p.total_amount) || 0), 0)
    return { open, late, waiting, arriving, ready, drafts, openValue: sum(open), waitingValue: sum(waiting) }
  }, [pos])
  const short = items.filter((i) => (Number(i.current_stock_quantity) || 0) <= 0)
  const shipsToday = list(schedules).filter((s) => String(s.scheduled_date || '').slice(0, 10) === today())

  // Chart data — every series comes from records already loaded above.
  const mon = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short' })
  const monthly = (rows, field) => (rows || []).map((r) => ({ x: mon(r.month), y: Number(r[field]) || 0 }))
  const money0 = (v) => formatMoney(v, 'USD', 0)
  const toneOf = (status) => {
    const st = String(status || '').toUpperCase()
    if (/REJECT|CANCEL/.test(st)) return 'risk'
    if (/PENDING|DRAFT/.test(st)) return st === 'DRAFT' ? 'ink' : 'warn'
    if (/RECEIVED|CLOSED|CONFIRMED/.test(st)) return 'ok'
    return 'ink'
  }
  const pretty = (st) => String(st || 'Unknown').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  const groupBy = (rows, key, val = () => 1) => {
    const m = new Map()
    rows.forEach((r) => { const k = key(r); m.set(k, (m.get(k) || 0) + val(r)) })
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }
  const poByStatus = groupBy(pos, (p) => p.status).map(([k, v]) => ({ label: pretty(k), value: v, tone: toneOf(k), to: '/procurement/purchase-orders' }))
  const spendBySupplier = groupBy(pos.filter((p) => !['DRAFT', 'REJECTED', 'CANCELLED'].includes(p.status)), (p) => p.supplier_name || 'Unknown', (p) => Number(p.total_amount) || 0)
    .slice(0, 5).map(([k, v]) => ({ label: k, value: v }))
  const decisionsByKind = groupBy(decisions, (d) => d.kind_label || 'Other', (d) => Number(d.value) || 0).map(([k, v]) => ({ label: k, value: v, to: '/approvals/unified' }))
  const totalItems = Number(inv?.total_items) || items.length
  const outN = Number(inv?.out_of_stock) || 0
  const lowN = Number(inv?.low_stock) || 0
  const stockHealth = [
    { label: 'In stock', value: Math.max(0, totalItems - outN - lowN), tone: 'ok', to: '/inventory/items' },
    { label: 'Below reorder point', value: lowN, tone: 'warn', to: '/inventory/items' },
    { label: 'Out of stock', value: outN, tone: 'risk', to: '/inventory/items' },
  ]
  const itemsByCategory = groupBy(items, (i) => i.item_category || 'Uncategorised').slice(0, 6).map(([k, v]) => ({ label: k, value: v }))
  const simeliNotes = [
    ...(brief?.items || []).slice(0, 3).map((i) => i.title),
    yours.length && `${yours.length} decision${yours.length === 1 ? ' is' : 's are'} waiting on you, ${formatMoney(yours.reduce((s, d) => s + (Number(d.value) || 0), 0), 'USD', 0)} in total.`,
    po.late.length && `${po.late.length} purchase order${po.late.length === 1 ? ' is' : 's are'} past the delivery date.`,
    outN && `${outN} item${outN === 1 ? ' is' : 's are'} out of stock.`,
    Number(ar?.overdue_count) && `${ar.overdue_count} customer invoice${Number(ar.overdue_count) === 1 ? ' is' : 's are'} overdue.`,
    openFindings.length && `${openFindings.length} open finding${openFindings.length === 1 ? '' : 's'} in the ledger.`,
  ].filter(Boolean)
  const simeliBusy = held.loading || posLoading || invLoading || briefLoading

  const weeks = cash?.forecast_weeks || []
  const lowest = weeks.reduce((m, w) => (m == null || w.p50 < m.p50 ? w : m), null)
  const currentPeriod = list(periods).find((p) => Number(p.year) === new Date().getFullYear() && Number(p.month) === new Date().getMonth() + 1)

  const greeting = (() => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening' })()
  const views = [
    { value: 'executive', label: 'Executive' },
    ...(finance ? [{ value: 'finance', label: 'Finance' }] : []),
    { value: 'procurement', label: 'Procurement' },
    { value: 'warehouse', label: 'Warehouse' },
  ]
  const activeView = views.some((v) => v.value === view) ? view : 'procurement'

  return (
    <div className="space-y-5">
      <PageHeader
        title={`${greeting}, ${user?.first_name || 'there'}`}
        description={`${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · ${company?.name || ''}`}
        secondary={<Segmented label="View" options={views} value={activeView} onChange={setView} size="md" />}
      />

      {(yours.length > 0 || openFindings.length > 0) && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {yours.length > 0 && (
            <InlineNotice tone="brand" title={`${yours.length} decision${yours.length === 1 ? '' : 's'} waiting on you`} action={<Button size="sm" variant="primary" to="/my-work">Open my work</Button>}>
              Largest: <Code>{[...yours].sort((a, b) => b.value - a.value)[0].number}</Code>, {formatMoney([...yours].sort((a, b) => b.value - a.value)[0].value, yours[0].currency, 0)}.
            </InlineNotice>
          )}
          {openFindings.length > 0 && (
            <InlineNotice tone="warn" title={`${openFindings.length} open finding${openFindings.length === 1 ? '' : 's'} from Simeli`} action={<Button size="sm" to="/ai/findings">Review</Button>}>
              {openFindings[0].title || openFindings[0].summary || 'Something in the ledger looks unusual.'}
            </InlineNotice>
          )}
        </div>
      )}

      <BusinessMap />
      <WhatMatters />

      {activeView === 'executive' && (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <SimeliCard className="xl:col-span-3" notes={simeliNotes} busy={simeliBusy} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:col-span-9">
            <Stat
              label="Revenue, this period"
              value={finance ? <Money amount={fin?.kpis?.totalRevenue} digits={0} /> : '—'}
              reason={finance ? (Number(fin?.kpis?.totalRevenue) ? `Net income ${formatMoney(fin?.kpis?.netIncome, 'USD', 0)}` : 'Nothing posted to revenue yet this period.') : 'Finance figures are not in your role.'}
              to={finance ? '/finance/reports/income-statement' : undefined}
            />
            <Stat
              label="Cash position"
              value={finance ? <Provenance method="Opening balance of cash and bank accounts in the ledger, as used by the 13-week cash forecast." sources={[{ label: 'Cash forecast', to: '/finance/cash-forecast' }]}><Money amount={cash?.starting_cash} digits={0} /></Provenance> : '—'}
              loading={finance && cashLoading}
              reason={finance && lowest ? (lowest.p50 < 0 ? `Forecast goes below zero in the week of ${new Date(lowest.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}.` : `Lowest point in 13 weeks: ${formatMoney(lowest.p50, 'USD', 0)}.`) : undefined}
              to={finance ? '/finance/cash-forecast' : undefined}
            />
            <Stat
              label="Overdue receivables"
              value={finance ? <Money amount={ar?.overdue_amount} digits={0} /> : '—'}
              loading={finance && arLoading}
              reason={finance ? (Number(ar?.overdue_count) ? `${ar.overdue_count} invoice${ar.overdue_count === 1 ? '' : 's'} past due.` : 'Nothing past due.') : undefined}
              to={finance ? '/finance/customer-invoices' : undefined}
            />
            <Stat
              label="Open purchase commitments"
              value={<Money amount={po.openValue} digits={0} />}
              loading={posLoading}
              delta={monthChange(series.purchase_orders) != null ? <Variance value={monthChange(series.purchase_orders)} goodWhen="down" label="vs last month" /> : undefined}
              reason={`${po.open.length} order${po.open.length === 1 ? '' : 's'} open${po.late.length ? `, ${po.late.length} late` : ''}.`}
              to="/procurement/purchase-orders"
            />
            <Stat
              label="Value awaiting decisions"
              value={<Money amount={held.data?.summary?.value_awaiting} digits={0} />}
              loading={held.loading}
              reason={held.data?.summary ? `${held.data.summary.awaiting} decisions, ${held.data.summary.escalated} escalated.` : undefined}
              to="/approvals/unified"
            />
              <Card title="Decisions by kind" description="Value waiting for approval">
                <Distribution items={decisionsByKind} format={money0} emptyText="Nothing waiting for a decision." />
              </Card>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card title="Purchasing" description="Purchase order value per month">
              <BarChart points={monthly(series.purchase_orders, 'value')} format={money0} title="Last six months" />
            </Card>
            <Card title="Sales orders" description="Orders taken per month">
              <BarChart points={monthly(series.sales_orders, 'count')} title="Last six months" />
            </Card>
            <Card title="Invoiced" description="Customer invoice value per month">
              <BarChart points={monthly(series.customer_invoices, 'value')} format={money0} title="Last six months" emptyText="No customer invoices yet." />
            </Card>
          </div>
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
            {finance && (
              <Card title="Cash position" description="13-week forecast with its likely range" className="lg:col-span-2">
                {cashLoading ? <SkeletonRows rows={4} columns={1} /> : weeks.some((w) => Number(w.p10) || Number(w.p50) || Number(w.p90)) ? (
                  <LineChart
                    title="Expected cash balance by week"
                    points={weeks.map((w) => ({ x: new Date(w.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), y: w.p50, lo: w.p10, hi: w.p90 }))}
                    format={money0}
                    threshold={weeks.some((w) => w.p10 < 0) ? 0 : undefined}
                    thresholdLabel="Zero"
                  />
                ) : <p className="py-6 text-sm text-ink-600">Nothing to forecast yet: no cash or bank balance in the ledger and no open invoices or bills.</p>}
              </Card>
            )}
            <Card title="Purchase orders by status" description={`${pos.length} orders`}>
              <Distribution items={poByStatus} emptyText="No purchase orders yet." />
            </Card>
            <Card title="Spend by supplier" description="Top five, submitted orders">
              <Distribution items={spendBySupplier} format={money0} emptyText="No submitted orders yet." />
            </Card>
            <Card title="Stock health" description={`${totalItems} items`}>
              <Distribution items={stockHealth} emptyText="No inventory items yet." />
            </Card>
          </div>
        </>
      )}

      {activeView === 'finance' && finance && (
        <div className="columns-1 gap-4 lg:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid">
          <SimeliCard size="sm" notes={simeliNotes} busy={simeliBusy} />
          <Card title="Cash position" description="13-week forecast: expected balance with its likely range">
            {cashLoading ? <SkeletonRows rows={4} columns={1} /> : weeks.some((w) => Number(w.p10) || Number(w.p50) || Number(w.p90)) ? (
              <LineChart
                title="Expected cash balance by week"
                points={weeks.map((w) => ({ x: new Date(w.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), y: w.p50, lo: w.p10, hi: w.p90 }))}
                format={(v) => formatMoney(v, 'USD', 0)}
                threshold={weeks.some((w) => w.p10 < 0) ? 0 : undefined}
                thresholdLabel="Zero"
              />
            ) : <p className="text-sm text-ink-600">Nothing to forecast yet: no cash or bank balance in the ledger and no open invoices or bills. The forecast appears once money moves.</p>}
          </Card>
          <div className="space-y-4">
            <Stat label="Overdue receivables" value={<Money amount={ar?.overdue_amount} digits={0} />} loading={arLoading} reason={`${ar?.overdue_count || 0} of ${ar?.open_count || 0} open invoices are past due.`} to="/finance/customer-invoices" />
            <Stat label="Payables overdue" value={<Money amount={ap?.overdue_amount} digits={0} />} loading={apLoading} reason={`${ap?.overdue_count || 0} supplier bills past due; ${formatMoney(ap?.total_outstanding, 'USD', 0)} outstanding in total.`} to="/finance/supplier-invoices" />
          </div>
          <Card title="This month's close" description={new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}>
            {periodsLoading ? <SkeletonRows rows={2} columns={1} /> : currentPeriod ? (
              <div className="space-y-2 text-sm">
                <p className="flex items-center gap-2"><StatusBadge status={currentPeriod.status || (currentPeriod.is_closed ? 'CLOSED' : 'OPEN')} /> <span className="text-ink-600">Period {currentPeriod.month}/{currentPeriod.year}</span></p>
                <Button size="sm" to="/finance/periods">Open period close</Button>
              </div>
            ) : (
              <InlineNotice tone="warn" title="No accounting period set up">Month-end close cannot run until periods exist. <Link className="font-medium underline" to="/finance/periods">Set up periods</Link>.</InlineNotice>
            )}
          </Card>
          <ListCard title="What looks wrong" description="Open findings from Simeli's checks on the ledger" loading={findingsLoading} empty="Nothing unusual found in the ledger." action={<Button size="xs" variant="ghost" to="/ai/findings">All</Button>}>
            {openFindings.length ? openFindings.slice(0, 5).map((f) => (
              <Row key={f.id} to="/ai/findings" aside={f.severity ? <Badge tone={f.severity === 'HIGH' ? 'risk' : 'warn'}>{String(f.severity).toLowerCase()}</Badge> : null}>
                <span className="block truncate text-sm text-fg">{f.title || f.summary}</span>
              </Row>
            )) : null}
          </ListCard>
          <Card title="Invoiced" description="Customer invoice value per month" >
            <BarChart points={monthly(series.customer_invoices, 'value')} format={money0} title="Last six months" emptyText="No customer invoices yet." />
          </Card>
          <Card title="Receivables" description="Open customer invoices">
            <Distribution
              format={money0}
              emptyText="No open receivables."
              items={[
                { label: 'Current', value: Math.max(0, (Number(ar?.total_outstanding) || 0) - (Number(ar?.overdue_amount) || 0)), tone: 'ok', to: '/finance/customer-invoices' },
                { label: 'Overdue', value: Number(ar?.overdue_amount) || 0, tone: 'risk', to: '/finance/customer-invoices' },
              ]}
            />
          </Card>
          <Card title="Payables" description="Open supplier bills">
            <Distribution
              format={money0}
              emptyText="No open payables."
              items={[
                { label: 'Current', value: Math.max(0, (Number(ap?.total_outstanding) || 0) - (Number(ap?.overdue_amount) || 0)), tone: 'ok', to: '/finance/supplier-invoices' },
                { label: 'Overdue', value: Number(ap?.overdue_amount) || 0, tone: 'risk', to: '/finance/supplier-invoices' },
              ]}
            />
          </Card>
          <Card title="Period result" description="Posted to the ledger this period">
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between"><dt className="text-ink-600">Revenue</dt><dd><Money amount={fin?.kpis?.totalRevenue} digits={0} /></dd></div>
              <div className="flex justify-between"><dt className="text-ink-600">Expenses</dt><dd><Money amount={fin?.kpis?.totalExpenses} digits={0} /></dd></div>
              <div className="flex justify-between border-t border-ink-200 pt-1.5 font-medium"><dt>Net income</dt><dd><Money amount={fin?.kpis?.netIncome} digits={0} /></dd></div>
            </dl>
          </Card>
        </div>
      )}

      {activeView === 'procurement' && (
        <div className="columns-1 gap-4 lg:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid">
          <SimeliCard size="sm" notes={simeliNotes} busy={simeliBusy} />
          <Stat label="Needs ordering" value={<Num value={(Number(inv?.out_of_stock) || 0) + (Number(inv?.low_stock) || 0)} />} loading={invLoading} reason={`${inv?.out_of_stock || 0} out of stock, ${inv?.low_stock || 0} below reorder point.`} to="/inventory/items" />
          <Stat label="Waiting for approval" value={<Num value={po.waiting.length} />} loading={posLoading} reason={po.waiting.length ? `${formatMoney(po.waitingValue, 'USD', 0)} of spend waiting.` : 'Nothing waiting.'} to="/approvals/unified" />
          <Stat label="Late deliveries" value={<Num value={po.late.length} />} loading={posLoading} reason={po.late.length ? 'Past delivery date and not received.' : 'Every open order is on time.'} to="/procurement/purchase-orders" />
          <Card title="Purchasing" description="Purchase order value per month">
            <BarChart points={monthly(series.purchase_orders, 'value')} format={money0} title="Last six months" />
          </Card>
          <Card title="Purchase orders by status" description={`${pos.length} orders`}>
            <Distribution items={poByStatus} emptyText="No purchase orders yet." />
          </Card>
          <Card title="Spend by supplier" description="Top five, submitted orders">
            <Distribution items={spendBySupplier} format={money0} emptyText="No submitted orders yet." />
          </Card>
          <ListCard title="Late purchase orders" description="Oldest first" loading={posLoading} empty="No late orders.">
            {po.late.length ? [...po.late].sort((a, b) => new Date(a.delivery_date) - new Date(b.delivery_date)).slice(0, 6).map((p) => (
              <Row key={p.id} to={`/procurement/purchase-orders/${p.id}`} aside={<span className="text-xs font-medium text-risk-600">▲ {Math.abs(daysFrom(p.delivery_date))}d</span>}>
                <span className="flex items-center gap-2"><Code className="shrink-0 whitespace-nowrap text-sm">{p.po_number}</Code><span className="truncate text-sm text-ink-600">{p.supplier_name}</span></span>
              </Row>
            )) : null}
          </ListCard>
          <ListCard title="Out of stock" description="Approved items with nothing on hand" loading={invLoading} empty="Nothing is out of stock.">
            {short.length ? short.slice(0, 6).map((i) => (
              <Row key={i.id} to={`/inventory/items/${i.id}`} aside={<Badge tone="risk" glyph="triangle">Out</Badge>}>
                <span className="block truncate text-sm text-fg">{i.item_name}</span>
              </Row>
            )) : null}
          </ListCard>
          <ListCard title="Drafts to finish" description="Purchase orders not yet submitted" loading={posLoading} empty="No drafts." action={<Button size="xs" variant="ghost" to="/procurement/purchase-orders/create">New</Button>}>
            {po.drafts.length ? po.drafts.slice(0, 6).map((p) => (
              <Row key={p.id} to={`/procurement/purchase-orders/${p.id}`} aside={<Money amount={p.total_amount} currency={p.currency} className="text-sm" />}>
                <span className="flex items-center gap-2"><Code className="shrink-0 whitespace-nowrap text-sm">{p.po_number}</Code><span className="truncate text-sm text-ink-600">{p.supplier_name}</span></span>
              </Row>
            )) : null}
          </ListCard>
        </div>
      )}

      {activeView === 'warehouse' && (
        <div className="columns-1 gap-4 lg:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid">
          <SimeliCard size="sm" notes={simeliNotes} busy={simeliBusy} />
          <ListCard title="Ready to receive" description="Delivered and verified; book them in" loading={posLoading} empty="Nothing waiting at the dock." action={<Button size="xs" variant="primary" icon={InboxArrowDownIcon} to="/warehouse/transactions/goods-receipt">Receive</Button>}>
            {po.ready.length ? po.ready.map((p) => (
              <Row key={p.id} to="/warehouse/transactions/goods-receipt" aside={<span className="text-xs text-ink-500">{p.line_item_count} lines</span>}>
                <span className="flex items-center gap-2"><Code className="shrink-0 whitespace-nowrap text-sm">{p.po_number}</Code><span className="truncate text-sm text-ink-600">{p.supplier_name}</span></span>
              </Row>
            )) : null}
          </ListCard>
          <ListCard title="Arriving today" description="Open orders due within a day" loading={posLoading} empty="Nothing is due today.">
            {po.arriving.length ? po.arriving.map((p) => (
              <Row key={p.id} to={`/procurement/purchase-orders/${p.id}`} aside={<DateText value={p.delivery_date} className="text-xs text-ink-500" />}>
                <span className="flex items-center gap-2"><Code className="shrink-0 whitespace-nowrap text-sm">{p.po_number}</Code><span className="truncate text-sm text-ink-600">{p.supplier_name}</span></span>
              </Row>
            )) : null}
          </ListCard>
          <ListCard title="Ships today" description="Scheduled customer deliveries" empty="No deliveries scheduled for today." action={<Button size="xs" variant="ghost" to="/sales/delivery-schedules">All</Button>}>
            {shipsToday.length ? shipsToday.map((s) => (
              <Row key={s.id} to="/sales/delivery-schedules"><span className="block truncate text-sm text-fg">{s.customer_name || `Schedule ${s.id}`}</span></Row>
            )) : null}
          </ListCard>
          <ListCard title="Short" description="Items with nothing on hand" loading={invLoading} empty="Nothing is short.">
            {short.length ? short.slice(0, 8).map((i) => (
              <Row key={i.id} to={`/inventory/items/${i.id}`} aside={<Badge tone="risk" glyph="triangle">0 {i.unit_of_measure}</Badge>}>
                <span className="block truncate text-sm text-fg">{i.item_name}</span>
              </Row>
            )) : null}
          </ListCard>
          <Card title="Stock health" description={`${totalItems} items`}>
            <Distribution items={stockHealth} emptyText="No inventory items yet." />
          </Card>
          <Card title="Items by category" description="Inventory items">
            <Distribution items={itemsByCategory} emptyText="No inventory items yet." />
          </Card>
          <Card title="Quick actions">
            <div className="grid grid-cols-2 gap-2">
              <Button size="lg" to="/warehouse/transactions/goods-receipt">Receive goods</Button>
              <Button size="lg" to="/warehouse/transactions/goods-issue">Issue goods</Button>
              <Button size="lg" to="/warehouse/transactions/goods-transfer">Transfer</Button>
              <Button size="lg" to="/inventory/barcode-scanner">Scan</Button>
            </div>
          </Card>
        </div>
      )}

      <p className="flex items-center gap-1.5 text-xs text-ink-500">
        <SparklesIcon className="h-3.5 w-3.5" aria-hidden="true" />
        Ask anything about these numbers with <kbd className="font-mono">⌘K</kbd>. Every figure opens the records behind it.
      </p>
    </div>
  )
}
