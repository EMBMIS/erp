/**
 * Webhook delivery for external integrations (ERP-Roadmap P3 #20).
 *
 * emit() is fire-and-forget by design: a webhook subscriber being slow or down
 * must never block or fail the business transaction that triggered the event
 * (the same "never let AI/integration failure block a business transaction"
 * rule already applied to the AI features in this codebase). Every delivery
 * attempt (success or failure) is logged to webhook_delivery_log.
 */

const crypto = require('crypto');
const { pool } = require('../config/database');

function sign(secret, payloadString) {
  return crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
}

/**
 * Fire an event to every active subscription registered for it. Never throws —
 * delivery errors are caught and logged, not propagated to the caller.
 * @param {string} eventType e.g. 'journal_entry.posted', 'sales_order.completed'
 * @param {object} data
 */
async function emit(eventType, data) {
  try {
    const subs = await pool.query(
      `SELECT * FROM webhook_subscriptions WHERE status = 'ACTIVE' AND $1 = ANY(event_types)`,
      [eventType]
    );
    if (subs.rows.length === 0) return;

    const payload = { event: eventType, data, occurred_at: new Date().toISOString() };
    const payloadString = JSON.stringify(payload);

    for (const sub of subs.rows) {
      deliverOne(sub, eventType, payload, payloadString).catch(() => {
        /* deliverOne handles its own logging; this catch exists only to
           guarantee emit() itself can never reject */
      });
    }
  } catch (err) {
    console.warn('webhookService.emit failed to look up subscriptions:', err.message);
  }
}

async function deliverOne(sub, eventType, payload, payloadString) {
  const signature = sign(sub.secret, payloadString);
  let status = null;
  let error = null;

  try {
    const res = await fetch(sub.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': eventType,
      },
      body: payloadString,
      signal: AbortSignal.timeout(10000),
    });
    status = res.status;
  } catch (err) {
    error = err.message;
  }

  await pool.query(
    `UPDATE webhook_subscriptions SET last_delivery_at = CURRENT_TIMESTAMP, last_delivery_status = $1 WHERE id = $2`,
    [status, sub.id]
  ).catch(() => {});

  await pool.query(
    `INSERT INTO webhook_delivery_log (subscription_id, event_type, payload, response_status, error)
     VALUES ($1,$2,$3,$4,$5)`,
    [sub.id, eventType, JSON.stringify(payload), status, error]
  ).catch(() => {});
}

module.exports = { emit, sign };
