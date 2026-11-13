import React, { useState } from 'react'
import { Dialog } from '@headlessui/react'
import { XMarkIcon, SparklesIcon, CheckIcon } from '@heroicons/react/24/outline'
import { itemsAPI } from '../services/api'
import toast from 'react-hot-toast'
import { useI18n } from '../contexts/I18nContext'

function AIComprehensiveModal({ isOpen, onClose, onApply, initialName = '', initialDescription = '' }) {
  const { t } = useI18n()
  const [itemName, setItemName] = useState(initialName)
  const [itemDescription, setItemDescription] = useState(initialDescription)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generatedData, setGeneratedData] = useState(null)
  const [selectedFields, setSelectedFields] = useState({})

  const handleGenerate = async () => {
    if (!itemName.trim()) {
      toast.error('Please enter an item name')
      return
    }

    setIsGenerating(true)
    try {
      const response = await itemsAPI.generateComprehensive(itemName, itemDescription)
      const data = response.data.data
      
      setGeneratedData(data)
      
      // Initialize all fields as selected by default
      const initialSelection = {}
      Object.keys(data).forEach(key => {
        initialSelection[key] = true
      })
      setSelectedFields(initialSelection)
      
      toast.success('AI data generated! Review and select fields to apply.')
    } catch (error) {
      toast.error('Failed to generate AI data')
      console.error('AI generation error:', error)
    } finally {
      setIsGenerating(false)
    }
  }

  const handleFieldToggle = (fieldName) => {
    setSelectedFields(prev => ({
      ...prev,
      [fieldName]: !prev[fieldName]
    }))
  }

  const handleApplySelected = () => {
    if (!generatedData) return

    const selectedData = {}
    Object.keys(selectedFields).forEach(key => {
      if (selectedFields[key] && generatedData[key] !== undefined) {
        selectedData[key] = generatedData[key]
      }
    })

    onApply(selectedData)
    onClose()
    toast.success(`Applied ${Object.keys(selectedData).length} fields`)
  }

  const handleApplyAll = () => {
    if (!generatedData) return
    onApply(generatedData)
    onClose()
    toast.success('Applied all generated fields')
  }

  const getFieldLabel = (fieldName) => {
    const labels = {
      name: 'Item Name',
      description: 'Description',
      is_stock_item: 'Stock Item',
      planned_stock: 'Planned Stock',
      status: 'Status',
      criticality: 'Criticality',
      unit_of_measure: 'Unit of Measure',
      unspsc_code: 'UNSPSC Code',
      manufacturer: 'Manufacturer',
      manufacturer_part_number: 'Manufacturer Part Number',
      item_category: 'Item Category',
      serial_number: 'Serial Number',
      equipment_tag: 'Equipment Tag',
      has_contract: 'Has Contract',
      contract_number: 'Contract Number',
      has_barcode: 'Has Barcode',
      barcode: 'Barcode',
      mass_per_uom: 'Mass per UoM (kg)',
      volume_per_uom: 'Volume per UoM (m³)'
    }
    return labels[fieldName] || fieldName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
  }

  const formatFieldValue = (fieldName, value) => {
    if (typeof value === 'boolean') {
      if (fieldName === 'is_stock_item') {
        return value ? '✅ Stock Item' : '❌ Non-Stock Item'
      }
      if (fieldName === 'planned_stock') {
        return value ? '📊 Requires Planning' : '🏷️ No Planning Required'
      }
      if (fieldName === 'has_contract') {
        return value ? '📄 Under Contract' : '🚫 No Contract'
      }
      if (fieldName === 'has_barcode') {
        return value ? '🔷 Has Barcode' : '🔲 No Barcode'
      }
      return value ? 'Yes' : 'No'
    }
    if (value === null || value === undefined || value === '') {
      return 'Not specified'
    }
    // Format numeric fields
    if (fieldName === 'mass_per_uom' && typeof value === 'number') {
      return `${value.toFixed(6)} kg`
    }
    if (fieldName === 'volume_per_uom' && typeof value === 'number') {
      return `${value.toFixed(6)} m³`
    }
    return String(value)
  }

  const getFieldDescription = (fieldName) => {
    const descriptions = {
      is_stock_item: 'Physical item requiring inventory tracking',
      planned_stock: 'Requires minimum/maximum stock level planning',
      status: 'Item approval and review status',
      criticality: 'Business criticality level',
      unspsc_code: '8-digit UN Standard Products and Services Code',
      manufacturer_part_number: 'Original manufacturer part number',
      item_category: 'Classification category for grouping',
      serial_number: 'Unique identification number',
      equipment_tag: 'Optional equipment identification tag',
      contract_number: 'Associated contract reference (if applicable)',
      barcode: 'Barcode identifier (if applicable)',
      mass_per_uom: 'Mass per unit of measure in kilograms - for inventory calculations',
      volume_per_uom: 'Volume per unit of measure in cubic meters - for inventory calculations'
    }
    return descriptions[fieldName]
  }

  const selectedCount = Object.values(selectedFields).filter(Boolean).length
  const totalCount = Object.keys(selectedFields).length

  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
      
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel className="mx-auto max-w-4xl w-full glass-card max-h-[90vh] overflow-hidden flex flex-col">
          <div className="flex items-center justify-between p-6 border-b">
            <Dialog.Title className="text-lg font-medium text-gray-900">
             {t('ui.aiComprehensiveDataGeneration')}
            </Dialog.Title>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
              <XMarkIcon className="w-6 h-6" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {/* Input Section */}
            <div className="mb-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2" htmlFor="item-name">
                   {t('ui.itemName')}
                  </label>
                  <input
                    type="text"
                    value={itemName}
                    onChange={(e) => setItemName(e.target.value)}
                    className="form-input w-full"
                    placeholder={t('ui.enterItemName')}
                   id="item-name" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2" htmlFor="description-optional">
                   {t('ui.descriptionOptional')}
                  </label>
                  <input
                    type="text"
                    value={itemDescription}
                    onChange={(e) => setItemDescription(e.target.value)}
                    className="form-input w-full"
                    placeholder={t('ui.optionalDescriptionToHelpAi')}
                   id="description-optional" />
                </div>
              </div>
              
              <button
                onClick={handleGenerate}
                disabled={isGenerating || !itemName.trim()}
                className="btn btn-primary mt-4"
              >
                <SparklesIcon className="w-4 h-4 mr-2" />
                {isGenerating ? 'Generating...' : 'Generate AI Data'}
              </button>
            </div>

            {/* Generated Data Section */}
            {generatedData && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-medium text-gray-900">
                   {t('ui.generatedData')}{selectedCount}/{totalCount} {t('ui.selected')}
                  </h3>
                  <div className="space-x-2">
                    <button
                      onClick={() => {
                        const allSelected = {}
                        Object.keys(generatedData).forEach(key => {
                          allSelected[key] = true
                        })
                        setSelectedFields(allSelected)
                      }}
                      className="text-sm text-blue-600 hover:text-blue-700"
                    >
                     {t('ui.selectAll')}
                    </button>
                    <button
                      onClick={() => {
                        const noneSelected = {}
                        Object.keys(generatedData).forEach(key => {
                          noneSelected[key] = false
                        })
                        setSelectedFields(noneSelected)
                      }}
                      className="text-sm text-gray-600 hover:text-gray-700"
                    >
                     {t('ui.selectNone')}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-h-96 overflow-y-auto border rounded-lg p-4">
                  {Object.entries(generatedData).map(([fieldName, value]) => (
                    <button
                      type="button"
                      key={fieldName}
                      className={`w-full text-left p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                        selectedFields[fieldName]
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-gray-200 bg-gray-50'
                      }`}
                      onClick={() => handleFieldToggle(fieldName)}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium text-gray-700">
                          {getFieldLabel(fieldName)}
                        </label>
                        {selectedFields[fieldName] && (
                          <CheckIcon className="w-5 h-5 text-blue-600" />
                        )}
                      </div>
                      <div className="text-sm text-gray-900 break-words mb-1">
                        {formatFieldValue(fieldName, value)}
                      </div>
                      {getFieldDescription(fieldName) && (
                        <div className="text-xs text-gray-500">
                          {getFieldDescription(fieldName)}
                        </div>
                      )}
                      {fieldName === 'is_stock_item' && value !== undefined && (
                        <div className="text-xs text-blue-600 mt-1">
                         {t('ui.autoStockCode')} {!value ? 'NS3' : generatedData.planned_stock ? 'ST2' : 'ST1'}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          {generatedData && (
            <div className="flex justify-end space-x-3 p-6 border-t bg-gray-50">
              <button
                onClick={onClose}
                className="btn btn-secondary"
              >
               {t('ui.cancel')}
              </button>
              <button
                onClick={handleApplySelected}
                disabled={selectedCount === 0}
                className="btn btn-primary"
              >
               {t('ui.applySelected')}{selectedCount})
              </button>
              <button
                onClick={handleApplyAll}
                className="btn bg-green-600 hover:bg-green-700 text-white"
              >
               {t('ui.applyAll')}
              </button>
            </div>
          )}
        </Dialog.Panel>
      </div>
    </Dialog>
  )
}

export default AIComprehensiveModal