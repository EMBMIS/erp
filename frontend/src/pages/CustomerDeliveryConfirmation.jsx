import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useResource, useResourceMutation } from '../hooks/useResource';
import { keys } from '../services/queryKeys';
import { useI18n } from '../contexts/I18nContext';
import {
  PublicShell, PublicHeader, PublicLoading, PublicMessage, PublicSection,
  LineList, Totals, PublicActions, Qty,
} from '../components/public/PublicPage';
import { Button, Field, Textarea, InlineNotice, DescriptionList, Money, Code, formatDate, describeError } from '../components/ui';

const CustomerDeliveryConfirmation = () => {
  const { t } = useI18n();
  const { token } = useParams();
  const navigate = useNavigate();
  const [customerNotes, setCustomerNotes] = useState('');
  const [notesError, setNotesError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [busyAction, setBusyAction] = useState(null);

  // Portal token can expire mid-session; retrying a 401 three times is worse
  // than failing once with a clear message.
  // This endpoint's envelope has no top-level `success` field, so useResource's
  // unwrap() returns the raw `{ data, message }` body as-is — unwrap it here.
  const { data: deliveryResponse, loading: isLoading, error: queryError } = useResource(
    keys.customerDeliveryConfirmation(token),
    ({ signal }) => api.get(`/customers/delivery-confirmation/${token}`, { signal }),
    { enabled: !!token, retry: false, staleTime: 0 }
  );
  const orderData = deliveryResponse?.data;

  const respondMutation = useResourceMutation(
    (payload) => api.post(`/customers/delivery-confirmation/${token}`, payload),
    { silent: true }
  );
  const isSubmitting = respondMutation.isPending;

  const respond = async (action) => {
    setSubmitError('');
    if (action === 'issue' && !customerNotes.trim()) {
      setNotesError('Describe what was wrong with the delivery — missing items, damage, wrong quantity.');
      document.getElementById('customerNotes')?.focus();
      return;
    }
    setBusyAction(action);
    try {
      const result = await respondMutation.mutateAsync({ action, notes: customerNotes });
      navigate('/delivery-confirmation/success', {
        state: {
          message: result?.message,
          orderNumber: orderData.so_number,
          ...(action === 'issue' ? { isIssue: true } : {}),
        },
      });
    } catch (error) {
      setSubmitError(
        error.response?.data?.error
          || (action === 'issue' ? 'Failed to report delivery issue' : 'Failed to confirm delivery')
      );
    } finally {
      setBusyAction(null);
    }
  };

  const shell = (children) => <PublicShell context="Delivery">{children}</PublicShell>;

  if (isLoading && token) return shell(<PublicLoading label={t('ui.loadingDeliveryConfirmation')} />);

  if (queryError || !orderData) {
    const { reference } = describeError(queryError);
    return shell(
      <PublicMessage tone="risk" title={t('ui.deliveryConfirmationNotFound')} reference={reference}>
        <p>{queryError?.response?.data?.error || 'Delivery confirmation not found'}</p>
        <p>{t('ui.thisDeliveryConfirmationMayHaveAlready')}</p>
      </PublicMessage>
    );
  }

  const currency = orderData.currency || 'USD';
  const items = orderData.items || [];

  return shell(
    <div className="space-y-5">
      <PublicHeader
        eyebrow="Delivery confirmation"
        title={<Code>{orderData.so_number}</Code>}
        description={`${orderData.customer_name ? `${orderData.customer_name}: y` : 'Y'}our order has been delivered. Check it arrived complete and in good condition, then confirm or report a problem.`}
      />

      <PublicSection title={t('ui.deliveryInformation')}>
        <DescriptionList
          items={[
            { label: 'Order', value: <Code>{orderData.so_number}</Code> },
            { label: 'Order date', value: formatDate(orderData.order_date) },
            orderData.po_number && { label: 'Your purchase order', value: <Code>{orderData.po_number}</Code> },
            { label: 'Delivery address', value: orderData.delivery_address ? <span className="whitespace-pre-line">{orderData.delivery_address}</span> : null },
            orderData.handover_notes && { label: 'Delivery notes', value: orderData.handover_notes, wide: true },
          ]}
        />
      </PublicSection>

      {items.length > 0 && (
        <PublicSection title={`Items delivered (${items.length})`} padded={false}>
          <LineList
            label="Items delivered"
            rows={items}
            columns={[
              {
                key: 'item', label: 'Item',
                render: (r) => (
                  <div>
                    <div className="font-medium">{r.item_name || 'Unnamed item'}</div>
                    {r.approved_item_code && <Code className="text-xs text-ink-500">{r.approved_item_code}</Code>}
                    {(r.description || r.item_description) && <div className="text-xs text-ink-500">{r.description || r.item_description}</div>}
                  </div>
                ),
              },
              { key: 'qty', label: 'Quantity', align: 'right', render: (r) => <Qty value={r.quantity} unit={r.unit_of_measure} /> },
              { key: 'price', label: 'Unit price', align: 'right', render: (r) => <Money amount={r.unit_price} currency={currency} /> },
              {
                key: 'total', label: 'Total', align: 'right',
                render: (r) => (r.quantity != null && r.unit_price != null
                  ? <Money amount={Number(r.quantity) * Number(r.unit_price)} currency={currency} />
                  : <Money amount={null} />),
              },
            ]}
            footer={<Totals rows={[{ label: 'Total', value: <Money amount={orderData.total_amount} currency={currency} />, strong: true }]} />}
          />
        </PublicSection>
      )}

      <PublicSection title="Your confirmation">
        <div className="space-y-4">
          <Field
            label="Notes"
            id="customerNotes"
            error={notesError}
            help="Optional when confirming. Required if you report a problem."
          >
            <Textarea
              rows={4}
              value={customerNotes}
              onChange={(e) => { setCustomerNotes(e.target.value); if (notesError) setNotesError(''); }}
              placeholder={t('ui.anyCommentsAboutTheDeliveryCondition')}
            />
          </Field>
          {submitError && <InlineNotice tone="risk" title="Not sent">{submitError}</InlineNotice>}
          <PublicActions>
            <Button size="lg" variant="secondary" onClick={() => respond('issue')} disabled={isSubmitting} loading={busyAction === 'issue'}>
              Report a problem
            </Button>
            <Button size="lg" variant="primary" onClick={() => respond('confirm')} disabled={isSubmitting} loading={busyAction === 'confirm'}>
              {t('ui.confirmDeliveryReceived')}
            </Button>
          </PublicActions>
        </div>
      </PublicSection>
    </div>
  );
};

export default CustomerDeliveryConfirmation;
