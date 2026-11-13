import React, { useState, useEffect } from 'react'
import api from '../../services/api'
import { useParams, useNavigate } from 'react-router-dom'
import { useResource, useResourceMutation } from '../../hooks/useResource'
import { keys } from '../../services/queryKeys'
import { useI18n } from '../../contexts/I18nContext'
import {
  PublicShell, PublicHeader, PublicLoading, PublicMessage, PublicSection, PublicActions, Totals, Qty,
} from '../../components/public/PublicPage'
import {
  Button, Field, Input, Select, Textarea, InlineNotice, DescriptionList, Code, Money, StatusBadge,
  formatDate, formatMoney, describeError,
} from '../../components/ui'

// Public, token-authenticated portal page — token travels from useParams into
// the URL path on every request, unchanged from before.
const SalesRfqResponse = () => {
  const { t } = useI18n()
  const { token } = useParams()
  const navigate = useNavigate()
  const [submitError, setSubmitError] = useState('')
  const [priceErrors, setPriceErrors] = useState({})
  const [response, setResponse] = useState({
    supplier_total_amount: '',
    supplier_currency: 'USD',
    supplier_validity_days: '30',
    supplier_comments: '',
    supplier_alternative_items: '',
    items: []
  })

  const { data: rfq, loading, error: queryError } = useResource(
    keys.supplierPortalSalesRfq(token),
    async ({ signal }) => {
      const res = await api.get(`/supplier-portal/sales-rfq/${token}`, { signal })
      const body = res.data
      return { data: body }
    },
    { enabled: !!token, retry: false, staleTime: 0 }
  )

  useEffect(() => {
    if (rfq) {
      const initialItems = rfq.items?.map(item => ({
        sales_rfq_item_id: item.id,
        item_name: item.item_name,
        requested_quantity: item.requested_quantity,
        unit_of_measure: item.unit_of_measure,
        quoted_unit_price: '',
        quoted_total_price: '',
        availability_status: 'AVAILABLE',
        lead_time_days: '',
        supplier_notes: ''
      })) || []
      setResponse(prev => ({ ...prev, items: initialItems }))
    }
  }, [rfq])

  const handleResponseChange = (field, value) => {
    setResponse(prev => ({ ...prev, [field]: value }))
  }

  const handleItemResponseChange = (itemIndex, field, value) => {
    setResponse(prev => ({
      ...prev,
      items: prev.items.map((item, index) =>
        index === itemIndex ? { ...item, [field]: value } : item
      )
    }))
    if (field === 'quoted_unit_price' && priceErrors[itemIndex]) {
      setPriceErrors((prev) => ({ ...prev, [itemIndex]: null }))
    }
  }

  const itemTotal = (itemIndex) => {
    const item = response.items[itemIndex]
    const rfqItem = rfq?.items?.[itemIndex]
    if (item?.quoted_unit_price && rfqItem?.requested_quantity) {
      return parseFloat(item.quoted_unit_price) * rfqItem.requested_quantity
    }
    return null
  }

  const calculateOverallTotal = () => {
    return response.items.reduce((total, item, index) => {
      const rfqItem = rfq.items[index]
      if (item.quoted_unit_price && rfqItem.requested_quantity) {
        return total + (parseFloat(item.quoted_unit_price) * rfqItem.requested_quantity)
      }
      return total
    }, 0)
  }

  const submitMutation = useResourceMutation(
    async (payload) => {
      const submitResponse = await api.post(`/supplier-portal/sales-rfq/${token}/respond`, payload)
      const result = submitResponse.data
      return { data: result }
    },
    {
      silent: true,
      invalidates: [keys.supplierPortalSalesRfq(token)],
      onSuccess: () => navigate('/supplier-portal/thank-you'),
      onError: (err) => setSubmitError(err.response?.data?.error || err.message || 'Your response was not sent. Try again.'),
    }
  )
  const submitting = submitMutation.isPending

  const validatePrice = (index) => {
    const v = response.items[index]?.quoted_unit_price
    const msg = v === '' || v == null ? 'Enter a unit price, or 0 if you cannot supply this item.'
      : Number(v) < 0 ? 'A price cannot be negative.' : null
    setPriceErrors((prev) => ({ ...prev, [index]: msg }))
    return msg
  }

  const handleSubmitResponse = (e) => {
    e.preventDefault()
    setSubmitError('')
    const failing = response.items.map((_, i) => validatePrice(i)).findIndex(Boolean)
    if (failing >= 0) {
      document.getElementById(`srfq-${failing}-price`)?.focus()
      return
    }
    const payload = { ...response }
    // The backend stores quoted_total_price as a NOT NULL numeric and parses
    // it with parseFloat — an empty string becomes NaN and the insert fails.
    // Derive it from the quoted unit price so the line total is always sent.
    payload.items = (payload.items || []).map((it, idx) => {
      const qty = parseFloat(rfq?.items?.[idx]?.requested_quantity || it.requested_quantity || 0)
      const price = parseFloat(it.quoted_unit_price || 0)
      return { ...it, quoted_total_price: (price * qty).toFixed(2) }
    })
    if (!payload.supplier_total_amount) {
      payload.supplier_total_amount = calculateOverallTotal().toFixed(2)
    }
    submitMutation.mutate(payload)
  }

  const shell = (children) => <PublicShell context="Supplier portal">{children}</PublicShell>

  if (loading && token) return shell(<PublicLoading />)

  if (queryError || !rfq) {
    const { reference } = describeError(queryError)
    return shell(
      <PublicMessage tone="risk" title={t('ui.unableToLoadRfq')} reference={reference}>
        <p>{queryError?.response?.data?.error || queryError?.message || 'RFQ not found or expired'}</p>
        <p>The request may have closed or the link expired. Reply to the email it came with to ask for a new one.</p>
      </PublicMessage>
    )
  }

  const overall = calculateOverallTotal()
  const currency = response.supplier_currency

  return shell(
    <div className="space-y-5">
      <PublicHeader
        eyebrow="Request for quotation"
        title={rfq.rfq_title || <Code>{rfq.rfq_number}</Code>}
        status={<StatusBadge status={rfq.status} />}
        description={<>Respond by {formatDate(rfq.response_deadline, { withTime: true })}. Quote a price for each item.</>}
      />

      <PublicSection title={t('ui.rfqDetails')}>
        <DescriptionList
          items={[
            { label: 'RFQ number', value: <Code>{rfq.rfq_number}</Code> },
            { label: 'Customer', value: rfq.customer_name },
            { label: 'Response deadline', value: formatDate(rfq.response_deadline, { withTime: true }) },
            { label: 'Requested date', value: formatDate(rfq.requested_date) },
            { label: 'Budget', value: rfq.budget ? <Money amount={rfq.budget} currency={rfq.currency || 'USD'} /> : null },
            rfq.priority && { label: 'Priority', value: rfq.priority },
            rfq.description && { label: 'Description', value: rfq.description, wide: true },
          ]}
        />
      </PublicSection>

      <form onSubmit={handleSubmitResponse} className="space-y-5" noValidate>
        <PublicSection title={t('ui.itemResponses')} description={`${rfq.items?.length || 0} item${rfq.items?.length === 1 ? '' : 's'}`} padded={false}>
          <ol className="divide-y divide-ink-200">
            {rfq.items?.map((item, index) => {
              const p = `srfq-${index}`
              const line = itemTotal(index)
              return (
                <li key={item.id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-medium text-fg">{index + 1}. {item.item_name}</h3>
                    <span className="text-xs text-ink-500"><Qty value={item.requested_quantity} unit={item.unit_of_measure || 'units'} /></span>
                  </div>
                  {item.specifications && <p className="text-xs text-ink-600">{item.specifications}</p>}
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                    <Field label={`Unit price (${currency})`} id={`${p}-price`} error={priceErrors[index]}
                      help={line != null ? <>Line total <Money amount={line} currency={currency} /></> : null}>
                      <Input numeric size="lg" type="number" step="0.01" min="0"
                        value={response.items[index]?.quoted_unit_price || ''}
                        onChange={(e) => handleItemResponseChange(index, 'quoted_unit_price', e.target.value)}
                        onBlur={() => validatePrice(index)} />
                    </Field>
                    <Field label="Lead time (days)" id={`${p}-lead`}>
                      <Input numeric size="lg" type="number" min="0"
                        value={response.items[index]?.lead_time_days || ''}
                        onChange={(e) => handleItemResponseChange(index, 'lead_time_days', e.target.value)} />
                    </Field>
                    <Field label="Availability" id={`${p}-availability`} className="col-span-2 lg:col-span-1">
                      <Select size="lg" value={response.items[index]?.availability_status || 'AVAILABLE'}
                        onChange={(e) => handleItemResponseChange(index, 'availability_status', e.target.value)}>
                        <option value="">{t('ui.selectAvailability')}</option>
                        <option value="IN_STOCK">{t('ui.inStock2')}</option>
                        <option value="AVAILABLE">{t('ui.available2')}</option>
                        <option value="LIMITED">{t('ui.limitedStock')}</option>
                        <option value="OUT_OF_STOCK">{t('ui.outOfStock')}</option>
                        <option value="DISCONTINUED">{t('ui.discontinued')}</option>
                      </Select>
                    </Field>
                  </div>
                  <Field label="Comments on this item" optional id={`${p}-notes`}>
                    <Textarea rows={2} value={response.items[index]?.supplier_notes || ''}
                      onChange={(e) => handleItemResponseChange(index, 'supplier_notes', e.target.value)} />
                  </Field>
                </li>
              )
            })}
          </ol>
          <div className="border-t border-ink-200 px-4 py-3">
            <Totals rows={[{ label: 'Total of quoted lines', value: <Money amount={overall} currency={currency} />, strong: true }]} />
          </div>
        </PublicSection>

        <PublicSection title={t('ui.overallResponse')}>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Currency" id="supplier-currency">
                <Select size="lg" value={response.supplier_currency} onChange={(e) => handleResponseChange('supplier_currency', e.target.value)}>
                  <option value="USD">{t('ui.usd')}</option>
                  <option value="EUR">{t('ui.eur')}</option>
                  <option value="GBP">{t('ui.gbp')}</option>
                  <option value="CAD">{t('ui.cad')}</option>
                </Select>
              </Field>
              <Field label="Total amount" optional id="total-amount" help={`Leave blank to use ${formatMoney(overall, currency)}.`}>
                <Input numeric size="lg" type="number" step="0.01" min="0"
                  value={response.supplier_total_amount}
                  placeholder={overall.toFixed(2)}
                  onChange={(e) => handleResponseChange('supplier_total_amount', e.target.value)} />
              </Field>
              <Field label="Valid for (days)" id="validity-days">
                <Input numeric size="lg" type="number" min="1" value={response.supplier_validity_days}
                  onChange={(e) => handleResponseChange('supplier_validity_days', e.target.value)} />
              </Field>
            </div>
            <Field label="Payment terms" optional id="payment-terms">
              <Select size="lg" value={response.supplier_payment_terms || ''} onChange={(e) => handleResponseChange('supplier_payment_terms', e.target.value)}>
                <option value="">{t('ui.selectPaymentTerms2')}</option>
                <option value="NET_30">{t('ui.net30')}</option>
                <option value="NET_60">{t('ui.net60')}</option>
                <option value="NET_90">{t('ui.net90')}</option>
                <option value="COD">{t('ui.cashOnDelivery')}</option>
                <option value="PREPAID">{t('ui.prepaid')}</option>
              </Select>
            </Field>
            <Field label="General comments" optional id="general-comments">
              <Textarea rows={3} value={response.supplier_comments}
                onChange={(e) => handleResponseChange('supplier_comments', e.target.value)}
                placeholder={t('ui.anyGeneralCommentsOrNotesAbout')} />
            </Field>
            <Field label="Alternative items" optional id="alternative-items" help="Suggest substitutes for anything you cannot supply as asked.">
              <Textarea rows={3} value={response.supplier_alternative_items}
                onChange={(e) => handleResponseChange('supplier_alternative_items', e.target.value)} />
            </Field>
          </div>
        </PublicSection>

        {submitError && <InlineNotice tone="risk" title="Not sent">{submitError}</InlineNotice>}

        <PublicActions>
          <Button type="submit" size="lg" variant="primary" loading={submitting}>Submit response</Button>
        </PublicActions>
      </form>
    </div>
  )
}

export default SalesRfqResponse
