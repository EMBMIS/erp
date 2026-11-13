import { useState } from 'react'
import { SparklesIcon } from '@heroicons/react/20/solid'
import AIComprehensiveModal from '../../components/AIComprehensiveModal'
import {
  Button, Field, Input, Select, Textarea, Checkbox, FormSection, ErrorSummary, InlineNotice, Code,
} from '../../components/ui'

/**
 * The item master form, shared by create and edit so both behave the same.
 * Controlled: the page owns `value` (create autosaves it as a draft) and the
 * submit buttons; this renders the fields, validates on blur, and lists what
 * is missing after a submit attempt.
 */
export const ITEM_BLANK = {
  name: '', description: '', is_stock_item: true, planned_stock: false, status: 'DRAFT', criticality: 'LOW', unit_of_measure: 'pcs',
  unspsc_code: '', manufacturer: '', manufacturer_part_number: '', item_category: '', serial_number: '', equipment_tag: '',
  has_contract: false, contract_number: '', has_barcode: false, barcode: '', mass_per_uom: '', volume_per_uom: '',
}

export function validateItem(f) {
  const e = {}
  if (!f.name?.trim()) e.name = 'Name the item the way buyers and the warehouse will search for it.'
  if (f.has_contract && !f.contract_number?.trim()) e.contract_number = 'Enter the contract number, or untick "Under contract".'
  if (f.has_barcode && !f.barcode?.trim()) e.barcode = 'Enter the barcode, or untick "Has a barcode".'
  if (f.mass_per_uom !== '' && f.mass_per_uom != null && !(Number(f.mass_per_uom) >= 0)) e.mass_per_uom = 'Enter zero or more.'
  if (f.volume_per_uom !== '' && f.volume_per_uom != null && !(Number(f.volume_per_uom) >= 0)) e.volume_per_uom = 'Enter zero or more.'
  return e
}

/** Server validation answers { details: [{ field, message }] }; show each on its field. */
export function serverFieldErrors(err) {
  const details = err?.response?.data?.details
  if (!Array.isArray(details)) return {}
  return Object.fromEntries(details.map((d) => [d.field, d.message]))
}

const stockCode = (f) => (!f.is_stock_item ? 'NS3' : f.planned_stock ? 'ST2' : 'ST1')
const STOCK_HELP = { ST1: 'Regular stock — kept on hand, reordered as used.', ST2: 'Planned stock — min/max levels are planned at approval.', NS3: 'Non-stock — bought when needed, never held.' }

export default function ItemMasterForm({ value: f, onChange, submitted, serverErrors = {}, serverError }) {
  const [touched, setTouched] = useState({})
  const [aiOpen, setAiOpen] = useState(false)
  const all = { ...validateItem(f), ...serverErrors }
  const errors = submitted ? all : Object.fromEntries(Object.entries(all).filter(([k]) => touched[k] || serverErrors[k]))
  const set = (k) => (e) => onChange({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }))
  const code = stockCode(f)

  return (
    <div className="space-y-5">
      {serverError && <InlineNotice tone="risk" title="The item was not saved">{serverError} Your entries are still here.</InlineNotice>}
      <ErrorSummary errors={submitted ? Object.entries(all).map(([id, message]) => ({ id, message })) : []} />

      <FormSection title="What it is">
        <Field label="Name" required error={errors.name} className="sm:col-span-2" id="name"
          labelAction={<Button size="xs" variant="ghost" icon={SparklesIcon} onClick={() => setAiOpen(true)} disabled={!f.name.trim()} title={f.name.trim() ? undefined : 'Type a name first'}>Fill the rest with Simeli</Button>}>
          <Input value={f.name} onChange={set('name')} onBlur={blur('name')} placeholder="Hex bolt M8 × 40, zinc plated" />
        </Field>
        <Field label="Description" optional className="sm:col-span-2" id="description">
          <Textarea rows={3} value={f.description} onChange={set('description')} placeholder="Material, size, standard — what a buyer needs to source it" />
        </Field>
        <Field label="Category" optional help="Used to group spend and stock." id="item_category">
          <Input value={f.item_category} onChange={set('item_category')} placeholder="Fasteners, electronics…" />
        </Field>
        <Field label="Unit of measure" id="unit_of_measure">
          <Input value={f.unit_of_measure} onChange={set('unit_of_measure')} placeholder="pcs, kg, m" />
        </Field>
        <Field label="Criticality" help="How badly operations suffer if it runs out." id="criticality">
          <Select value={f.criticality} onChange={set('criticality')}>
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
          </Select>
        </Field>
        <Field label="UNSPSC code" optional help="United Nations Standard Products and Services Code, 8 digits." id="unspsc_code">
          <Input className="font-mono" inputMode="numeric" value={f.unspsc_code} onChange={set('unspsc_code')} placeholder="31161500" />
        </Field>
      </FormSection>

      <FormSection title="Stock classification" columns={1}>
        <Checkbox label="Stock item" description="A physical item held in inventory." checked={f.is_stock_item} onChange={(e) => onChange({ ...f, is_stock_item: e.target.checked, planned_stock: e.target.checked ? f.planned_stock : false })} id="is_stock_item" />
        {f.is_stock_item && <Checkbox label="Planned stock" description="Needs minimum and maximum stock levels planned." checked={f.planned_stock} onChange={set('planned_stock')} id="planned_stock" />}
        <p className="text-sm text-ink-700">Stock code <Code className="font-semibold text-fg">{code}</Code> <span className="text-ink-500">— {STOCK_HELP[code]}</span></p>
      </FormSection>

      <FormSection title="Manufacturer and physical" description="Manufacturer, part number, mass and volume" advanced defaultOpen={Boolean(f.manufacturer || f.manufacturer_part_number || f.mass_per_uom || f.volume_per_uom)}>
        <Field label="Manufacturer" optional id="manufacturer">
          <Input value={f.manufacturer} onChange={set('manufacturer')} />
        </Field>
        <Field label="Manufacturer part number" optional id="manufacturer_part_number">
          <Input className="font-mono" value={f.manufacturer_part_number} onChange={set('manufacturer_part_number')} />
        </Field>
        <Field label="Mass per unit" optional error={errors.mass_per_uom} help="Used for bin weight capacity." id="mass_per_uom">
          <Input type="number" step="0.001" min="0" numeric suffix="kg" value={f.mass_per_uom} onChange={set('mass_per_uom')} onBlur={blur('mass_per_uom')} />
        </Field>
        <Field label="Volume per unit" optional error={errors.volume_per_uom} help="Used for bin volume capacity." id="volume_per_uom">
          <Input type="number" step="0.000001" min="0" numeric suffix="m³" value={f.volume_per_uom} onChange={set('volume_per_uom')} onBlur={blur('volume_per_uom')} />
        </Field>
      </FormSection>

      <FormSection title="Tracking and contract" description="Serial number, equipment tag, contract, barcode" advanced defaultOpen={Boolean(f.serial_number || f.equipment_tag || f.has_contract || f.has_barcode)}>
        <Field label="Serial number" optional id="serial_number">
          <Input className="font-mono" value={f.serial_number} onChange={set('serial_number')} />
        </Field>
        <Field label="Equipment tag" optional id="equipment_tag">
          <Input className="font-mono" value={f.equipment_tag} onChange={set('equipment_tag')} />
        </Field>
        <div className="space-y-3">
          <Checkbox label="Under contract" checked={f.has_contract} onChange={(e) => onChange({ ...f, has_contract: e.target.checked, contract_number: e.target.checked ? f.contract_number : '' })} id="has_contract" />
          {f.has_contract && (
            <Field label="Contract number" required error={errors.contract_number} id="contract_number">
              <Input className="font-mono" value={f.contract_number} onChange={set('contract_number')} onBlur={blur('contract_number')} />
            </Field>
          )}
        </div>
        <div className="space-y-3">
          <Checkbox label="Has a barcode" checked={f.has_barcode} onChange={(e) => onChange({ ...f, has_barcode: e.target.checked, barcode: e.target.checked ? f.barcode : '' })} id="has_barcode" />
          {f.has_barcode && (
            <Field label="Barcode" required error={errors.barcode} help="Scan it into this box, or type it." id="barcode">
              <Input className="font-mono" value={f.barcode} onChange={set('barcode')} onBlur={blur('barcode')} autoComplete="off" />
            </Field>
          )}
        </div>
      </FormSection>

      <AIComprehensiveModal
        isOpen={aiOpen}
        onClose={() => setAiOpen(false)}
        onApply={(ai) => onChange({ ...f, ...ai })}
        initialName={f.name}
        initialDescription={f.description}
      />
    </div>
  )
}
