import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import api from '../services/api';
import { useResource, useResourceMutation } from '../hooks/useResource';
import { keys } from '../services/queryKeys';
import { useI18n } from '../contexts/I18nContext';
import {
  PublicShell, PublicHeader, PublicLoading, PublicMessage, PublicSection,
  LineList, Totals, PublicActions, Qty,
} from '../components/public/PublicPage';
import {
  Button, Field, Input, Textarea, InlineNotice, DescriptionList, Money, Code, StatusBadge,
  ConfirmDialog, formatDate, describeError, useFieldValidation,
} from '../components/ui';

const CustomerOrderResponse = () => {
  const { t } = useI18n();
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const action = searchParams.get('action');

  const [submitted, setSubmitted] = useState(null); // 'accept' | 'reject'
  const [response, setResponse] = useState({ customer_name: '', customer_email: '', comments: '' });
  const [pendingAction, setPendingAction] = useState(null);
  const [autoOpened, setAutoOpened] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Portal token can expire mid-session; retrying a 401 three times is worse
  // than failing once with a clear message.
  const { data: order, loading, error: queryError } = useResource(
    keys.customerOrderResponse(token),
    ({ signal }) => api.get(`/sales-orders/customer-response/${token}`, { signal }),
    { enabled: !!token, retry: false, staleTime: 0 }
  );

  useEffect(() => {
    if (order) {
      // Pre-fill customer details if available
      setResponse((prev) => ({
        ...prev,
        customer_name: order.customer_name_full || '',
        customer_email: order.customer_email || '',
      }));
    }
  }, [order]);

  const rules = useMemo(() => ({
    customer_name: (v) => (!v?.trim() ? 'Enter your name. It is recorded as your signature.' : null),
    customer_email: (v) => (!v?.trim() ? 'Enter your email address.'
      : !v.includes('@') ? 'Enter a full email address, like name@company.com.' : null),
  }), []);
  const { errors, onBlur, validateAll } = useFieldValidation(response, rules);

  const submitMutation = useResourceMutation(
    (payload) => api.post(`/sales-orders/customer-response/${token}`, payload),
    { silent: true }
  );
  const submitting = submitMutation.isPending;

  // Ask before signing. Validates the name/email first so the dialog never
  // opens for a response the server would refuse.
  const requestResponse = (selectedAction) => {
    if (submitting) return;
    setSubmitError('');
    const all = validateAll();
    const first = Object.keys(all)[0];
    if (first) {
      document.getElementById(first)?.focus();
      return;
    }
    setPendingAction(selectedAction);
  };

  const sendResponse = async () => {
    const selectedAction = pendingAction;
    try {
      await submitMutation.mutateAsync({
        action: selectedAction,
        customer_name: response.customer_name,
        customer_email: response.customer_email,
        comments: response.comments,
      });
      setPendingAction(null);
      setSubmitted(selectedAction);
    } catch (error) {
      setPendingAction(null);
      const verb = selectedAction === 'accept' ? 'accept' : 'decline';
      setSubmitError(error.response?.data?.error || `The order could not be ${verb === 'accept' ? 'accepted' : 'declined'}. Try again.`);
    }
  };

  // The email links carry ?action=accept|reject: open the matching
  // confirmation once the order (and pre-filled details) have loaded.
  useEffect(() => {
    if (!autoOpened && order && order.status === 'SENT_TO_CUSTOMER' && (action === 'accept' || action === 'reject')) {
      setAutoOpened(true);
      if (order.customer_name_full && order.customer_email) setPendingAction(action);
    }
  }, [order, action, autoOpened]);

  const shell = (children) => <PublicShell context="Sales order">{children}</PublicShell>;

  if (loading && token) return shell(<PublicLoading label={t('ui.loadingOrderDetails')} />);

  if (queryError || !order) {
    const { reference } = describeError(queryError);
    return shell(
      <PublicMessage tone="risk" title={t('ui.orderNotFound')} reference={reference}>
        <p>{queryError?.response?.data?.error || t('ui.theOrderLinkMayBeInvalid')}</p>
        <p>If you still need to respond, reply to the email the order came with and ask for a new link.</p>
      </PublicMessage>
    );
  }

  if (submitted) {
    return shell(
      <PublicMessage tone="ok" title={submitted === 'accept' ? 'Order accepted and signed' : 'Order declined'}>
        <p>{t('ui.thankYouForYourResponseTo2')} <Code>{order.so_number}</Code>.</p>
        <p>{t('ui.ourTeamHasBeenNotifiedAnd')}</p>
      </PublicMessage>
    );
  }

  const currency = order.currency || 'USD';
  const open = order.status === 'SENT_TO_CUSTOMER';

  return shell(
    <div className="space-y-5">
      <PublicHeader
        eyebrow="Sales order"
        title={<Code>{order.so_number}</Code>}
        status={!open ? <StatusBadge status={order.status} /> : null}
        description={open ? t('ui.thisOrderHasBeenApprovedBy') : null}
      />

      <PublicSection title={t('ui.orderInformation')}>
        <DescriptionList
          items={[
            { label: 'Order date', value: formatDate(order.order_date) },
            { label: 'Delivery date', value: formatDate(order.delivery_date) },
            { label: 'Currency', value: order.currency },
            order.reference_number && { label: 'Your reference', value: <Code>{order.reference_number}</Code> },
            order.payment_terms && { label: 'Payment terms', value: order.payment_terms },
            order.delivery_address && { label: 'Delivery address', value: <span className="whitespace-pre-line">{order.delivery_address}</span> },
            order.delivery_instructions && { label: 'Delivery instructions', value: order.delivery_instructions, wide: true },
            order.notes && { label: 'Notes', value: order.notes, wide: true },
          ]}
        />
      </PublicSection>

      <PublicSection title={t('ui.orderItems2')} padded={false}>
        <LineList
          label="Order items"
          rows={order.items || []}
          columns={[
            {
              key: 'item', label: 'Item',
              render: (r) => (
                <div>
                  <div className="font-medium">{r.item_name}</div>
                  {r.item_code && <Code className="text-xs text-ink-500">{r.item_code}</Code>}
                  {r.item_description && <div className="text-xs text-ink-500">{r.item_description}</div>}
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
                order.subtotal != null && { label: 'Subtotal', value: <Money amount={order.subtotal} currency={currency} /> },
                Number(order.discount_amount) > 0 && { label: 'Discount', value: <span>−<Money amount={order.discount_amount} currency={currency} /></span> },
                Number(order.tax_amount) > 0 && { label: 'Tax', value: <Money amount={order.tax_amount} currency={currency} /> },
                { label: 'Total', value: <Money amount={order.total_amount} currency={currency} />, strong: true },
              ]}
            />
          }
        />
      </PublicSection>

      {open ? (
        <PublicSection title={t('ui.yourResponse')}>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Your name" error={errors.customer_name} id="customer_name">
                <Input size="lg" autoComplete="name" value={response.customer_name}
                  onChange={(e) => setResponse((prev) => ({ ...prev, customer_name: e.target.value }))}
                  onBlur={onBlur('customer_name')} />
              </Field>
              <Field label="Your email" error={errors.customer_email} id="customer_email">
                <Input size="lg" type="email" autoComplete="email" value={response.customer_email}
                  onChange={(e) => setResponse((prev) => ({ ...prev, customer_email: e.target.value }))}
                  onBlur={onBlur('customer_email')} />
              </Field>
            </div>
            <Field label="Comments" optional id="comments">
              <Textarea rows={3} value={response.comments}
                onChange={(e) => setResponse((prev) => ({ ...prev, comments: e.target.value }))}
                placeholder={t('ui.anyAdditionalCommentsOrQuestions')} />
            </Field>
            {submitError && <InlineNotice tone="risk" title="Not sent">{submitError}</InlineNotice>}
            <PublicActions note="Accepting is your digital signature and is legally binding.">
              <Button size="lg" variant="destructive" onClick={() => requestResponse('reject')} disabled={submitting}>
                Decline order
              </Button>
              <Button size="lg" variant="primary" onClick={() => requestResponse('accept')} loading={submitting && pendingAction === 'accept'}>
                Accept and sign order
              </Button>
            </PublicActions>
          </div>
        </PublicSection>
      ) : (
        <InlineNotice tone="warn" title={t('ui.orderNotAvailableForResponse')}>
          This order has already been answered or withdrawn. If something needs to change, reply to the email it came with.
        </InlineNotice>
      )}

      <ConfirmDialog
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
        onConfirm={sendResponse}
        busy={submitting}
        tone={pendingAction === 'accept' ? 'primary' : 'danger'}
        title={pendingAction === 'accept' ? `Accept and sign ${order.so_number}?` : `Decline ${order.so_number}?`}
        confirmLabel={pendingAction === 'accept' ? 'Accept and sign' : 'Decline order'}
        consequence={pendingAction === 'accept'
          ? `You confirm the order details are correct, agree to its terms and authorise fulfilment. ${response.customer_name || 'Your name'} is recorded as your digital signature.`
          : 'The order is returned to the sales team as declined.'}
      />
    </div>
  );
};

export default CustomerOrderResponse;
