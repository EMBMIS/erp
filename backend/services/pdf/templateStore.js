/**
 * PDF template CRUD and versioning.
 *
 * A template is the styling (letterhead, colours, fonts, margins) plus an
 * optional default body of sections with {{placeholders}}. That second half is
 * what makes a template more than a skin: "monthly financial summary" can be a
 * whole document whose numbers are filled in each month, so the layout is
 * decided once by a person rather than re-improvised by the model every run.
 */

const { pool } = require('../../config/database');

const KEY_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

async function listTemplates() {
  const { rows } = await pool.query(
    `SELECT t.*, u.first_name || ' ' || u.last_name AS created_by_name
       FROM pdf_templates t LEFT JOIN users u ON u.id = t.created_by
      ORDER BY t.is_builtin DESC, t.name`
  );
  return rows;
}

async function getTemplate(keyOrId) {
  if (!keyOrId) return null;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(keyOrId));
  const { rows } = await pool.query(
    `SELECT * FROM pdf_templates WHERE ${isUuid ? 'id' : 'key'} = $1`,
    [keyOrId]
  );
  return rows[0] || null;
}

/**
 * The template to render with. A named template that does not exist is a hard
 * error, not a silent fall back to the default: a report that quietly ignored
 * the branding it was asked for looks correct and is not.
 *
 * No key returns null rather than the `standard_report` row. That row is a
 * management-report letterhead, and applying it whenever nobody named a
 * template meant every document the assistant produced — a letter, a
 * certificate, a CV — came out dressed as a financial report. With no template
 * the renderer uses the document-type preset instead (see DOCUMENT_PRESETS in
 * templatedPdf.js), which is chosen to suit what the document actually is.
 */
async function resolveTemplate(key) {
  if (!key) return null;
  const found = await getTemplate(key);
  if (!found) throw new Error(`No PDF template named "${key}". Use list_pdf_templates to see what exists.`);
  return found;
}

function validate(input) {
  if (!KEY_PATTERN.test(String(input.key || ''))) {
    throw new Error('A template key must be lowercase letters, digits and underscores, 3-64 characters, starting with a letter.');
  }
  if (!input.name || !String(input.name).trim()) throw new Error('A template needs a name.');
  if (input.orientation && !['portrait', 'landscape'].includes(input.orientation)) {
    throw new Error('Orientation must be "portrait" or "landscape".');
  }
  if (input.sections !== undefined && !Array.isArray(input.sections)) {
    throw new Error('Template sections must be an array.');
  }
  return true;
}

async function createTemplate(input, userId) {
  validate(input);
  const { rows } = await pool.query(
    `INSERT INTO pdf_templates
       (key, name, description, page_size, orientation, margin, header, footer, colors, fonts, sections, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
     RETURNING *`,
    [
      input.key,
      String(input.name).slice(0, 160),
      input.description || null,
      input.page_size || 'A4',
      input.orientation || 'portrait',
      Number(input.margin) || 50,
      JSON.stringify(input.header || {}),
      JSON.stringify(input.footer || {}),
      JSON.stringify(input.colors || {}),
      JSON.stringify(input.fonts || {}),
      JSON.stringify(input.sections || []),
      userId || null,
    ]
  );
  await snapshot(pool, rows[0], 'Created', userId);
  return rows[0];
}

async function snapshot(client, template, note, userId) {
  await client.query(
    `INSERT INTO pdf_template_versions (template_id, version, snapshot, note, created_by)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (template_id, version) DO NOTHING`,
    [template.id, template.version, JSON.stringify(template), note || null, userId || null]
  );
}

async function updateTemplate(keyOrId, changes, userId) {
  const existing = await getTemplate(keyOrId);
  if (!existing) throw new Error('Template not found.');

  const merged = {
    key: changes.key ?? existing.key,
    name: changes.name ?? existing.name,
    description: changes.description ?? existing.description,
    page_size: changes.page_size ?? existing.page_size,
    orientation: changes.orientation ?? existing.orientation,
    margin: changes.margin ?? existing.margin,
    header: changes.header ?? existing.header,
    footer: changes.footer ?? existing.footer,
    colors: changes.colors ?? existing.colors,
    fonts: changes.fonts ?? existing.fonts,
    sections: changes.sections ?? existing.sections,
  };
  validate(merged);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await snapshot(client, existing, changes.note || 'Edited', userId);
    const { rows } = await client.query(
      `UPDATE pdf_templates
          SET key = $2, name = $3, description = $4, page_size = $5, orientation = $6,
              margin = $7, header = $8, footer = $9, colors = $10, fonts = $11, sections = $12,
              version = version + 1, updated_by = $13, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING *`,
      [
        existing.id, merged.key, merged.name, merged.description, merged.page_size,
        merged.orientation, Number(merged.margin) || 50,
        JSON.stringify(merged.header || {}), JSON.stringify(merged.footer || {}),
        JSON.stringify(merged.colors || {}), JSON.stringify(merged.fonts || {}),
        JSON.stringify(merged.sections || []), userId || null,
      ]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function deleteTemplate(keyOrId) {
  const existing = await getTemplate(keyOrId);
  if (!existing) throw new Error('Template not found.');
  // The built-in is the fallback every other code path assumes exists.
  if (existing.is_builtin) throw new Error('The built-in template cannot be deleted. Edit it instead.');
  await pool.query('DELETE FROM pdf_templates WHERE id = $1', [existing.id]);
  return { deleted: existing.key };
}

async function listVersions(keyOrId) {
  const existing = await getTemplate(keyOrId);
  if (!existing) throw new Error('Template not found.');
  const { rows } = await pool.query(
    `SELECT v.id, v.version, v.note, v.created_at, v.snapshot, u.first_name || ' ' || u.last_name AS created_by_name
       FROM pdf_template_versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.template_id = $1 ORDER BY v.version DESC`,
    [existing.id]
  );
  return rows;
}

async function rollbackTemplate(keyOrId, version, userId) {
  const existing = await getTemplate(keyOrId);
  if (!existing) throw new Error('Template not found.');
  const { rows } = await pool.query(
    'SELECT snapshot FROM pdf_template_versions WHERE template_id = $1 AND version = $2',
    [existing.id, Number(version)]
  );
  if (!rows.length) throw new Error(`Version ${version} not found for this template.`);
  return updateTemplate(existing.id, { ...rows[0].snapshot, note: `Rolled back to version ${version}` }, userId);
}

module.exports = {
  listTemplates,
  getTemplate,
  resolveTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  listVersions,
  rollbackTemplate,
  KEY_PATTERN,
};
