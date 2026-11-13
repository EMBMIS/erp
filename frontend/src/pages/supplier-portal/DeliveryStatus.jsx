import React, { useState, useEffect } from 'react';
import api from '../../services/api';
import { useParams } from 'react-router-dom';
import { useResource, useResourceMutation } from '../../hooks/useResource';
import { keys } from '../../services/queryKeys';
import { useI18n } from '../../contexts/I18nContext';
import {
  PublicShell, PublicHeader, PublicLoading, PublicMessage, PublicSection, PublicActions,
  LineList, Totals, Qty,
} from '../../components/public/PublicPage';
import {
  Button, Field, Textarea, InlineNotice, DescriptionList, Code, Money, StatusBadge,
  formatDate, describeError,
} from '../../components/ui';

// What each status means to the supplier, and the one step that comes next.
const STATUS = {
  SENT_TO_SUPPLIER: { label: 'Awaiting confirmation', description: 'Confirm you can deliver this order on time.', next: 'CONFIRMED', action: 'Confirm order' },
  CONFIRMED: { label: 'Confirmed', description: 'Order confirmed. Start preparing it when you are ready.', next: 'PREPARING_DELIVERY', action: 'Start preparation' },
  PREPARING_DELIVERY: { label: 'Preparing for delivery', description: 'The order is being prepared. Mark it in transit when it leaves you.', next: 'IN_TRANSIT', action: 'Mark as in transit' },
  IN_TRANSIT: { label: 'In transit', description: 'On the way. Mark it delivered once it has been handed over.', next: 'DELIVERED', action: 'Mark as delivered' },
  DELIVERED: { label: 'Delivered', description: 'Delivered. The buyer will verify the goods on receipt.', next: null },
};

// This is a public, token-authenticated portal page (no logged-in session).
// The token travels from useParams into the URL path on every request below —
// that mechanism is unchanged from the pre-conversion fetch() calls.
const DeliveryStatus = () => {
  const { t } = useI18n();
  const { token } = useParams();
  const [deliveryNotes, setDeliveryNotes] = useState('');
  const [deliveryStatusOverride, setDeliveryStatusOverride] = useState(null);
  const [notice, setNotice] = useState(null);

  const { data: poData, loading, error: queryError } = useResource(
    keys.supplierPortalDelivery(token),
    async ({ signal }) => {
      const response = await api.get(`/supplier-portal/delivery/verify/${token}`, { signal });
      return { data: response.data };
    },
    { enabled: !!token, retry: false, staleTime: 0 }
  );

  useEffect(() => {
    if (poData?.po) {
      setDeliveryStatusOverride(null);
      setDeliveryNotes(poData.po.delivery_notes || '');
    }
  }, [poData]);

  const deliveryStatus = deliveryStatusOverride || poData?.po?.status || 'CONFIRMED';

  const updateStatusMutation = useResourceMutation(
    async ({ status, notes }) => {
      const response = await api.post('/supplier-portal/delivery/update-status', { token, status, notes });
      return { data: response.data };
    },
    {
      silent: true,
      invalidates: [keys.supplierPortalDelivery(token)],
      onSuccess: (_result, variables) => {
        setDeliveryStatusOverride(variables.status);
        setNotice({ tone: 'ok', text: `Status updated: ${(STATUS[variables.status] || {}).label || variables.status}.` });
      },
      onError: (err) => setNotice({ tone: 'risk', text: err.response?.data?.error || err.message || 'The status was not updated. Try again.' }),
    }
  );
  const submitting = updateStatusMutation.isPending;

  const handleStatusUpdate = (newStatus) => {
    setNotice(null);
    updateStatusMutation.mutate({ status: newStatus, notes: deliveryNotes });
  };

  const shell = (children) => <PublicShell context="Supplier portal">{children}</PublicShell>;

  if (loading && token) return shell(<PublicLoading />);

  if (queryError || !poData) {
    const { reference } = describeError(queryError);
    return shell(
      <PublicMessage tone="risk" title="This delivery link cannot be opened" reference={reference}>
        <p>{queryError?.response?.data?.error || queryError?.message || 'The link is incomplete.'}</p>
        <p>Reply to the purchase order email to ask the buyer for a new link.</p>
      </PublicMessage>
    );
  }

  const { po, lineItems } = poData;
  const info = STATUS[deliveryStatus] || STATUS.CONFIRMED;
  const currency = po.currency || 'USD';

  return shell(
    <div className="space-y-5">
      <PublicHeader
        eyebrow="Purchase order delivery"
        title={<Code>{po.po_number}</Code>}
        status={<StatusBadge status={deliveryStatus} label={info.label} />}
        description={info.description}
      />

      <PublicSection title={t('ui.purchaseOrderDetails')}>
        <DescriptionList
          items={[
            { label: 'Total amount', value: <Money amount={po.total_amount} currency={currency} className="font-medium" /> },
            { label: 'Expected delivery', value: formatDate(po.delivery_date) },
            { label: 'Payment terms', value: po.payment_terms || 'As agreed' },
            po.delivery_address && { label: 'Delivery address', value: <span className="whitespace-pre-line">{po.delivery_address}</span> },
          ]}
        />
      </PublicSection>

      {lineItems?.length > 0 && (
        <PublicSection title={t('ui.orderItems2')} padded={false}>
          <LineList
            label="Order items"
            rows={lineItems}
            columns={[
              { key: 'desc', label: 'Item', render: (r) => <span className="font-medium">{r.item_description}</span> },
              { key: 'qty', label: 'Quantity', align: 'right', render: (r) => <Qty value={r.quantity} unit={r.unit_of_measure} /> },
              { key: 'price', label: 'Unit price', align: 'right', render: (r) => <Money amount={r.unit_price} currency={currency} /> },
              {
                key: 'total', label: 'Total', align: 'right',
                render: (r) => <Money amount={r.quantity != null && r.unit_price != null ? Number(r.quantity) * Number(r.unit_price) : null} currency={currency} />,
              },
            ]}
            footer={<Totals rows={[{ label: 'Total', value: <Money amount={po.total_amount} currency={currency} />, strong: true }]} />}
          />
        </PublicSection>
      )}

      <PublicSection title={t('ui.updateDeliveryStatus')}>
        <div className="space-y-4">
          <Field label="Delivery notes" optional id="delivery-notes" help="Tracking number, carrier, anything the buyer should know.">
            <Textarea rows={3} value={deliveryNotes} onChange={(e) => setDeliveryNotes(e.target.value)} />
          </Field>
          {notice && <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice>}
          {info.next ? (
            <PublicActions>
              <Button size="lg" variant="primary" onClick={() => handleStatusUpdate(info.next)} loading={submitting}>
                {info.action}
              </Button>
            </PublicActions>
          ) : (
            <InlineNotice tone="ok">{t('ui.deliveryCompleteAwaitingCustomerVerification')}</InlineNotice>
          )}
        </div>
      </PublicSection>
    </div>
  );
};

export default DeliveryStatus;
