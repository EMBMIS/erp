import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api from '../../services/api'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import {
  PageHeader, Button, Field, Input, Select, FormSection, ErrorSummary, InlineNotice, describeError, useDraft, notify,
} from '../../components/ui'
import { Utilisation } from './WarehouseParts'
import { asList, formatBinCode, validateBin } from './warehouseData'

const sharePct = (used, max) => {
  const u = parseFloat(used)
  const m = parseFloat(max)
  return m > 0 && Number.isFinite(u) ? (u / m) * 100 : null
}

/** Capacity and current usage — shared by the create and edit screens. */
export function BinCapacityFields({ form, set, errors, blur }) {
  const massPct = sharePct(form.current_mass_used, form.max_mass_capacity)
  const volPct = sharePct(form.current_volume_used, form.max_volume_capacity)
  return (
    <>
      <FormSection title="Capacity" description="The most this bin can hold. Put-away is checked against these limits.">
        <Field label="Weight capacity" required error={errors.max_mass_capacity} id="max_mass_capacity">
          <Input size="lg" type="number" inputMode="decimal" min="0.001" step="0.001" suffix="kg" value={form.max_mass_capacity} onChange={(e) => set({ max_mass_capacity: e.target.value })} onBlur={blur('max_mass_capacity')} />
        </Field>
        <Field label="Volume capacity" required error={errors.max_volume_capacity} id="max_volume_capacity">
          <Input size="lg" type="number" inputMode="decimal" min="0.001" step="0.001" suffix="m³" value={form.max_volume_capacity} onChange={(e) => set({ max_volume_capacity: e.target.value })} onBlur={blur('max_volume_capacity')} />
        </Field>
      </FormSection>
      <FormSection title="Already in use" description="Leave at 0 for an empty bin. Stock movements keep these up to date afterwards.">
        <Field label="Weight in use" error={errors.current_mass_used} id="current_mass_used">
          <Input size="lg" type="number" inputMode="decimal" min="0" step="0.001" suffix="kg" value={form.current_mass_used} onChange={(e) => set({ current_mass_used: e.target.value })} onBlur={blur('current_mass_used')} />
        </Field>
        <Field label="Volume in use" error={errors.current_volume_used} id="current_volume_used">
          <Input size="lg" type="number" inputMode="decimal" min="0" step="0.001" suffix="m³" value={form.current_volume_used} onChange={(e) => set({ current_volume_used: e.target.value })} onBlur={blur('current_volume_used')} />
        </Field>
        {(massPct != null || volPct != null) && (
          <div className="grid grid-cols-1 gap-4 rounded-md bg-sunken p-3 sm:col-span-2 sm:grid-cols-2">
            <Utilisation label="Weight used" percent={massPct} />
            <Utilisation label="Volume used" percent={volPct} />
          </div>
        )}
      </FormSection>
    </>
  )
}

const BLANK = (loc) => ({ code: '', description: '', max_mass_capacity: '', max_volume_capacity: '', current_mass_used: '0', current_volume_used: '0', storage_location_id: loc || '' })

/** New bin — a shelf or bay in an approved storage location. Saved as a draft first, as before. */
export default function BinCreate() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const preLoc = searchParams.get('location')
  const initial = useMemo(() => BLANK(preLoc), [preLoc])
  const { value: form, setValue, restored, savedAt, clear, discard } = useDraft(`warehouse:bin:new${preLoc ? `:${preLoc}` : ''}`, initial)
  const set = (patch) => setValue((f) => ({ ...f, ...patch }))
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)
  const [mode, setMode] = useState(null)

  const { data: locData, loading: locLoading } = useResource(keys.storageLocations({ is_active: true }), ({ signal }) => api.get('/storage-locations', { params: { is_active: true }, signal }))
  const locations = asList(locData)

  const all = useMemo(() => validateBin(form), [form])
  const errors = submitted ? all : Object.fromEntries(Object.entries(all).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const create = useResourceMutation(async (payload) => {
    const response = await api.post('/bins', payload)
    if (payload.submitForApproval) await api.post(`/bins/${response.data.id}/submit-for-approval`)
    return response
  }, { invalidates: [['bins'], ['bins-stats'], ['storage-locations']], silent: true })

  const save = async (submit) => {
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(all).length) return
    setMode(submit ? 'submit' : 'draft')
    try {
      await create.mutateAsync({
        ...form,
        max_mass_capacity: parseFloat(form.max_mass_capacity),
        max_volume_capacity: parseFloat(form.max_volume_capacity),
        current_mass_used: parseFloat(form.current_mass_used) || 0,
        current_volume_used: parseFloat(form.current_volume_used) || 0,
        status: 'DRAFT',
        submitForApproval: submit,
      })
      clear()
      notify.success(`Bin ${formatBinCode(form.code)} ${submit ? 'sent for approval' : 'saved as a draft'}`)
      navigate('/warehouse/bins')
    } catch (e) {
      setServerError(describeError(e))
    } finally {
      setMode(null)
    }
  }

  return (
    <form className="mx-auto max-w-3xl space-y-5" noValidate onSubmit={(e) => { e.preventDefault(); save(false) }}>
      <PageHeader
        title="New bin"
        description="A shelf or bay with a weight and volume limit. It can hold stock once a manager approves it."
        meta={savedAt ? <span aria-live="polite">Draft saved in this browser {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
      />
      {restored && (
        <InlineNotice title="Picked up where you left off" action={<Button size="sm" variant="ghost" onClick={discard}>Start over</Button>}>
          This bin was restored from a draft saved in this browser.
        </InlineNotice>
      )}
      {serverError && (
        <InlineNotice tone="risk" title="The bin was not saved">
          {serverError.message} Your entries are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      {!locLoading && !locations.length && (
        <InlineNotice tone="warn" title="No storage location to put it in" action={<Button size="sm" to="/warehouse/storage-locations/create">New location</Button>}>
          A bin belongs to an active storage location. Create one first.
        </InlineNotice>
      )}
      <ErrorSummary errors={submitted ? all : {}} />

      <FormSection title="Bin">
        <Field label="Bin code" required error={errors.code} help={/^\d{8}$/.test(form.code) ? `Reads as ${formatBinCode(form.code)} — warehouse, row, shelf, bin.` : '8 digits: warehouse, row, shelf, bin (WWRRSSBB), e.g. 01020304.'} id="code">
          <Input size="lg" inputMode="numeric" pattern="\d{8}" maxLength={8} className="font-mono" placeholder="01010101" value={form.code} onChange={(e) => set({ code: e.target.value.replace(/\D/g, '') })} onBlur={blur('code')} />
        </Field>
        <Field label="Storage location" required error={errors.storage_location_id} id="storage_location_id">
          <Select size="lg" value={form.storage_location_id} onChange={(e) => set({ storage_location_id: e.target.value })} onBlur={blur('storage_location_id')}>
            <option value="">{locLoading ? 'Loading locations…' : 'Choose a location…'}</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.code})</option>)}
          </Select>
        </Field>
        <Field label="Description" required error={errors.description} help="What people call it, e.g. Aisle 2, top shelf, left." className="sm:col-span-2" id="description">
          <Input size="lg" value={form.description} onChange={(e) => set({ description: e.target.value })} onBlur={blur('description')} />
        </Field>
      </FormSection>

      <BinCapacityFields form={form} set={set} errors={errors} blur={blur} />

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button size="lg" variant="ghost" onClick={() => navigate('/warehouse/bins')}>Cancel</Button>
          <Button size="lg" type="submit" loading={mode === 'draft'} disabled={Boolean(mode)}>Save as draft</Button>
          <Button size="lg" variant="primary" loading={mode === 'submit'} disabled={Boolean(mode)} onClick={() => save(true)}>Send for approval</Button>
        </div>
      </div>
    </form>
  )
}
