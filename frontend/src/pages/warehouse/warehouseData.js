/**
 * Small shared helpers for the warehouse screens.
 *
 * Several warehouse endpoints answer with a bare array (storage locations,
 * bins, bin contents) while others use the `{ success, data }` envelope.
 * `useResource` unwraps the envelope, so pages read lists through `asList`,
 * which accepts either shape. Reading `.data` off a bare array was the bug
 * that left several dropdowns on these screens permanently empty.
 */
export const asList = (d) => (Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [])

/** 8-digit bin codes read as WW-RR-SS-BB (warehouse, row, shelf, bin). */
export const formatBinCode = (code) =>
  code && /^\d{8}$/.test(code) ? `${code.slice(0, 2)}-${code.slice(2, 4)}-${code.slice(4, 6)}-${code.slice(6, 8)}` : code || ''

export const pct = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Utilisation as a state: near full is a risk, getting full is a warning. */
export const fillState = (p) => (p == null ? null : p >= 90 ? 'risk' : p >= 75 ? 'warn' : 'ok')

export const locationLabel = (l) => (l ? [l.code, l.name].filter(Boolean).join(' — ') : '')

export const TX_TYPES = {
  GR: { label: 'Goods receipt', short: 'Receipt', to: '/warehouse/transactions/goods-receipt' },
  GI: { label: 'Goods issue', short: 'Issue', to: '/warehouse/transactions/goods-issue' },
  GE: { label: 'Goods return', short: 'Return', to: '/warehouse/transactions/goods-return' },
  GT: { label: 'Goods transfer', short: 'Transfer', to: '/warehouse/transactions/goods-transfer' },
  SA: { label: 'Stock adjustment', short: 'Adjustment', to: '/warehouse/transactions/stock-adjustment' },
}

export const today = () => new Date().toISOString().split('T')[0]

/* ---- Storage location form ---- */
export const LOCATION_BLANK = { code: '', name: '', country: '', city: '', address: '', postal_code: '', description: '' }

export function validateLocation(f) {
  const e = {}
  if (!f.code?.trim()) e.code = 'Give the location a short unique code, such as LON or WH01.'
  if (!f.name?.trim()) e.name = 'Name the location the way people refer to it.'
  if (!f.country?.trim()) e.country = 'Enter the country.'
  if (!f.city?.trim()) e.city = 'Enter the city.'
  if (!f.address?.trim()) e.address = 'Enter the street address.'
  if (!f.postal_code?.trim()) e.postal_code = 'Enter the postal code.'
  return e
}

/* ---- Bin form ---- */
export function validateBin(f, { requireCode = true } = {}) {
  const e = {}
  const n = (v) => (v === '' || v == null ? null : parseFloat(v))
  if (requireCode && !/^\d{8}$/.test(f.code || '')) e.code = 'Use exactly 8 digits: warehouse, row, shelf, bin (WWRRSSBB).'
  if (requireCode && !f.storage_location_id) e.storage_location_id = 'Choose the storage location this bin is in.'
  if (!f.description?.trim()) e.description = 'Describe the bin so people can find it.'
  if (!(n(f.max_mass_capacity) > 0)) e.max_mass_capacity = 'Enter the weight it can hold, above zero.'
  if (!(n(f.max_volume_capacity) > 0)) e.max_volume_capacity = 'Enter the volume it can hold, above zero.'
  if (n(f.current_mass_used) != null && n(f.max_mass_capacity) > 0 && n(f.current_mass_used) > n(f.max_mass_capacity)) e.current_mass_used = 'Weight in use cannot be more than the capacity.'
  if (n(f.current_volume_used) != null && n(f.max_volume_capacity) > 0 && n(f.current_volume_used) > n(f.max_volume_capacity)) e.current_volume_used = 'Volume in use cannot be more than the capacity.'
  if (n(f.current_mass_used) < 0) e.current_mass_used = 'Cannot be negative.'
  if (n(f.current_volume_used) < 0) e.current_volume_used = 'Cannot be negative.'
  return e
}

/** Stocktake statuses in the shared vocabulary, keeping the stocktake's own words. */
export const SHEET_STATUS = {
  DRAFT: { status: 'DRAFT', label: 'Not started' },
  IN_PROGRESS: { status: 'IN_PROGRESS', label: 'Counting' },
  COUNTED: { status: 'PENDING_REVIEW', label: 'Counted — awaiting review' },
  REVIEWED: { status: 'APPROVED', label: 'Reviewed — ready to post' },
  POSTED: { status: 'POSTED', label: 'Posted' },
  CANCELLED: { status: 'CANCELLED', label: 'Cancelled' },
}

