/**
 * Recurring invoices (ERP-Roadmap P2 #8) — the sales-side equivalent of the
 * recurring depreciation journals that already exist elsewhere in this
 * codebase. A recurring_invoice_schedules row represents a standing billing
 * arrangement (e.g. a monthly retainer); running it generates a real
 * customer_invoice (via CustomerInvoice.createStandalone) and advances
 * next_run_date by the schedule's frequency.
 */

const { pool } = require('../config/database');
const { currentCompanyId } = require('./companyContext');
const CustomerInvoice = require('../models/CustomerInvoice');

function advance(date, frequency) {
  const d = new Date(date);
  if (frequency === 'MONTHLY') d.setMonth(d.getMonth() + 1);
  else if (frequency === 'QUARTERLY') d.setMonth(d.getMonth() + 3);
  else if (frequency === 'ANNUALLY') d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split('T')[0];
}

/**
 * Run every ACTIVE schedule whose next_run_date is today or earlier.
 * @param {{dryRun?: boolean}} opts
 * @param {string|null} companyId
 */
async function runDueSchedules(userId, opts = {}, companyId = currentCompanyId()) {
  const dryRun = !!opts.dryRun;
  const params = [];
  let companyClause = '';
  if (companyId) {
    companyClause = 'AND ris.company_id = $1';
    params.push(companyId);
  }

  const due = await pool.query(`
    SELECT ris.*, c.customer_name
    FROM recurring_invoice_schedules ris
    JOIN customers c ON ris.customer_id = c.id
    WHERE ris.status = 'ACTIVE' AND ris.next_run_date <= CURRENT_DATE
    ${companyClause}
    ORDER BY ris.next_run_date ASC
  `, params);


  const created = [];
  const errors = [];

  for (const schedule of due.rows) {
    if (dryRun) {
      created.push({
        schedule_id: schedule.id, customer_name: schedule.customer_name,
        amount: Number(schedule.amount) + Number(schedule.tax_amount),
        next_run_date: schedule.next_run_date, dry_run: true,
      });
      continue;
    }

    try {
      const invoice = await CustomerInvoice.createStandalone({
        customer_id: schedule.customer_id,
        amount: schedule.amount,
        tax_amount: schedule.tax_amount,
        currency: schedule.currency,
        description: schedule.description,
        recurring_schedule_id: schedule.id,
      }, userId);

      const nextRunDate = advance(schedule.next_run_date, schedule.frequency);
      const occurrencesRun = schedule.occurrences_run + 1;
      const hitMax = schedule.max_occurrences != null && occurrencesRun >= schedule.max_occurrences;

      await pool.query(
        `UPDATE recurring_invoice_schedules
         SET last_run_date = CURRENT_DATE, next_run_date = $1, occurrences_run = $2,
             status = CASE WHEN $3 THEN 'CANCELLED' ELSE status END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [nextRunDate, occurrencesRun, hitMax, schedule.id]
      );

      created.push({ schedule_id: schedule.id, invoice_id: invoice.id, invoice_number: invoice.invoice_number, customer_name: schedule.customer_name, amount: invoice.total_amount });
    } catch (err) {
      errors.push({ schedule_id: schedule.id, customer_name: schedule.customer_name, error: err.message });
    }
  }

  return { checked: due.rows.length, created, errors, dry_run: dryRun };
}

module.exports = { runDueSchedules, advance };
