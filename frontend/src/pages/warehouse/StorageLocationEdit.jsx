import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import {
  PageHeader, Button, Switch, ErrorSummary, InlineNotice, ErrorState, SkeletonDetail, StatusBadge, describeError, notify,
} from '../../components/ui'
import { LocationFields } from './StorageLocationCreate'
import { LOCATION_BLANK, validateLocation } from './warehouseData'

/** Edit a storage location. Same fields as creating one, plus whether it is in use. */
export default function StorageLocationEdit() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [form, setForm] = useState({ ...LOCATION_BLANK, is_active: true })
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)

  const { data: location, loading, error, refetch } = useResource(keys.storageLocation(id), ({ signal }) => api.get(`/storage-locations/${id}`, { signal }), { enabled: Boolean(id) })
  useRecordTitle(location?.name, { subtitle: location?.code })

  // Seed the editable copy once the server copy arrives.
  useEffect(() => {
    if (!location) return
    setForm({
      code: location.code || '',
      name: location.name || '',
      country: location.country || '',
      city: location.city || '',
      address: location.address || '',
      postal_code: location.postal_code || '',
      description: location.description || '',
      is_active: location.is_active,
    })
  }, [location])

  const update = useResourceMutation((payload) => api.put(`/storage-locations/${id}`, payload), { invalidates: [['storage-locations']], silent: true })

  const all = useMemo(() => validateLocation(form), [form])
  const errors = submitted ? all : Object.fromEntries(Object.entries(all).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const save = async (e) => {
    e.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(all).length) return
    try {
      await update.mutateAsync(form)
      notify.success(`${form.name} updated`)
      navigate(`/warehouse/storage-locations/${id}`)
    } catch (err) {
      setServerError(describeError(err))
    }
  }

  if (loading) return <SkeletonDetail />
  if (error || !location) return <ErrorState what="Storage location" error={error} onRetry={refetch} />

  return (
    <form className="mx-auto max-w-3xl space-y-5" noValidate onSubmit={save}>
      <PageHeader
        title={`Edit ${location.name}`}
        status={<StatusBadge status={location.status} label={location.status === 'ACTIVE' ? 'Approved' : undefined} />}
        meta={<span className="font-mono">{location.code}</span>}
      />
      {serverError && (
        <InlineNotice tone="risk" title="Changes were not saved">
          {serverError.message} Your edits are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={submitted ? all : {}} />

      <LocationFields form={form} set={set} errors={errors} blur={blur}>
        <div className="sm:col-span-2">
          <Switch checked={form.is_active} onChange={(v) => set({ is_active: v })} label="In use" />
          <p className="mt-1 text-xs text-ink-500">{form.is_active ? 'Active — can receive bins and stock.' : 'Inactive — kept for history, hidden from pickers.'}</p>
        </div>
      </LocationFields>

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button size="lg" variant="ghost" onClick={() => navigate(`/warehouse/storage-locations/${id}`)}>Cancel</Button>
          <Button size="lg" variant="primary" type="submit" loading={update.isPending}>Save changes</Button>
        </div>
      </div>
    </form>
  )
}
