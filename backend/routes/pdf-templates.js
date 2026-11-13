/**
 * PDF template administration.
 *
 * Reading is open — knowing what document formats exist is not privileged.
 * Editing is manager/admin: a template is the letterhead on documents that
 * leave the company, so changing one changes what customers and auditors see.
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const templateStore = require('../services/pdf/templateStore');
const { renderDocument, interpolate } = require('../services/pdf/templatedPdf');

router.use(auth);

const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ success: true, ...result });
  } catch (error) {
    console.error(`PDF template route error (${req.method} ${req.path}):`, error.message);
    if (!res.headersSent) res.status(400).json({ success: false, error: error.message });
  }
};

router.get('/', handle(async () => ({ data: await templateStore.listTemplates() })));

router.get('/:keyOrId', handle(async (req) => {
  const template = await templateStore.getTemplate(req.params.keyOrId);
  if (!template) throw new Error('Template not found.');
  return { data: template };
}));

router.post('/', requireManagerOrAdmin, handle(async (req) => ({
  data: await templateStore.createTemplate(req.body, req.user.id),
})));

router.put('/:keyOrId', requireManagerOrAdmin, handle(async (req) => ({
  data: await templateStore.updateTemplate(req.params.keyOrId, req.body, req.user.id),
})));

router.delete('/:keyOrId', requireManagerOrAdmin, handle(async (req) => ({
  data: await templateStore.deleteTemplate(req.params.keyOrId),
})));

router.get('/:keyOrId/versions', handle(async (req) => ({
  data: await templateStore.listVersions(req.params.keyOrId),
})));

router.post('/:keyOrId/rollback', requireManagerOrAdmin, handle(async (req) => ({
  data: await templateStore.rollbackTemplate(req.params.keyOrId, req.body.version, req.user.id),
})));

/**
 * POST /pdf-templates/:keyOrId/preview — render the template to a PDF without
 * storing it, using sample data.
 *
 * Streamed rather than saved: a preview is a look, not a document. Persisting
 * every keystroke of template editing would fill the document list with drafts
 * nobody asked to keep.
 */
router.post('/:keyOrId/preview', async (req, res) => {
  try {
    const template = req.params.keyOrId === 'draft'
      ? req.body.template
      : await templateStore.getTemplate(req.params.keyOrId);
    if (!template) return res.status(404).json({ success: false, error: 'Template not found.' });

    const data = req.body.data || {};
    const sections = req.body.sections || template.sections || [
      { type: 'heading', text: 'Section heading' },
      { type: 'paragraph', text: 'This is how body text looks in this template.' },
      { type: 'metrics', items: [{ label: 'Total', value: '1,234.00' }, { label: 'Open items', value: '17' }] },
      { type: 'table', columns: ['Reference', 'Customer', 'Amount'], rows: [['INV-001', 'Example Ltd', '1,000.00'], ['INV-002', 'Sample GmbH', '234.00']] },
    ];

    const buffer = await renderDocument(
      {
        title: req.body.title || interpolate(template.header?.title || template.name, data),
        subtitle: interpolate(template.header?.subtitle || '', data),
        sections: interpolate(sections, data),
      },
      template
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    res.send(buffer);
  } catch (error) {
    console.error('Template preview error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
