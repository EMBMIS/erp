/**
 * Credential vault control plane.
 *
 * Admin/manager only, in full: unlike most screens in this ERP, there is no
 * read-only tier here. Knowing that a credential called "Stripe live key"
 * exists, which hosts it may be sent to, and which agents hold it is itself
 * sensitive — it is a map of what an attacker would want.
 *
 * No endpoint returns a secret. There is deliberately no "reveal" route: the
 * moment one exists, the vault is only as strong as whoever can call it. A user
 * who has lost a key rotates it at the provider and re-enters it.
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const vault = require('../services/ai/credentialVault');

router.use(auth, requireManagerOrAdmin);

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...result });
  } catch (error) {
    console.error(`Credential route error (${req.method} ${req.path}):`, error.message);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  }
};

// Whether the vault can store anything at all. The UI needs this to explain
// why saving is unavailable, rather than showing a form that always fails.
router.get('/status', handle(async () => ({ data: vault.vaultStatus() })));

router.get('/', handle(async () => ({ data: await vault.listCredentials() })));

router.post('/', handle(async (req) => ({
  data: await vault.createCredential(req.body, req.user.id),
  note: 'Stored encrypted. The key cannot be read back — rotate it here if it is ever lost.',
})));

router.put('/:idOrName', handle(async (req) => ({
  data: await vault.updateCredential(req.params.idOrName, req.body, req.user.id),
})));

router.delete('/:idOrName', handle(async (req) => ({
  data: await vault.deleteCredential(req.params.idOrName),
})));

// --- Per-agent grants -------------------------------------------------------

router.get('/agent/:agentKey', handle(async (req) => ({
  data: await vault.agentCredentials(req.params.agentKey),
})));

router.post('/agent/:agentKey/grant', handle(async (req) => ({
  data: await vault.grantToAgent(req.params.agentKey, req.body.credential_id, req.user.id),
})));

router.post('/agent/:agentKey/revoke', handle(async (req) => ({
  data: await vault.revokeFromAgent(req.params.agentKey, req.body.credential_id),
})));

module.exports = router;
