import React from 'react'
import Barcode from 'react-barcode'
import { useI18n } from '../contexts/I18nContext'

function BarcodeDisplay({ value, format = 'CODE128', width = 2, height = 100, displayValue = true }) {
  // Validate if the barcode value is suitable for rendering
  const { t } = useI18n()
  const isValidBarcode = (value, format) => {
    if (!value || value.trim() === '') return false
    
    // Basic validation for different barcode formats
    switch (format) {
      case 'CODE128':
        return value.length > 0 && value.length <= 80
      case 'CODE39':
        return /^[A-Z0-9\-\.\ \$\/\+\%]*$/.test(value) && value.length <= 43
      case 'EAN13':
        return /^\d{12,13}$/.test(value)
      case 'EAN8':
        return /^\d{7,8}$/.test(value)
      case 'UPC':
        return /^\d{11,12}$/.test(value)
      default:
        return true
    }
  }

  // Determine the best barcode format based on the value
  const getBestFormat = (value) => {
    if (!value) return 'CODE128'
    
    const cleanValue = value.toString().trim()
    
    // Check for EAN13 (13 digits)
    if (/^\d{13}$/.test(cleanValue)) return 'EAN13'
    
    // Check for EAN8 (8 digits)
    if (/^\d{8}$/.test(cleanValue)) return 'EAN8'
    
    // Check for UPC (12 digits)
    if (/^\d{12}$/.test(cleanValue)) return 'UPC'
    
    // Check for CODE39 compatibility
    if (/^[A-Z0-9\-\.\ \$\/\+\%]*$/.test(cleanValue) && cleanValue.length <= 43) {
      return 'CODE39'
    }
    
    // Default to CODE128 for most cases
    return 'CODE128'
  }

  const barcodeFormat = format === 'AUTO' ? getBestFormat(value) : format
  const isValid = isValidBarcode(value, barcodeFormat)

  if (!isValid) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-md p-4 text-center">
        <div className="text-sm text-gray-500 mb-2">{t('ui.invalidBarcodeFormat')}</div>
        <div className="text-xs text-gray-400 font-mono">{value}</div>
      </div>
    )
  }

  try {
    return (
      <div className="bg-white border border-gray-200 rounded-md p-4 text-center">
        <Barcode
          value={value}
          format={barcodeFormat}
          width={width}
          height={height}
          displayValue={displayValue}
          fontSize={12}
          margin={10}
          background="#ffffff"
          lineColor="#000000"
        />
        <div className="text-xs text-gray-500 mt-2">
         {t('ui.format')} {barcodeFormat}
        </div>
      </div>
    )
  } catch (error) {
    console.error('Barcode generation error:', error)
    return (
      <div className="bg-red-50 border border-red-200 rounded-md p-4 text-center">
        <div className="text-sm text-red-600 mb-2">{t('ui.barcodeGenerationFailed')}</div>
        <div className="text-xs text-gray-500 font-mono">{value}</div>
        <div className="text-xs text-red-400 mt-1">{t('ui.format')} {barcodeFormat}</div>
      </div>
    )
  }
}

export default BarcodeDisplay