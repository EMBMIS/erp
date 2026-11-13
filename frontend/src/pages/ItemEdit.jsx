import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { itemsAPI } from '../services/api'
import { useResource } from '../hooks/useResource'
import { useRecordTitle } from '../components/shell/ShellContext'
import { PageHeader, Button, StatusBadge, Code, ErrorState, SkeletonDetail, describeError, notify } from '../components/ui'
import ItemMasterForm, { ITEM_BLANK, validateItem, serverFieldErrors } from './inventory/ItemMasterForm'

const fromItem = (item) => Object.fromEntries(Object.keys(ITEM_BLANK).map((k) => {
  const v = item[k]
  if (k === 'is_stock_item') return [k, v !== undefined ? v : true]
  if (k === 'planned_stock') return [k, v !== undefined ? v : false]
  if (k === 'has_contract' || k === 'has_barcode') return [k, v || false]
  if (k === 'status') return [k, v || 'DRAFT']
  if (k === 'criticality') return [k, v || 'LOW']
  if (k === 'unit_of_measure') return [k, v || 'pcs']
  return [k, v || '']
}))

/** Edit an item master. A draft can be saved or sent for approval; otherwise it is updated in place. */
export default function ItemEdit() {
  const { id } = useParams()
  const { data: item, loading, error, refetch } = useResource(['items', id], () => itemsAPI.getById(id), { enabled: !!id })
  useRecordTitle(item?.name, { subtitle: item?.approved_item_code || item?.item_code })
  if (loading) return <SkeletonDetail />
  if (error || !item) return <ErrorState what="Item master" error={error} onRetry={refetch} />
  return <EditForm key={item.id} item={item} />
}

function EditForm({ item }) {
  const navigate = useNavigate()
  const [value, setValue] = useState(() => fromItem(item))
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(null)
  const [serverError, setServerError] = useState(null)
  const [serverErrors, setServerErrors] = useState({})
  const draft = value.status === 'DRAFT'

  const save = async (status = null) => {
    setSubmitted(true)
    setServerError(null)
    setServerErrors({})
    if (Object.keys(validateItem(value)).length) return
    setSaving(status || 'update')
    try {
      await itemsAPI.update(item.id, status ? { ...value, status } : value)
      notify.success(status === 'PENDING_REVIEW' ? `${value.name} sent for approval` : status === 'DRAFT' ? `${value.name} saved as a draft` : `${value.name} updated`)
      navigate('/items')
    } catch (err) {
      const fields = serverFieldErrors(err)
      setServerErrors(fields)
      setServerError(Object.keys(fields).length ? 'Some fields need fixing.' : describeError(err).message)
    } finally {
      setSaving(null)
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); save() }} noValidate className="mx-auto max-w-3xl space-y-5">
      <PageHeader title={`Edit ${item.name}`} status={<StatusBadge status={item.status} />} meta={<Code>{item.approved_item_code || item.item_code}</Code>} />
      <ItemMasterForm value={value} onChange={setValue} submitted={submitted} serverErrors={serverErrors} serverError={serverError} />
      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap justify-end gap-2 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <Button variant="ghost" onClick={() => navigate(`/items/${item.id}/view`)}>Cancel</Button>
        {draft ? (
          <>
            <Button type="submit" loading={saving === 'update'} disabled={Boolean(saving)}>Save as draft</Button>
            <Button variant="primary" loading={saving === 'PENDING_REVIEW'} disabled={Boolean(saving)} onClick={() => save('PENDING_REVIEW')}>Send for approval</Button>
          </>
        ) : (
          <Button type="submit" variant="primary" loading={saving === 'update'} disabled={Boolean(saving)}>Save changes</Button>
        )}
      </div>
    </form>
  )
}
