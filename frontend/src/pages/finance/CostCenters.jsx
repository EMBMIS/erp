import { useMemo, useState } from 'react'
import { PlusIcon, Squares2X2Icon } from '@heroicons/react/20/solid'
import api, { costCentersAPI } from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { useAuth } from '../../contexts/AuthContext'
import {
  PageHeader, Button, DataTable, StatusBadge, Code, Dialog, Field, Input, InlineNotice, notify,
} from '../../components/ui'

/** Cost centers — the departments and units that carry cost. */
export default function CostCenters() {
  const [adding, setAdding] = useState(false)
  const { user } = useAuth()
  // POST /cost-centers is manager/admin only on the server.
  const canManage = ['ADMIN', 'MANAGER'].includes(user?.role)
  const { data, loading, error, refetch } = useResource(['cost-centers'], ({ signal }) => api.get('/cost-centers', { signal }))
  const centers = useMemo(() => (Array.isArray(data) ? data : []), [data])

  const columns = useMemo(() => [
    { id: 'code', header: 'Code', accessor: 'code', cell: (c) => <Code>{c.code}</Code>, width: 120, mobile: 'title' },
    {
      id: 'name', header: 'Name', accessor: 'name', filter: 'text', minWidth: 220, mobile: 'subtitle',
      cell: (c) => (
        <span className="block min-w-0">
          <span className="block truncate">{c.name}</span>
          {c.description && <span className="block truncate text-xs text-ink-500">{c.description}</span>}
        </span>
      ),
    },
    { id: 'manager', header: 'Manager', accessor: 'manager_name', filter: 'text', cell: (c) => c.manager_name || <span className="text-ink-400">—</span>, width: 180 },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', cell: (c) => <StatusBadge status={c.status} />, width: 130, mobile: 'meta' },
  ], [])

  const newButton = (
    <Button variant="primary" icon={PlusIcon} onClick={() => setAdding(true)} disabled={!canManage} title={canManage ? undefined : 'Adding a cost center needs a Manager or Admin role'}>
      New cost center
    </Button>
  )

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Cost centers"
        description="Departments and units that carry cost, for allocating expenses and budgeting."
        primary={newButton}
      />
      <DataTable
        viewKey="finance.cost-centers"
        caption="Cost centers"
        noun="cost center"
        rows={centers}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={refetch}
        defaultSort={{ id: 'code', dir: 'asc' }}
        searchPlaceholder="Search code, name, manager"
        empty={{
          icon: Squares2X2Icon,
          title: 'No cost centers yet',
          description: 'A cost center is a department or unit that carries cost — Sales, Warehouse, Head office. Add one to tag journal lines and budget against it.',
          action: newButton,
        }}
      />
      {adding && <AddCostCenter onClose={() => setAdding(false)} />}
    </div>
  )
}

function AddCostCenter({ onClose }) {
  const [form, setForm] = useState({ name: '', description: '' })
  const [touched, setTouched] = useState(false)
  const [serverError, setServerError] = useState(null)
  const create = useResourceMutation((payload) => costCentersAPI.create(payload), { invalidates: [['cost-centers']], silent: true })
  const nameError = !form.name.trim() ? 'Name the cost center, e.g. Sales department.' : null

  const submit = async (e) => {
    e?.preventDefault()
    setTouched(true)
    setServerError(null)
    if (nameError) return
    try {
      await create.mutateAsync({ name: form.name, description: form.description || undefined })
      notify.success(`Cost center ${form.name} added`)
      onClose()
    } catch (err) {
      setServerError(err?.response?.data?.error || err.message)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="New cost center"
      description="The code is assigned automatically."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>Add cost center</Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        {serverError && <InlineNotice tone="risk" title="Not added">{serverError}</InlineNotice>}
        <Field label="Name" required error={touched ? nameError : null}>
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} onBlur={() => setTouched(true)} placeholder="Sales department" data-autofocus />
        </Field>
        <Field label="Description" optional>
          <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </Field>
      </form>
    </Dialog>
  )
}
