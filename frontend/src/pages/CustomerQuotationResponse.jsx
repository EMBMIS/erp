import React, { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import api from '../services/api';
import { useResource, useResourceMutation } from '../hooks/useResource';
import { keys } from '../services/queryKeys';
import { useI18n } from '../contexts/I18nContext';
import {
  PublicShell, PublicHeader, PublicLoading, PublicMessage, PublicSection,
  LineList, Totals, ChoiceGroup, PublicActions, Qty,
} from '../components/public/PublicPage';
import { Button, Field, Textarea, InlineNotice, DescriptionList, Money, Code, formatDate, describeError } from '../components/ui';

const CustomerQuotationResponse = () => {
  const { t } = useI18n();
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const preselectedAction = searchParams.get('action');

  const [submitted, setSubmitted] = useState(false);
  const [selectedAction, setSelectedAction] = useState(
    preselectedAction === 'accept' || preselectedAction === 'reject' ? preselectedAction : ''
  );
  const [customerNotes, setCustomerNotes] = useState('');
  const [choiceError, setChoiceError] = useState('');
  const [submitError, setSubmitError] = useState('');

  // Portal token can expire mid-session; retrying a 401 three times is worse
  // than failing once with a clear message.
  const { data: quotation, loading, error: queryError } = useResource(
    keys.customerQuotationResponse(token),
    ({ signal }) => api.get(`/sales-quotations/customer-response/${token}`, { signal }),
    { enabled: !!token, retry: false, staleTime: 0 }
  );

  const submitMutation = useResourceMutation(
    (payload) => api.post(`/sales-quotations/customer-response/${token}`, payload),
    { silent: true }
  );
  const submitting = submitMutation.isPending;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitError('');
    if (!selectedAction) {
      setChoiceError('Choose whether you accept or decline this quotation.');
      return;
    }
    try {
      await submitMutation.mutateAsync({ action: selectedAction, notes: customerNotes });
      setSubmitted(true);
    } catch (error) {
      setSubmitError(error.response?.data?.error || 'Your response was not sent. Check your connection and try again.');
    }
  };

  const shell = (children) => <PublicShell context="Quotation">{children}</PublicShell>;

  if (loading && token) return shell(<PublicLoading />);

  if (queryError || !token) {
    const { reference } = describeError(queryError);
    return shell(
      <PublicMessage tone="risk" title={t('ui.unableToLoadQuotation')} reference={reference}>
        <p>
          {queryError?.response?.status === 404 || !token
            ? 'This quotation has already been answered, has expired, or the link is incomplete.'
            : 'The quotation could not be loaded. Try again in a minute.'}
        </p>
        <p>If you still need to respond, reply to the email the quotation came with and ask for a new link.</p>
      </PublicMessage>
    );
  }

  if (submitted) {
    return shell(
      <PublicMessage tone="ok" title={selectedAction === 'accept' ? 'Quotation accepted' : 'Quotation declined'}>
        <p>{t('ui.thankYouForYourResponseTo3')} <Code>{quotation?.quotation_number}</Code>.</p>
        <p>
          {selectedAction === 'accept'
            ? 'We will process your acceptance and contact you with the next steps shortly.'
            : 'We appreciate your consideration and hope to work with you in the future.'}
        </p>
        <p className="text-xs text-ink-500">{t('ui.youMayNowCloseThisWindow')}</p>
      </PublicMessage>
    );
  }

  const currency = quotation?.currency || 'USD';
  const items = quotation?.items || [];

  return shell(
    <div className="space-y-5">
      <PublicHeader
        eyebrow="Quotation"
        title={<Code>{quotation?.quotation_number}</Code>}
        description={`Review the quotation and accept or decline it. Valid until ${formatDate(quotation?.valid_until)}.`}
      />

      <PublicSection title={t('ui.quotationDetails')}>
        <DescriptionList
          items={[
            { label: 'Customer', value: quotation?.customer_name },
            { label: 'Quotation date', value: formatDate(quotation?.quotation_date) },
            { label: 'Valid until', value: formatDate(quotation?.valid_until) },
            quotation?.reference_number && { label: 'Your reference', value: <Code>{quotation.reference_number}</Code> },
            quotation?.notes && { label: 'Notes', value: quotation.notes, wide: true },
          ]}
        />
      </PublicSection>

      <PublicSection title={t('ui.quotationItems')} padded={false}>
        {items.length ? (
          <LineList
            label="Quotation items"
            rows={items}
            rowKey={(r, i) => r.id ?? i}
            columns={[
              {
                key: 'item', label: 'Item',
                render: (r) => (
                  <div>
                    <div className="font-medium">{r.item_name}</div>
                    {r.description && <div className="text-xs text-ink-500">{r.description}</div>}
                  </div>
                ),
              },
              { key: 'qty', label: 'Quantity', align: 'right', render: (r) => <Qty value={r.quantity} unit={r.unit_of_measure} /> },
              { key: 'price', label: 'Unit price', align: 'right', render: (r) => <Money amount={r.unit_price} currency={currency} /> },
              { key: 'total', label: 'Total', align: 'right', render: (r) => <Money amount={r.line_total} currency={currency} /> },
            ]}
            footer={
              <Totals
                rows={[
                  { label: 'Subtotal', value: <Money amount={quotation?.subtotal} currency={currency} /> },
                  Number(quotation?.discount_amount) > 0 && { label: 'Discount', value: <span>−<Money amount={quotation.discount_amount} currency={currency} /></span> },
                  { label: 'Tax', value: <Money amount={quotation?.tax_amount} currency={currency} /> },
                  { label: 'Total', value: <Money amount={quotation?.total_amount} currency={currency} />, strong: true },
                ]}
              />
            }
          />
        ) : (
          <div className="p-4">
            <Totals rows={[{ label: 'Total', value: <Money amount={quotation?.total_amount} currency={currency} />, strong: true }]} />
          </div>
        )}
      </PublicSection>

      <PublicSection title={t('ui.yourResponse')}>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <ChoiceGroup
            legend="Decision"
            name="action"
            value={selectedAction}
            onChange={(v) => { setSelectedAction(v); setChoiceError(''); }}
            error={choiceError}
            options={[
              { value: 'accept', label: t('ui.acceptQuotation'), description: 'We will turn it into an order and confirm next steps.' },
              { value: 'reject', label: t('ui.declineQuotation'), description: 'The quotation is closed. Tell us why in the notes if you can.' },
            ]}
          />
          <Field label="Notes" optional id="notes" help={t('ui.pleaseProvideAnyAdditionalCommentsQuestions')}>
            <Textarea
              name="notes"
              rows={4}
              value={customerNotes}
              onChange={(e) => setCustomerNotes(e.target.value)}
            />
          </Field>
          {submitError && <InlineNotice tone="risk" title="Not sent">{submitError}</InlineNotice>}
          <PublicActions note="Your response goes straight to the sales team.">
            <Button
              type="submit"
              size="lg"
              variant={selectedAction === 'reject' ? 'destructive' : 'primary'}
              loading={submitting}
            >
              {selectedAction === 'accept' ? 'Accept quotation' : selectedAction === 'reject' ? 'Decline quotation' : 'Send response'}
            </Button>
          </PublicActions>
        </form>
      </PublicSection>
    </div>
  );
};

export default CustomerQuotationResponse;
