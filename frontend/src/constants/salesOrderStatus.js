/**
 * Canonical sales-order status vocabulary for the UI.
 *
 * This mirrors backend/models/SalesOrder.js SALES_ORDER_STATUSES and the DB
 * CHECK constraint. Before this existed, each screen carried its own inline
 * switch statement, and all of them were wrong in the same two ways:
 *
 *   • They handled INVOICED and PARTIALLY_DELIVERED, which are not valid
 *     sales-order statuses anywhere in the system. Those branches were dead
 *     code that could never run — including the guard that was supposed to stop
 *     an invoiced order being edited.
 *   • They did not handle COMPLETED, the status that actually generates the
 *     customer invoice and posts revenue to the GL. A completed, invoiced order
 *     therefore rendered as an unlabelled grey badge, so staff could not tell
 *     from any list screen whether an order had been invoiced.
 *
 * Keep this file in step with the backend list. `npm run db:verify` asserts the
 * backend list against the live CHECK constraint.
 */

export const SALES_ORDER_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENT_TO_CUSTOMER',
  'CONFIRMED',
  'CUSTOMER_ACCEPTED',
  'CUSTOMER_REJECTED',
  'IN_PRODUCTION',
  'GOODS_ISSUED',
  'READY_FOR_DELIVERY',
  'SHIPPED',
  'DELIVERED',
  'WAITING_CUSTOMER_DELIVERY_CONFIRMATION',
  'DELIVERY_ISSUE_REPORTED',
  'COMPLETED',
  'CANCELLED',
  'REJECTED',
];

/**
 * Display metadata per status. `label` exists because raw enum values like
 * WAITING_CUSTOMER_DELIVERY_CONFIRMATION are unreadable in a table cell.
 */
export const SALES_ORDER_STATUS_META = {
  DRAFT: { label: 'Draft', color: 'bg-gray-100 text-gray-800' },
  PENDING_APPROVAL: { label: 'Pending approval', color: 'bg-yellow-100 text-yellow-800' },
  APPROVED: { label: 'Approved', color: 'bg-teal-100 text-teal-800' },
  SENT_TO_CUSTOMER: { label: 'Sent to customer', color: 'bg-sky-100 text-sky-800' },
  CONFIRMED: { label: 'Confirmed', color: 'bg-green-100 text-green-800' },
  CUSTOMER_ACCEPTED: { label: 'Customer accepted', color: 'bg-green-100 text-green-800' },
  CUSTOMER_REJECTED: { label: 'Customer rejected', color: 'bg-red-100 text-red-800' },
  IN_PRODUCTION: { label: 'In production', color: 'bg-indigo-100 text-indigo-800' },
  GOODS_ISSUED: { label: 'Goods issued', color: 'bg-indigo-100 text-indigo-800' },
  READY_FOR_DELIVERY: { label: 'Ready for delivery', color: 'bg-cyan-100 text-cyan-800' },
  SHIPPED: { label: 'Shipped', color: 'bg-blue-100 text-blue-800' },
  DELIVERED: { label: 'Delivered', color: 'bg-blue-100 text-blue-800' },
  WAITING_CUSTOMER_DELIVERY_CONFIRMATION: {
    label: 'Awaiting customer confirmation',
    color: 'bg-amber-100 text-amber-800',
  },
  DELIVERY_ISSUE_REPORTED: { label: 'Delivery issue reported', color: 'bg-orange-100 text-orange-800' },
  COMPLETED: { label: 'Completed & invoiced', color: 'bg-purple-100 text-purple-800' },
  CANCELLED: { label: 'Cancelled', color: 'bg-red-100 text-red-800' },
  REJECTED: { label: 'Rejected', color: 'bg-red-100 text-red-800' },
};

const FALLBACK = { label: 'Unknown', color: 'bg-gray-100 text-gray-800' };

export function getSalesOrderStatusMeta(status) {
  return SALES_ORDER_STATUS_META[status] || { ...FALLBACK, label: status || 'Unknown' };
}

export function getSalesOrderStatusColor(status) {
  return getSalesOrderStatusMeta(status).color;
}

export function getSalesOrderStatusLabel(status) {
  return getSalesOrderStatusMeta(status).label;
}

/**
 * Reaching COMPLETED generates the customer invoice and posts revenue to the
 * general ledger, so the order is financial record from that point on.
 */
export function isInvoiced(status) {
  return status === 'COMPLETED';
}

/** States from which an order can no longer progress. */
export const TERMINAL_STATUSES = ['COMPLETED', 'CANCELLED', 'REJECTED', 'CUSTOMER_REJECTED'];

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Statuses at which an order must no longer be edited.
 *
 * Everything from GOODS_ISSUED onward has either moved stock or been invoiced,
 * so editing quantities or prices would desynchronise the order from inventory
 * movements and posted GL entries. The previous guard listed INVOICED — a value
 * that never occurs — and omitted COMPLETED, which meant an order that had
 * already been invoiced and posted to the ledger remained fully editable.
 */
export const NON_EDITABLE_STATUSES = [
  'GOODS_ISSUED',
  'SHIPPED',
  'DELIVERED',
  'WAITING_CUSTOMER_DELIVERY_CONFIRMATION',
  'COMPLETED',
  'CANCELLED',
  'REJECTED',
  'CUSTOMER_REJECTED',
];

export function isEditable(status) {
  return !NON_EDITABLE_STATUSES.includes(status);
}

export const EDITABLE_STATUSES = SALES_ORDER_STATUSES.filter((s) => isEditable(s));

/**
 * There is deliberately no manual, click-driven transition map here anymore.
 * A sales order's status now advances only as a byproduct of a real
 * operation — customer portal acceptance, a work order releasing, a goods
 * issue posting, a delivery schedule action, or a customer confirming
 * delivery — exactly like Purchase Orders have no manual "Update Status"
 * panel. The one remaining manual action is cancellation
 * (POST /sales-orders/:id/cancel), which is its own single-purpose endpoint,
 * not a generic "set any status" control.
 */
