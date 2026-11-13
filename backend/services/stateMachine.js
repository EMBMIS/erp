/**
 * Canonical State Machine Engine for Simeli ERP.
 *
 * Defines legal status transition maps per entity type. Every consequential status
 * change in the system MUST pass through `assertTransition(entityType, fromStatus, toStatus)`
 * to prevent bypasses like DRAFT -> COMPLETED directly into the general ledger.
 *
 * Comments explain WHY transitions are forbidden to preserve business controls.
 */

const { AppError } = require('../middleware/errorHandler');

const TRANSITION_MAPS = {
  JOURNAL_ENTRY: {
    'DRAFT': ['PENDING_APPROVAL', 'POSTED'],
    'PENDING_APPROVAL': ['APPROVED', 'REJECTED'],
    'APPROVED': ['POSTED', 'REJECTED'],
    'POSTED': ['REVERSED'],
    'REJECTED': ['DRAFT'],
    'REVERSED': []
  },
  // The keys here MUST cover models/SalesOrder.js SALES_ORDER_STATUSES — the same
  // vocabulary the DB CHECK enforces and `npm run db:verify` asserts parity on.
  // This map had drifted to a three-state fiction (CONFIRMED -> IN_PROGRESS ->
  // FULFILLED) that shares almost nothing with the statuses the product actually
  // writes, so every real order died at the first delivery: the delivery route
  // moves a CONFIRMED order to WAITING_CUSTOMER_DELIVERY_CONFIRMATION and the
  // customer portal then moves it to COMPLETED, and neither status existed here.
  // IN_PROGRESS/FULFILLED are kept only for backward compatibility with callers
  // that still name them; they are not in the DB CHECK, so the constraint remains
  // the hard backstop. Every status is a key so no live row can dead-end.
  SALES_ORDER: {
    'DRAFT': ['PENDING_APPROVAL', 'APPROVED', 'SENT_TO_CUSTOMER', 'CONFIRMED', 'CANCELLED'],
    'PENDING_APPROVAL': ['APPROVED', 'CONFIRMED', 'REJECTED', 'CANCELLED'],
    'APPROVED': ['SENT_TO_CUSTOMER', 'CONFIRMED', 'REJECTED', 'CANCELLED'],
    'SENT_TO_CUSTOMER': ['CUSTOMER_ACCEPTED', 'CUSTOMER_REJECTED', 'CONFIRMED', 'CANCELLED'],
    'CUSTOMER_ACCEPTED': ['CONFIRMED', 'IN_PRODUCTION', 'CANCELLED'],
    'CUSTOMER_REJECTED': ['DRAFT', 'SENT_TO_CUSTOMER', 'CANCELLED'],
    'CONFIRMED': [
      'IN_PRODUCTION', 'IN_PROGRESS', 'GOODS_ISSUED', 'READY_FOR_DELIVERY',
      'SHIPPED', 'DELIVERED', 'WAITING_CUSTOMER_DELIVERY_CONFIRMATION',
      'FULFILLED', 'CANCELLED'
    ],
    'IN_PRODUCTION': ['GOODS_ISSUED', 'READY_FOR_DELIVERY', 'SHIPPED', 'CANCELLED'],
    'IN_PROGRESS': ['IN_PRODUCTION', 'GOODS_ISSUED', 'READY_FOR_DELIVERY', 'FULFILLED', 'CANCELLED'],
    'GOODS_ISSUED': ['READY_FOR_DELIVERY', 'SHIPPED', 'CANCELLED'],
    // A delivery schedule may go READY_TO_SHIP -> DELIVERED without ever passing
    // through IN_TRANSIT, so READY_FOR_DELIVERY has to reach the delivered states
    // directly or the route's follow-up SO update would 400.
    'READY_FOR_DELIVERY': [
      'SHIPPED', 'DELIVERED', 'WAITING_CUSTOMER_DELIVERY_CONFIRMATION',
      'DELIVERY_ISSUE_REPORTED', 'CANCELLED'
    ],
    'SHIPPED': ['DELIVERED', 'WAITING_CUSTOMER_DELIVERY_CONFIRMATION', 'DELIVERY_ISSUE_REPORTED', 'CANCELLED'],
    'DELIVERED': ['WAITING_CUSTOMER_DELIVERY_CONFIRMATION', 'DELIVERY_ISSUE_REPORTED', 'COMPLETED', 'CANCELLED'],
    // Completion (and therefore the customer invoice + revenue posting) is only
    // reachable once the customer has been asked to confirm, or has reported an
    // issue that staff then resolved — never straight off the warehouse floor.
    'WAITING_CUSTOMER_DELIVERY_CONFIRMATION': ['COMPLETED', 'DELIVERY_ISSUE_REPORTED', 'CANCELLED'],
    'DELIVERY_ISSUE_REPORTED': ['READY_FOR_DELIVERY', 'SHIPPED', 'COMPLETED', 'CANCELLED'],
    'FULFILLED': ['COMPLETED', 'CANCELLED'],
    'COMPLETED': [],
    'REJECTED': ['DRAFT', 'CANCELLED'],
    'CANCELLED': []
  },
  CUSTOMER_PAYMENT: {
    'DRAFT': ['POSTED', 'CANCELLED'],
    'POSTED': ['REVERSED'],
    'REVERSED': [],
    'CANCELLED': []
  },
  SUPPLIER_PAYMENT: {
    'DRAFT': ['POSTED', 'CANCELLED'],
    'POSTED': ['REVERSED'],
    'REVERSED': [],
    'CANCELLED': []
  },
  CREDIT_NOTE: {
    'DRAFT': ['APPROVED', 'POSTED', 'CANCELLED'],
    'APPROVED': ['POSTED', 'CANCELLED'],
    'POSTED': ['REVERSED'],
    'REVERSED': [],
    'CANCELLED': []
  },
  PURCHASE_ORDER: {
    'DRAFT': ['PENDING_APPROVAL', 'APPROVED', 'CANCELLED'],
    'PENDING_APPROVAL': ['APPROVED', 'REJECTED', 'CANCELLED'],
    'APPROVED': ['ISSUED', 'CANCELLED'],
    'ISSUED': ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
    'PARTIALLY_RECEIVED': ['RECEIVED', 'CANCELLED'],
    'RECEIVED': ['COMPLETED', 'CLOSED'],
    'COMPLETED': [],
    'CLOSED': [],
    'REJECTED': ['DRAFT', 'CANCELLED'],
    'CANCELLED': []
  },
  PURCHASE_REQUISITION: {
    'DRAFT': ['SUBMITTED', 'CANCELLED'],
    'SUBMITTED': ['APPROVED', 'REJECTED', 'CANCELLED'],
    'APPROVED': ['ORDERED', 'CANCELLED'],
    'REJECTED': ['DRAFT', 'CANCELLED'],
    'ORDERED': [],
    'CANCELLED': []
  },
  CONTRACT: {
    'DRAFT': ['PENDING_APPROVAL', 'ACTIVE', 'CANCELLED'],
    'PENDING_APPROVAL': ['ACTIVE', 'REJECTED', 'CANCELLED'],
    'ACTIVE': ['EXPIRED', 'TERMINATED'],
    'REJECTED': ['DRAFT'],
    'EXPIRED': [],
    'TERMINATED': [],
    'CANCELLED': []
  },
  SALES_QUOTATION: {
    'DRAFT': ['PENDING_APPROVAL', 'SENT', 'CANCELLED'],
    'PENDING_APPROVAL': ['SENT', 'REJECTED', 'CANCELLED'],
    'SENT': ['ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
    'ACCEPTED': ['CONVERTED'],
    'REJECTED': ['DRAFT'],
    'EXPIRED': [],
    'CONVERTED': [],
    'CANCELLED': []
  },
  SALES_RFQ: {
    'DRAFT': ['SUBMITTED', 'CANCELLED'],
    'SUBMITTED': ['QUOTED', 'REJECTED', 'CANCELLED'],
    'QUOTED': ['ACCEPTED', 'REJECTED'],
    'ACCEPTED': [],
    'REJECTED': [],
    'CANCELLED': []
  },
  // READY_TO_SHIP is in the route allowlist (routes/delivery-schedules.js) and
  // maps the sales order to READY_FOR_DELIVERY, so it belongs here too.
  DELIVERY_SCHEDULE: {
    'SCHEDULED': ['READY_TO_SHIP', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED'],
    'READY_TO_SHIP': ['IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED'],
    'IN_TRANSIT': ['DELIVERED', 'FAILED', 'CANCELLED'],
    'DELIVERED': [],
    'FAILED': ['SCHEDULED', 'CANCELLED'],
    'CANCELLED': []
  },
  SUPPLIER_INVOICE: {
    'DRAFT': ['PENDING_MATCH', 'APPROVED', 'CANCELLED'],
    'PENDING_MATCH': ['APPROVED', 'DISPUTED', 'CANCELLED'],
    'APPROVED': ['POSTED', 'PAID', 'CANCELLED'],
    'POSTED': ['PAID', 'CANCELLED'],
    'DISPUTED': ['DRAFT', 'CANCELLED'],
    'PAID': [],
    'CANCELLED': []
  },
  PAYROLL_RUN: {
    'DRAFT': ['CALCULATED', 'CANCELLED'],
    'CALCULATED': ['PENDING_APPROVAL', 'POSTED', 'CANCELLED'],
    'PENDING_APPROVAL': ['APPROVED', 'REJECTED', 'CANCELLED'],
    'APPROVED': ['POSTED', 'CANCELLED'],
    'POSTED': ['PAID'],
    'PAID': [],
    'REJECTED': ['DRAFT', 'CANCELLED'],
    'CANCELLED': []
  },
  FIXED_ASSET: {
    'DRAFT': ['ACTIVE', 'DISPOSED'],
    'ACTIVE': ['FULLY_DEPRECIATED', 'DISPOSED', 'WRITTEN_OFF'],
    'FULLY_DEPRECIATED': ['DISPOSED'],
    'DISPOSED': [],
    'WRITTEN_OFF': []
  },
  WAREHOUSE_TRANSACTION: {
    'DRAFT': ['SUBMITTED', 'COMPLETED', 'CANCELLED'],
    'SUBMITTED': ['COMPLETED', 'CANCELLED'],
    'COMPLETED': [],
    'CANCELLED': []
  },
  WORK_ORDER: {
    'DRAFT': ['RELEASED', 'CANCELLED'],
    'RELEASED': ['IN_PROGRESS', 'CANCELLED'],
    'IN_PROGRESS': ['COMPLETED', 'CANCELLED'],
    'COMPLETED': [],
    'CANCELLED': []
  },
  BUDGET: {
    'DRAFT': ['SUBMITTED', 'CANCELLED'],
    'SUBMITTED': ['APPROVED', 'REJECTED', 'CANCELLED'],
    'APPROVED': ['CLOSED'],
    'REJECTED': ['DRAFT'],
    'CLOSED': [],
    'CANCELLED': []
  }
};

/**
 * Asserts that transitioning `entityType` from `fromStatus` to `toStatus` is legal.
 *
 * @param {string} entityType
 * @param {string} fromStatus
 * @param {string} toStatus
 * @throws {AppError} 400 if transition is illegal or unknown entity
 */
function assertTransition(entityType, fromStatus, toStatus) {
  const typeKey = String(entityType).toUpperCase();
  const map = TRANSITION_MAPS[typeKey];
  
  if (!map) {
    throw new AppError(`Unknown entity type for state machine transition: ${entityType}`, 400);
  }

  // If statuses match, no state change is occurring
  if (fromStatus === toStatus) return true;

  const allowedNext = map[fromStatus];
  if (!allowedNext || !allowedNext.includes(toStatus)) {
    throw new AppError(
      `Illegal status transition for ${entityType}: cannot move from '${fromStatus}' to '${toStatus}'.`,
      400
    );
  }

  return true;
}

/**
 * Get transition map for an entity type.
 */
function getTransitionMap(entityType) {
  return TRANSITION_MAPS[String(entityType).toUpperCase()] || null;
}

module.exports = {
  TRANSITION_MAPS,
  assertTransition,
  getTransitionMap
};
