/**
 * The event vocabulary — what this ERP tells the rest of the ecosystem.
 *
 * ===========================================================================
 * WHY THIS EXISTS, AND WHY IT IS WORTH GETTING RIGHT NOW
 * ===========================================================================
 * The webhook machinery was already built and working: subscriptions, HMAC
 * signing, delivery logging, retries. Exactly ONE event was ever emitted into
 * it — `journal_entry.posted`. A delivery system with one event is not an
 * integration surface, it is a proof of concept.
 *
 * That matters more than it looks for a product meant to be the system of
 * record other products build on. If a sibling application cannot subscribe to
 * "an order was confirmed" or "an invoice was raised", it will do the thing
 * every ecosystem regrets: read this database directly. At that point the
 * schema becomes the public API, and no table can ever be refactored again.
 * The cost of defining this while there is one consumer is an afternoon; the
 * cost of defining it after four products have grown into the tables is a
 * migration nobody wants to schedule.
 *
 * THE SHAPE
 * ===========================================================================
 * `entity.event`, lower snake_case, past tense — something that HAPPENED, not
 * a command. Status transitions produce `entity.status_changed` plus a
 * specific `entity.<status>` for the statuses subscribers actually care about,
 * so a consumer can subscribe narrowly ("sales_order.completed") or broadly
 * ("sales_order.status_changed") without receiving a firehose it must filter.
 *
 * Every payload carries the same envelope fields — id, company_id, and the
 * document's own number — because a subscriber that has to call back to find
 * out WHICH tenant an event came from cannot process events concurrently.
 *
 * WHERE THEY COME FROM
 * ===========================================================================
 * Almost entirely from one place. Every consequential status change in this
 * system already funnels through services/statusTransitionService, so hooking
 * emission in there gives near-complete coverage for free, and — more
 * importantly — makes it impossible for a new flow to change a status without
 * announcing it. Events emitted by hand at call sites are events that get
 * forgotten at the next call site.
 */

const webhookService = require('./webhookService');

/**
 * Entity types whose transitions are worth telling the world about, mapped to
 * the event prefix. Anything not listed still emits nothing, so adding an
 * internal entity does not silently create a public contract.
 */
const ENTITY_EVENT_PREFIX = {
  SALES_ORDER: 'sales_order',
  SALES_QUOTATION: 'sales_quotation',
  PURCHASE_ORDER: 'purchase_order',
  PURCHASE_REQUISITION: 'purchase_requisition',
  SUPPLIER_INVOICE: 'supplier_invoice',
  CUSTOMER_PAYMENT: 'customer_payment',
  SUPPLIER_PAYMENT: 'supplier_payment',
  CREDIT_NOTE: 'credit_note',
  DELIVERY_SCHEDULE: 'delivery_schedule',
  JOURNAL_ENTRY: 'journal_entry',
  PAYROLL_RUN: 'payroll_run',
  FIXED_ASSET: 'fixed_asset',
  WAREHOUSE_TRANSACTION: 'warehouse_transaction',
  WORK_ORDER: 'work_order',
  CONTRACT: 'contract',
  BUDGET: 'budget',
};

/**
 * The statuses that get their own named event, per entity. A subscriber wants
 * `sales_order.completed`; nobody wants `sales_order.sent_to_customer` badly
 * enough to justify it being part of the contract forever. Everything else is
 * still visible through `<entity>.status_changed`.
 */
const NAMED_STATUSES = {
  sales_order: ['CONFIRMED', 'COMPLETED', 'CANCELLED'],
  sales_quotation: ['SENT', 'ACCEPTED', 'REJECTED'],
  purchase_order: ['APPROVED', 'ISSUED', 'RECEIVED', 'COMPLETED', 'CANCELLED'],
  purchase_requisition: ['APPROVED', 'REJECTED'],
  supplier_invoice: ['APPROVED', 'POSTED', 'PAID'],
  customer_payment: ['POSTED'],
  supplier_payment: ['POSTED'],
  credit_note: ['POSTED'],
  delivery_schedule: ['IN_TRANSIT', 'DELIVERED', 'FAILED'],
  journal_entry: ['POSTED', 'REVERSED'],
  payroll_run: ['POSTED', 'PAID'],
  fixed_asset: ['DISPOSED'],
  warehouse_transaction: ['COMPLETED'],
  work_order: ['RELEASED', 'COMPLETED'],
  contract: ['ACTIVE', 'EXPIRED', 'TERMINATED'],
  budget: ['APPROVED'],
};

/** Documents whose creation is worth announcing on its own. */
const CREATED_EVENTS = ['customer_invoice', 'supplier_invoice', 'customer_payment', 'purchase_order', 'sales_order'];

/**
 * Every event this system can emit. Exported so the webhook subscription UI
 * can offer a real list instead of a free-text box, and so a test can assert
 * the contract has not silently changed.
 */
function catalogue() {
  const events = new Set();
  for (const prefix of Object.values(ENTITY_EVENT_PREFIX)) {
    events.add(`${prefix}.status_changed`);
    for (const status of NAMED_STATUSES[prefix] || []) {
      events.add(`${prefix}.${status.toLowerCase()}`);
    }
  }
  for (const doc of CREATED_EVENTS) events.add(`${doc}.created`);
  return [...events].sort();
}

/**
 * The fields every subscriber gets, whatever the entity. `document_number` is
 * whichever of the many *_number columns this entity uses — a subscriber
 * should not have to know that a sales order calls it so_number and a bill
 * calls it bill_number.
 */
function envelope(entityType, record) {
  return {
    id: record?.id,
    entity_type: entityType,
    company_id: record?.company_id ?? null,
    document_number:
      record?.so_number ?? record?.po_number ?? record?.invoice_number ?? record?.bill_number ??
      record?.payment_number ?? record?.journal_number ?? record?.quotation_number ??
      record?.schedule_number ?? record?.credit_note_number ?? record?.requisition_number ?? null,
    status: record?.status ?? null,
    total_amount: record?.total_amount ?? null,
    currency: record?.currency ?? null,
  };
}

/**
 * Announce a status transition. Never throws and never awaits delivery — a
 * subscriber being down must not roll back the business transaction that
 * triggered it, which is the same rule the AI and webhook layers already
 * follow here.
 */
function statusChanged(entityType, record, fromStatus, toStatus, actorId) {
  const prefix = ENTITY_EVENT_PREFIX[String(entityType).toUpperCase()];
  if (!prefix) return;

  const payload = {
    ...envelope(entityType, record),
    from_status: fromStatus ?? null,
    to_status: toStatus,
    changed_by: actorId ?? null,
  };

  webhookService.emit(`${prefix}.status_changed`, payload);
  dispatchInside(`${prefix}.status_changed`, payload);
  if ((NAMED_STATUSES[prefix] || []).includes(toStatus)) {
    webhookService.emit(`${prefix}.${String(toStatus).toLowerCase()}`, payload);
    dispatchInside(`${prefix}.${String(toStatus).toLowerCase()}`, payload);
  }
  // An order that moves is looked at again: can it still ship on the day?
  if (prefix === 'sales_order' && record?.id) {
    require('./orderWatch').onOrderLanded(record.company_id || null, record.id, String(toStatus || 'changed').toLowerCase().replace(/_/g, ' '));
  }
}

/**
 * The same events, inside: an agent whose blueprint says `trigger_type:
 * 'event'` with this event_key runs when it happens (services/agents/events.js).
 * Until now only the manual POST /agents/events/:key reached them, so "when an
 * order is confirmed, do X" never fired on a real order. Fire-and-forget, after
 * the business transaction, in the event's own company; only ENABLED agents
 * react, and they act through their blueprint's tools and the Gateway like any
 * other run — a disabled or read-only agent stays exactly that.
 */
function dispatchInside(eventKey, payload) {
  setImmediate(async () => {
    try {
      const { emitAgentEvent } = require('./agents/events');
      const run = () => emitAgentEvent(eventKey, payload, { triggeredBy: payload.changed_by || null });
      if (payload.company_id) await require('./companyContext').runWithCompany(payload.company_id, run);
      else await run();
    } catch (err) {
      console.warn(`[domainEvents] agent dispatch failed for ${eventKey}:`, err.message);
    }
  });
}

/** Announce a newly created document. */
function created(documentType, record) {
  if (!CREATED_EVENTS.includes(documentType)) return;
  webhookService.emit(`${documentType}.created`, envelope(documentType, record));
  dispatchInside(`${documentType}.created`, envelope(documentType, record));
}

module.exports = {
  statusChanged,
  created,
  catalogue,
  ENTITY_EVENT_PREFIX,
  NAMED_STATUSES,
  CREATED_EVENTS,
};
