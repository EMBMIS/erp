import { useMemo, useState } from 'react'
import { PlayIcon, CheckCircleIcon, BeakerIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Badge, Num, DateText, Segmented, Select, notify,
} from '../../components/ui'

/**
 * MRP workbench — net demand against stock and safety stock, then turn the
 * planned orders into drafts: a purchase requisition for what is bought, a
 * work order for what is made. Nothing is ordered until a person converts it.
 */
const HORIZONS = [30, 60, 90]
const kind = (o) => (o.order_type === 'BUY' || o.action === 'BUY' ? 'BUY' : o.order_type || o.action || 'MAKE')

const QUICK = {
  all: { label: 'All', test: () => true },
  BUY: { label: 'Buy', test: (o) => kind(o) === 'BUY' },
  MAKE: { label: 'Make', test: (o) => kind(o) === 'MAKE' },
}

export default function MRPWorkbench() {
  const [horizon, setHorizon] = useState(90)
  const [quick, setQuick] = useState('all')

  const { data, loading, error, refetch } = useResource(keys.mrpPlannedOrders(), ({ signal }) => api.get('/manufacturing/mrp/planned-orders', { signal }))
  const plannedOrders = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, plannedOrders.filter(q.test).length])), [plannedOrders])

  const runMrp = useResourceMutation(
    (horizonDays) => api.post('/manufacturing/mrp/run', { horizon_days: Number(horizonDays), persist: true }),
    {
      invalidates: [keys.mrpPlannedOrders()],
      onSuccess: (result) => notify.success(`MRP run complete — ${result?.planned_orders_created ?? 0} planned order(s) generated`),
    }
  )
  const convert = useResourceMutation(
    (orderId) => api.post(`/manufacturing/mrp/planned-orders/${orderId}/convert`),
    { invalidates: [keys.mrpPlannedOrders()], successMessage: 'Planned order converted to a draft' }
  )
  const converting = convert.isPending ? convert.variables : null

  const columns = useMemo(() => [
    { id: 'kind', header: 'Action', accessor: kind, filter: 'select', width: 100, mobile: 'meta', cell: (o) => <Badge tone="ink" mono>{kind(o) === 'BUY' ? 'Buy' : 'Make'}</Badge> },
    { id: 'item', header: 'Item', accessor: (o) => o.item_name || o.description, filter: 'text', minWidth: 220, mobile: 'title', cell: (o) => o.item_name || o.description || <span className="text-ink-400">—</span> },
    {
      id: 'qty', header: 'Net quantity', accessor: (o) => Number(o.planned_quantity ?? o.quantity), align: 'right', width: 140, mobile: 'trailing',
      cell: (o) => <Num value={o.planned_quantity ?? o.quantity} digits={2} unit={o.unit_of_measure} />,
    },
    { id: 'due', header: 'Required by', accessor: (o) => o.required_by || o.required_date || o.due_date, width: 130, mobile: 'subtitle', cell: (o) => <DateText value={o.required_by || o.required_date || o.due_date} /> },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 130, cell: (o) => (o.status ? <StatusBadge status={o.status} /> : <span className="text-ink-400">—</span>) },
  ], [])

  return (
    <>
      <PageHeader
        title="MRP workbench"
        description="Material requirements planning: nets demand against stock and safety stock, then proposes what to buy and what to make."
        secondary={
          <label className="flex items-center gap-2 text-sm text-ink-600">
            <span className="whitespace-nowrap">Horizon</span>
            <Select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} className="w-32" aria-label="Planning horizon">
              {HORIZONS.map((d) => <option key={d} value={d}>{d} days</option>)}
            </Select>
          </label>
        }
        primary={<Button variant="primary" icon={PlayIcon} onClick={() => runMrp.mutate(horizon)} loading={runMrp.isPending}>{runMrp.isPending ? 'Calculating…' : 'Run MRP'}</Button>}
      />

      <DataTable
        viewKey="manufacturing.mrp"
        caption="Planned orders"
        noun="planned order"
        rows={plannedOrders}
        rowKey={(o) => o.id}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        externalFilter={QUICK[quick].test}
        searchPlaceholder="Search item"
        toolbarStart={
          <Segmented
            label="Show"
            value={quick}
            onChange={setQuick}
            options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))}
          />
        }
        rowActions={(o) => (
          <RowAction
            icon={CheckCircleIcon}
            label={kind(o) === 'BUY' ? 'Convert to a draft purchase requisition' : 'Convert to a draft work order'}
            onClick={() => convert.mutate(o.id)}
            disabled={converting === o.id || o.status === 'CONVERTED'}
            reason={o.status === 'CONVERTED' ? 'Already converted' : 'Converting…'}
          />
        )}
        empty={{
          icon: BeakerIcon,
          title: 'No planned orders',
          description: `Run MRP to explode demand and safety stock over the next ${horizon} days. Planned orders appear here for you to convert.`,
          action: <Button variant="primary" icon={PlayIcon} onClick={() => runMrp.mutate(horizon)} loading={runMrp.isPending}>Run MRP</Button>,
        }}
      />
    </>
  )
}
