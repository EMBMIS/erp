/**
 * Settings → AI → Provider key. Platform owner only: the key is used by every company on this deployment.
 *   GET    /api/ai-provider            which provider, where the key comes from (settings / server / none), its last 4
 *   GET    /api/ai-provider?check=1    the same, and whether the provider accepts the key right now
 *   PUT    /api/ai-provider  { key }   test it with the provider, then keep it encrypted and use it at once
 *   DELETE /api/ai-provider            forget it: the server's own key is used again
 */
const express = require('express');
const router = express.Router();
const { auth, requirePlatformOwner } = require('../middleware/auth');
const providerKey = require('../services/ai/providerKey');

router.use(auth, requirePlatformOwner);

router.get('/', async (req, res) => {
  try { res.json({ success: true, data: await providerKey.status({ check: req.query.check === '1' }) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.put('/', async (req, res) => {
  try {
    const r = await providerKey.save(req.body?.key, req.user.id);
    if (!r.ok) return res.status(400).json({ success: false, error: r.reason, expose: true });
    res.json({ success: true, data: await providerKey.status() });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/', async (req, res) => {
  try { await providerKey.clear(); res.json({ success: true, data: await providerKey.status() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
