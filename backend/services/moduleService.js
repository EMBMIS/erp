/**
 * Per-company module (feature area) enablement.
 *
 * A company's enabled module set is: every core module (always on) plus
 * whatever is TRUE in company_modules. That row set is normally seeded from
 * business_type_default_modules at signup (seedForCompany), but is freely
 * editable afterward — a company can turn on a module its business type
 * doesn't default to, and turn off one it does. company_modules is the only
 * source of truth once seeded; business_type_default_modules is a signup-time
 * template, not a live constraint.
 */

const { pool } = require('../config/database');

async function listModules() {
  const { rows } = await pool.query(
    `SELECT key, name, description, is_core, nav_section FROM modules ORDER BY is_core DESC, name ASC`
  );
  return rows;
}

async function listBusinessTypes() {
  const { rows } = await pool.query(
    `SELECT code, name, category, description FROM business_types ORDER BY category, name`
  );
  return rows;
}

/** Every module key this company actually has on — core modules plus enabled company_modules rows. */
async function getEnabledModuleKeys(companyId) {
  const { rows } = await pool.query(
    `SELECT key FROM modules WHERE is_core = true
     UNION
     SELECT module_key FROM company_modules WHERE company_id = $1 AND enabled = true`,
    [companyId]
  );
  return new Set(rows.map((r) => r.key));
}

/** Full module list annotated with this company's current on/off state — what the settings UI renders. */
async function getModulesWithStatus(companyId) {
  const { rows } = await pool.query(
    `SELECT m.key, m.name, m.description, m.is_core, m.nav_section,
            (m.is_core OR COALESCE(cm.enabled, false)) AS enabled
       FROM modules m
       LEFT JOIN company_modules cm ON cm.module_key = m.key AND cm.company_id = $1
      ORDER BY m.is_core DESC, m.name ASC`,
    [companyId]
  );
  return rows;
}

/** Turn a non-core module on or off for a company. Core modules cannot be toggled. */
async function setModuleEnabled(companyId, moduleKey, enabled) {
  const { rows } = await pool.query(`SELECT is_core FROM modules WHERE key = $1`, [moduleKey]);
  if (!rows.length) throw new Error(`Unknown module "${moduleKey}".`);
  if (rows[0].is_core) throw new Error(`"${moduleKey}" is a core module and cannot be disabled.`);

  await pool.query(
    `INSERT INTO company_modules (company_id, module_key, enabled, updated_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (company_id, module_key)
     DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = CURRENT_TIMESTAMP`,
    [companyId, moduleKey, enabled]
  );
}

/**
 * Seed a new company's modules from its business type's defaults. Called once
 * at signup (or when a business type is set for the first time) — idempotent,
 * so calling it again just leaves already-decided rows alone.
 */
async function seedForCompany(companyId, businessTypeCode) {
  if (!businessTypeCode) return;
  await pool.query(
    `INSERT INTO company_modules (company_id, module_key, enabled)
       SELECT $1, module_key, true
         FROM business_type_default_modules
        WHERE business_type_code = $2
     ON CONFLICT (company_id, module_key) DO NOTHING`,
    [companyId, businessTypeCode]
  );
}

module.exports = {
  listModules,
  listBusinessTypes,
  getEnabledModuleKeys,
  getModulesWithStatus,
  setModuleEnabled,
  seedForCompany,
};
