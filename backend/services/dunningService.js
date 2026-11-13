/**
 * Dunning — payment-reminder emails for overdue customer invoices.
 *
 * Reuses the existing AR aging query (financial-reports.js's ar-aging logic)
 * and the general-notification email template already used elsewhere in this
 * codebase (customerEmailService.sendCustomerNotificationEmail). Escalates tone
 * by days overdue: a friendly nudge, then a firmer reminder, then a final notice.
 *
 * This is deliberately notification-only — it never blocks, cancels, or writes
 * to any financial record; it only reads AR and sends email. Safe to run
 * on demand or on a schedule.
 */

const { pool } = require('../config/database');
const { currentCompanyId } = require('./companyContext');
const customerEmailService = require('./customerEmailService');

const ESCALATION_LEVELS = [
  { minDays: 1, maxDays: 15, level: 'REMINDER', subject: 'Friendly Payment Reminder' },
  { minDays: 16, maxDays: 45, level: 'OVERDUE_NOTICE', subject: 'Overdue Payment Notice' },
  { minDays: 46, maxDays: Infinity, level: 'FINAL_NOTICE', subject: 'Final Notice — Payment Required' },
];

function escalationFor(daysOverdue) {
  return ESCALATION_LEVELS.find((l) => daysOverdue >= l.minDays && daysOverdue <= l.maxDays) || null;
}

function buildMessage(level, invoice, daysOverdue) {
  const amount = `${invoice.currency || 'USD'} ${Number(invoice.outstanding_amount).toFixed(2)}`;
  switch (level) {
    case 'REMINDER':
      return `This is a friendly reminder that invoice ${invoice.invoice_number} for ${amount} was due on ${new Date(invoice.due_date).toISOString().split('T')[0]} and is now ${daysOverdue} day(s) overdue. If you have already sent payment, please disregard this notice.`;
    case 'OVERDUE_NOTICE':
      return `Invoice ${invoice.invoice_number} for ${amount} is now ${daysOverdue} days overdue. Please arrange payment at your earliest convenience or contact us if there is an issue we can help resolve.`;
    case 'FINAL_NOTICE':
      return `Invoice ${invoice.invoice_number} for ${amount} is significantly overdue (${daysOverdue} days) and requires immediate attention. Please remit payment promptly to avoid further action.`;
    default:
      return `Invoice ${invoice.invoice_number} for ${amount} is overdue.`;
  }
}

/**
 * Send dunning reminders for all open, overdue customer invoices.
 * @param {{dryRun?: boolean}} opts  dryRun: compute what WOULD be sent, without emailing.
 * @param {string|null} companyId
 * @returns {{ sent: number, skipped: number, errors: Array, details: Array, credit_holds_set: Array, credit_holds_released: Array }}
 */
async function runDunning(opts = {}, companyId = currentCompanyId()) {
  const dryRun = !!opts.dryRun;
  const params = [];
  let companyClause = '';
  if (companyId) {
    companyClause = 'AND ci.company_id = $1';
    params.push(companyId);
  }

  const overdue = await pool.query(`
    SELECT ci.id, ci.invoice_number, ci.due_date, ci.outstanding_amount, ci.currency, ci.customer_id,
           c.customer_name, c.primary_email, c.secondary_email, c.credit_hold,
           GREATEST(0, (CURRENT_DATE - ci.due_date))::int AS days_overdue
    FROM customer_invoices ci
    LEFT JOIN customers c ON ci.customer_id = c.id
    WHERE ci.deleted_at IS NULL
      AND ci.status IN ('APPROVED','SENT','PARTIALLY_PAID','OVERDUE')
      AND ci.outstanding_amount > 0
      AND ci.due_date < CURRENT_DATE
      ${companyClause}
    ORDER BY days_overdue DESC
  `, params);

  let sent = 0, skipped = 0;
  const errors = [];
  const details = [];
  // Customers this run found at FINAL_NOTICE — they should be on hold, and
  // everyone else currently on hold (in this company scope) should not be.
  const finalNoticeCustomerIds = new Set();

  for (const invoice of overdue.rows) {
    const escalation = escalationFor(invoice.days_overdue);
    if (!escalation) { skipped++; continue; }

    if (escalation.level === 'FINAL_NOTICE' && invoice.customer_id) {
      finalNoticeCustomerIds.add(invoice.customer_id);
    }

    if (!invoice.primary_email) { skipped++; continue; }

    const message = buildMessage(escalation.level, invoice, invoice.days_overdue);
    details.push({ invoice_number: invoice.invoice_number, customer: invoice.customer_name, days_overdue: invoice.days_overdue, level: escalation.level });

    if (dryRun) { continue; }

    try {
      await customerEmailService.sendCustomerNotificationEmail(
        { customer_name: invoice.customer_name, primary_email: invoice.primary_email, secondary_email: invoice.secondary_email },
        escalation.subject,
        message,
        'warning'
      );
      sent++;
    } catch (err) {
      errors.push({ invoice_number: invoice.invoice_number, error: err.message });
    }
  }

  const credit_holds_set = [];
  const credit_holds_released = [];
  if (!dryRun) {
    const result = await syncCreditHolds(finalNoticeCustomerIds, companyId);
    credit_holds_set.push(...result.set);
    credit_holds_released.push(...result.released);
  }

  return { sent, skipped, errors, details, dry_run: dryRun, credit_holds_set, credit_holds_released };
}

/**
 * A customer with an invoice at FINAL_NOTICE (46+ days overdue, per
 * ESCALATION_LEVELS) is put on credit hold — SalesOrder.approveOrder refuses
 * to approve a new order for them regardless of whether they're still under
 * their numeric credit limit, because "delinquent for 46+ days" is a
 * different, stronger signal than "close to the limit." Recomputed fresh on
 * every run: a customer who pays down their FINAL_NOTICE invoice(s) comes off
 * hold automatically the next time dunning runs, no separate release flow.
 * Holds set for a reason other than dunning (none exist today, but the
 * `credit_hold_reason` column keeps them distinguishable) are left alone.
 */
async function syncCreditHolds(finalNoticeCustomerIds, companyId) {
  const set = [];
  const released = [];

  if (finalNoticeCustomerIds.size) {
    const ids = [...finalNoticeCustomerIds];
    const { rows } = await pool.query(
      `UPDATE customers
          SET credit_hold = true, credit_hold_reason = 'Dunning: invoice(s) at FINAL_NOTICE (46+ days overdue)',
              credit_hold_set_at = CASE WHEN credit_hold THEN credit_hold_set_at ELSE CURRENT_TIMESTAMP END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ANY($1) AND COALESCE(credit_hold, false) = false
        RETURNING id, customer_name`,
      [ids]
    );
    set.push(...rows);
  }

  const params = [];
  let companyClause = '';
  if (companyId) { companyClause = 'AND company_id = $1'; params.push(companyId); }
  const excludeClause = finalNoticeCustomerIds.size
    ? `AND id != ALL($${params.length + 1})`
    : '';
  if (finalNoticeCustomerIds.size) params.push([...finalNoticeCustomerIds]);

  const { rows: releasedRows } = await pool.query(
    `UPDATE customers
        SET credit_hold = false, credit_hold_reason = NULL, credit_hold_set_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE credit_hold = true
        AND credit_hold_reason = 'Dunning: invoice(s) at FINAL_NOTICE (46+ days overdue)'
        ${companyClause} ${excludeClause}
      RETURNING id, customer_name`,
    params
  );
  released.push(...releasedRows);

  return { set, released };
}

module.exports = { runDunning, escalationFor, ESCALATION_LEVELS, syncCreditHolds };

