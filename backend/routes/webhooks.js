const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { auth, requireAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');

router.use(auth, requireAdmin);

// GET /webhooks - list subscriptions (secret is never returned after creation)
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, url, event_types, status, last_delivery_at, last_delivery_status, created_at
       FROM webhook_subscriptions ORDER BY created_at DESC`
    );
    res.json({ success: true, data: r.rows });
  } catch (error) {
    console.error('List webhooks error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /webhooks/event-types - the events a subscription can be registered for.
//
// Generated from services/domainEvents, not typed out here. The hardcoded list
// this replaced advertised three events, of which exactly one was ever emitted
// — so a subscriber could register for `sales_order.completed`, see the API
// accept it, and then wait forever for a delivery that no code path produced.
// A discovery endpoint that does not come from the emitter is worse than none.
router.get('/event-types', (req, res) => {
  res.json({ success: true, data: require('../services/domainEvents').catalogue() });
});

// POST /webhooks - create a subscription. The signing secret is returned ONCE.
router.post('/', async (req, res) => {
  try {
    const { url, event_types } = req.body;
    if (!url || !Array.isArray(event_types) || event_types.length === 0) {
      return res.status(400).json({ success: false, error: 'url and a non-empty event_types array are required' });
    }
    const secret = crypto.randomBytes(32).toString('hex');
    const r = await pool.query(
      `INSERT INTO webhook_subscriptions (url, event_types, secret, created_by)
       VALUES ($1,$2,$3,$4) RETURNING id, url, event_types, status, created_at`,
      [url, event_types, secret, req.user.id]
    );
    res.status(201).json({ success: true, data: { ...r.rows[0], secret }, note: 'Save this secret now — used to verify the X-Webhook-Signature header; it will not be shown again.' });
  } catch (error) {
    console.error('Create webhook error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// PATCH /webhooks/:id - enable/disable
router.patch('/:id', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['ACTIVE', 'DISABLED'].includes(status)) {
      return res.status(400).json({ success: false, error: 'status must be ACTIVE or DISABLED' });
    }
    const r = await pool.query('UPDATE webhook_subscriptions SET status = $1 WHERE id = $2 RETURNING id, status', [status, req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Subscription not found' });
    res.json({ success: true, data: r.rows[0] });
  } catch (error) {
    console.error('Update webhook error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// DELETE /webhooks/:id
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM webhook_delivery_log WHERE subscription_id = $1', [req.params.id]);
    await pool.query('DELETE FROM webhook_subscriptions WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Subscription deleted' });
  } catch (error) {
    console.error('Delete webhook error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
