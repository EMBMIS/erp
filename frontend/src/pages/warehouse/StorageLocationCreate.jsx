import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../services/api'
import { useResourceMutation } from '../../hooks/useResource'
import {
  PageHeader, Button, Field, Input, Textarea, FormSection, ErrorSummary, InlineNotice, describeError, useDraft, notify,
} from '../../components/ui'
import { LOCATION_BLANK, validateLocation } from './warehouseData'

/** The fields of a storage location — shared by the create and edit screens. */
export function LocationFields({ form, set, errors, blur, children }) {
  return (
    <>
      <FormSection title="Location" description="How people will find and refer to it.">
        <Field label="Code" required error={errors.code} help="A short, unique code — up to 10 characters, e.g. LON or WH01." id="code">
          <Input size="lg" value={form.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} onBlur={blur('code')} maxLength={10} autoCapitalize="characters" className="font-mono" />
        </Field>
        <Field label="Name" required error={errors.name} id="name">
          <Input size="lg" value={form.name} onChange={(e) => set({ name: e.target.value })} onBlur={blur('name')} maxLength={255} placeholder="e.g. Brighton warehouse" />
        </Field>
        {children}
      </FormSection>
      <FormSection title="Address">
        <Field label="Country" required error={errors.country} id="country">
          <Input size="lg" value={form.country} onChange={(e) => set({ country: e.target.value })} onBlur={blur('country')} maxLength={100} autoComplete="country-name" />
        </Field>
        <Field label="City" required error={errors.city} id="city">
          <Input size="lg" value={form.city} onChange={(e) => set({ city: e.target.value })} onBlur={blur('city')} maxLength={100} autoComplete="address-level2" />
        </Field>
        <Field label="Street address" required error={errors.address} className="sm:col-span-2" id="address">
          <Textarea rows={2} value={form.address} onChange={(e) => set({ address: e.target.value })} onBlur={blur('address')} autoComplete="street-address" />
        </Field>
        <Field label="Postal code" required error={errors.postal_code} id="postal_code">
          <Input size="lg" value={form.postal_code} onChange={(e) => set({ postal_code: e.target.value })} onBlur={blur('postal_code')} maxLength={20} autoComplete="postal-code" />
        </Field>
      </FormSection>
      <FormSection title="Notes" description="Access hours, dock details, anything a driver or picker should know" advanced defaultOpen={Boolean(form.description)}>
        <Field label="Description" optional className="sm:col-span-2" id="description">
          <Textarea rows={3} value={form.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
      </FormSection>
    </>
  )
}

/**
 * New storage location. Saved as a draft first; sending it for approval is
 * a second call on the same record, exactly as before.
 */
export default function StorageLocationCreate() {
  const navigate = useNavigate()
  const { value: form, setValue, restored, savedAt, clear, discard } = useDraft('warehouse:location:new', LOCATION_BLANK)
  const set = (patch) => setValue((f) => ({ ...f, ...patch }))
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState(null)
  const [mode, setMode] = useState(null)

  const all = useMemo(() => validateLocation(form), [form])
  const errors = submitted ? all : Object.fromEntries(Object.entries(all).filter(([k]) => touched[k]))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const create = useResourceMutation(async ({ submit }) => {
    const res = await api.post('/storage-locations', { ...form, status: 'DRAFT' })
    const created = res.data
    if (submit) await api.post(`/storage-locations/${created.id}/submit-for-approval`)
    return res
  }, { invalidates: [['storage-locations'], ['storage-locations-stats']], silent: true })

  const save = async (submit) => {
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(all).length) return
    setMode(submit ? 'submit' : 'draft')
    try {
      await create.mutateAsync({ submit })
      clear()
      notify.success(`${form.name} ${submit ? 'sent for approval' : 'saved as a draft'}`)
      navigate('/warehouse/storage-locations')
    } catch (e) {
      setServerError(describeError(e))
    } finally {
      setMode(null)
    }
  }

  return (
    <form className="mx-auto max-w-3xl space-y-5" noValidate onSubmit={(e) => { e.preventDefault(); save(false) }}>
      <PageHeader
        title="New storage location"
        description="A warehouse or site that will hold bins and stock. It can be used once a manager approves it."
        meta={savedAt ? <span aria-live="polite">Draft saved in this browser {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
      />
      {restored && (
        <InlineNotice title="Picked up where you left off" action={<Button size="sm" variant="ghost" onClick={discard}>Start over</Button>}>
          This location was restored from a draft saved in this browser.
        </InlineNotice>
      )}
      {serverError && (
        <InlineNotice tone="risk" title="The location was not saved">
          {serverError.message} Your entries are still here.{serverError.reference && <> Reference <span className="font-mono">{serverError.reference}</span>.</>}
        </InlineNotice>
      )}
      <ErrorSummary errors={submitted ? all : {}} />

      <LocationFields form={form} set={set} errors={errors} blur={blur} />

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button size="lg" variant="ghost" onClick={() => navigate('/warehouse/storage-locations')}>Cancel</Button>
          <Button size="lg" type="submit" loading={mode === 'draft'} disabled={Boolean(mode)}>Save as draft</Button>
          <Button size="lg" variant="primary" loading={mode === 'submit'} disabled={Boolean(mode)} onClick={() => save(true)}>Send for approval</Button>
        </div>
      </div>
    </form>
  )
}
