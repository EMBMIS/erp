import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { itemsAPI } from '../services/api'
import { PageHeader, Button, InlineNotice, useDraft, describeError, notify } from '../components/ui'
import ItemMasterForm, { ITEM_BLANK, validateItem, serverFieldErrors } from './inventory/ItemMasterForm'

/** Strings stay strings: the API rejects null for these text fields. */
const sanitize = (d) => ({
  ...d,
  description: d.description || '', unspsc_code: d.unspsc_code || '', manufacturer: d.manufacturer || '', manufacturer_part_number: d.manufacturer_part_number || '',
  item_category: d.item_category || '', serial_number: d.serial_number || '', equipment_tag: d.equipment_tag || '', contract_number: d.contract_number || '',
  barcode: d.barcode || '', mass_per_uom: d.mass_per_uom || '', volume_per_uom: d.volume_per_uom || '',
})

/** New item master. Autosaves to this browser; save as a draft or send it for approval. */
export default function ItemCreate() {
  const navigate = useNavigate()
  const { value, setValue, restored, savedAt, clear, discard } = useDraft('item-master:new', ITEM_BLANK)
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(null)
  const [serverError, setServerError] = useState(null)
  const [serverErrors, setServerErrors] = useState({})

  const save = async (status) => {
    setSubmitted(true)
    setServerError(null)
    setServerErrors({})
    if (Object.keys(validateItem(value)).length) return
    setSaving(status)
    try {
      await itemsAPI.create(sanitize({ ...value, status }))
      clear()
      notify.success(status === 'DRAFT' ? `${value.name} saved as a draft` : `${value.name} sent for approval`)
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
    <form onSubmit={(e) => { e.preventDefault(); save('DRAFT') }} noValidate className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="New item master"
        description="Describe something the company buys, stocks or sells. Once approved it gets its permanent code."
        meta={savedAt ? <span aria-live="polite">Draft saved in this browser {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
      />
      {restored && (
        <InlineNotice tone="ink" title="Picked up where you left off" action={<Button size="sm" variant="ghost" onClick={discard}>Start over</Button>}>
          This item was restored from a draft saved in this browser.
        </InlineNotice>
      )}
      <ItemMasterForm value={value} onChange={setValue} submitted={submitted} serverErrors={serverErrors} serverError={serverError} />
      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap justify-end gap-2 border-t border-ink-200 bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <Button variant="ghost" onClick={() => navigate('/items')}>Cancel</Button>
        <Button type="submit" loading={saving === 'DRAFT'} disabled={Boolean(saving)}>Save as draft</Button>
        <Button variant="primary" loading={saving === 'PENDING_REVIEW'} disabled={Boolean(saving)} onClick={() => save('PENDING_REVIEW')}>Send for approval</Button>
      </div>
    </form>
  )
}
