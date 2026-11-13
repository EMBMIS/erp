import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { inventoryItemsAPI } from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { useRecordTitle } from '../../components/shell/ShellContext'
import {
  PageHeader, Button, Field, Input, Select, Textarea, FormSection, ErrorSummary, InlineNotice, ErrorState, SkeletonDetail,
  StatusBadge, Code, DescriptionList, describeError, notify,
} from '../../components/ui'

const GRADES = [
  { value: 'A', label: 'A — Excellent', hint: 'New or like-new, no visible wear' },
  { value: 'B', label: 'B — Good', hint: 'Minor wear or cosmetic issues, fully functional' },
  { value: 'C', label: 'C — Fair', hint: 'Noticeable wear but still functional and usable' },
  { value: 'D', label: 'D — Poor', hint: 'Significant wear, damage, or functionality issues' },
]
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD']
const n = (v) => (v === '' || v == null ? null : parseFloat(v))

/** Edit an inventory item's price and condition; once approved, its stock levels too. */
export default function InventoryItemEdit() {
  const { id } = useParams()
  const { data: item, loading, error, refetch } = useResource(['inventory-items', id], () => inventoryItemsAPI.getById(id), { enabled: !!id })
  useRecordTitle(item?.item_name, { subtitle: item?.approved_item_code || item?.item_code })

  if (loading) return <SkeletonDetail />
  if (error || !item) return <ErrorState what="Inventory item" error={error} onRetry={refetch} />
  if (item.status === 'DECLINED') {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <PageHeader title={`Edit ${item.item_name}`} status={<StatusBadge status={item.status} />} />
        <InlineNotice tone="risk" title="A declined item cannot be edited" action={<Button size="sm" to={`/inventory/items/${id}`}>View item</Button>}>
          {item.decline_reason ? `Declined: ${item.decline_reason}` : 'No reason was recorded.'}
        </InlineNotice>
      </div>
    )
  }
  return <EditForm key={item.id} item={item} />
}

function EditForm({ item }) {
  const navigate = useNavigate()
  const approved = item.status === 'APPROVED'
  const [form, setForm] = useState({
    unit_price: item.unit_price || '',
    currency: item.currency || 'USD',
    condition_grade: item.condition_grade || 'A',
    condition_notes: item.condition_notes || '',
    minimum_stock_level: item.minimum_stock_level || '',
    maximum_stock_level: item.maximum_stock_level || '',
    reorder_point: item.reorder_point || '',
  })
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState(null)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))

  const all = {}
  if (approved) {
    const min = n(form.minimum_stock_level)
    const max = n(form.maximum_stock_level)
    const rp = n(form.reorder_point)
    if (min && max && min > max) all.maximum_stock_level = 'Maximum must be at least the minimum.'
    if (min && rp && rp < min) all.reorder_point = 'Reorder point should not be below the minimum.'
    else if (max && rp && rp > max) all.reorder_point = 'Reorder point should not exceed the maximum.'
  }
  const errors = submitted ? all : Object.fromEntries(Object.entries(all).filter(([k]) => touched[k]))
  const unit = item.unit_of_measure

  const submit = async (e) => {
    e.preventDefault()
    setSubmitted(true)
    setServerError(null)
    if (Object.keys(all).length) return
    setSaving(true)
    try {
      await inventoryItemsAPI.update(item.id, {
        unit_price: form.unit_price ? parseFloat(form.unit_price) : null,
        currency: form.currency,
        condition_grade: form.condition_grade,
        condition_notes: form.condition_notes || null,
        minimum_stock_level: form.minimum_stock_level ? parseFloat(form.minimum_stock_level) : null,
        maximum_stock_level: form.maximum_stock_level ? parseFloat(form.maximum_stock_level) : null,
        reorder_point: form.reorder_point ? parseFloat(form.reorder_point) : null,
      })
      notify.success(`${item.item_name} updated`)
      navigate(`/inventory/items/${item.id}`)
    } catch (err) {
      setServerError(describeError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title={`Edit ${item.item_name}`}
        status={<StatusBadge status={item.status} />}
        meta={<><Code>{item.approved_item_code || item.item_code}</Code>{unit && <span>Unit {unit}</span>}</>}
      />
      {serverError && <InlineNotice tone="risk" title="Changes were not saved">{serverError.message} Your entries are still here.</InlineNotice>}
      <ErrorSummary errors={submitted ? Object.entries(all).map(([id, message]) => ({ id, message })) : []} />

      <FormSection title="Item master" description="Changed on the item master, not here." columns={1}>
        <DescriptionList columns={3} items={[
          { label: 'Name', value: item.item_name },
          { label: 'Item code', value: <Code>{item.approved_item_code || item.item_code}</Code> },
          { label: 'Unit', value: unit },
          { label: 'Description', value: item.description, wide: true },
        ]} />
      </FormSection>

      <FormSection title="Cost">
        <Field label="Unit price" optional help="Can be updated later from purchase orders." id="unit_price">
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
        <Field label="Condition notes" optional id="condition_notes">
          <Textarea rows={3} value={form.condition_notes} onChange={set('condition_notes')} placeholder="Scratches on housing, original packaging missing…" />
        </Field>
      </FormSection>

      {approved ? (
        <FormSection title="Stock levels" description="Drive the low-stock warnings and replenishment." columns={3}>
          <Field label="Minimum" optional id="minimum_stock_level">
            <Input type="number" step="0.01" min="0" numeric suffix={unit} value={form.minimum_stock_level} onChange={set('minimum_stock_level')} onBlur={blur('minimum_stock_level')} />
          </Field>
          <Field label="Maximum" optional error={errors.maximum_stock_level} id="maximum_stock_level">
            <Input type="number" step="0.01" min="0" numeric suffix={unit} value={form.maximum_stock_level} onChange={set('maximum_stock_level')} onBlur={blur('maximum_stock_level')} />
          </Field>
          <Field label="Reorder point" optional error={errors.reorder_point} help="Warn when on-hand falls to this." id="reorder_point">
            <Input type="number" step="0.01" min="0" numeric suffix={unit} value={form.reorder_point} onChange={set('reorder_point')} onBlur={blur('reorder_point')} />
          </Field>
        </FormSection>
      ) : (
        <InlineNotice tone="ink" title="Stock levels are set at approval">Minimum, maximum and reorder point can be edited once the item is approved.</InlineNotice>
      )}

      <div className="flex justify-end gap-2 border-t border-ink-200 pt-4">
        <Button variant="ghost" onClick={() => navigate(`/inventory/items/${item.id}`)}>Cancel</Button>
        <Button type="submit" variant="primary" loading={saving}>Save changes</Button>
      </div>
    </form>
  )
}
