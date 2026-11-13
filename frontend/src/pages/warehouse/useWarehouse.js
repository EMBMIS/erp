import api from '../../services/api'
import { useResource } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { asList } from './warehouseData'

/**
 * Inventory items in a storage location that are still awaiting approval.
 *
 * There is no endpoint for this, so it is composed: the location's bins,
 * then each bin's contents, keeping lines whose inventory item is pending.
 * One bin failing must not blank the list, so each bin is tried on its own.
 * The location screen and the approvals screen share this key, so the count
 * on one and the list on the other always agree.
 */
export function useLocationPendingItems(locationId) {
  return useResource(
    keys.storageLocationPendingApprovals(locationId),
    async ({ signal }) => {
      const binsResponse = await api.get(`/storage-locations/${locationId}/bins`, { signal })
      const bins = asList(binsResponse.data)
      const pending = []
      for (const bin of bins) {
        try {
          const itemsResponse = await api.get(`/bins/${bin.id}/inventory-items`, { signal })
          asList(itemsResponse.data)
            .filter((item) => item.inventory_status === 'PENDING_APPROVAL')
            .forEach((item) => pending.push({ ...item, bin_code: bin.code, bin_id: bin.id }))
        } catch {
          // one bin failed — count what we can
        }
      }
      return { data: { success: true, data: pending } }
    },
    { enabled: Boolean(locationId) }
  )
}

/** Active storage locations, for pickers. */
export function useActiveLocations() {
  const q = useResource(keys.storageLocations({ is_active: true }), ({ signal }) => api.get('/storage-locations', { params: { is_active: true }, signal }))
  return { ...q, locations: asList(q.data) }
}

/** Active bins in one storage location, for pickers. Disabled until a location is chosen. */
export function useLocationBins(locationId) {
  const q = useResource(
    [...keys.bins(locationId), 'active'],
    ({ signal }) => api.get('/bins', { params: { storage_location_id: locationId, is_active: true }, signal }),
    { enabled: Boolean(locationId) }
  )
  return { ...q, bins: asList(q.data) }
}
