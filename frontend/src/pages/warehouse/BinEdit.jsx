import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useRecordTitle } from '../../components/shell/ShellContext'
import {
  PageHeader, Button, Field, Input, Switch, FormSection, ErrorSummary, InlineNotice, ErrorState, SkeletonDetail, StatusBadge,
  describeError, notify,
} from '../../components/ui'
import { BinCapacityFields } from './BinCreate'
import { formatBinCode, validateBin } from './warehouseData'

const str = (v, fallback = '') => (v == null || v === '' ? fallback : String(v))

/** Edit a bin's description, capacity and usage. Its code and location are fixed once created. */
export default function BinEdit() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [form, setForm] = useState({ description: '', max_mass_capacity: '', max_volume_capacity: '', current_mass_used: '', current_volume_used: '', is_active: true })
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)

  const { data: bin, loading, error, refetch } = useResource(keys.bin(id), ({ signal }) => api.get(`/bins/${id}`, { signal }), { enabled: Boolean(id) })
  useRecordTitle(bin ? formatBinCode(bin.code) : null, { subtitle: bin?.storage_location_name })

  useEffect(() => {
    if (!bin) return
    setForm({
      description: bin.description || '',
      max_mass_capacity: str(bin.max_mass_capacity ?? bin.max_weight_capacity),
      max_volume_capacity: str(bin.max_volume_capacity),
      current_mass_used: str(bin.current_mass_used ?? bin.current_weight, '0'),
      current_volume_used: str(bin.current_volume_used ?? bin.current_volume, '0'),
      is_active: bin.is_active,
    })
  }, [bin])

  const update = useResourceMutation((payload) => api.put(`/bins/${id}`, payload), { invalidates: [['bins']], silent: true })

  const all = useMemo(() => validateBin(form, { requireCode: false }), [form])
  const errors = submitted ? all : Object.fromEntries(Object.entries(all).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const save = async (e) => {
    e.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(all).length) return
    try {
      await update.mutateAsync({
        ...form,
        max_mass_capacity: parseFloat(form.max_mass_capacity),
        max_volume_capacity: parseFloat(form.max_volume_capacity),
        current_mass_used: parseFloat(form.current_mass_used),
        current_volume_used: parseFloat(form.current_volume_used),
      })
      notify.success(`Bin ${bin.code} updated`)
      navigate(`/warehouse/bins/${id}`)
    } catch (err) {
      setServerError(describeError(err))
    }
  }

  if (loading) return <SkeletonDetail />
  if (error || !bin) return <ErrorState what="Bin" error={error} onRetry={refetch} />

  return (
    <form className="mx-auto max-w-3xl space-y-5" noValidate onSubmit={save}>
      <PageHeader
        title={`Edit bin ${formatBinCode(bin.code)}`}
        status={<StatusBadge status={bin.status} label={bin.status === 'ACTIVE' ? 'Approved' : undefined} />}
        meta={<span>{bin.storage_location_name} {bin.storage_location_code && <span className="font-mono">({bin.storage_location_code})</span>}</span>}
      />
      {serverError && (
        <InlineNotice tone="risk" title="Changes were not saved">
          {serverError.message} Your edits are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={submitted ? all : {}} />

      <FormSection title="Bin" description="The code and storage location cannot change once a bin exists.">
        <Field label="Description" required error={errors.description} className="sm:col-span-2" id="description">
          <Input size="lg" value={form.description} onChange={(e) => set({ description: e.target.value })} onBlur={blur('description')} placeholder="e.g. Shelf 1, row 1" />
        </Field>
        <div className="sm:col-span-2">
          <Switch checked={form.is_active} onChange={(v) => set({ is_active: v })} label="In use" />
          <p className="mt-1 text-xs text-ink-500">{form.is_active ? 'Active — can be chosen for put-away and picking.' : 'Inactive — cannot be used for new stock movements.'}</p>
        </div>
      </FormSection>

      <BinCapacityFields form={form} set={set} errors={errors} blur={blur} />

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button size="lg" variant="ghost" onClick={() => navigate(`/warehouse/bins/${id}`)}>Cancel</Button>
          <Button size="lg" variant="primary" type="submit" loading={update.isPending}>Save changes</Button>
        </div>
      </div>
    </form>
  )
}
