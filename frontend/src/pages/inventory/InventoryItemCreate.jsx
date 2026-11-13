import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CubeIcon } from '@heroicons/react/20/solid'
import { inventoryItemsAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import {
  PageHeader, Button, Card, Field, Input, Select, Textarea, Combobox, FormSection, ErrorSummary, InlineNotice, EmptyState,
  ErrorState, SkeletonRows, DescriptionList, Badge, Code, describeError, notify,
} from '../../components/ui'

/**
 * New inventory item — an approved item master becomes stock with a price
 * and a condition. Min/max and the reorder point are set by a manager when
 * the item is approved, not here.
 */
const GRADES = [
  { value: 'A', label: 'A — Excellent', hint: 'New or like-new, no visible wear' },
  { value: 'B', label: 'B — Good', hint: 'Minor wear or cosmetic issues, fully functional' },
  { value: 'C', label: 'C — Fair', hint: 'Noticeable wear but still functional and usable' },
  { value: 'D', label: 'D — Poor', hint: 'Significant wear, damage, or functionality issues' },
]
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD']
const stockClass = (m) => (m.is_stock_item ? (m.planned_stock ? 'Planned stock (ST2)' : 'Regular stock (ST1)') : 'Non-stock (NS3)')
const CRIT_TONE = { HIGH: 'risk', MEDIUM: 'warn' }

export default function InventoryItemCreate() {
  const navigate = useNavigate()
  const [form, setForm] = useState({ item_master_id: '', unit_price: '', currency: 'USD', condition_grade: 'A', condition_notes: '' })
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState(null)

  const { data, loading, error, refetch } = useResource(['inventory-items', 'available-item-masters'], () => inventoryItemsAPI.getAvailableItemMasters())
  const masters = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const master = masters.find((m) => m.id === form.item_master_id)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }))

  const errors = {}
  if (!form.item_master_id) errors.item_master_id = 'Choose the item master to stock.'
  if (form.unit_price !== '' && !(parseFloat(form.unit_price) >= 0)) errors.unit_price = 'Enter a price of zero or more.'
  const shown = submitted ? errors : {}

  const submit = async (e) => {
    e.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(errors).length) return
    setSaving(true)
    try {
      await inventoryItemsAPI.create({
        item_master_id: form.item_master_id,
        unit_price: form.unit_price ? parseFloat(form.unit_price) : null,
        currency: form.currency,
        condition_grade: form.condition_grade,
        condition_notes: form.condition_notes || null,
      })
      notify.success(`${master?.name || 'Inventory item'} added to inventory`)
      navigate('/inventory/items')
    } catch (err) {
      setServerError(describeError(err))
    } finally {
      setSaving(false)
    }
  }

  const header = <PageHeader title="New inventory item" description="Turn an approved item master into stock with a price and a condition." />

  if (loading) return <div className="mx-auto max-w-3xl">{header}<Card><SkeletonRows rows={4} columns={2} /></Card></div>
  if (error) return <div className="mx-auto max-w-3xl">{header}<ErrorState what="Available item masters" error={error} onRetry={refetch} /></div>
  if (!masters.length) {
    return (
      <div className="mx-auto max-w-3xl">
        {header}
        <EmptyState
          icon={CubeIcon}
          title="Every approved item master is already stocked"
          description="Only approved item masters that are not yet inventory items can be added. Create or approve an item master first."
          action={<Button variant="primary" to="/items">Item masters</Button>}
        />
      </div>
    )
  }

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-3xl space-y-5">
      {header}
      {serverError && <InlineNotice tone="risk" title="The item was not created">{serverError.message}</InlineNotice>}
      <ErrorSummary errors={submitted ? Object.entries(errors).map(([id, message]) => ({ id, message })) : []} />

      <FormSection title="Item master" columns={1}>
        <Field label="Item master" required error={shown.item_master_id} help="Only approved item masters that are not yet inventory items are listed." id="item_master_id">
          <Combobox
            value={form.item_master_id}
            onChange={set('item_master_id')}
            options={masters.map((m) => ({ value: m.id, label: m.name, meta: m.approved_item_code, description: [m.item_category, m.criticality && `${m.criticality.toLowerCase()} criticality`].filter(Boolean).join(' · ') }))}
            placeholder="Search by name or code"
            emptyText="No item master matches"
          />
        </Field>
        {master && (
          <div className="rounded-md border border-ink-200 bg-sunken p-4">
            <DescriptionList
              columns={3}
              items={[
                { label: 'Item code', value: <Code>{master.approved_item_code}</Code> },
                { label: 'Original code', value: <Code>{master.item_code}</Code> },
                { label: 'Unit', value: master.unit_of_measure },
                { label: 'Criticality', value: master.criticality && <Badge tone={CRIT_TONE[master.criticality] || 'ink'}>{master.criticality.toLowerCase().replace(/^./, (c) => c.toUpperCase())}</Badge> },
                { label: 'Stock class', value: stockClass(master) },
                { label: 'Category', value: master.item_category },
                { label: 'Manufacturer', value: master.manufacturer },
                { label: 'Part number', value: master.manufacturer_part_number && <Code>{master.manufacturer_part_number}</Code> },
                { label: 'UNSPSC', value: master.unspsc_code && <Code>{master.unspsc_code}</Code> },
                master.serial_number && { label: 'Serial number', value: <Code>{master.serial_number}</Code> },
                master.equipment_tag && { label: 'Equipment tag', value: <Code>{master.equipment_tag}</Code> },
                (master.mass_per_uom || master.volume_per_uom) && { label: 'Per unit', value: [master.mass_per_uom && `${master.mass_per_uom} kg`, master.volume_per_uom && `${master.volume_per_uom} m³`].filter(Boolean).join(' · ') },
                master.has_contract && { label: 'Contract', value: master.contract_number || 'Yes (no number)' },
                master.has_barcode && master.barcode && { label: 'Barcode', value: <Code>{master.barcode}</Code> },
                { label: 'Description', value: master.description, wide: true },
              ]}
            />
          </div>
        )}
      </FormSection>

      <InlineNotice tone="ink" title="Stock levels are set at approval">
        Minimum, maximum and reorder point are set by an authorised manager when this item is approved.
      </InlineNotice>

      <FormSection title="Cost">
        <Field label="Unit price" optional error={shown.unit_price} help="Can be updated later from purchase orders." id="unit_price">
          <Input type="number" step="0.01" min="0" numeric value={form.unit_price} onChange={set('unit_price')} placeholder="0.00" />
        </Field>
        <Field label="Currency" id="currency">
          <Select value={form.currency} onChange={set('currency')}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
      </FormSection>

      <FormSection title="Condition">
        <Field label="Condition grade" help={GRADES.find((g) => g.value === form.condition_grade)?.hint} id="condition_grade">
          <Select value={form.condition_grade} onChange={set('condition_grade')}>
            {GRADES.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
          </Select>
        </Field>
        <Field label="Condition notes" optional help="Anything a picker or buyer should know about this stock." id="condition_notes">
          <Textarea rows={3} value={form.condition_notes} onChange={set('condition_notes')} placeholder="Scratches on housing, original packaging missing…" />
        </Field>
      </FormSection>

      <div className="flex justify-end gap-2 border-t border-ink-200 pt-4">
        <Button variant="ghost" onClick={() => navigate('/inventory/items')}>Cancel</Button>
        <Button type="submit" variant="primary" loading={saving}>Create inventory item</Button>
      </div>
    </form>
  )
}
