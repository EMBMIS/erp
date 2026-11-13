import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../services/api';
import { useResource, useResourceMutation } from '../../hooks/useResource';
import { keys } from '../../services/queryKeys';
import { useI18n } from '../../contexts/I18nContext';
import {
  PublicShell, PublicHeader, PublicLoading, PublicMessage, PublicSection, PublicActions, Qty,
} from '../../components/public/PublicPage';
import {
  Button, Field, Input, Textarea, InlineNotice, DescriptionList, Code, Money, Badge, formatDate, describeError,
} from '../../components/ui';

// Public, token-authenticated portal page — token travels from useParams into
// the URL path on every request, unchanged from before.
const SupplierRFQResponse = () => {
  const { t } = useI18n();
  const { token } = useParams();
  const navigate = useNavigate();
  const [quotations, setQuotations] = useState({});
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState('');

  const { data, loading, error: queryError } = useResource(
    keys.supplierRfqResponse(token),
    ({ signal }) => api.get(`/supplier-portal/rfq-response/${token}`, { signal }),
    { enabled: !!token, retry: false, staleTime: 0 }
  );

  const rfq = data?.rfq || null;
  const lineItems = data?.line_items || [];
  const supplier = data?.supplier || null;

  useEffect(() => {
    if (data?.existing_quotations) {
      const existingQuotations = {};
      data.existing_quotations.forEach((quote) => {
        existingQuotations[quote.rfq_line_item_id] = {
          unit_price: quote.unit_price,
          delivery_date: quote.delivery_date ? new Date(quote.delivery_date).toISOString().split('T')[0] : '',
          notes: quote.notes || '',
        };
      });
      setQuotations(existingQuotations);
    }
  }, [data]);

  const handleQuotationChange = (lineItemId, field, value) => {
    setQuotations((prev) => ({ ...prev, [lineItemId]: { ...prev[lineItemId], [field]: value } }));
    if (errors[`${lineItemId}_${field}`] || errors.general) {
      setErrors((prev) => ({ ...prev, [`${lineItemId}_${field}`]: '', general: '' }));
    }
  };

  const validateLine = (item) => {
    const q = quotations[item.id] || {};
    const next = {};
    if (q.unit_price !== undefined && q.unit_price !== '' && !(parseFloat(q.unit_price) > 0)) {
      next[`${item.id}_unit_price`] = 'Enter a price above zero, or leave it blank to skip this item.';
    }
    if (q.delivery_date && new Date(q.delivery_date) <= new Date()) {
      next[`${item.id}_delivery_date`] = 'Choose a delivery date after today.';
    }
    return next;
  };

  const validateQuotations = () => {
    let newErrors = {};
    let hasValidQuotation = false;
    lineItems.forEach((item) => {
      newErrors = { ...newErrors, ...validateLine(item) };
      const q = quotations[item.id];
      if (q && parseFloat(q.unit_price) > 0) hasValidQuotation = true;
    });
    if (!hasValidQuotation) newErrors.general = 'Enter a unit price for at least one item. Leave items you cannot supply blank.';
    return newErrors;
  };

  const submitMutation = useResourceMutation(
    (quotationData) => api.post(`/supplier-portal/rfq-response/${token}`, { quotations: quotationData }),
    {
      silent: true,
      invalidates: [keys.supplierRfqResponse(token)],
      onSuccess: () => navigate('/supplier-portal/thank-you'),
      onError: (error) => {
        if (error.response?.status === 410) setSubmitError('The response period for this RFQ has expired.');
        else setSubmitError(error.response?.data?.error || error.message || 'Failed to submit quotations. Please try again.');
      },
    }
  );
  const submitting = submitMutation.isPending;

  const handleSubmit = (e) => {
    e.preventDefault();
    setSubmitError('');
    const validationErrors = validateQuotations();
    const keysWithErrors = Object.keys(validationErrors).filter((k) => validationErrors[k]);
    if (keysWithErrors.length > 0) {
      setErrors(validationErrors);
      const firstField = keysWithErrors.find((k) => k !== 'general');
      if (firstField) document.getElementById(`q-${firstField}`)?.focus();
      return;
    }

    const quotationData = Object.entries(quotations)
      .filter(([, quotation]) => quotation.unit_price)
      .map(([lineItemId, quotation]) => ({
        rfq_line_item_id: lineItemId,
        unit_price: parseFloat(quotation.unit_price),
        delivery_date: quotation.delivery_date || null,
        notes: quotation.notes || '',
      }));

    submitMutation.mutate(quotationData);
  };

  const shell = (children) => <PublicShell context="Supplier portal">{children}</PublicShell>;

  if (loading && token) return shell(<PublicLoading />);

  if (queryError || !rfq) {
    const status = queryError?.response?.status;
    const { reference } = describeError(queryError);
    return shell(
      <PublicMessage tone="risk" title={t('ui.rfqNotFound')} reference={reference}>
        <p>
          {status === 410 ? 'This RFQ response period has expired.'
            : status === 404 ? 'RFQ not found or access denied.'
            : queryError ? 'Failed to load RFQ details.' : t('ui.theRequestedRfqCouldNotBe')}
        </p>
        <p>Reply to the email this link came with to ask the buyer for a new one.</p>
      </PublicMessage>
    );
  }

  const expired = rfq.response_deadline ? new Date() > new Date(rfq.response_deadline) : false;
  const currency = rfq.currency || 'USD';
  const today = new Date().toISOString().split('T')[0];

  return shell(
    <div className="space-y-5">
      <PublicHeader
        eyebrow="Request for quotation"
        title={rfq.title || <Code>{rfq.rfq_number}</Code>}
        status={expired ? <Badge tone="risk">{t('ui.responsePeriodExpired2')}</Badge> : null}
        description={<><Code>{rfq.rfq_number}</Code> · Respond by {formatDate(rfq.response_deadline)}</>}
      />

      {expired && (
        <InlineNotice tone="risk" title={t('ui.responsePeriodExpired')}>
          The deadline was {formatDate(rfq.response_deadline)}. You can no longer submit quotations for this request.
        </InlineNotice>
      )}

      <PublicSection title={t('ui.rfqInformation')}>
        <DescriptionList
          items={[
            { label: 'Response deadline', value: formatDate(rfq.response_deadline) },
            { label: 'Currency', value: rfq.currency },
            supplier && { label: 'Your company', value: supplier.legal_name },
            supplier?.supplier_code && { label: 'Supplier code', value: <Code>{supplier.supplier_code}</Code> },
            { label: 'Description', value: rfq.description || null, wide: true },
          ]}
        />
      </PublicSection>

      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <PublicSection title={t('ui.submitYourQuotation')} description={t('ui.pleaseProvideYourPricingAndDelivery')} padded={false}>
          <ol className="divide-y divide-ink-200">
            {lineItems.map((item, index) => {
              const q = quotations[item.id] || {};
              const lineTotal = q.unit_price && item.quantity != null ? Number(q.unit_price) * Number(item.quantity) : null;
              return (
                <li key={item.id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-medium text-fg">{index + 1}. {item.item_description}</h3>
                    <span className="text-xs text-ink-500"><Qty value={item.quantity} unit={item.unit_of_measure} /></span>
                  </div>
                  {item.specifications && <p className="text-xs text-ink-600">{item.specifications}</p>}
                  <div className="grid grid-cols-2 gap-3">
                    <Field
                      label={`Unit price (${currency})`}
                      id={`q-${item.id}_unit_price`}
                      error={errors[`${item.id}_unit_price`]}
                      help={lineTotal != null ? <>Line total <Money amount={lineTotal} currency={currency} /></> : null}
                    >
                      <Input numeric size="lg" type="number" step="0.01" min="0.01" disabled={expired}
                        value={q.unit_price || ''}
                        onChange={(e) => handleQuotationChange(item.id, 'unit_price', e.target.value)}
                        onBlur={() => setErrors((prev) => ({ ...prev, [`${item.id}_unit_price`]: validateLine(item)[`${item.id}_unit_price`] || '' }))} />
                    </Field>
                    <Field label="Delivery date" optional id={`q-${item.id}_delivery_date`} error={errors[`${item.id}_delivery_date`]}>
                      <Input size="lg" type="date" min={today} disabled={expired}
                        value={q.delivery_date || ''}
                        onChange={(e) => handleQuotationChange(item.id, 'delivery_date', e.target.value)}
                        onBlur={() => setErrors((prev) => ({ ...prev, [`${item.id}_delivery_date`]: validateLine(item)[`${item.id}_delivery_date`] || '' }))} />
                    </Field>
                  </div>
                  <Field label="Notes" optional id={`q-${item.id}_notes`}>
                    <Textarea rows={2} disabled={expired} value={q.notes || ''}
                      onChange={(e) => handleQuotationChange(item.id, 'notes', e.target.value)}
                      placeholder={t('ui.anyAdditionalInformationAboutThisItem')} />
                  </Field>
                </li>
              );
            })}
          </ol>
        </PublicSection>

        {errors.general && <InlineNotice tone="risk">{errors.general}</InlineNotice>}
        {submitError && <InlineNotice tone="risk" title="Not sent">{submitError}</InlineNotice>}

        {!expired && (
          <PublicActions>
            <Button type="submit" size="lg" variant="primary" loading={submitting}>{t('ui.submitQuotation')}</Button>
          </PublicActions>
        )}
      </form>
    </div>
  );
};

export default SupplierRFQResponse;
