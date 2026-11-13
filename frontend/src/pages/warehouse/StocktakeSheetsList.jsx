import { useMemo, useState } from 'react'
import { PlusIcon, ClipboardDocumentCheckIcon, EyeIcon } from '@heroicons/react/20/solid'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, DataTable, RowAction, StatusBadge, Code, Num, DateText, Segmented, Dialog, Field, Select, Input,
  InlineNotice, describeError, notify,
} from '../../components/ui'
import { asList, SHEET_STATUS } from './warehouseData'

const QUICK = {
  open: { label: 'Open', test: (s) => !['POSTED', 'CANCELLED'].includes(s.status) },
  review: { label: 'To review', test: (s) => ['COUNTED', 'REVIEWED'].includes(s.status) },
  posted: { label: 'Posted', test: (s) => s.status === 'POSTED' },
  all: { label: 'All', test: () => true },
}

/** Stocktake — count sheets, from counting on the floor to posting the variances. */
export default function StocktakeSheetsList() {
  const [quick, setQuick] = useState('open')
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ location_id: '', notes: '' })
  const [serverError, setServerError] = useState(null)

  const { data, loading, error, refetch } = useResource(keys.stocktakeSheets(), ({ signal }) => api.get('/stocktake/sheets', { signal }))
  const sheets = useMemo(() => asList(data), [data])
  const { data: locData } = useResource(keys.storageLocations(), ({ signal }) => api.get('/storage-locations', { signal }))
  const locations = asList(locData)

  const create = useResourceMutation((payload) => api.post('/stocktake/sheets', payload), { invalidates: [keys.stocktakeSheets()], silent: true })
  const counts = useMemo(() => Object.fromEntries(Object.entries(QUICK).map(([k, q]) => [k, sheets.filter(q.test).length])), [sheets])

  const save = async () => {
    setServerError(null)
    try {
      const sheet = await create.mutateAsync({ location_id: form.location_id || null, notes: form.notes })
      notify.success(`${sheet?.sheet_number || 'Count sheet'} created`)
      setForm({ location_id: '', notes: '' })
      setCreating(false)
    } catch (e) {
      setServerError(describeError(e))
    }
  }

  const columns = useMemo(() => {
    const locName = (id) => { const l = locations.find((x) => x.id === id); return l ? l.name || l.code : null }
    return [
    { id: 'sheet', header: 'Sheet', accessor: 'sheet_number', width: 160, mobile: 'title', cell: (s) => <Code>{s.sheet_number}</Code> },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 230, mobile: 'meta', cell: (s) => { const m = SHEET_STATUS[s.status] || { status: s.status }; return <StatusBadge status={m.status} label={m.label} /> } },
    { id: 'location', header: 'Location', accessor: (s) => (s.location_id ? locName(s.location_id) : 'All locations'), width: 200, mobile: 'subtitle', cell: (s) => (s.location_id ? locName(s.location_id) || <span className="text-ink-400">Unknown location</span> : 'All locations') },
    { id: 'items', header: 'Lines', accessor: (s) => (s.item_count == null ? null : Number(s.item_count)), align: 'right', width: 90, cell: (s) => <Num value={s.item_count} /> },
    { id: 'created', header: 'Created', accessor: 'created_at', width: 130, cell: (s) => <DateText value={s.created_at} /> },
    { id: 'posted', header: 'Posted', accessor: 'posted_at', width: 130, cell: (s) => <DateText value={s.posted_at} /> },
    ]
  }, [locations])

  return (
    <>
      <PageHeader
        title="Stocktake"
        description="Count what is on the shelves, review the differences, then post them to stock and the ledger."
        primary={<Button variant="primary" icon={PlusIcon} onClick={() => setCreating(true)}>New count sheet</Button>}
      />

      <DataTable
        viewKey="warehouse.stocktake"
        caption="Count sheets"
        noun="sheet"
        rows={sheets}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        rowHref={(s) => `/stocktake/${s.id}`}
        externalFilter={QUICK[quick].test}
        defaultSort={{ id: 'created', dir: 'desc' }}
        searchPlaceholder="Search sheet number"
        toolbarStart={<Segmented label="Show" value={quick} onChange={setQuick} options={Object.entries(QUICK).map(([k, q]) => ({ value: k, label: `${q.label}${counts[k] ? ` ${counts[k]}` : ''}` }))} />}
        rowActions={(s) => <RowAction icon={EyeIcon} label={`Open ${s.sheet_number}`} to={`/stocktake/${s.id}`} />}
        empty={{
          icon: ClipboardDocumentCheckIcon,
          title: quick === 'all' ? 'No count sheets yet' : 'No sheets here',
          description: 'A count sheet lists every stocked item with its book quantity. Counters enter what they find; the differences are reviewed and posted.',
          action: <Button variant="primary" icon={PlusIcon} onClick={() => setCreating(true)}>New count sheet</Button>,
        }}
      />

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New count sheet"
        description="Lists every stocked item in the location with today’s book quantity."
        footer={<>
          <Button size="lg" variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
          <Button size="lg" variant="primary" loading={create.isPending} onClick={save}>Create sheet</Button>
        </>}
      >
        <div className="space-y-4">
          {serverError && <InlineNotice tone="risk" title="The sheet was not created">{serverError.message} {serverError.next}</InlineNotice>}
          <Field label="Location" optional help="Leave on All locations to count everything." id="warehouse-location-optional-leave-blank-for-all">
            <Select size="lg" value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
              <option value="">All locations</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name || l.location_code}</option>)}
            </Select>
          </Field>
          <Field label="Notes" optional id="stocktake-notes">
            <Input size="lg" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. Quarter-end count, aisle 3 only" />
          </Field>
        </div>
      </Dialog>
    </>
  )
}
