/**
 * Route-level gate for a toggleable module (backend/services/moduleService.js).
 *
 * The frontend nav and the AI tool catalog both hide what a company has
 * turned off; this is the same gate for the raw HTTP route, so a disabled
 * module's endpoints refuse a direct call too, not just a hidden button.
 * Mount after `auth` — it reads req.companyId, which auth's establishCompany
 * step sets.
 */

const moduleService = require('../services/moduleService');

function requireModule(moduleKey) {
  return async (req, res, next) => {
    try {
      const enabled = await moduleService.getEnabledModuleKeys(req.companyId);
      if (!enabled.has(moduleKey)) {
        return res.status(403).json({
          success: false,
          error: `The "${moduleKey}" module is not enabled for this company. An admin can turn it on under Admin > Modules.`,
        });
      }
      next();
    } catch (error) {
      res.status(500).json({ success: false, error: 'Could not verify module access.' });
    }
  };
}

module.exports = requireModule;
