import React, { useState, useEffect } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { storageLocationsAPI, binsAPI, inventoryItemsAPI } from '../services/api'
import toast from 'react-hot-toast'
import { useI18n } from '../contexts/I18nContext'

function StorageAssignmentModal({ isOpen, onClose, inventoryItem, onSuccess }) {
  const { t } = useI18n()
  const [storageLocations, setStorageLocations] = useState([])
  const [bins, setBins] = useState([])
  const [formData, setFormData] = useState({
    storage_location_id: '',
    bin_id: ''
  })
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (isOpen) {
      fetchStorageLocations()
      resetForm()
    }
  }, [isOpen])

  useEffect(() => {
    if (formData.storage_location_id) {
      fetchBins(formData.storage_location_id)
    } else {
      setBins([])
      setFormData(prev => ({ ...prev, bin_id: '' }))
    }
  }, [formData.storage_location_id])

  const resetForm = () => {
    setFormData({
      storage_location_id: '',
      bin_id: ''
    })
  }

  const fetchStorageLocations = async () => {
    try {
      setIsLoading(true)
      const response = await storageLocationsAPI.getApproved()
      setStorageLocations(response.data.data || response.data || [])
    } catch (error) {
      console.error('Error fetching storage locations:', error)
      toast.error('Failed to fetch storage locations')
    } finally {
      setIsLoading(false)
    }
  }

  const fetchBins = async (storageLocationId) => {
    try {
      const response = await binsAPI.getByStorageLocation(storageLocationId)
      setBins(response.data.data || response.data || [])
    } catch (error) {
      console.error('Error fetching bins:', error)
      toast.error('Failed to fetch bins')
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    
    if (!formData.storage_location_id) {
      toast.error('Please select a storage location')
      return
    }

    setIsSubmitting(true)
    try {
      const submitData = {
        storage_location_id: formData.storage_location_id,
        bin_id: formData.bin_id || null,
        status: 'PENDING_APPROVAL'
        // No quantity needed - assign the complete inventory item
      }

      await inventoryItemsAPI.addStorageMapping(inventoryItem.id, submitData)
      toast.success('Assignment request submitted for approval')
      onSuccess()
      onClose()
    } catch (error) {
      console.error('Error submitting assignment request:', error)
      toast.error(error.response?.data?.error || 'Failed to submit assignment request')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
      <div className="relative top-20 mx-auto p-5 border w-full max-w-2xl shadow-lg rounded-md bg-white">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-gray-900">
           {t('ui.assignStorageLocation')}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <XMarkIcon className="w-6 h-6" />
          </button>
        </div>

        <div className="mb-4 p-3 bg-gray-50 rounded-lg">
          <h4 className="font-medium text-gray-900 mb-1">{t('ui.itemDetails')}</h4>
          <p className="text-sm text-gray-600">
            {inventoryItem.item_name} ({inventoryItem.approved_item_code})
          </p>
          <p className="text-xs text-gray-500">
           {t('ui.unitOfMeasure2')} {inventoryItem.unit_of_measure}
          </p>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2" htmlFor="storage-location">
               {t('ui.storageLocation')}
              </label>
              <select
                value={formData.storage_location_id}
                onChange={(e) => setFormData({ ...formData, storage_location_id: e.target.value })}
                className="form-select w-full"
                required
               id="storage-location">
                <option value="">{t('ui.selectStorageLocation')}</option>
                {storageLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name} ({location.code}) - {location.city}, {location.country}
                  </option>
                ))}
              </select>
              {storageLocations.length === 0 && (
                <p className="text-sm text-yellow-600 mt-1">
                 {t('ui.noApprovedStorageLocationsAvailablePlease')}
                </p>
              )}
            </div>

            {formData.storage_location_id && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2" htmlFor="specific-bin-optional">
                 {t('ui.specificBinOptional')}
                </label>
                <select
                  value={formData.bin_id}
                  onChange={(e) => setFormData({ ...formData, bin_id: e.target.value })}
                  className="form-select w-full"
                 id="specific-bin-optional">
                  <option value="">{t('ui.noSpecificBinGeneralStorage')}</option>
                  {bins.map((bin) => (
                    <option key={bin.id} value={bin.id}>
                      {bin.code} - {bin.description || 'No description'}
                    </option>
                  ))}
                </select>
                {bins.length === 0 && formData.storage_location_id && (
                  <p className="text-sm text-gray-500 mt-1">
                   {t('ui.noBinsAvailableForThisStorage')}
                  </p>
                )}
              </div>
            )}

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <h4 className="text-sm font-medium text-yellow-800 mb-3">{t('ui.assignmentApprovalProcess')}</h4>
              <div className="text-sm text-yellow-700 space-y-2">
                <p><span className="font-medium">{t('ui.approvalRequired')}</span> {t('ui.assignmentWillBeSubmittedForManager')}</p>
                <p><span className="font-medium">{t('ui.completeItemAssignment')}</span> {t('ui.fullInventoryItemWillBeAssigned')}</p>
                {inventoryItem.mass_per_uom && (
                  <p><span className="font-medium">{t('ui.massCalculation')}</span> {t('ui.automaticBasedOnItemQuantityAnd')}</p>
                )}
                {inventoryItem.volume_per_uom && (
                  <p><span className="font-medium">{t('ui.volumeCalculation')}</span> {t('ui.automaticBasedOnItemQuantityAnd2')}</p>
                )}
              </div>
              
              <div className="mt-4 pt-3 border-t border-yellow-200">
                <h5 className="text-sm font-medium text-yellow-800 mb-2">{t('ui.assignmentNotes')}</h5>
                <ul className="text-sm text-yellow-700 space-y-1">
                  <li>{t('ui.assignmentWillBePendingApprovalUntil')}</li>
                  <li>{t('ui.completeInventoryItemWillBeAssigned')}</li>
                  <li>{t('ui.binSelectionIsOptionalItemsCan')}</li>
                  <li>{t('ui.onlyApprovedStorageLocationsAndBins')}</li>
                  <li>{t('ui.capacityCalculationsAreAutomaticBasedOn')}</li>
                </ul>
              </div>
            </div>

            <div className="flex justify-end space-x-3 pt-4 border-t">
              <button
                type="button"
                onClick={onClose}
                className="btn btn-secondary"
                disabled={isSubmitting}
              >
               {t('ui.cancel')}
              </button>
              <button
                type="submit"
                disabled={isSubmitting || storageLocations.length === 0}
                className="btn btn-primary"
              >
                {isSubmitting ? 'Submitting...' : 'Submit for Approval'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

export default StorageAssignmentModal