/**
 * Collections agent — runs accounts-receivable chasing end to end.
 *
 * Monitors overdue customer invoices, decides an escalation level from how far
 * overdue and how large the debt is, and sends the reminder itself. A human only
 * becomes involved when the amount exceeds the agent's authority or the account
 * needs a judgement call (legal escalation, disputed balance).
 *
 * Reuses services/dunningService.js for the escalation tiers and message text so
 * the agent and the manual "run dunning" button cannot drift apart.
 *
 * Note on why detection is split from action: dunning sends real email to real
 * customers. detect() therefore performs no sends at all, which is what lets the
 * runtime honestly answer "what would you do?" in dry-run mode.
 */

const { pool } = require('../../../config/database');
const { escalationFor } = require('../../dunningService');
const customerEmailService = require('../../customerEmailService');

// Beyond this, chasing is a commercial decision (legal action, write-off,
// stopping supply) rather than a reminder, so it always goes to a human.
const FINAL_ESCALATION_DAYS = 90;

module.exports = {
  key: 'collections',
  displayName: 'Collections Agent',
  description:
    'Chases overdue customer invoices: escalates reminders by age, sends them, and hands seriously overdue or high-value accounts to a human.',
  domain: 'FINANCE',
  defaultMode: 'observe',
  defaultSchedule: 60 * 60 * 24, // daily
  defaultAuthority: {
    max_amount: 10000,
    max_actions_per_run: 50,
    allowed_actions: ['send_dunning_reminder'],
  },
  defaultConfig: {
    min_days_overdue: 1,
    min_amount: 1,
  },

  async detect(ctx) {
    const minDays = Number(ctx.config.min_days_overdue) || 1;
    const minAmount = Number(ctx.config.min_amount) || 0;

    const { rows } = await pool.query(
      `
      SELECT ci.id, ci.invoice_number, ci.due_date, ci.currency,
             ci.outstanding_amount::float AS outstanding,
             c.id AS customer_id, c.customer_name, c.primary_email, c.secondary_email,
             (CURRENT_DATE - ci.due_date)::int AS days_overdue,
             -- Do not re-chase an invoice this agent already chased today.
             (SELECT MAX(a.created_at)
                FROM agent_run_actions a
               WHERE a.agent_key = 'collections'
                 AND a.entity_id = ci.id
                 AND a.decision = 'acted') AS last_chased_at
        FROM customer_invoices ci
        JOIN customers c ON c.id = ci.customer_id
       WHERE ci.deleted_at IS NULL
         AND ci.status IN ('APPROVED','SENT','PARTIALLY_PAID','OVERDUE')
         AND ci.outstanding_amount > $1
         AND ci.due_date < CURRENT_DATE - ($2::int - 1)
       ORDER BY ci.outstanding_amount DESC
      `,
      [minAmount, minDays]
    );

    const observations = [];
    for (const inv of rows) {
      const escalation = escalationFor(inv.days_overdue);
      if (!escalation) continue;

      // Suppress repeat chasing within the same escalation window. Without this
      // a daily schedule would email the same customer every morning.
      if (inv.last_chased_at) {
        const daysSince = (Date.now() - new Date(inv.last_chased_at).getTime()) / 86_400_000;
        if (daysSince < 7) continue;
      }

      if (!inv.primary_email) {
        observations.push({
          action_type: 'send_dunning_reminder',
          impact: 'real',
          entity_type: 'customer_invoice',
          entity_id: inv.id,
          entity_label: `${inv.invoice_number} — ${inv.customer_name}`,
          amount: inv.outstanding,
          currency: inv.currency,
          rationale: `${inv.invoice_number} is ${inv.days_overdue} days overdue but ${inv.customer_name} has no email address on file, so no reminder can be sent.`,
          blocked: true,
        });
        continue;
      }

      // Seriously overdue debt is a commercial decision, not a reminder. Declare
      // it as an action the agent is not permitted to take, so authority routes
      // it to a human rather than the agent quietly sending a fourth email.
      const isFinal = inv.days_overdue >= FINAL_ESCALATION_DAYS;

      observations.push({
        action_type: isFinal ? 'escalate_to_collections_review' : 'send_dunning_reminder',
        impact: 'real',
        entity_type: 'customer_invoice',
        entity_id: inv.id,
        entity_label: `${inv.invoice_number} — ${inv.customer_name}`,
        amount: inv.outstanding,
        currency: inv.currency,
        rationale: isFinal
          ? `${inv.invoice_number} (${inv.currency} ${inv.outstanding.toFixed(2)}) is ${inv.days_overdue} days overdue — past the ${FINAL_ESCALATION_DAYS}-day point where reminders stop being appropriate and a commercial decision is needed.`
          : `${inv.invoice_number} (${inv.currency} ${inv.outstanding.toFixed(2)}) is ${inv.days_overdue} days overdue; sending the "${escalation.level}" reminder to ${inv.customer_name}.`,
        data: {
          level: escalation.level,
          subject: escalation.subject,
          days_overdue: inv.days_overdue,
          customer: inv.customer_name,
          email: inv.primary_email,
        },
      });
    }

    return observations;
  },

  async act(observation, _ctx) {
    if (observation.blocked) {
      throw new Error('No email address on file for this customer.');
    }

    const { level, subject, days_overdue, customer, email } = observation.data;
    const message = buildReminder({
      customer,
      invoiceNumber: observation.entity_label.split(' — ')[0],
      amount: observation.amount,
      currency: observation.currency,
      daysOverdue: days_overdue,
      level,
    });

    await customerEmailService.sendCustomerNotificationEmail(
      { customer_name: customer, primary_email: email },
      subject,
      message,
      'warning'
    );

    return { sent_to: email, level, days_overdue };
  },
};

function buildReminder({ customer, invoiceNumber, amount, currency, daysOverdue, level }) {
  const tone =
    level === 'FINAL'
      ? 'This account is now seriously overdue and requires immediate attention.'
      : level === 'SECOND'
        ? 'Our records show this invoice remains unpaid despite an earlier reminder.'
        : 'This is a courtesy reminder that the invoice below is now past its due date.';

  return [
    `Dear ${customer},`,
    '',
    tone,
    '',
    `Invoice:    ${invoiceNumber}`,
    `Amount due: ${currency} ${Number(amount).toFixed(2)}`,
    `Overdue by: ${daysOverdue} days`,
    '',
    'If payment has already been sent, please disregard this message. If there is a query on this invoice, reply to this email and we will look into it.',
    '',
    'Kind regards,',
    'Accounts Receivable',
  ].join('\n');
}
