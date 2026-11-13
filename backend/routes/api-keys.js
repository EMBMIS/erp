const express = require('express');
const router = express.Router();
const { auth, requireAdmin } = require('../middleware/auth');
const ApiKey = require('../models/ApiKey');

// Admin-only: API keys grant programmatic access to this ERP — only an admin
// should be able to mint or revoke them.
router.use(auth, requireAdmin);

// GET /api-keys - list keys (never returns the plaintext key)
router.get('/', async (req, res) => {
  try {
    const keys = await ApiKey.findAll();
    res.json({ success: true, data: keys });
  } catch (error) {
    console.error('List API keys error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api-keys - create a key. The plaintext key is returned ONLY in this
// response — store it now, it cannot be retrieved again.
router.post('/', async (req, res) => {
  try {
    const { name, scopes, role, expires_at } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });
    const created = await ApiKey.create({ name, scopes, role, expiresAt: expires_at || null }, req.user.id);
    res.status(201).json({ success: true, data: created, note: 'Save this key now — it will not be shown again.' });
  } catch (error) {
    console.error('Create API key error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// DELETE /api-keys/:id - revoke
router.delete('/:id', async (req, res) => {
  try {
    await ApiKey.revoke(req.params.id);
    res.json({ success: true, message: 'API key revoked' });
  } catch (error) {
    console.error('Revoke API key error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
