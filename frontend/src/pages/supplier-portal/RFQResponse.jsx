import React, { useState, useEffect } from 'react';
import api from '../../services/api';
import { useParams, useNavigate } from 'react-router-dom';
import { useResource, useResourceMutation } from '../../hooks/useResource';
import { keys } from '../../services/queryKeys';
import { useI18n } from '../../contexts/I18nContext';
import {
  PublicShell, PublicHeader, PublicLoading, PublicMessage, PublicSection, PublicActions, Qty,
} from '../../components/public/PublicPage';
import {
  Button, Field, Input, Textarea, InlineNotice, DescriptionList, Code, Money, ConfirmDialog,
  formatDate, describeError,
} from '../../components/ui';

// Public, token-authenticated portal page — token travels from useParams into
// the URL path (GET) and the JSON body (POST), unchanged from before.
const RFQResponse = () => {
  const { t } = useI18n();
  const { token } = useParams();
  const navigate = useNavigate();
  const [quotations, setQuotations] = useState([]);
  const [notes, setNotes] = useState('');
  const [declineOpen, setDeclineOpen] = useState(false);
  const [formError, setFormError] = useState('');
  const [submitError, setSubmitError] = useState('');

  const { data: rfqData, loading, error: queryError } = useResource(
    keys.supplierPortalRfq(token),
    async ({ signal }) => {
      const response = await api.get(`/supplier-portal/rfq/verify/${token}`, { signal });
      return { data: response.data };
    },
    { enabled: !!token, retry: false, staleTime: 0 }
  );

  useEffect(() => {
    if (rfqData?.lineItems) {
      setQuotations(rfqData.lineItems.map((item) => ({
        line_item_id: item.id,
        item_description: item.item_description,
        quantity: item.quantity,
        unit_of_measure: item.unit_of_measure,
        unit_price: '',
        lead_time_days: '',
        delivery_terms: '',
        payment_terms: '',
        validity_days: 30,
        notes: '',
      })));
    }
  }, [rfqData]);

  const updateQuotation = (index, field, value) => {
    setQuotations((prev) => prev.map((q, i) => (i === index ? { ...q, [field]: value } : q)));
    if (field === 'unit_price' && formError) setFormError('');
  };

  const submitMutation = useResourceMutation(
    async ({ quotations: validQuotations, notes: submitNotes }) => {
      const response = await api.post('/supplier-portal/rfq/submit-quotation', { token, quotations: validQuotations, notes: submitNotes });
      return { data: response.data };
    },
    {
      silent: true,
      invalidates: [keys.supplierPortalRfq(token)],
      onSuccess: () => navigate('/supplier-portal/thank-you'),
      onError: (err) => setSubmitError(err.response?.data?.error || err.message),
    }
  );

  const declineMutation = useResourceMutation(
    async (reason) => {
      const response = await api.post('/supplier-portal/rfq/decline', { token, reason });
      return { data: response.data };
    },
    {
      silent: true,
      invalidates: [keys.supplierPortalRfq(token)],
      onSuccess: () => navigate('/supplier-portal/thank-you'),
      onError: (err) => { setDeclineOpen(false); setSubmitError(err.response?.data?.error || err.message); },
    }
  );

  const submitting = submitMutation.isPending || declineMutation.isPending;

  const handleSubmit = (e) => {
    e.preventDefault();
    setSubmitError('');
    const validQuotations = quotations.filter((q) => q.unit_price && parseFloat(q.unit_price) > 0);
    if (validQuotations.length === 0) {
      setFormError('Enter a unit price above zero for at least one item. Leave items you cannot supply blank.');
      document.getElementById('rfq-line-0-price')?.focus();
      return;
    }
    submitMutation.mutate({ quotations: validQuotations, notes });
  };

  const shell = (children) => <PublicShell context="Supplier portal">{children}</PublicShell>;

  if (loading && token) return shell(<PublicLoading />);

  if (queryError || !rfqData) {
    const { reference } = describeError(queryError);
    return shell(
      <PublicMessage tone="risk" title="This request for quotation cannot be opened" reference={reference}>
        <p>{queryError?.response?.data?.error || queryError?.message || 'The link is incomplete.'}</p>
        <p>The link may have expired. Reply to the email it came with to ask for a new one.</p>
      </PublicMessage>
    );
  }

  const { rfq, supplier } = rfqData;
  const currency = rfq?.currency || 'USD';

  return shell(
    <div className="space-y-5">
      <PublicHeader
        eyebrow="Request for quotation"
        title={rfq?.title || <Code>{rfq?.rfq_number}</Code>}
        description={<>Respond by {formatDate(rfq?.response_deadline)}. Price the items you can supply and leave the rest blank.</>}
      />

      <PublicSection title={t('ui.rfqDetails')}>
        <DescriptionList
          items={[
            { label: 'RFQ number', value: <Code>{rfq?.rfq_number}</Code> },
            { label: 'Response deadline', value: formatDate(rfq?.response_deadline) },
            { label: 'Currency', value: rfq?.currency },
            supplier && { label: 'Your company', value: supplier.legal_name },
            rfq?.description && { label: 'Description', value: rfq.description, wide: true },
          ]}
        />
      </PublicSection>

      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <PublicSection title={t('ui.submitYourQuotation')} description={`${quotations.length} item${quotations.length === 1 ? '' : 's'} · prices in ${currency}`} padded={false}>
          <ol className="divide-y divide-ink-200">
            {quotations.map((q, index) => {
              const p = `rfq-line-${index}`;
              const lineTotal = q.unit_price && q.quantity != null ? Number(q.unit_price) * Number(q.quantity) : null;
              return (
                <li key={q.line_item_id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-medium text-fg">{index + 1}. {q.item_description}</h3>
                    <span className="text-xs text-ink-500"><Qty value={q.quantity} unit={q.unit_of_measure} /></span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <Field label={`Unit price (${currency})`} id={`${p}-price`} help={lineTotal != null ? <>Line total <Money amount={lineTotal} currency={currency} /></> : null}>
                      <Input numeric size="lg" type="number" step="0.01" min="0" value={q.unit_price}
                        onChange={(e) => updateQuotation(index, 'unit_price', e.target.value)} />
                    </Field>
                    <Field label="Lead time (days)" id={`${p}-lead`}>
                      <Input numeric size="lg" type="number" min="0" value={q.lead_time_days}
                        onChange={(e) => updateQuotation(index, 'lead_time_days', e.target.value)} />
                    </Field>
                    <Field label="Delivery terms" id={`${p}-delivery`}>
                      <Input size="lg" value={q.delivery_terms} placeholder={t('ui.fobCifEtc')}
                        onChange={(e) => updateQuotation(index, 'delivery_terms', e.target.value)} />
                    </Field>
                    <Field label="Payment terms" id={`${p}-payment`}>
                      <Input size="lg" value={q.payment_terms} placeholder={t('ui.net30Etc')}
                        onChange={(e) => updateQuotation(index, 'payment_terms', e.target.value)} />
                    </Field>
                  </div>
                  <Field label="Notes for this item" optional id={`${p}-notes`}>
                    <Textarea rows={2} value={q.notes} onChange={(e) => updateQuotation(index, 'notes', e.target.value)} />
                  </Field>
                </li>
              );
            })}
          </ol>
        </PublicSection>

        <Field label="General notes" optional id="general-notes" help="Anything that applies to the whole quotation.">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {formError && <InlineNotice tone="risk">{formError}</InlineNotice>}
        {submitError && <InlineNotice tone="risk" title="Not sent">{submitError}</InlineNotice>}

        <PublicActions>
          <Button size="lg" variant="destructive" onClick={() => setDeclineOpen(true)} disabled={submitting}>
            {t('ui.declineRfq')}
          </Button>
          <Button type="submit" size="lg" variant="primary" loading={submitMutation.isPending} disabled={submitting}>
            Submit quotation
          </Button>
        </PublicActions>
      </form>

      <ConfirmDialog
        open={declineOpen}
        onClose={() => setDeclineOpen(false)}
        onConfirm={(reason) => declineMutation.mutate(reason)}
        busy={declineMutation.isPending}
        title={`Decline ${rfq?.rfq_number || 'this request'}?`}
        confirmLabel="Decline request"
        consequence="The buyer is told you will not quote. You cannot quote on this request afterwards."
        requireReason
        reasonHelp="The buyer sees this."
      />
    </div>
  );
};

export default RFQResponse;
