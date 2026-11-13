import { DocumentTextIcon, BuildingStorefrontIcon, UserIcon, CubeIcon, ShoppingCartIcon } from '@heroicons/react/24/outline'
import api from '../../services/api'

/**
 * Record search for the command palette.
 *
 * There is no cross-entity search endpoint (see docs/design/HANDOFF.md), so
 * this fans out to the list endpoints the user can already read and filters
 * the recent rows locally. Each endpoint enforces its own permissions; one
 * the user may not read simply contributes nothing. Lists are cached for a
 * minute so typing does not re-fetch on every key.
 */
const SOURCES = [
  {
    key: 'po', group: 'Purchase orders', icon: DocumentTextIcon, path: '/purchase-orders', params: { limit: 300 },
    map: (r) => ({ id: `po:${r.id}`, title: r.po_number, subtitle: [r.supplier_name || r.supplier_legal_name, r.status?.replace(/_/g, ' ').toLowerCase()].filter(Boolean).join(' · '), href: `/procurement/purchase-orders/${r.id}`, keywords: `${r.supplier_name || ''} ${r.supplier_code || ''}` }),
  },
  {
    key: 'sup', group: 'Suppliers', icon: BuildingStorefrontIcon, path: '/suppliers', params: { limit: 300 },
    map: (r) => ({ id: `sup:${r.id}`, title: r.legal_name || r.trade_name, subtitle: [r.supplier_code, r.city, r.country].filter(Boolean).join(' · '), href: `/procurement/suppliers/${r.id}`, keywords: r.trade_name }),
  },
  {
    key: 'cust', group: 'Customers', icon: UserIcon, path: '/customers', params: { limit: 300 },
    map: (r) => ({ id: `cust:${r.id}`, title: r.customer_name, subtitle: [r.customer_code, r.billing_city].filter(Boolean).join(' · '), href: `/sales/customers/${r.id}` }),
  },
  {
    key: 'so', group: 'Sales orders', icon: ShoppingCartIcon, path: '/sales-orders', params: { limit: 300 },
    map: (r) => ({ id: `so:${r.id}`, title: r.order_number || r.so_number, subtitle: [r.customer_name, r.status?.replace(/_/g, ' ').toLowerCase()].filter(Boolean).join(' · '), href: `/sales/sales-orders/${r.id}` }),
  },
  {
    key: 'item', group: 'Items', icon: CubeIcon, path: '/items', params: { limit: 500 },
    map: (r) => ({ id: `item:${r.id}`, title: r.name, subtitle: [r.approved_item_code || r.item_code, r.unit_of_measure].filter(Boolean).join(' · '), href: `/items/${r.id}/view`, keywords: r.item_code }),
  },
]

const cache = new Map()
const TTL = 60_000

async function load(source) {
  const hit = cache.get(source.key)
  if (hit && Date.now() - hit.at < TTL) return hit.rows
  try {
    const res = await api.get(source.path, { params: source.params })
    const raw = res.data?.data
    const list = Array.isArray(raw) ? raw : raw?.rows || raw?.items || []
    const rows = list.map(source.map).filter((r) => r.title)
    cache.set(source.key, { at: Date.now(), rows })
    return rows
  } catch {
    cache.set(source.key, { at: Date.now(), rows: [] })
    return []
  }
}

export async function searchRecords(query, navigate) {
  const q = query.toLowerCase()
  const results = await Promise.all(SOURCES.map(async (s) => {
    const rows = await load(s)
    return rows
      .filter((r) => `${r.title} ${r.subtitle || ''} ${r.keywords || ''}`.toLowerCase().includes(q))
      .slice(0, 5)
      .map((r) => ({ ...r, group: s.group, icon: s.icon, run: () => navigate(r.href) }))
  }))
  return results.flat()
}

export function invalidateRecordSearch() {
  cache.clear()
}
