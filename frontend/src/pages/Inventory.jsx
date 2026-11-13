import { Link } from 'react-router-dom'
import { ChevronRightIcon, PlusIcon, InboxArrowDownIcon, QrCodeIcon } from '@heroicons/react/20/solid'
import api, { auditTrailAPI, inventoryItemsAPI, warehouseTransactionsAPI } from '../services/api'
import { useResource } from '../hooks/useResource'
import {
  PageHeader, Button, Card, Stat, Badge, Code, Num, LineChart, Distribution, SkeletonRows, EmptyState, InlineNotice,
  formatMoney, formatNumber, relativeTime,
} from '../components/ui'

/**
 * Inventory — what stock is worth, what needs reordering, and what moved.
 *
 * Value is quantity × unit price throughout; there is no separate valuation.
 * The value line is reconstructed — today's valuation walked back through the
 * posted movements — so it is exact at the right edge and an estimate to the
 * left, and the card says so. Count accuracy is the share of counted
 * stocktake lines that matched the book; nothing counted reports "—", not 100%.
 */
const RECENT = 6
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const rows = (d) => (Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [])
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (m) => `${MONTHS[Number(String(m).slice(5, 7)) - 1]} ${String(m).slice(2, 4)}`
const humanize = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
const unavailable = (e) => (e ? (e?.response?.status === 403 ? 'Not available for your role' : 'Could not be loaded') : null)
const TX = { GR: 'Goods receipt', GI: 'Goods issue', GE: 'Goods return', GT: 'Transfer', SA: 'Stock adjustment' }

function useOverview(key, fn) {
  return useResource(['inventory-overview', key], () => fn(), { retry: false })
}

function Row({ to, title, subtitle, trailing, badge }) {
  const Tag = to ? Link : 'div'
  return (
    <li>
      <Tag to={to} className="flex min-h-[48px] items-center gap-3 px-4 py-2.5 hover:bg-ink-50">
        {badge}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg">{title}</span>
          {subtitle && <span className="block truncate text-xs text-ink-500">{subtitle}</span>}
        </span>
        {trailing && <span className="shrink-0 text-right text-sm tabular-nums">{trailing}</span>}
        {to && <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />}
      </Tag>
    </li>
  )
}

function ListCard({ title, to, loading, error, emptyText, children }) {
  return (
    <Card title={title} padded={false} actions={to ? <Button size="sm" variant="ghost" to={to}>View all</Button> : null}>
      {loading ? <SkeletonRows rows={3} columns={2} /> : error ? <p className="px-4 py-3 text-sm text-ink-600">{unavailable(error)}.</p> : children?.length ? <ul className="divide-y divide-ink-100">{children}</ul> : <p className="px-4 py-3 text-sm text-ink-600">{emptyText}</p>}
    </Card>
  )
}

export default function Inventory() {
  const analytics = useOverview('analytics', () => inventoryItemsAPI.analytics(12, 90))
  const transactions = useOverview('transactions', () => warehouseTransactionsAPI.list({ limit: RECENT }))
  const activity = useOverview('activity', () => auditTrailAPI.list({ limit: 6, entity_type: 'WAREHOUSE_TRANSACTION,WORK_ORDER' }))
  const findings = useOverview('findings', () => api.get('/ai-findings?status=OPEN&entity_type=INVENTORY_ITEM'))

  const a = analytics.data || {}
  const err = analytics.error
  const status = a.stock_status || {}
  const accuracy = a.accuracy || {}
  const turnover = a.turnover || {}
  const abc = a.abc || {}
  const series = a.value_over_time || []
  const slow = num(a.slow_moving?.count)
  const lowItems = a.low_stock_items || []
  const lowCount = num(status.low_stock)
  const outCount = num(status.out_of_stock)
  const pending = num(status.inactive)
  const v = (x) => (err ? '—' : x)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Inventory"
        description="What stock is worth, what needs reordering, and what moved."
        secondary={<>
          <Button icon={QrCodeIcon} to="/inventory/barcode-scanner">Scan</Button>
          <Button icon={PlusIcon} to="/items/create">New item</Button>
        </>}
        primary={<Button variant="primary" icon={InboxArrowDownIcon} to="/warehouse/transactions/goods-receipt">Receive goods</Button>}
      />

      {!err && (lowCount > 0 || outCount > 0) && (
        <InlineNotice tone={outCount ? 'risk' : 'warn'} title={[outCount && `${outCount} out of stock`, lowCount && `${lowCount} at or below reorder point`].filter(Boolean).join(', ')} action={<Button size="sm" to="/inventory/items">Review items</Button>}>
          Issues against an empty item fail until stock is received.
        </InlineNotice>
      )}

      <section aria-label="Inventory figures" className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        <Stat label="Stock value" loading={analytics.loading} to="/inventory/items" value={v(formatMoney(a.total_value))} reason={unavailable(err) || 'Quantity × unit price'} />
        <Stat label="Items" loading={analytics.loading} to="/inventory/items" value={v(formatNumber(num(status.total)))} reason={unavailable(err) || `${formatNumber(num(status.in_stock))} in stock${pending ? ` · ${pending} not approved` : ''}`} />
        <Stat label="Low stock" loading={analytics.loading} to="/inventory/items" value={v(formatNumber(lowCount))} reason={err ? null : lowCount ? 'At or below reorder point' : 'Nothing needs reordering'} />
        <Stat label="Out of stock" loading={analytics.loading} to="/inventory/items" value={v(formatNumber(outCount))} reason={err ? null : `${formatNumber(slow)} not issued in ${num(a.slow_moving?.window_days) || 90} days`} />
        <Stat label="Stock turns" loading={analytics.loading} to="/warehouse/transactions" value={turnover.turns == null ? '—' : `${num(turnover.turns).toFixed(2)}×`} reason={err ? null : `${formatMoney(turnover.issued_value, 'USD', 0)} issued this year`} />
        <Stat label="Count accuracy" loading={analytics.loading} to="/stocktake" value={accuracy.rate == null ? '—' : `${(accuracy.rate * 100).toFixed(1)}%`} reason={err ? null : accuracy.rate == null ? 'Nothing counted yet' : `${formatNumber(num(accuracy.counted_lines))} lines counted`} />
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <Card title="Stock value by month" description="Reconstructed from today's value and the posted movements — exact today, an estimate further back.">
            {analytics.loading ? <SkeletonRows rows={4} columns={1} /> : err ? <p className="text-sm text-ink-600">{unavailable(err)}.</p> : series.some((r) => num(r.value)) ? (
              <LineChart points={series.map((r) => ({ x: monthLabel(r.month), y: num(r.value) }))} format={(x) => formatMoney(x, 'USD', 0)} height={200} title="Stock value" />
            ) : <EmptyState compact title="No value to trace yet" description="The line appears once stock with a unit price is received." />}
          </Card>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card title="Stock by status" actions={<Button size="sm" variant="ghost" to="/inventory/items">Items</Button>}>
              {analytics.loading ? <SkeletonRows rows={4} columns={2} /> : (
                <Distribution
                  items={[
                    { label: 'In stock', value: num(status.in_stock), tone: 'ok' },
                    { label: 'Low stock', value: lowCount, tone: 'warn' },
                    { label: 'Out of stock', value: outCount, tone: 'risk' },
                    { label: 'Not approved', value: pending },
                  ].filter((x) => x.value)}
                  emptyText="No inventory items yet."
                />
              )}
            </Card>
            <Card title="Value by storage location" actions={<Button size="sm" variant="ghost" to="/warehouse">Warehouse</Button>}>
              {analytics.loading ? <SkeletonRows rows={4} columns={2} /> : (
                <Distribution items={(a.by_warehouse || []).map((w) => ({ label: w.warehouse, value: num(w.value) }))} format={(x) => formatMoney(x, 'USD', 0)} emptyText="No stock is assigned to a storage location yet." />
              )}
            </Card>
            <Card title="Value by category" actions={<Button size="sm" variant="ghost" to="/items">Item master</Button>}>
              {analytics.loading ? <SkeletonRows rows={4} columns={2} /> : (
                <Distribution items={(a.by_category || []).map((c) => ({ label: c.category, value: num(c.value) }))} format={(x) => formatMoney(x, 'USD', 0)} emptyText="No valued stock to split yet." />
              )}
            </Card>
            <Card title="ABC classification" description="A items make up the first 80% of value, B the next 15%, C the rest.">
              {analytics.loading ? <SkeletonRows rows={3} columns={2} /> : (
                <Distribution
                  items={[['A', abc.a], ['B', abc.b], ['C', abc.c]].map(([k, x]) => ({ label: `${k} — ${formatNumber(num(x?.items))} item${num(x?.items) === 1 ? '' : 's'}`, value: num(x?.value) })).filter((x) => x.value)}
                  format={(x) => formatMoney(x, 'USD', 0)}
                  emptyText="Needs stock with a value to classify."
                />
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <ListCard title="Low stock" to="/inventory/items" loading={analytics.loading} error={err} emptyText="Nothing is at or below its reorder point.">
              {lowItems.map((r) => (
                <Row key={r.item_code} title={r.item_name || r.item_code} subtitle={<><Code>{r.item_code}</Code>{r.warehouse ? ` · ${r.warehouse}` : ''}</>} trailing={<><Num value={r.on_hand} /> <span className="text-xs text-ink-500">/ {formatNumber(num(r.reorder_point))}</span></>} />
              ))}
            </ListCard>
            <ListCard title="Recent movements" to="/warehouse/transactions/history" loading={transactions.loading} error={transactions.error} emptyText="Nothing has moved yet.">
              {rows(transactions.data).slice(0, RECENT).map((tx) => (
                <Row key={tx.id} to="/warehouse/transactions/history" badge={<Badge mono className="w-9 justify-center">{tx.transaction_type}</Badge>}
                  title={TX[tx.transaction_type] || humanize(tx.transaction_type)}
                  subtitle={<>{tx.transaction_number}{tx.reference_document ? ` · ${tx.reference_document}` : ''}</>}
                  trailing={<><Num value={tx.total_quantity} className="block" /><span className="text-2xs text-ink-500">{relativeTime(tx.transaction_date || tx.created_at)}</span></>} />
              ))}
            </ListCard>
          </div>
        </div>

        <aside className="min-w-0 space-y-4">
          <ListCard title="Simeli findings" to="/ai-findings" loading={findings.loading} error={findings.error} emptyText="Simeli has not flagged anything in inventory.">
            {rows(findings.data).slice(0, 5).map((f) => (
              <Row key={f.id} to="/ai-findings" title={f.title} subtitle={f.description} badge={f.severity ? <Badge tone={f.severity === 'HIGH' ? 'risk' : f.severity === 'MEDIUM' ? 'warn' : 'ink'}>{humanize(f.severity)}</Badge> : null} />
            ))}
          </ListCard>
          <ListCard title="Recent activity" to="/admin/audit-trail" loading={activity.loading} error={activity.error} emptyText="No activity recorded yet.">
            {rows(activity.data).map((x, i) => (
              <Row key={`${x.entity_type}-${x.entity_id}-${i}`} title={`${humanize(x.entity_type)} → ${humanize(x.to_status)}`} subtitle={`${x.changed_by_name || 'System'} · ${relativeTime(x.occurred_at)}`} />
            ))}
          </ListCard>
          <nav aria-label="More inventory" className="rounded-lg border border-ink-200 bg-surface">
            <h2 className="label-mono border-b border-ink-200 px-4 py-2.5">Also here</h2>
            <ul className="divide-y divide-ink-100">
              {[
                ['Inventory items', '/inventory/items'], ['Item master', '/items'], ['Stock adjustment', '/warehouse/transactions/stock-adjustment'],
                ['Transfers in transit', '/warehouse/transfers'], ['Stocktake', '/stocktake'], ['Warehouse', '/warehouse'],
              ].map(([label, to]) => <Row key={to} to={to} title={label} />)}
            </ul>
          </nav>
        </aside>
      </div>
    </div>
  )
}
